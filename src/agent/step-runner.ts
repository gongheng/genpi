// StepRunner——pi SDK 唯一适配点（public-API-only）：StepSpec → AgentSession → 事件流/StepResult
// 扩展透传（契约 17）：内联 extensionFactories + additionalExtensionPaths + pi 三层自动发现
// 契约 4（v1.6）：bash 真实执行记录（tool_execution_* 事件）与模型自报 evidence 交叉校验，伪造即 fail
import { join } from "node:path";
import type { CommandEvidence, StepEvent, StepResult, StepRunner, StepSpec, StateId } from "../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SessionLike {
  prompt(text: string): Promise<void>;
  subscribe(cb: (event: unknown) => void): () => void;
  getLastAssistantText(): string;
  dispose(): void;
  abort?(): void;
  readonly id?: string;
}

export type SessionFactory = (
  opts: { cwd: string; model?: string; extensions?: InlineExtension[]; additionalExtensionPaths?: string[] },
) => Promise<SessionLike>;

/** pi 扩展（内联工厂形态，签名与 pi ExtensionAPI 一致）。 */
export type InlineExtension = (pi: ExtensionAPI) => void;

let testFactory: SessionFactory | null = null;

/** 测试注入：替换会话工厂；传 null 还原真实工厂。 */
export function setSessionFactoryForTest(f: SessionFactory | null): void {
  testFactory = f;
}

/** 构建 pi 资源装载器：扩展三层发现 + 内联/额外路径（导出供测试与定制）。 */
export async function buildResourceLoader(opts: {
  cwd: string;
  agentDir: string;
  extensionFactories?: InlineExtension[];
  additionalExtensionPaths?: string[];
}) {
  const pi = await loadPi();
  return new pi.DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    ...(opts.extensionFactories?.length ? { extensionFactories: opts.extensionFactories } : {}),
    ...(opts.additionalExtensionPaths?.length ? { additionalExtensionPaths: opts.additionalExtensionPaths } : {}),
  });
}

let piModule: typeof import("@earendil-works/pi-coding-agent") | null = null;
async function loadPi(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
  piModule ??= await import("@earendil-works/pi-coding-agent");
  return piModule;
}

// ModelRuntime 按 agentDir 缓存（读盘/auth 冷启动只做一次；进程内模型目录变更罕见，重启生效）
const modelRuntimeCache = new Map<string, unknown>();
async function getModelRuntime(pi: typeof import("@earendil-works/pi-coding-agent"), agentDir: string): Promise<unknown> {
  const hit = modelRuntimeCache.get(agentDir);
  if (hit) return hit;
  const rt = await pi.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  modelRuntimeCache.set(agentDir, rt);
  return rt;
}

async function defaultFactory(
  opts: { cwd: string; model?: string; extensions?: InlineExtension[]; additionalExtensionPaths?: string[] },
): Promise<SessionLike> {
  // services 化：modelRuntime 可按角色解析 Model 对象（契约 16）；会话仍持久（genpi 数据根）供审计
  const pi = await loadPi();
  const services = await pi.createAgentSessionServices({
    cwd: opts.cwd,
    agentDir: pi.getAgentDir(),
    modelRuntime: (await getModelRuntime(pi, pi.getAgentDir())) as never, // 缓存：每 step 不再冷启动读盘
    resourceLoaderOptions: {
      ...(opts.extensions?.length ? { extensionFactories: opts.extensions } : {}),
      ...(opts.additionalExtensionPaths?.length ? { additionalExtensionPaths: opts.additionalExtensionPaths } : {}),
    },
  });
  let model: unknown;
  if (opts.model) {
    const resolved = pi.resolveCliModel({ cliModel: opts.model, modelRuntime: services.modelRuntime });
    model = resolved.model; // 解析失败/无凭证回落全局默认
  }
  const { session } = await pi.createAgentSessionFromServices({
    services,
    sessionManager: pi.SessionManager.create(opts.cwd),
    ...(model ? { model: model as never } : {}),
  });
  // SAFETY: SDK AgentSession 结构满足 SessionLike（prompt/subscribe/getLastAssistantText/dispose/abort），
  // 历史验证于 step-runner 测试——双 cast 仅抹平 SDK 类型参数差异，运行时形状一致。
  return session as unknown as SessionLike;
}

export interface PiStepRunnerOptions {
  model?: string;
  /** 契约 16：按角色指定模型（implementer/reviewer），缺省回落 defaultModel/model/全局默认 */
  models?: Partial<Record<"implementer" | "reviewer", string>>;
  /** 会话当前模型解析器（如跟随交互会话 /model 切换）；优先于 model，低于角色配置 */
  defaultModel?: () => string | undefined;
  onSessionId?: (id: string) => void;
  /** 内联 pi 扩展（每 step 会话生效）。 */
  extensions?: InlineExtension[];
  /** 额外扩展文件路径（此外仍有三层自动发现）。 */
  additionalExtensionPaths?: string[];
}

