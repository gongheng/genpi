// StepRunner——pi SDK 唯一适配点（public-API-only）：StepSpec → AgentSession → 事件流/StepResult
// 扩展透传（契约 17）：内联 extensionFactories + additionalExtensionPaths + pi 三层自动发现
// 契约 4（v1.6）：bash 真实执行记录（tool_execution_* 事件）与模型自报 evidence 交叉校验，伪造即 fail
// T38：A1 验收命令强制（复合运算符审计 + pinned 覆盖）/ A2 产物存在性校验 / D6 token 用量聚合
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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

/** T38/F8：把 "prov/model-id" 解析为 Model 对象（失败/缺省返回 undefined，回落全局默认）——路由小模型复用 StepRunner 的 ModelRuntime 缓存 */
export async function resolveCliModelSafe(model?: string): Promise<unknown | undefined> {
  if (!model) return undefined;
  try {
    const pi = await loadPi();
    const rt = await getModelRuntime(pi, pi.getAgentDir());
    const resolved = pi.resolveCliModel({ cliModel: model, modelRuntime: rt as never });
    return resolved.model ?? undefined;
  } catch {
    return undefined; // 解析失败回落全局默认（与真实工厂同策略）
  }
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

/**
 * P2/#3：services（含资源装载三层扩展发现/设置读盘）按 key 缓存——Promise 级去重（同 key 并发只建一次，
 * 长 run 的多 step 冷启动只付首次）；失败驱逐不缓存，下次重试。会话仍每 step 新建（上下文隔离不变）。
 */
export function cachedServices<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit;
  const p = create().catch((e: unknown) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, p);
  return p;
}

function buildSessionFactory(): SessionFactory {
  // 每 factory 实例独立缓存（createPiStepRunner 每 runner 建一个）：不同 bootstrap 的内联扩展集不共享 services（防扩展污染）
  const servicesCache = new Map<string, Promise<unknown>>();
  return async (opts) => {
  // services 化：modelRuntime 可按角色解析 Model 对象（契约 16）；会话仍持久（genpi 数据根）供审计
  // T39：codemode 工具（沙箱脚本，嵌套工具调用不进上下文）——SDK 会话默认连注册都没有（builtin 装载是
  // CLI 路径待遇，defaultActive:false）；genpi 显式装载+激活：IMPLEMENT/DEBUG 批量机械操作省 token 降 compaction。
  // 零新依赖：createCodemodeExtension 从已依赖的包根导出；嵌套调用走同一工具管道，tool_execution_* 事件
  // 照发（实测形状见 step-runner 测试⑮）——契约 4 证据交叉校验与恒真式审计对脚本内命令同样生效。
  const pi = await loadPi();
  const cacheKey = `${opts.cwd}::${(opts.additionalExtensionPaths ?? []).join(",")}::${opts.extensions?.length ?? 0}`;
  const services = (await cachedServices(servicesCache, cacheKey, async () =>
    pi.createAgentSessionServices({
      cwd: opts.cwd,
      agentDir: pi.getAgentDir(),
      modelRuntime: (await getModelRuntime(pi, pi.getAgentDir())) as never, // 缓存：每 step 不再冷启动读盘
      resourceLoaderOptions: {
        extensionFactories: [pi.createCodemodeExtension(), ...(opts.extensions ?? [])],
        ...(opts.additionalExtensionPaths?.length ? { additionalExtensionPaths: opts.additionalExtensionPaths } : {}),
      },
    }),
  )) as Awaited<ReturnType<typeof pi.createAgentSessionServices>>;
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
  // T39：注册是 defaultActive:false——显式激活（增量，不动其余工具集）
  session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
  // SAFETY: SDK AgentSession 结构满足 SessionLike（prompt/subscribe/getLastAssistantText/dispose/abort），
  // 历史验证于 step-runner 测试——双 cast 仅抹平 SDK 类型参数差异，运行时形状一致。
  return session as unknown as SessionLike;
  };
}

