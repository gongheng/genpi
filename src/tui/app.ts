// TUI 应用层：直接嵌入 pi 的 InteractiveMode（真 pi TUI：编辑器/footer/主题/模型切换/会话持久化），
// genpi 以编排扩展接入：input 事件接管用户输入（分流：答题 > 门禁 > 新循环 > steering），
// sendMessage 显示进度，ui.select 模态门禁（机器强制），setStatus footer 常显状态机位置。
// headless LoopEngine 与全部契约（worktree 隔离/预算/台账/门禁）原样保留。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { EngineEvent, GateDecision, PathId, StepRunner } from "../types";
import { applyDataRoot } from "../config";
import { bootstrap } from "../engine/bootstrap";
import { routeRequest } from "../router";
import { applyDelta, createStepLiveState, fmtRoute, fmtStepDigest, formatHistoryLines, gateHint, renderGateBlock, renderStepLiveView, renderWelcome } from "./screens";

export const VERSION = "0.1.0";

// ---------- 门禁命令解析（纯函数，测试面） ----------

export type GateCommand = { kind: "approve" } | { kind: "request_changes"; note: string } | { kind: "reject" } | null;

/** 聊天内门禁命令：a/批准/通过 → 批准；c <意见> → 要求修改；r/终止 → 终止。其余返回 null。 */
export function parseGateCommand(input: string): { command: GateCommand; hint?: string } {
  const text = input.trim();
  if (/^(a|批准|通过|approve|yes|ok)$/i.test(text)) return { command: { kind: "approve" } };
  if (/^(r|终止|停止|reject|stop)$/i.test(text)) return { command: { kind: "reject" } };
  const changes = /^(?:c|改|修改)[:：\s]*(.*)$/is.exec(text);
  if (changes) {
    const note = changes[1].trim();
    if (!note) return { command: null, hint: "要求修改请附意见：c <修改意见>" };
    return { command: { kind: "request_changes", note } };
  }
  return { command: null, hint: gateHint() };
}

// ---------- 输入分流（纯函数，测试面） ----------

export type InputPhase = "idle" | "routing" | "run" | "gate" | "awaiting-answer";

/** 决定一段用户输入落到哪里：待答问题 > 门禁命令 > 新循环 > 运行中插话。 */
export function routeUserInput(
  phase: InputPhase,
  currentRunId: string | null,
  input: string,
  hasPendingResume = false,
): {
  target: "answer" | "gate" | "gate-hint" | "start" | "steer" | "resume" | "ignore";
  gateCommand?: GateCommand;
  hint?: string;
} {
  const text = input.trim();
  if (!text) return { target: "ignore" };
  if (phase === "awaiting-answer") return { target: "answer" };
  if (phase === "gate") {
    const { command, hint } = parseGateCommand(text);
    if (!command) return { target: "gate-hint", hint };
    return { target: "gate", gateCommand: command };
  }
  if (phase === "routing") return { target: "ignore", hint: "正在路由，请稍候…" };
  // v1.7：空闲且有未完循环时，「继续」优先于新需求（新需求走 start 自动搁置）
  if (phase === "idle" && !currentRunId && hasPendingResume && /^(继续|continue|resume|续跑)$/i.test(text)) {
    return { target: "resume" };
  }
  if (currentRunId) return { target: "steer" };
  return { target: "start" };
}

// ---------- 运行时桥（genpi 引擎 ↔ pi TUI） ----------

export interface RunTuiOptions {
  projectRoot: string;
  home?: string;
  hasGit?: boolean;
  runner?: StepRunner;
  resumeRunId?: string;
}

