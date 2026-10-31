import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFsLedger } from "../src/engine/ledger";
import { GenpiActiveRunError, LoopEngine, type EngineDeps, type GitOps, type ResourceProvider } from "../src/engine/loop-engine";
import { PATHS } from "../src/engine/paths";
import type { ResolvedConfig } from "../src/config";
import type { CommandEvidence, EngineEvent, StepEvent, StepResult, StepRunner, StepSpec } from "../src/types";

const dirs: string[] = [];
function mkProject(): string {
  const d = join(tmpdir(), `genpi-t3-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

const ok = (artifacts: string[] = [], evidence: CommandEvidence[] = []): StepResult => ({ ok: true, summary: "完成", artifacts, evidence });
const fail: StepResult = { ok: false, summary: "失败", artifacts: [], evidence: [] };

class FakeRunner implements StepRunner {
  calls: StepSpec[] = [];
  extra: StepEvent[] = []; // 测试注入：thinking/tool 等额外事件
  private idx = new Map<string, number>();
  constructor(public handler: (spec: StepSpec, n: number) => { questions?: string[]; result: StepResult }) {}
  async run(spec: StepSpec, onEvent: (e: StepEvent) => void): Promise<StepResult> {
    this.calls.push(spec);
    const n = (this.idx.get(spec.state) ?? 0) + 1;
    this.idx.set(spec.state, n);
    const { questions = [], result } = this.handler(spec, n);
    for (const q of questions) onEvent({ type: "question", text: q });
    onEvent({ type: "text", delta: `[${spec.state}] working` });
    for (const e of this.extra) onEvent(e);
    return result;
  }
}

function makeWorld(handler: FakeRunner["handler"], request = "加定时发布") {
  const projectRoot = mkProject();
  const events: EngineEvent[] = [];
  const asked: string[] = [];
  const config: ResolvedConfig = {
    agentDir: "/tmp/genpi-home",
    mrTarget: "github",
    branchPrefix: "feature/",
    worktreeDir: ".worktrees/",
    budget: 3,
    models: {},
  };
  const resources: ResourceProvider = { byState: (s) => [`方法论:${s}`], preamble: () => "常驻约束" };
  const git: GitOps = {
    async ensureWorktree(root, runId) {
      return { path: join(root, ".worktrees", runId), baseSha: "f".repeat(40) };
    },
    async mrPreview() {
      return "提交：\n- fake: 改动\n\n变更统计：\n a.txt | 1 +";
    },
    async pushAndMr() {
      return { mode: "manual", url: "https://example.com/compare/branch" };
    },
  };
  const deps: EngineDeps = {
    runner: new FakeRunner(handler),
    ledger: createFsLedger(),
    resources,
    git,
    config,
    projectRoot,
    emit: (e) => events.push(e),
    ask: async (q) => {
      asked.push(q);
      return "好的";
    },
  };
  return { projectRoot, request, events, asked, deps, runner: deps.runner as FakeRunner };
}

describe("LoopEngine", () => {
  it("① feature 全转移：问答→双 GATE 批准→DONE，转移序与路径表一致", async () => {
    const w = makeWorld((spec, n) => {
      if (spec.state === "CLARIFY" && n === 1) return { questions: ["发布时区按什么算？"], result: ok() };
      if (spec.state === "VERIFY") return { result: ok([], [{ command: "npm test", exitCode: 0, outputTail: "3 passed" }]) };
      return { result: ok() };
    });
    const engine = new LoopEngine(w.deps);
    const runId = await engine.start("feature", w.request);

    expect(w.events.at(-1)?.type).toBe("gate_opened");
    await engine.decide(runId, { kind: "approve" });
    expect(w.events.filter((e) => e.type === "gate_opened").map((e) => (e as { gate: string }).gate)).toEqual(["GATE_DESIGN", "GATE_MR"]);
    await engine.decide(runId, { kind: "approve" });
    expect(w.events.at(-1)).toMatchObject({ type: "run_done" });

    const entered = w.events.filter((e) => e.type === "state_entered").map((e) => (e as { state: string }).state);
    expect(entered).toEqual(PATHS.feature.states.filter((s) => s !== "DONE"));

    // 内联问答进入下一轮指令；VERIFY 证据落台账
    expect(w.asked).toEqual(["发布时区按什么算？"]);
    const clarify2 = w.runner.calls.filter((c) => c.state === "CLARIFY")[1];
    expect(clarify2.instruction).toContain("A:好的");
    const history = readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "phase-history.jsonl"), "utf8");
    expect(history).toContain('"command":"npm test"');
    const run = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "run.json"), "utf8"));
    expect(run.status).toBe("done");
    // T26：step_finished 携带摘要（聊天流一行化数据源）；全部非 aborted
    const fins = w.events.filter((e) => e.type === "step_finished") as { ok: boolean; summary?: string; aborted?: boolean }[];
    expect(fins.length).toBeGreaterThanOrEqual(5);
    expect(fins.every((f) => !f.aborted && f.summary === "完成")).toBe(true); // FakeRunner ok() 摘要全为「完成」
  });

  it("② GATE 死等：无 decide() 不得转移（契约 3）", async () => {
    const w = makeWorld(() => ({ result: ok() }));
    const engine = new LoopEngine(w.deps);
    const runId = await engine.start("feature", w.request);
    const len = w.events.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(w.events.length).toBe(len); // 无新事件
    const run = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "run.json"), "utf8"));
    expect(run.status).toBe("gate");
    expect(run.currentState).toBe("GATE_DESIGN");
  });

  it("③ fail budget：FIX 连败 3 次 → STOP，不无限重试（契约 6）", async () => {
    const w = makeWorld((spec) => (spec.state === "FIX" ? { result: fail } : { result: ok() }));
    const engine = new LoopEngine(w.deps);
    const runId = await engine.start("bugfix", "列表不刷新");
    const stopped = w.events.find((e) => e.type === "run_stopped");
    expect(stopped).toMatchObject({ reason: expect.stringContaining("FIX") });
    const budgets = w.events.filter((e) => e.type === "budget_changed").map((e) => (e as { remaining: number }).remaining);
    expect(budgets).toEqual([2, 1, 0]);
    expect(w.runner.calls.filter((c) => c.state === "FIX")).toHaveLength(3);
    const run = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "run.json"), "utf8"));
    expect(run.status).toBe("stopped");
  });

  it("④ request_changes 回退不扣 budget，携 note 落台账", async () => {
    const w = makeWorld(() => ({ result: ok() }));
    const engine = new LoopEngine(w.deps);
    const runId = await engine.start("feature", w.request);
    await engine.decide(runId, { kind: "request_changes", note: "补时区说明" });
    // 回 DESIGN 重跑 → 再次到 GATE_DESIGN
    expect(w.events.filter((e) => e.type === "gate_opened")).toHaveLength(2);
    await engine.decide(runId, { kind: "approve" });
    await engine.decide(runId, { kind: "approve" });
    const run = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "run.json"), "utf8"));
    expect(run.status).toBe("done");
    expect(run.budget.DESIGN).toBeUndefined(); // 从未扣减
    const history = readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "phase-history.jsonl"), "utf8");
    expect(history).toContain("gate_request_changes");
    expect(history).toContain("补时区说明");
  });

  it("⑤ resume：新引擎实例从台账恢复 GATE 并可走完（契约 7）", async () => {
    const w = makeWorld(() => ({ result: ok() }));
    const e1 = new LoopEngine(w.deps);
    const runId = await e1.start("feature", w.request);
    // 模拟进程重启：新实例、同一持久依赖
    const events2: EngineEvent[] = [];
    const deps2 = { ...w.deps, emit: (e: EngineEvent) => events2.push(e) };
    const e2 = new LoopEngine(deps2);
    await e2.resume(runId);
    expect(events2[0]).toMatchObject({ type: "gate_opened", gate: "GATE_DESIGN" });
    await e2.decide(runId, { kind: "approve" });
    await e2.decide(runId, { kind: "approve" });
    expect(events2.at(-1)).toMatchObject({ type: "run_done" });
  });

  it("⑥ 单活跃 run：GATE 挂起时再 start 抛错（契约 15）", async () => {
    const w = makeWorld(() => ({ result: ok() }));
    const engine = new LoopEngine(w.deps);
    await engine.start("feature", w.request);
    await expect(engine.start("bugfix", "另一个")).rejects.toBeInstanceOf(GenpiActiveRunError);
  });
});

describe("IMPLEMENT 逐任务循环", () => {
  it("⑦ 解析 tasks.md 逐任务执行并勾选（设计 §2.2）", async () => {
    const w = makeWorld((spec, _n) => {
      if (spec.state === "PLAN") {
        const runDir = /# 运行目录: (\S+)/.exec(spec.instruction)?.[1] ?? "";
        writeFileSync(join(runDir, "tasks.md"), "# 任务\n- [ ] T1 加字段\n- [ ] T2 定时任务\n");
        return { result: ok(["tasks.md"]) };
      }
      if (spec.state === "IMPLEMENT") {
        implementCalls.push(spec.instruction);
        return { result: ok([]) };
      }
      return { result: ok() };
    });
    const implementCalls: string[] = [];
    const engine = new LoopEngine(w.deps);
    const runId = await engine.start("feature", "定时发布");
    await engine.decide(runId, { kind: "approve" });
    await engine.decide(runId, { kind: "approve" });
    const runDir = join(w.projectRoot, ".genpi", "runs", runId);
    expect(implementCalls).toHaveLength(2);
    expect(implementCalls[0]).toContain("# 本任务");
    expect(implementCalls[0]).toContain("T1 加字段");
    expect(implementCalls[1]).toContain("T2 定时任务");
    expect(readFileSync(join(runDir, "tasks.md"), "utf8")).not.toContain("[ ]");
    const history = readFileSync(join(runDir, "phase-history.jsonl"), "utf8");
    expect(history.match(/task_done/g)?.length).toBe(2);
    expect(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).status).toBe("done");
  });

  it("⑧ 单任务失败即停，勾选不推进，budget 扣减", async () => {
    const w = makeWorld((spec, _n) => {
      if (spec.state === "PLAN") {
        const runDir = /# 运行目录: (\S+)/.exec(spec.instruction)?.[1] ?? "";
        writeFileSync(join(runDir, "tasks.md"), "# 任务\n- [ ] T1 必败\n- [ ] T2 不该跑\n");
        return { result: ok(["tasks.md"]) };
      }
      if (spec.state === "IMPLEMENT") return { result: fail };
      return { result: ok() };
    });
    const engine = new LoopEngine(w.deps);
    const runId = await engine.start("feature", "x");
    await engine.decide(runId, { kind: "approve" }); // 过 GATE_DESIGN 才到 PLAN/IMPLEMENT
    const runDir = join(w.projectRoot, ".genpi", "runs", runId);
    expect(w.events.find((e) => e.type === "run_stopped")).toBeTruthy();
    const md = readFileSync(join(runDir, "tasks.md"), "utf8");
    expect(md).toContain("- [ ] T2 不该跑"); // 未推进
    expect(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).status).toBe("stopped");
  });

  it("⑨ thinking/tool 事件透传（实时视图事件面）", async () => {
    const w = makeWorld(() => ({ result: ok() }));
    w.runner.extra = [
      { type: "thinking", delta: "先看仓库现状" },
      { type: "tool", name: "bash", detail: "npm test" },
    ];
    const engine = new LoopEngine(w.deps);
    await engine.start("research", "调研一下");
    expect(w.events).toContainEqual({ type: "step_thinking", runId: w.events.find((e) => e.type === "state_entered")?.runId, delta: "先看仓库现状" });
    expect(w.events.some((e) => e.type === "step_tool" && e.name === "bash" && e.detail === "npm test")).toBe(true);
  });

  it("⑩ 用户中断：aborted 不扣 budget，run 转 stopped 可恢复（契约 19）", async () => {
    const w = makeWorld((spec, n) =>
      spec.state === "RESEARCH" && n === 1 ? { result: { ok: false, aborted: true, summary: "用户中断", artifacts: [], evidence: [] } } : { result: ok() },
    );
    const engine = new LoopEngine(w.deps);
    const runId = await engine.start("research", "调研");
    const stopped = w.events.find((e) => e.type === "run_stopped");
    expect(stopped).toBeTruthy();
    expect((stopped as { reason: string }).reason).toBe("用户中断"); // 引擎层裸 reason，「可 --resume 续跑」由展示层追加，防重复拼接
    const rec = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "run.json"), "utf8"));
    expect(rec.status).toBe("stopped");
    expect(rec.budget.RESEARCH).toBeUndefined(); // budget 仅在扣减时落账——键不存在即未扣（中断≠失败）
    await engine.resume(runId); // v1.8：stopped 可续跑——从 RESEARCH 继续跑完
    const rec2 = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "run.json"), "utf8"));
    expect(rec2.status).toBe("done");
  });

  it("⑪ GATE 期废弃：/genpi-stop 语义，status=stopped 且 run_stopped（契约 19）", async () => {
    const w = makeWorld(() => ({ result: ok() }));
    const engine = new LoopEngine(w.deps);
    const runId = await engine.start("feature", "加功能");
    expect(w.events.at(-1)?.type).toBe("gate_opened"); // GATE_DESIGN
    await engine.stop(runId, "人工废弃");
    const rec = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "run.json"), "utf8"));
    expect(rec.status).toBe("stopped");
    expect(w.events.some((e) => e.type === "run_stopped")).toBe(true);
    // v1.8：stopped 可续跑——停在门禁态则重开 GATE 死等 decide（与「可 --resume 续跑」提示/契约 19 对齐）
    w.events.length = 0;
    await engine.resume(runId);
    const rec2 = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "run.json"), "utf8"));
    expect(rec2.status).toBe("gate");
    expect(w.events.at(-1)?.type).toBe("gate_opened");
  });

  it("⑪b research 无门禁：结论即交付，直接 run_done（v1.5，咨询类不设批准/拒绝）", async () => {
    const w = makeWorld(() => ({ result: ok() }));
    const engine = new LoopEngine(w.deps);
    const runId = await engine.start("research", "要不要上 SSR");
    expect(w.events.some((e) => e.type === "gate_opened")).toBe(false);
    const rec = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "run.json"), "utf8"));
    expect(rec.status).toBe("done");
  });

  it("⑫ GATE_MR 开门时携带变更预览（审批对象不再是空标签）", async () => {
    const w = makeWorld((spec) => (spec.state === "VERIFY" ? { result: ok([], [{ command: "npm test", exitCode: 0, outputTail: "ok" }]) } : { result: ok() }));
    const engine = new LoopEngine(w.deps);
    const runId = await engine.start("feature", "加功能");
    await engine.decide(runId, { kind: "approve" }); // 过 GATE_DESIGN
    const mrGate = w.events.find((e) => e.type === "gate_opened" && (e as { gate: string }).gate === "GATE_MR") as { preview?: string };
    expect(mrGate?.preview).toContain("fake: 改动");
  });

  it("⑬ Q&A 等待期 stop：不再多跑一步，run_stopped 只发一次（契约 19）", async () => {
    let engineRef: LoopEngine | null = null;
    const w = makeWorld((spec, n) => {
      if (spec.state === "CLARIFY" && n === 1) return { questions: ["发布时区？"], result: ok() };
      return { result: ok() };
    });
    w.deps.ask = async () => {
      await engineRef?.stop(w.events.find((e) => e.type === "state_entered")?.runId ?? "", "人工废弃");
      return "（用户已废弃）";
    };
    engineRef = new LoopEngine(w.deps);
    const runId = await engineRef.start("feature", "x");
    expect(w.runner.calls.filter((s) => s.state === "CLARIFY")).toHaveLength(1); // 没多跑一步
    expect(w.events.filter((e) => e.type === "run_stopped")).toHaveLength(1); // 不重复发
    const rec = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "run.json"), "utf8"));
    expect(rec.status).toBe("stopped");
  });

  it("⑭ 会话间隙 abort（Q&A 中按 escape）：pendingAbort 下一轮消费，不再发模型调用", async () => {
    let engineRef: LoopEngine | null = null;
    const w = makeWorld((spec, n) => {
      if (spec.state === "CLARIFY" && n === 1) return { questions: ["发布时区？"], result: ok() };
      return { result: ok() };
    });
    w.deps.ask = async () => {
      engineRef?.abort(); // 会话间隙：无 active session，靠 pendingAbort
      return "好";
    };
    engineRef = new LoopEngine(w.deps);
    await engineRef.start("feature", "x");
    expect(w.runner.calls.filter((s) => s.state === "CLARIFY")).toHaveLength(1);
    expect(w.events.some((e) => e.type === "run_stopped")).toBe(true);
  });

  it("⑮ 搁置残留不毒死新 run：对无循环 run 的 stop 不留中断标志（1607 回归）", async () => {
    const w = makeWorld(() => ({ result: ok() }));
    const engine = new LoopEngine(w.deps);
    const first = await engine.start("feature", "第一需求"); // 停在 GATE_DESIGN，drive 已退出
    await engine.stop(first, "新需求优先，自动搁置"); // 修复前：无条件置 pendingAbort→无人消费
    const second = await engine.start("research", "第二需求"); // 修复前：第一步吃下毒标志，2ms 内「用户中断」
    const rec = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", second, "run.json"), "utf8"));
    expect(rec.status).toBe("done");
    const stops = w.events.filter((e) => e.type === "run_stopped");
    expect(stops).toHaveLength(1); // 仅搁置那一条，新 run 不再出现假「用户中断」
    expect((stops[0] as { reason: string }).reason).not.toContain("用户中断");
  });

  it("⑯ escape 中断旧 run 后，新 run 第一步不被残留标志误杀（1607 回归）", async () => {
    const aborted: StepResult = { ok: false, aborted: true, summary: "用户中断", artifacts: [], evidence: [] };
    const w = makeWorld((spec, n) => (spec.state === "RESEARCH" && n === 1 ? { result: aborted } : { result: ok() }));
    const engine = new LoopEngine(w.deps);
    await engine.start("research", "旧需求"); // 中途 aborted→stopped（修复前 pendingAbort 残留）
    const second = await engine.start("research", "新需求");
    const rec = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", second, "run.json"), "utf8"));
    expect(rec.status).toBe("done");
  });

  it("⑰ T0 短链（契约 20）：微改动跳过澄清/设计/计划，仅 MR 一道门禁，tier 落台账", async () => {
    const w = makeWorld(() => ({ result: ok() }));
    const engine = new LoopEngine(w.deps);
    const runId = await engine.start("feature", w.request, undefined, { tier: "t0" });
    expect(w.events.at(-1)?.type).toBe("gate_opened"); // 唯一门禁：GATE_MR
    const entered = w.events.filter((e) => e.type === "state_entered").map((e) => (e as { state: string }).state);
    expect(entered).toEqual(["INIT", "IMPLEMENT", "VERIFY", "GATE_MR"]);
    const rec = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "run.json"), "utf8"));
    expect(rec.tier).toBe("t0");
    const hist = readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "phase-history.jsonl"), "utf8");
    expect(hist).toContain('"event":"routed"'); // T30：路由决策全量入史
    expect(hist).toContain("path=feature");
    await engine.decide(runId, { kind: "approve" });
    expect(w.events.at(-1)).toMatchObject({ type: "run_done" });
  });

  it("⑱ T2 高风险（契约 20）：链同 T1，DESIGN 强制回滚预案节；REVIEW 安全轴 feature/bugfix 均生效", async () => {
    const w = makeWorld(() => ({ result: ok() }));
    const engine = new LoopEngine(w.deps);
    const runId = await engine.start("feature", w.request, undefined, { tier: "t2" });
    const rec = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "run.json"), "utf8"));
    expect(rec.tier).toBe("t2");
    expect(w.runner.calls.find((s) => s.state === "DESIGN")?.instruction).toContain("回滚预案");
    await engine.decide(runId, { kind: "approve" }); // REVIEW 在 GATE_DESIGN 之后：批准才继续
    expect(w.runner.calls.find((s) => s.state === "REVIEW")?.instruction).toContain("安全轴"); // T28a：feature 链亦有 REVIEW（T2 安全轴随链生效）
    expect(w.runner.calls.find((s) => s.state === "REVIEW")?.role).toBe("reviewer");
    expect(w.runner.calls.some((s) => s.state === "CLARIFY")).toBe(true); // 链同 T1，不短链
    const wb = makeWorld(() => ({ result: ok() }), "修登录认证");
    await new LoopEngine(wb.deps).start("bugfix", wb.request, undefined, { tier: "t2" });
    expect(wb.runner.calls.find((s) => s.state === "REVIEW")?.instruction).toContain("安全轴");
  });

  it("⑲ CLARIFY 豁免（契约 21）：证据完整直入 DESIGN 理由落史；不豁免默认 CLARIFY", async () => {
    const w = makeWorld(() => ({ result: ok() }));
    const engine = new LoopEngine(w.deps);
    const runId = await engine.start("feature", w.request, undefined, { tier: "t1", waiveClarify: true, waiveReason: "附验收标准" });
    expect(w.runner.calls[0]?.state).toBe("DESIGN");
    const hist = readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "phase-history.jsonl"), "utf8");
    expect(hist).toContain("clarify_waived");
    expect(hist).toContain("附验收标准");
    const w2 = makeWorld(() => ({ result: ok() }));
    await new LoopEngine(w2.deps).start("feature", "第二需求");
    expect(w2.runner.calls[0]?.state).toBe("CLARIFY"); // 默认不豁免，行为与 v1.8 一致
  });

  it("⑳ prd 路径（契约 22）：PRD→GATE_PRD 死等→approve→done；request_changes 回 PRD 不扣 budget", async () => {
    const w = makeWorld(() => ({ result: ok(["prd.md"]) }));
    const engine = new LoopEngine(w.deps);
    const runId = await engine.start("prd", "写登录功能 PRD");
    expect(w.events.at(-1)).toMatchObject({ type: "gate_opened", gate: "GATE_PRD" });
    expect((w.events.at(-1) as { artifactPath: string }).artifactPath).toContain("prd.md");
    const entered = w.events.filter((e) => e.type === "state_entered").map((e) => (e as { state: string }).state);
    expect(entered).toEqual(["INIT", "PRD", "GATE_PRD"]);
    w.events.length = 0;
    await engine.decide(runId, { kind: "request_changes", note: "补非目标节" }); // 回 PRD 携注重写
    expect(w.events.at(-1)).toMatchObject({ type: "gate_opened", gate: "GATE_PRD" });
    const rec = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "run.json"), "utf8"));
    expect(rec.budget.PRD).toBeUndefined(); // 人工反馈不扣 budget（契约 12/20 精神）
    await engine.decide(runId, { kind: "approve" });
    expect(w.events.at(-1)).toMatchObject({ type: "run_done" });
    const rec2 = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "run.json"), "utf8"));
    expect(rec2.status).toBe("done");
    expect(rec2.currentState).toBe("DONE");
  });

  it("㉑ 需求标题落账（T22）：runId 用 title，run.json 双落 title+原话；产物态指令含标题约束", async () => {
    const w = makeWorld(() => ({ result: ok() }));
    const engine = new LoopEngine(w.deps);
    const runId = await engine.start("feature", "基于本项目，我要抽取一个通用框架出来，我后续开发新项目", undefined, {
      tier: "t1",
      title: "抽取通用开发框架",
    });
    expect(runId).toContain("feature-抽取通用开发框架");
    expect(runId).not.toContain("基于本项目"); // 原话不再直接成目录名
    const rec = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "run.json"), "utf8"));
    expect(rec.title).toBe("抽取通用开发框架"); // 标题落账（人读）
    expect(rec.request).toContain("我后续开发新项目"); // 原话保留（审计保真，不修饰）
    const rid2 = await new LoopEngine(makeWorld(() => ({ result: ok() })).deps).start("research", "现在什么进度"); // 无 title：回退原话 slug（向后兼容）
    expect(rid2).toContain("现在什么进度");
    const w3 = makeWorld(() => ({ result: ok() }));
    await new LoopEngine(w3.deps).start("feature", "加导出", undefined, { tier: "t1" });
    expect(w3.runner.calls.find((s) => s.state === "DESIGN")?.instruction).toContain("禁止照抄需求原话"); // 产物标题指令注入
    const ridEmpty = await new LoopEngine(makeWorld(() => ({ result: ok() })).deps).start("research", "空标题兜底原话", undefined, { tier: "t1", title: "" }); // 空串 title：兑底原话 slug（T23：?? 只挡 nullish）
    expect(ridEmpty).toContain("空标题兜底原话");
  });

  it("㉒ DEBUG 诊断循环（契约 23）：VERIFY 失败转诊断→回修复态携诊断→再验证；DEBUG 连败耗尽 STOP", async () => {
    const runDirOf = (spec: StepSpec) => /# 运行目录: (.+)/.exec(spec.instruction)?.[1] ?? "";
    // feature：VERIFY 首败→DEBUG 写诊断→IMPLEMENT 重入携诊断注入→删诊断→全链走完
    const w = makeWorld((spec, n) => {
      if (spec.state === "VERIFY" && n === 1) return { result: fail };
      if (spec.state === "DEBUG") {
        writeFileSync(join(runDirOf(spec), "diagnosis-latest.md"), "根因：时区计算用本地时区\n修复：改用 UTC");
        return { result: ok() };
      }
      if (spec.state === "IMPLEMENT" && n === 2) {
        expect(spec.instruction).toContain("diagnosis-latest.md"); // 修复态自动携带诊断注入（契约 23）
        rmSync(join(runDirOf(spec), "diagnosis-latest.md"), { force: true }); // 模拟「修复后删除」
      }
      return { result: ok() };
    });
    const engine = new LoopEngine(w.deps);
    const runId = await engine.start("feature", w.request);
    await engine.decide(runId, { kind: "approve" }); // GATE_DESIGN
    await engine.decide(runId, { kind: "approve" }); // GATE_MR
    const entered = w.events.filter((e) => e.type === "state_entered").map((e) => (e as { state: string }).state);
    const vIdx = entered.indexOf("VERIFY");
    expect(entered[vIdx + 1]).toBe("DEBUG"); // 失败即转诊断，不盲重试
    expect(entered.filter((x) => x === "IMPLEMENT")).toHaveLength(2); // 诊断后回修复态
    expect(entered).toContain("REVIEW"); // T28a：feature 链有审查
    const hist = readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "phase-history.jsonl"), "utf8");
    expect(hist).toContain("verify_fail_debug");
    expect(hist).toContain("debug_to_fix");
    const rec = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", runId, "run.json"), "utf8"));
    expect(rec.status).toBe("done");
    expect(rec.budget.VERIFY).toBe(2); // 失败扣一次，循环封顶仍在（契约 6 不变）

    // DEBUG 连败 3 次 → STOP
    const w2 = makeWorld((spec, n) => {
      if (spec.state === "VERIFY" && n === 1) return { result: fail };
      if (spec.state === "DEBUG") return { result: fail };
      return { result: ok() };
    });
    const engine2 = new LoopEngine(w2.deps);
    const rid2 = await engine2.start("feature", w2.request);
    await engine2.decide(rid2, { kind: "approve" });
    const stopped = w2.events.find((e) => e.type === "run_stopped");
    expect(stopped).toBeTruthy();
    expect((stopped as { reason: string }).reason).toContain("DEBUG");

    // bugfix：debugTo=FIX 同样注入诊断
    const wb = makeWorld((spec, n) => {
      if (spec.state === "VERIFY" && n === 1) return { result: fail };
      if (spec.state === "DEBUG") {
        writeFileSync(join(runDirOf(spec), "diagnosis-latest.md"), "根因：X");
        return { result: ok() };
      }
      if (spec.state === "FIX" && n === 2) {
        expect(spec.instruction).toContain("diagnosis-latest.md"); // bugfix 修复态同样携带
        rmSync(join(runDirOf(spec), "diagnosis-latest.md"), { force: true });
      }
      return { result: ok() };
    });
    await new LoopEngine(wb.deps).start("bugfix", wb.request); // 停在 GATE_MR 即验证完成（断言已在 handler 内）
  });

  it("㉓ 会话滚动摘要（契约 24/E）：run 完成落 conversation.md，新 run 注入最近背景", async () => {
    const w = makeWorld(() => ({ result: ok() })); // 同一项目：两轮共享 .genpi/conversation.md
    await new LoopEngine(w.deps).start("research", "第一轮调研登录方案");
    const conv = readFileSync(join(w.projectRoot, ".genpi", "conversation.md"), "utf8");
    expect(conv).toContain("research/done");
    expect(conv).toContain("第一轮调研登录方案");
    await new LoopEngine(w.deps).start("research", "第二轮独立需求");
    const secondInstr = w.runner.calls.filter((c) => c.instruction.includes("第二轮独立需求"))[0]?.instruction ?? "";
    expect(secondInstr).toContain("近期会话背景"); // E 底座：新 run 注入滚动摘要
    expect(secondInstr).toContain("第一轮调研登录方案");
  });

  it("㉔ 前轮承接（契约 24/A）：parentRunId 落账+指令注入前轮需求/产物目录+research 续写语义；前轮不存在静默降级", async () => {
    const w = makeWorld(() => ({ result: ok() })); // 同一项目：前轮产物在本项目台账内
    const first = await new LoopEngine(w.deps).start("research", "调研状态机方案");
    const second = await new LoopEngine(w.deps).start("research", "深入刚才那个方案", undefined, { parentRunId: first });
    const rec2 = JSON.parse(readFileSync(join(w.projectRoot, ".genpi", "runs", second, "run.json"), "utf8"));
    expect(rec2.parentRunId).toBe(first); // 承接关系落账（审计）
    const hist = readFileSync(join(w.projectRoot, ".genpi", "runs", second, "phase-history.jsonl"), "utf8");
    expect(hist).toContain("context_attached");
    const instr = (w.runner.calls.filter((c) => c.instruction.includes("深入刚才那个方案"))[0]?.instruction ?? "");
    expect(instr).toContain("调研状态机方案"); // 前轮需求
    expect(instr).toContain(first); // 前轮产物目录（含 runId）
    expect(instr).toContain("修订/追加"); // research→research 续写语义：不重写
    await new LoopEngine(w.deps).start("research", "承接已删前轮", undefined, { parentRunId: "20990101-0000-research-none" });
    const instr3 = (w.runner.calls.filter((c) => c.instruction.includes("承接已删前轮"))[0]?.instruction ?? "");
    expect(instr3).not.toContain("前轮上下文"); // 前轮不存在：静默降级不崩（契约 10 精神）
  });
});