// 真实工厂由 createPiStepRunner 每 runner 实例化（services 缓存随 runner 生命周期，不跨 runner 共享）

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
  const ownFactory = buildSessionFactory(); // 每 runner 独立：services 缓存随 runner 生命周期，不跨 runner 共享（自审修正）
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
      const factory = testFactory ?? ownFactory;
      const session = await factory({
        cwd: spec.workingDir,
        model: (spec.role && opts.models?.[spec.role]) || opts.defaultModel?.() || opts.model,
        extensions: opts.extensions,
        additionalExtensionPaths: opts.additionalExtensionPaths,
      });
      active = session;
      // 真实 bash 执行记录（机器证据源，契约 4）+ token 用量聚合（T38/D6：message_end.assistant.usage）
      const toolCalls = new Map<string, { command?: string; exitCode?: number; outputTail?: string }>();
      let usageIn = 0;
      let usageOut = 0;
      try {
        if (session.id) opts.onSessionId?.(session.id);
        const unsub = session.subscribe((ev) => {
          const e = ev as {
            type?: string;
            toolCallId?: string;
            toolName?: string;
            args?: { command?: string };
            result?: { exitCode?: number; output?: string; outputTail?: string; structuredContent?: { exit_code?: number; output?: string } };
            assistantMessageEvent?: {
              type?: string;
              delta?: string;
              toolCall?: { name?: string; arguments?: unknown };
            };
          };
          // 机器证据源（契约 4）：bash 真实执行记录（含 codemode 嵌套调用——同管道同事件形状，带 parentToolCallId）
          if (e.type === "tool_execution_start" && e.toolName === "bash" && e.toolCallId) {
            if (e.args?.command) toolCalls.set(e.toolCallId, { command: e.args.command });
          } else if (e.type === "tool_execution_end" && e.toolName === "bash" && e.toolCallId) {
            const prev = toolCalls.get(e.toolCallId);
            if (prev) {
              const { exitCode, output } = bashExecResult(e.result); // P1/#1：真实形状在 structuredContent.exit_code
              if (typeof exitCode === "number") {
                prev.exitCode = exitCode;
                prev.outputTail = (output ?? "").split("\n").slice(-3).join("\n").slice(0, 200);
              }
            }
          } else if (e.type === "message_update" && e.assistantMessageEvent) {
            const ae = e.assistantMessageEvent;
            if (ae.type === "text_delta" && ae.delta) onEvent({ type: "text", delta: ae.delta });
            else if (ae.type === "thinking_delta" && ae.delta) onEvent({ type: "thinking", delta: ae.delta });
            else if (ae.type === "toolcall_end" && ae.toolCall) {
              onEvent({ type: "tool", name: ae.toolCall.name ?? "tool", detail: toolDetail(ae.toolCall.arguments) });
            }
          } else if (e.type === "message_end") {
            const msg = (e as { message?: { role?: string; usage?: { input?: number; output?: number } } }).message;
            if (msg?.role === "assistant" && msg.usage) {
              usageIn += msg.usage.input ?? 0;
              usageOut += msg.usage.output ?? 0;
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
        const usage = usageIn + usageOut > 0 ? { input: usageIn, output: usageOut } : undefined;
        // T38/A2：自报产物存在性机器校验（两阶段 done 产物侧）——缺失即 fail，不进门禁
        const artCheck = checkArtifacts(parsed.artifacts, spec.artifactRoots ?? [spec.workingDir]);
        if (!artCheck.ok) return { ...parsed, ok: false, summary: `${parsed.summary}｜⚠ ${artCheck.note}`, ...(usage ? { usage } : {}) };
        // 契约 4（v1.6）+ T38/A1：自报证据与真实执行交叉校验（含复合运算符审计与 pinned 验收覆盖）
        const real: CommandEvidence[] = [...toolCalls.values()]
          .filter((t): t is { command: string; exitCode: number; outputTail?: string } => typeof t.command === "string" && typeof t.exitCode === "number")
          .map((t) => ({ command: t.command, exitCode: t.exitCode, outputTail: t.outputTail ?? "" }));
        const check = crossCheckEvidence(parsed.evidence, real, spec.state, spec.verifyCommands);
        if (!check.ok) return { ...parsed, ok: false, summary: `${parsed.summary}｜⚠ ${check.note}`, ...(usage ? { usage } : {}) };
        return { ...parsed, ...(usage ? { usage } : {}) };
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
 * 从 tool_execution_end.result 提取 bash 的 exitCode/output（真实 SDK 形状钉子，P1/#1）：
 * 实测（含 codemode 嵌套调用，同经 runToolCall 管道）exitCode 在 result.structuredContent.exit_code
 * （snake_case），不在顶层——旧代码读 e.result.exitCode 恒 undefined，真实证据从未被采集（mock 同形未繁觉）。
 * 兼容旧顶层字段（exitCode/output/outputTail）以防 SDK 形状演进。
 */
export function bashExecResult(result: unknown): { exitCode?: number; output?: string } {
  const r = result as
    | { exitCode?: number; output?: string; outputTail?: string; structuredContent?: { exit_code?: number; output?: string } }
    | undefined;
  if (!r) return {};
  const sc = r.structuredContent;
  let exitCode: number | undefined;
  if (typeof r.exitCode === "number") exitCode = r.exitCode;
  else if (typeof sc?.exit_code === "number") exitCode = sc.exit_code;
  let output: string | undefined;
  if (typeof sc?.output === "string") output = sc.output;
  else if (typeof r.output === "string") output = r.output;
  else if (typeof r.outputTail === "string") output = r.outputTail;
  const out: { exitCode?: number; output?: string } = {};
  if (exitCode !== undefined) out.exitCode = exitCode;
  if (output !== undefined) out.output = output;
  return out;
}

/**
 * 恒真式/平凡命令审计（T38/A1① + 证据强制 II，纯函数）：能抹掉真实退出码的命令一律拒绝。
 * 拒绝：`||`、`;`、`|`（无 pipefail 时取末命令退出码）、`$(...)`、反引号、行首 `!` 取反、末尾单 `&` 后台、
 * 平凡命令（`true`/`:`/`pwd`/`exit 0`/`echo …`——恒 exit 0，验收语义为空）。
 * 放行：`&&`（全成功才 0，不掩错）、重定向（不改退出码）、`2>&1`（& 后非空白）、
 * 管道带 `set -o pipefail && ` 前缀（退出码取最右非零，长输出截断如 `… | tail` 不再被一刀切）。
 */
export function masksExitCode(cmd: string): boolean {
  const c = cmd.trim();
  if (c.startsWith("!")) return true;
  if (/[\n;]/.test(c)) return true;
  if (c.includes("$(") || c.includes("`")) return true;
  if (/(^|[^&])&(?=\s|$)/.test(c)) return true;
  if (c.includes("|")) {
    if (c.includes("||")) return true;
    return !/^set -o pipefail && /.test(c); // 管道仅 pipefail 前缀放行
  }
  if (/^(true|:|pwd|exit( 0)?)$/i.test(c)) return true; // 平凡命令：恒 exit 0，验收语义为空
  if (/^echo(\s|$)/i.test(c)) return true;
  return false;
}

/**
 * 产物存在性校验（T38/A2 + 非空补强，纯函数）：自报 artifacts 逐个在解析根（绝对路径直接查）下
 * 存在且非空，缺失/空文件即 fail——空 design.md 多为写入失败残留，不该进门禁。
 */
export function checkArtifacts(artifacts: string[], roots: string[]): { ok: boolean; note?: string } {
  const missing: string[] = [];
  const present = (p: string): boolean => {
    try {
      return existsSync(p) && statSync(p).size > 0;
    } catch {
      return false;
    }
  };
  for (const a of artifacts) {
    const hit = isAbsolute(a) ? present(a) : roots.some((r) => present(join(r, a)));
    if (!hit) missing.push(a);
  }
  if (missing.length === 0) return { ok: true };
  const shown = missing.slice(0, 3).join("、");
  return { ok: false, note: `自报产物不存在或为空（两阶段 done 产物侧校验）：${shown}${missing.length > 3 ? ` 等 ${missing.length} 项` : ""}` };
}

/**
 * 证据交叉校验（契约 4，纯函数）：
 * - 自报命令与真实执行（同命令取最近一次）exitCode 不符 → fail（伪造证据）
 * - VERIFY 态自报命令含恒真式构造 → fail（T38/A1①：`npm test || true` 骗过交叉校验的洞）
 * - VERIFY 态固定验收命令（pinned，来自 tasks.md）必须被自报且真实执行 exit 0 → 否则 fail（T38/A1②）
 * - VERIFY 态自报命令无真实执行对应 → fail（无法机器复核）
 * - 非验证态（调研/设计等）无对应则放行（可能引用早前会话或只读操作）
 */
export function crossCheckEvidence(
  claimed: CommandEvidence[],
  real: CommandEvidence[],
  state: StateId,
  pinned?: string[],
): { ok: boolean; note?: string } {
  if (claimed.length === 0 && !(state === "VERIFY" && pinned?.length)) return { ok: true };
  const realByCmd = new Map<string, CommandEvidence>();
  for (const r of real) realByCmd.set(normCmd(r.command), r); // 后写覆盖：同命令取最近一次
  if (state === "VERIFY") {
    for (const c of claimed) {
      if (masksExitCode(c.command)) return { ok: false, note: `验证命令含恒真式构造（拒绝）：${c.command}` };
    }
    // P3/#5：格式完整性先行——缺 exitCode 直接报格式问题（模型结果块残缺），
    // 而非误导性的「证据与真实执行不符」（NaN/undefined 比较永不相等的下游症状）
    for (const c of claimed) {
      if (typeof (c as { exitCode?: number }).exitCode !== "number") {
        return { ok: false, note: `自报证据缺 exitCode 字段（结果块格式不完整）：${c.command}` };
      }
    }
    for (const p of pinned ?? []) {
      const r = realByCmd.get(normCmd(p));
      if (!r) return { ok: false, note: `固定验收命令未真实执行：${p}` };
      if (r.exitCode !== 0) return { ok: false, note: `固定验收命令未通过（exit ${r.exitCode}）：${p}` };
    }
  }
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

/** 列表行（T40）：❓ 引导句后的模板/选项体——checkbox/无序/有序列表项。 */
const LIST_LINE = /^\s*(?:[-*+]\s|\d+[.)]\s|\[[ xX]\])/;

/**
 * 提取问题块（T40 块修复）：❓ 行 + 紧随的列表行为同一问题（多行体）。
 * 背景：模型常把「勾选模板」写在 ❓ 引导句下方（多行 checkbox 列表）；旧版只取 ❓ 行，
 * 模板本体丢失——加上 T26 叙事不归档与 ask() 的 endStreamWidget，用户只看到孤零引导句，
 * 无从作答。规则：吸收紧跟 ❓ 的列表行；允许空行分隔的松散列表（空行后仍是列表项则继续）；
 * 非问题区的普通列表不受影响（吸收仅从 ❓ 行开始）。
 */
export function extractQuestions(text: string): string[] {
  const lines = text.split("\n");
  const qs: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim().startsWith("❓")) {
      i++;
      continue;
    }
    const block = [line.trim().replace(/^❓\s*/, "")];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j]!;
      if (LIST_LINE.test(l)) {
        block.push(l.trim());
        j++;
        continue;
      }
      if (l.trim() === "" && LIST_LINE.test(lines[j + 1] ?? "")) {
        j++; // 松散列表：空行分隔的列表项继续吸收
        continue;
      }
      break;
    }
    qs.push(block.join("\n"));
    i = j;
  }
  return qs;
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