export function createPiStepRunner(opts: PiStepRunnerOptions = {}): StepRunner {
  let active: SessionLike | null = null;
  let aborting = false;
  return {
    abort() {
      if (!active) return;
      aborting = true;
      active.abort?.();
    },
    async run(spec: StepSpec, onEvent: (e: StepEvent) => void): Promise<StepResult> {
      aborting = false;
      const factory = testFactory ?? defaultFactory;
      const session = await factory({
        cwd: spec.workingDir,
        model: (spec.role && opts.models?.[spec.role]) || opts.defaultModel?.() || opts.model,
        extensions: opts.extensions,
        additionalExtensionPaths: opts.additionalExtensionPaths,
      });
      active = session;
      // 真实 bash 执行记录（机器证据源，契约 4）
      const toolCalls = new Map<string, { command?: string; exitCode?: number; outputTail?: string }>();
      try {
        if (session.id) opts.onSessionId?.(session.id);
        const unsub = session.subscribe((ev) => {
          const e = ev as {
            type?: string;
            toolCallId?: string;
            toolName?: string;
            args?: { command?: string };
            result?: { exitCode?: number; output?: string; outputTail?: string };
            assistantMessageEvent?: {
              type?: string;
              delta?: string;
              toolCall?: { name?: string; arguments?: unknown };
            };
          };
          // 机器证据源（契约 4）：bash 真实执行记录
          if (e.type === "tool_execution_start" && e.toolName === "bash" && e.toolCallId) {
            if (e.args?.command) toolCalls.set(e.toolCallId, { command: e.args.command });
          } else if (e.type === "tool_execution_end" && e.toolName === "bash" && e.toolCallId) {
            const prev = toolCalls.get(e.toolCallId);
            if (prev && e.result && typeof e.result.exitCode === "number") {
              prev.exitCode = e.result.exitCode;
              prev.outputTail = (e.result.outputTail ?? e.result.output ?? "").split("\n").slice(-3).join("\n").slice(0, 200);
            }
          } else if (e.type === "message_update" && e.assistantMessageEvent) {
            const ae = e.assistantMessageEvent;
            if (ae.type === "text_delta" && ae.delta) onEvent({ type: "text", delta: ae.delta });
            else if (ae.type === "thinking_delta" && ae.delta) onEvent({ type: "thinking", delta: ae.delta });
            else if (ae.type === "toolcall_end" && ae.toolCall) {
              onEvent({ type: "tool", name: ae.toolCall.name ?? "tool", detail: toolDetail(ae.toolCall.arguments) });
            }
          }
        });
        let text = "";
        try {
          await session.prompt(composePrompt(spec));
        } catch (e) {
          if (aborting) {
            // 契约 19：用户中断不扣 budget，run 转 stopped 可续跑
            return { ok: false, aborted: true, summary: "用户中断", artifacts: [], evidence: [] };
          }
          throw e;
        } finally {
          unsub();
        }
        text = session.getLastAssistantText();
        for (const q of extractQuestions(text)) onEvent({ type: "question", text: q });
        const parsed = parseResult(text);
        // 契约 4（v1.6）：自报证据与真实执行交叉校验——伪造/无法复核即 fail
        const real: CommandEvidence[] = [...toolCalls.values()]
          .filter((t): t is { command: string; exitCode: number; outputTail?: string } => typeof t.command === "string" && typeof t.exitCode === "number")
          .map((t) => ({ command: t.command, exitCode: t.exitCode, outputTail: t.outputTail ?? "" }));
        const check = crossCheckEvidence(parsed.evidence, real, spec.state);
        if (!check.ok) return { ...parsed, ok: false, summary: `${parsed.summary}｜⚠ ${check.note}` };
        return parsed;
      } finally {
        active = null;
        aborting = false;
        session.dispose();
      }
    },
  };
}

const normCmd = (c: string): string => c.trim().replace(/\s+/g, " ");

/**
 * 证据交叉校验（契约 4，纯函数）：
 * - 自报命令与真实执行（同命令取最近一次）exitCode 不符 → fail（伪造证据）
 * - VERIFY 态自报命令无真实执行对应 → fail（无法机器复核）
 * - 非验证态（调研/设计等）无对应则放行（可能引用早前会话或只读操作）
 */