export async function runTui(opts: RunTuiOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("genpi 需要交互式终端（TTY）。在管道/CI 环境请用：--demo-run（演示）或 headless 引擎（见 docs/design.md）。");
    return 1;
  }
  const pi = await import("@earendil-works/pi-coding-agent");
  const piSdk = pi; // 别名：genpiExtension 参数 pi(ExtensionAPI) 遮蔽模块导入，渲染器需引模块命名空间（T32）
  const agentDir = applyDataRoot(opts.home ?? homedir());

  // ---- genpi 侧状态（闭包，扩展与引擎共享） ----
  let phase: InputPhase = opts.resumeRunId ? "run" : "idle";
  let currentRunId: string | null = opts.resumeRunId ?? null;
  let currentPath: PathId = "feature";
  let answerResolver: ((a: string) => void) | null = null;
  /** 上次中断的活跃 run（打开时提示，不自动复活；continue 续跑 / 新需求自动搁置，v1.7） */
  let pendingResume: string | null = null;
  let uiRef: ExtensionUIContext | null = null;
  let apiRef: ExtensionAPI | null = null;
  let live = createStepLiveState();
  let widgetTimer: ReturnType<typeof setTimeout> | null = null;
  let streaming = false; // step 流式进行中（escape 归属中断，契约 19）
  let booted = false; // session_start 幂等守卫：pi 启动期可能多次触发（init/信任重绑），欢迎只发一次

  function say(text: string): void {
    // T32：sendMessage 空闲路径双渲染（message_start + entry_appended 都 addMessageToChat，pi 怪癖，
    // 曾致欢迎块成对出现）；改走 appendEntry + 自注册渲染器——单路径渲染，且 custom entry 不入 LLM 上下文
    apiRef?.appendEntry("genpi/progress", { text });
  }
  function status(text: string | undefined): void {
    uiRef?.setStatus("genpi", text);
  }
  function scheduleWidget(): void {
    if (widgetTimer) return; // 合帧：高频 delta 合并为每 80ms 一次重绘
    widgetTimer = setTimeout(() => {
      widgetTimer = null;
      // T33：欢迎浮层与步骤浮层同帧替换——两次结构变化并为一次重排（黑屏闪感源头）
      uiRef?.setWidget("genpi-welcome", undefined);
      uiRef?.setWidget("genpi-stream", renderStepLiveView(live, process.stdout.columns ?? 80));
    }, 80);
  }
  function pushLive(kind: "text" | "thinking", delta: string): void {
    applyDelta(live, kind, delta);
    scheduleWidget();
  }
  function pushTool(name: string, detail: string): void {
    live.tools.push({ name, detail });
    if (live.tools.length > 12) live.tools.shift();
    scheduleWidget();
  }
  function endStreamWidget(): void {
    if (widgetTimer) {
      clearTimeout(widgetTimer);
      widgetTimer = null;
    }
    // T26：叙事不归档入聊天流（widget 看完即走）；步末只落一行摘要（step_finished 事件携带 summary）
    live = createStepLiveState(live.state);
    uiRef?.setWidget("genpi-stream", undefined);
  }

  // ---- headless 引擎（契约不变：worktree/预算/台账/门禁） ----
  /** 交互会话当前模型（/model 切换后更新；步骤会话跟随，见 bootstrap defaultModel） */
  let lastModel: string | undefined;
  const { engine, ledger } = bootstrap({
    projectRoot: opts.projectRoot,
    home: opts.home,
    runner: opts.runner,
    defaultModel: () => lastModel,
    emit: (e: EngineEvent) => void onEvent(e),
    ask: (q) =>
      new Promise<string>((resolve) => {
        endStreamWidget();
        say(`❓ ${q}`);
        phase = "awaiting-answer";
        answerResolver = resolve;
      }),
  });

  // 契约 24/A：最近完成轮（followUp 承接目标）；run_done 时从台账捕获（对 started/resumed 均可靠）
  let lastDone: { runId: string; request: string } | null = null;
  const captureLastDone = (runId: string) =>
    (async () => {
      try {
        const rec = await ledger.readRun(await ledger.runDir(opts.projectRoot, runId));
        lastDone = { runId, request: rec.request };
      } catch {
        /* 台账不可读则不承接 */
      }
    })();

  function onEvent(e: EngineEvent): void {
    switch (e.type) {
      case "state_entered":
        endStreamWidget();
        live = createStepLiveState(e.state);
        streaming = false;
        // T26：状态行不进聊天流——footer(setStatus) 与 widget 标题已实时显示，聊天流只留需要用户在场的节点
        status(`${currentPath} · ${e.state}`);
        break;
      case "step_stream":
        streaming = true;
        pushLive("text", e.delta);
        break;
      case "step_thinking":
        streaming = true;
        pushLive("thinking", e.delta);
        break;
      case "step_tool":
        streaming = true;
        pushTool(e.name, e.detail);
        break;
      case "step_finished":
        streaming = false; // 步末（含问答间隙）不再抢 escape
        if (!e.aborted) say(fmtStepDigest(e.state, e.ok, e.summary)); // T26：一行摘要；aborted 由 run_stopped 报，不双报
        break;
      case "gate_opened":
        endStreamWidget();
        streaming = false;
        handleGate(e.gate, e.artifactPath, e.preview);
        break;
      case "run_done":
        endStreamWidget();
        say(`✔ ${e.summary}`);
        status(undefined);
        void captureLastDone(e.runId); // 契约 24：记最近完成轮，供下一轮 followUp 承接
        currentRunId = null;
        phase = "idle";
        break;
      case "run_stopped":
        endStreamWidget();
        say(`⏹ ${e.reason}（台账已存，可 --resume 续跑）`);
        status(undefined);
        currentRunId = null;
        phase = "idle";
        pendingResume = e.runId; // 中断/耗尽/搁置后回「继续」可续跑（引擎已支持 stopped 恢复，v1.8）
        break;
      default:
        break;
    }
  }

  /** 门禁预览文本（p 命令按需拉取；GATE_MR 用引擎 diff 统计，文件型门禁读头部）。 */
  let gatePreviewText: () => string = () => "（无预览）";
  let gateTaught = false; // 首门禁带 a/c/r/p 教学，此后 1 行化（T26）

  function handleGate(gate: string, artifactPath: string, preview?: string): void {
    phase = "gate";
    status(`${currentPath} · ${gate} · 等待审批`);
    gatePreviewText = () => preview ?? artifactPreview(artifactPath);
    const meta = gateMetaNote(artifactPath);
    // 不倒产物正文（防刷屏）；预览由 p 拉取；首门禁两行含教学，后续一行（T26）
    say(renderGateBlock({ gate, artifact: `${artifactPath}${meta}` }, !gateTaught));
    gateTaught = true;
  }

  /** 审批对象元信息：文件行数（不存在返回空）。 */
  function gateMetaNote(path: string): string {
    if (path.startsWith("MR")) return "";
    try {
      const abs = path.startsWith("/") ? path : join(opts.projectRoot, ".genpi", "runs", path);
      if (existsSync(abs)) return `（${readFileSync(abs, "utf8").split("\n").length} 行）`;
    } catch {
      /* 元信息失败不影响门禁 */
    }
    return "";
  }

  function decide(d: GateDecision): void {
    if (!currentRunId) return;
    phase = "run";
    status(`${currentPath} · 继续…`);
    void engine.decide(currentRunId, d).catch((e) => say(`⚠ ${String(e)}`));
  }

  function artifactPreview(path: string): string {
    try {
      const abs = path.startsWith("/") ? path : join(opts.projectRoot, ".genpi", "runs", path);
      if (existsSync(abs)) {
        const lines = readFileSync(abs, "utf8").split("\n");
        const head = lines.slice(0, 12).join("\n");
        return lines.length > 12 ? `${head}\n…（全文 ${lines.length} 行：${abs}）` : head;
      }
    } catch {
      /* 预览失败不阻塞审批 */
    }
    return `（产物预览不可用，路径：${path}）`;
  }

  async function beginRun(request: string): Promise<{ action: "continue" } | { action: "handled" }> {
    phase = "routing";
    status("路由中…");
    try {
      const route = await routeRequest(request, undefined, { allowCodePaths: opts.hasGit !== false, lastRun: lastDone ?? undefined });
      if (route.path === "chat") {
        status(undefined);
        phase = "idle";
        return { action: "continue" }; // T27：闲聊放行——pi 原生会话直接回答，不建 run 不落产物；不预回显（原生已记录）
      }
      apiRef?.appendEntry("genpi/user", { text: `› ${request}` }); // 路由中状态由 footer 呈现，不再发聊天消息（T33 减重排）
      // v1.7：新需求优先——自动搁置旧活跃 run（台账保留，入口永不阻塞）；chat 不触发搁置
      const active = (await ledger.listRuns(opts.projectRoot)).find((r) => r.status === "active" || r.status === "gate");
      if (active) {
        await engine.stop(active.id, "新需求优先，自动搁置");
        pendingResume = null;
      }
      currentPath = route.path;
      say(fmtRoute(route.path, route.reason, route.by, { tier: route.tier, waive: route.waive, title: route.title, followUp: route.followUp }));
      // runId 创建即注入、提前进入 run 相位：初始 drive（CLARIFY/DESIGN…）期间 escape/steering 即可用；
      // await 返回时 run 已停到 gate/done/stopped——phase/currentRunId 以事件为准，不回头覆盖（曾致输入黑洞）；
      // v1.9：tier/CLARIFY 豁免随路由结果透传引擎（契约 20/21）
      phase = "run";
      await engine.start(currentPath, route.text, (id) => {
        currentRunId = id;
      }, { tier: route.tier, waiveClarify: route.waive, waiveReason: route.reason, title: route.title, parentRunId: route.followUp && lastDone ? lastDone.runId : undefined, routeBy: route.by, routeReason: route.reason });
    } catch (e) {
      say(`⚠ ${String(e)}`);
      currentRunId = null;
      phase = "idle";
      status(undefined);
    }
    return { action: "handled" };
  }

  async function resumeRun(runId: string): Promise<void> {
    pendingResume = null;
    say(`恢复运行 ${runId}…`);
    currentRunId = runId;
    phase = "run";
    try {
      await engine.resume(runId);
    } catch (e) {
      say(`⚠ ${String(e)}`);
      currentRunId = null;
      phase = "idle";
    }
  }

  // ---- genpi 编排扩展（inline factory，随 pi 会话装载） ----
  const genpiExtension = (pi: ExtensionAPI): void => {
    apiRef = pi;
    // T32 渲染通道：custom entry 无 renderer 不显示（addCustomEntryToChat 直接 return）——注册渲染器
    // 用 CustomMessageComponent（与原 custom message 同组件，视觉一致），仅 entry_appended 单路径渲染
    const asText = (data: unknown): string => String((data as { text?: string } | undefined)?.text ?? "");
    pi.registerEntryRenderer("genpi/progress", (entry) =>
      new piSdk.CustomMessageComponent({ role: "custom", customType: "genpi/progress", content: asText(entry.data), display: true, timestamp: Date.parse(entry.timestamp) || Date.now() }),
    );
    pi.registerEntryRenderer("genpi/user", (entry) =>
      new piSdk.CustomMessageComponent({ role: "custom", customType: "genpi/user", content: asText(entry.data), display: true, timestamp: Date.parse(entry.timestamp) || Date.now() }),
    );
    // /genpi-stop：废弃当前 run（台账保留，可 --resume）——卡死时的 TUI 内出口（契约 19）
    pi.registerCommand("genpi-stop", {
      description: "废弃当前 run（台账保留，可 --resume 续跑）",
      handler: async () => {
        // 台账兜底：resume 失败等场景 currentRunId 可能为空但台账仍有活跃 run（修复死锁）
        let runId: string | null | undefined = currentRunId;
        if (!runId) {
          const active = (await ledger.listRuns(opts.projectRoot)).find((r) => r.status === "active" || r.status === "gate");
          runId = active?.id;
        }
        if (!runId) {
          uiRef?.notify("当前没有活跃 run", "info");
          return;
        }
        if (answerResolver) {
          answerResolver("（用户已废弃 run，请停止当前步骤）");
          answerResolver = null;
        }
        await engine.stop(runId);
      },
    });
    pi.on("session_start", (_event, ctx) => {
      uiRef = ctx.ui;
      if (ctx.model) lastModel = `${ctx.model.provider}/${ctx.model.id}`; // 步骤会话跟随 /model 切换
      // escape 中断当前 step（契约 19）：仅在 step 流式进行时接管，避免抢编辑器的 Esc 语义
      ctx.ui.onTerminalInput((data) => {
        if (data === "\x1b" && streaming && currentRunId && phase === "run") {
          streaming = false;
          engine.abort();
          say("⏹ 中断当前步骤…（run 保留，可继续或 /genpi-stop 废弃）");
          return { consume: true };
        }
        return undefined;
      });
      // 幂等守卫：pi 启动期 bindExtensions 可能多次触发 session_start（init 直发 + 信任授予/重载
      // 经 setRebindSession 再发），曾致欢迎块逐次叠加重复——uiRef/onTerminalInput/模型跟随每次都要
      // 刷新，但欢迎与续跑提示整个进程只发一次（/new /resume 切会话同理不重发，状态与 session 无关）
      if (booted) return;
      booted = true;
      void (async () => {
        try {
          const runs = await ledger.listRuns(opts.projectRoot);
          if (opts.resumeRunId) {
            await resumeRun(opts.resumeRunId); // 显式 --resume 才直接续跑
            return;
          }
          // v1.7：打开不再自动复活旧 run——只提示，用户主导（continue 续跑 / 新需求自动搁置旧的）；v1.8：stopped（中断/搁置/耗尽）同样可续跑
          const resumable = runs.filter((r) => r.status === "active" || r.status === "gate" || r.status === "stopped").at(-1);
          pendingResume = resumable?.id ?? null;
          // T32 根治：欢迎/续跑提示改走 widget——聊天容器的启动期消息会被 pi 双添加
          // （entry_appended 实时路径 + renderInitialMessages 追加式重画，不清空容器）；
          // widget 按键替换天然单份，且欢迎语仅空闲时相关，开跑/首输入即隐
          const welcomeLines = renderWelcome().split("\n");
          if (resumable) {
            welcomeLines.push("", `⏸ 有未完成循环「${resumable.title ?? resumable.id}」（${resumable.id}）`, "回「继续」续跑 · /genpi-stop 放弃 · 直接输入新需求将自动搁置它（台账保留）");
          }
          uiRef?.setWidget("genpi-welcome", welcomeLines);
        } catch {
          uiRef?.setWidget("genpi-welcome", renderWelcome().split("\n"));
        }
      })();
    });
    pi.on("input", (event, ctx) => {
      uiRef = ctx.ui;
      if (ctx.model) lastModel = `${ctx.model.provider}/${ctx.model.id}`;
      const text = event.text.trim();
      if (!text) return { action: "continue" };
      const echoUser = () => pi.appendEntry("genpi/user", { text: `› ${text}` });
      // /genpi log [n]：查看当前/最近 run 的转移史尾部（T30 观测性；目标=当前 run→最近完成轮→台账最新）
      const logm = /^\/genpi\s+log(\s+(\d+))?$/i.exec(text);
      if (logm) {
        echoUser();
        const n = Number(logm[2] ?? 15);
        void (async () => {
          try {
            const target = currentRunId ?? lastDone?.runId ?? (await ledger.listRuns(opts.projectRoot)).at(-1)?.id;
            if (!target) {
              say("（还没有任何 run）");
              return;
            }
            const dir = await ledger.runDir(opts.projectRoot, target);
            const raw = readFileSync(join(dir, "phase-history.jsonl"), "utf8").split("\n").filter(Boolean);
            say(`📋 ${target} 最近转移：\n${formatHistoryLines(raw, n)}`);
          } catch {
            say("（历史不可读：run 可能已清理）");
          }
        })();
        return { action: "handled" };
      }
      // 门禁期预览命令：p 拉取审批对象内容（按需，不默认刷屏）
      if (phase === "gate" && /^(p|预览|preview)$/i.test(text)) {
        echoUser();
        say(gatePreviewText());
        return { action: "handled" };
      }
      const r = routeUserInput(phase, currentRunId, text, pendingResume !== null);
      // T27：start 路由先行——chat 放行时不回显（pi 原生已记录用户消息），工作路径由 beginRun 内回显
      if (r.target === "start") return beginRun(text);
      echoUser();
      switch (r.target) {
        case "answer":
          phase = currentRunId ? "run" : "idle";
          answerResolver?.(text);
          answerResolver = null;
          break;
        case "gate": {
          const cmd = r.gateCommand;
          if (!cmd) break;
          let d: GateDecision;
          if (cmd.kind === "approve") d = { kind: "approve" };
          else if (cmd.kind === "reject") d = { kind: "reject" };
          else d = { kind: "request_changes", note: cmd.note };
          decide(d);
          break;
        }
        case "gate-hint":
          ctx.ui.notify(r.hint ?? gateHint(), "info");
          break;
        case "resume":
          if (pendingResume) {
            const id = pendingResume;
            pendingResume = null;
            void resumeRun(id);
          } else {
            ctx.ui.notify("没有可恢复的循环", "info");
          }
          break;
        case "steer":
          if (currentRunId) engine.steer(currentRunId, text);
          break;
        case "ignore":
          if (r.hint) ctx.ui.notify(r.hint, "info");
          break;
      }
      return { action: "handled" }; // genpi 接管输入：pi 会话不自行启动 agent 轮
    });
  };

  // ---- 装配 pi 会话与 InteractiveMode ----
  const createRuntime: import("@earendil-works/pi-coding-agent").CreateAgentSessionRuntimeFactory = async ({
    cwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await pi.createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: { extensionFactories: [genpiExtension] },
    });
    return {
      ...(await pi.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await pi.createAgentSessionRuntime(createRuntime, {
    cwd: opts.projectRoot,
    agentDir,
    sessionManager: pi.SessionManager.create(opts.projectRoot, join(agentDir, "sessions")),
  });
  const mode = new pi.InteractiveMode(runtime, {});
  await mode.run();
  await runtime.dispose();
  return 0;
}

// ---------- 演示模式（非 TTY 安全，CI 可验收） ----------

export async function runDemoMode(): Promise<number> {
  const frames = [
    renderWelcome(),
    `› 加定时发布\n\n${fmtRoute("feature", "模型判断", "model")}`,
    "❓ 定时到点自动上线？\n\n› 是，到点自动 visible",
    "▸ IMPLEMENT\n[IMPLEMENT] T1 schema 迁移 ✓\n[IMPLEMENT] T2 定时任务 ✓",
    renderGateBlock({ gate: "GATE_DESIGN", artifact: "design.md（23 行）" }),
    "› p\n\n# 设计\nscheduled_at timestamptz，到点自动 visible\n…（全文 23 行）",
    renderGateBlock({ gate: "GATE_MR", artifact: "MR 变更摘要" }),
    "› p\n\n提交：\n- feat: 定时发布\n\n变更统计：\n src/schema.sql | 2 +\n api/publish.ts | 42 ++++++++--",
    "✔ 定时发布已交付（MR #12）",
  ];
  for (const f of frames) {
    console.log(`${f}\n`);
    await new Promise((r) => setTimeout(r, 60));
  }
  console.log("✔ demo 完成");
  return 0;
}