export function crossCheckEvidence(
  claimed: CommandEvidence[],
  real: CommandEvidence[],
  state: StateId,
): { ok: boolean; note?: string } {
  if (claimed.length === 0) return { ok: true };
  const realByCmd = new Map<string, CommandEvidence>();
  for (const r of real) realByCmd.set(normCmd(r.command), r); // 后写覆盖：同命令取最近一次
  for (const c of claimed) {
    const r = realByCmd.get(normCmd(c.command));
    if (!r) {
      if (state === "VERIFY") return { ok: false, note: `证据无法机器复核（未见真实执行）：${c.command}` };
      continue;
    }
    if (r.exitCode !== c.exitCode) {
      return { ok: false, note: `证据与真实执行不符：${c.command} 自报 exit ${c.exitCode}，实际 ${r.exitCode}` };
    }
  }
  return { ok: true };
}

/** 工具调用人读摘要：bash→命令；read/write/edit→路径；其余取首个字符串字段或 JSON 截断。 */
export function toolDetail(args: unknown): string {
  if (args == null || typeof args !== "object") return String(args ?? "").slice(0, 80);
  const a = args as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "url", "pattern", "query"]) {
    const v = a[key];
    if (typeof v === "string" && v) return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  }
  const s = JSON.stringify(a);
  return s.length > 80 ? `${s.slice(0, 80)}…` : (s ?? "");
}

/** prompt 组装：常驻约束 + 方法论 + 状态任务 + 结构化输出要求。 */
export function composePrompt(spec: StepSpec): string {
  return [
    spec.preamble,
    ...spec.methodology.map((m) => `---\n${m}`),
    `# 当前任务\n${spec.instruction}`,
    [
      "# 输出要求",
      "完成后必须以如下 yaml 代码块结尾（最后一块、三个反引号包裹）：",
      "```yaml",
      "ok: true   # 或 false",
      "summary: 一句话结论",
      'artifacts: ["design.md"]   # 本步产物相对路径，无则 []',
      "evidence:",
      "  - command: npm test",
      "    exitCode: 0",
      "    outputTail: 末尾输出摘录",
      "```",
      "需要向用户提问时，用单独一行并以 ❓ 开头。",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function extractQuestions(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => l.trim().startsWith("❓"))
    .map((l) => l.trim().replace(/^❓\s*/, ""));
}

/** 解析末尾 yaml 结果块（受限子集手写解析，避免引入 yaml 依赖）。 */
export function parseResult(text: string): StepResult {
  const blocks = [...text.matchAll(/```yaml\r?\n([\s\S]*?)```/g)];
  if (blocks.length === 0) {
    return { ok: false, summary: `无法解析结果块：${text.slice(0, 200)}`, artifacts: [], evidence: [] };
  }
  const body = blocks.at(-1)![1];
  const lines = body.split("\n");
  const result: StepResult = { ok: false, summary: "", artifacts: [], evidence: [] };
  let inEvidence = false;
  let cur: { command?: string; exitCode?: number; outputTail?: string } | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const m = (re: RegExp) => line.match(re);
    if (m(/^ok:\s*(\S+)/)) {
      result.ok = m(/^ok:\s*(\S+)/)![1].startsWith("true");
      inEvidence = false;
    } else if (m(/^summary:\s*(.*)$/)) {
      result.summary = m(/^summary:\s*(.*)$/)![1].trim();
      inEvidence = false;
    } else if (m(/^artifacts:\s*\[(.*)\]$/)) {
      result.artifacts = (m(/^artifacts:\s*\[(.*)\]$/)![1].match(/"([^"]*)"/g) ?? []).map((s) => s.slice(1, -1));
      inEvidence = false;
    } else if (m(/^artifacts:\s*$/)) {
      inEvidence = false;
    } else if (m(/^\s*-\s+"?([^"#]*)"?\s*$/) && !inEvidence) {
      result.artifacts.push(m(/^\s*-\s+"?([^"#]*)"?\s*$/)![1].trim());
    } else if (m(/^evidence:\s*$/)) {
      inEvidence = true;
    } else if (inEvidence && m(/^\s*-\s+command:\s*(.*)$/)) {
      if (cur) result.evidence.push(cur as { command: string; exitCode: number; outputTail: string });
      cur = { command: m(/^\s*-\s+command:\s*(.*)$/)![1].trim() };
    } else if (cur && m(/^\s+exitCode:\s*(-?\d+)/)) {
      cur.exitCode = Number(m(/^\s+exitCode:\s*(-?\d+)/)![1]);
    } else if (cur && m(/^\s+outputTail:\s*(.*)$/)) {
      cur.outputTail = m(/^\s+outputTail:\s*(.*)$/)![1].trim();
    }
  }
  if (cur && cur.command) result.evidence.push(cur as { command: string; exitCode: number; outputTail: string });
  if (result.summary === "") result.summary = text.slice(0, 200);
  return result;
}
