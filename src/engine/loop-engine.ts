// LoopEngine——产品核心深模块：状态机驱动、GATE 死等、fail budget、单活跃锁、steering 队列
// 契约 3（GATE 无 decide 不转移）/ 6（budget 耗尽 STOP）/ 13（steering 边界注入）/ 15（单活跃 run）
import { basename, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ResolvedConfig } from "../config";
import type { EngineEvent, GateDecision, PathId, RunId, StateId, StepEvent, StepResult, StepRunner, StepSpec, Tier } from "../types";
import type { Ledger } from "./ledger";
import { chainFor, PATHS, type PathDef } from "./paths";
import { parseUnchecked, tick } from "./tasks";

export interface ResourceProvider {
  byState(state: StateId): string[];
  preamble(): string;
}

export interface GitOps {
  ensureWorktree(projectRoot: string, runId: string, branchPrefix: string, worktreeDir: string): Promise<{ path: string; baseSha?: string }>;
  mrPreview(worktreeDir: string, baseSha?: string): Promise<string | null>;
  pushAndMr(worktreeDir: string, opts: { mrTarget: string; runId: string; summary: string }): Promise<{ mode: "mr" | "manual"; url: string }>;
}

export class GenpiActiveRunError extends Error {
  constructor(id: string) {
    super(`已有活跃 run: ${id}（同项目同时仅一个，契约 15）`);
  }
}

export interface EngineDeps {
  runner: StepRunner;
  ledger: Ledger;
  resources: ResourceProvider;
  git: GitOps;
  config: ResolvedConfig;
  projectRoot: string;
  emit(e: EngineEvent): void;
  ask(prompt: string): Promise<string>;
}

const STATE_INSTRUCTIONS: Partial<Record<StateId, string>> = {
  CLARIFY: "澄清需求：就模糊点向用户提问（每行以 ❓ 开头），无问题则产出理解摘要",
  DESIGN: "写 design.md（动机与范围/技术方案/行为契约），保存到运行目录",
  PLAN: "基于 design.md 写 tasks.md（原子任务清单，每任务含验收命令）",
  IMPLEMENT: "按 tasks.md 逐任务实现（TDD：先红后绿），完成后在 tasks.md 勾销",
  VERIFY: "运行项目验证命令（测试/构建/lint），逐条记录命令与 exit code",
  REPRODUCE: "复现 bug：给出最小复现步骤与证据",
  ROOT_CAUSE: "定位根因：数据流追踪，给出证据链",
  FIX: "按根因修复（最小 diff，不顺手重构）",
  REVIEW: "审查变更：spec 符合度 + 代码质量两轴",
  RESEARCH: "调研并产出 conclusion.md（结论 + 依据 + 引用）",
  DEBUG: "诊断 VERIFY 失败：重跑失败命令，定位根因与最小修复方案，写入运行目录 diagnosis-latest.md（修复态会自动读取）",
  PRD: "写 prd.md（背景与目标/用户故事/验收标准/非目标/优先级），保存到运行目录",
};

const QA_MAX_ROUNDS = 5;
const now = () => new Date().toISOString();
/** 产出文档的状态：指令强制标题用简短动宾短语，不复述需求原话（T22） */
const ARTIFACT_STATES = new Set<StateId>(["DESIGN", "PLAN", "PRD", "RESEARCH"]);

export class LoopEngine {
  private steering = new Map<RunId, string[]>();
  private qa = new Map<RunId, string>();
  private parentCtx = new Map<RunId, { request: string; runDir: string }>(); // 契约 24/A：承接轮的前轮需求与产物目录（start 时解析缓存，进程内有效）
  private pendingAbort = false; // 会话间隙（建会话/Q&A 等待）收到的中断，下一 step 前消费（契约 19）
  private driving: RunId | null = null; // 当前 drive 循环所属 run：中断仅对活跃循环生效，防跨 run 泄漏毒死新 run

  constructor(private deps: EngineDeps) {}

  async start(
    path: PathId,
    request: string,
    onCreated?: (runId: RunId) => void,
    opts?: { tier?: Tier; waiveClarify?: boolean; waiveReason?: string; title?: string; parentRunId?: RunId; routeBy?: string; routeReason?: string },
  ): Promise<RunId> {
    const runs = await this.deps.ledger.listRuns(this.deps.projectRoot);
    const active = runs.find((r) => r.status === "active" || r.status === "gate");
    if (active) throw new GenpiActiveRunError(active.id);
    const { runId, runDir } = await this.deps.ledger.initRun(this.deps.projectRoot, path, request, opts?.title);
    const rec = await this.deps.ledger.readRun(runDir);
    if (opts?.parentRunId) {
      rec.parentRunId = opts.parentRunId; // 契约 24/A：承接轮落账；前轮产物目录注入指令（先读再动手）
      await this.deps.ledger.appendHistory(runDir, { ts: now(), from: "INIT", to: "INIT", event: "context_attached", note: opts.parentRunId });
      try {
        const pDir = await this.deps.ledger.runDir(this.deps.projectRoot, opts.parentRunId);
        const pRec = await this.deps.ledger.readRun(pDir);
        this.parentCtx.set(runId, { request: pRec.request, runDir: pDir });
      } catch {
        /* 前轮已删除：静默降级为无前轮上下文（契约 10 精神） */
      }
    }
    if (opts?.tier) {
      rec.tier = opts.tier; // 契约 20：tier 全路径落账（审计统一）；链变体仅 feature，T2 指令强化 bugfix REVIEW 同样消费
      // T30 观测性：路由决策全量入史（path/by/tier/waive/followUp/title/理由），/genpi log 与 T31 校准的数据源
      await this.deps.ledger.appendHistory(runDir, {
        ts: now(),
        from: "INIT",
        to: "INIT",
        event: "routed",
        note: `path=${path} by=${opts.routeBy ?? "?"} tier=${opts.tier}${opts.waiveClarify ? " waive=yes" : ""}${opts.parentRunId ? ` followUp=${opts.parentRunId}` : ""}${opts.title ? ` title=${opts.title}` : ""}${opts.routeReason ? ` · ${opts.routeReason}` : ""}`,
      });
    }
    const def = PATHS[path];
    const chain = chainFor(def, rec.tier);
    if (opts?.waiveClarify && chain.includes("CLARIFY")) {
      // 契约 21：需求证据完整豁免澄清——直入后续态，理由落史（T0 短链无 CLARIFY 自然不触发）
      rec.currentState = chain[chain.indexOf("CLARIFY") + 1];
      await this.deps.ledger.appendHistory(runDir, { ts: now(), from: "INIT", to: rec.currentState, event: "clarify_waived", note: opts.waiveReason ?? "路由判定需求证据完整" });
    }
    await this.deps.ledger.writeRun(runDir, rec);
    onCreated?.(runId); // runId 在 drive 前即回调：调用方（TUI）在初始 drive 期间即可响应 escape/steering
    if (def.needsWorktree) {
      const wt = await this.deps.git.ensureWorktree(this.deps.projectRoot, runId, this.deps.config.branchPrefix, this.deps.config.worktreeDir);
      rec.worktree = wt.path;
      rec.baseSha = wt.baseSha;
      await this.deps.ledger.writeRun(runDir, rec);
    }
    await this.drive(runDir, def);
    return runId;
  }

  async resume(runId: RunId): Promise<void> {
    const runDir = await this.deps.ledger.runDir(this.deps.projectRoot, runId);
    const rec = await this.deps.ledger.readRun(runDir);
    const def = PATHS[rec.path];
    if (rec.status === "done" || rec.status === "rejected") throw new Error(`run ${runId} 状态 ${rec.status} 不可恢复`);
    if (rec.status === "gate" || (rec.status === "stopped" && def.gates[rec.currentState])) {
      // stopped 停在门禁态同样重开（契约 19：转 stopped 可续跑，v1.8 修正与提示语/README 的一致性）
      rec.status = "gate";
      await this.deps.ledger.writeRun(runDir, rec);
      const gate = def.gates[rec.currentState];
      const preview =
        gate?.artifact === "mr" && rec.worktree ? await this.deps.git.mrPreview(rec.worktree, rec.baseSha) : undefined;
      this.deps.emit({
        type: "gate_opened",
        runId,
        gate: rec.currentState,
        artifactPath: gate?.artifact === "mr" ? "MR 变更摘要" : join(basename(runDir), gate?.artifact ?? ""),
        ...(preview ? { preview } : {}),
      });
      return; // 重新摆上 GATE，继续死等 decide
    }
    rec.status = "active";
    await this.deps.ledger.writeRun(runDir, rec);
    await this.drive(runDir, def);
  }

  async decide(runId: RunId, d: GateDecision): Promise<void> {
    const runDir = await this.deps.ledger.runDir(this.deps.projectRoot, runId);
    const rec = await this.deps.ledger.readRun(runDir);
    if (rec.status !== "gate") throw new Error(`run ${runId} 不在 GATE 态（当前 ${rec.status}）`);
    const def = PATHS[rec.path];
    const gate = def.gates[rec.currentState];
    if (!gate) throw new Error(`${rec.currentState} 不是 GATE`);
    this.deps.emit({ type: "gate_resolved", runId, gate: rec.currentState, decision: d });
    await this.deps.ledger.appendHistory(runDir, { ts: now(), from: rec.currentState, to: rec.currentState, event: `gate_${d.kind}`, note: d.note });
    if (d.kind === "reject") {
      rec.status = "rejected";
      await this.deps.ledger.writeRun(runDir, rec);
      await this.#logConversation(runId, rec.path, rec.request, "rejected", "人工终止（产物保留）");
      this.deps.emit({ type: "run_done", runId, summary: "人工终止（产物保留）" });
      return;
    }
    if (d.kind === "request_changes") {
      rec.currentState = gate.requestChangesTo; // 不扣 budget（人工反馈≠失败）
      rec.status = "active";
      await this.deps.ledger.writeRun(runDir, rec);
      await this.drive(runDir, def);
      return;
    }
    // approve
    if (rec.currentState === "GATE_MR") {
      const r = await this.deps.git.pushAndMr(rec.worktree ?? this.deps.projectRoot, {
        mrTarget: this.deps.config.mrTarget,
        runId,
        summary: `genpi run ${runId}`,
      });
      await this.deps.ledger.appendHistory(runDir, { ts: now(), from: "GATE_MR", to: "ARCHIVE", event: `push_${r.mode}`, note: r.url });
    }
    rec.currentState = gate.approveTo;
    rec.status = "active";
    await this.deps.ledger.writeRun(runDir, rec);
    await this.drive(runDir, def);
  }

  /** 契约 13：入队，下一 step 边界前置注入；不引发状态跳跃。 */
  steer(runId: RunId, text: string): void {
    const q = this.steering.get(runId) ?? [];
    q.push(text);
    this.steering.set(runId, q);
  }

  /** 契约 19：中断当前在跑的 step（escape）：StepResult.aborted，不扣 budget，run 转 stopped 可续跑。会话间隙收到时置 pendingAbort，下一 step 前生效。 */
  abort(): void {
    if (this.driving) this.pendingAbort = true; // 仅当有活跃 drive 循环：否则置位无人消费，会毒死下一个 run（1607 回归）
    this.deps.runner.abort?.();
  }

  /** 契约 19：废弃 run（/genpi-stop）：台账保留，status=stopped；若在 step 中先 abort。 */
  async stop(runId: RunId, reason = "人工废弃"): Promise<void> {
    const runDir = await this.deps.ledger.runDir(this.deps.projectRoot, runId);
    const rec = await this.deps.ledger.readRun(runDir);
    if (rec.status !== "active" && rec.status !== "gate") return;
    if (this.driving === runId) {
      // 仅当该 run 的 drive 循环仍在时置位/打断（无循环的 stop 不得留下毒标志）
      this.pendingAbort = true;
      this.deps.runner.abort?.();
    }
    rec.status = "stopped";
    await this.deps.ledger.writeRun(runDir, rec);
    await this.deps.ledger.appendHistory(runDir, { ts: now(), from: rec.currentState, to: rec.currentState, event: "stopped", note: reason });
    await this.#logConversation(runId, rec.path, rec.request, "stopped", reason);
    this.deps.emit({ type: "run_stopped", runId, reason }); // 「可 --resume 续跑」提示由展示层统一追加，防重复拼接
  }

  private async drive(runDir: string, def: PathDef): Promise<void> {
    const runId = (await this.deps.ledger.readRun(runDir)).id;
    this.pendingAbort = false; // 中断标志只属于发起它的循环：新循环启动即清，不跨 run/跨代（1607 回归）
    this.driving = runId;
    try {
      await this.#driveLoop(runDir, def, runId);
    } finally {
      this.driving = null;
      this.pendingAbort = false;
    }
  }

  async #driveLoop(runDir: string, def: PathDef, runId: RunId): Promise<void> {
    let rec = await this.deps.ledger.readRun(runDir);
    let lastSummary = ""; // 最近工作态摘要（契约 24/E：终态写会话滚动摘要用）
    const chain = chainFor(def, rec.tier); // 契约 20：tier 决定链变体（缺省 t1 全链；旧 run 无 tier 同样回退）
    while (rec.status === "active") {
      const state = rec.currentState;
      this.deps.emit({ type: "state_entered", runId, state });

      if (state === "INIT") {
        const next = chain[1];
        await this.deps.ledger.appendHistory(runDir, { ts: now(), from: "INIT", to: next, event: "init" });
        rec.currentState = next;
        await this.deps.ledger.writeRun(runDir, rec);
        continue;
      }
      if (state === "ARCHIVE") {
        rec.status = "done";
        await this.deps.ledger.writeRun(runDir, rec);
        await this.deps.ledger.appendHistory(runDir, { ts: now(), from: "ARCHIVE", to: "DONE", event: "run_done" });
        await this.#logConversation(runId, rec.path, rec.request, "done", lastSummary);
        this.deps.emit({ type: "run_done", runId, summary: "循环完成" });
        continue;
      }
      if (state === "DONE") {
        rec.status = "done";
        await this.deps.ledger.writeRun(runDir, rec);
        await this.deps.ledger.appendHistory(runDir, { ts: now(), from: "DONE", to: "DONE", event: "run_done" });
        await this.#logConversation(runId, rec.path, rec.request, "done", lastSummary);
        this.deps.emit({ type: "run_done", runId, summary: "循环完成" });
        continue;
      }
      const gate = def.gates[state];
      if (gate) {
        rec.status = "gate"; // 契约 3：死等 decide，模型不能自我放行
        await this.deps.ledger.writeRun(runDir, rec);
        const artifactPath = gate.artifact === "mr" ? "MR 变更摘要" : join(basename(runDir), gate.artifact);
        const preview = gate.artifact === "mr" && rec.worktree ? await this.deps.git.mrPreview(rec.worktree, rec.baseSha) : undefined;
        await this.deps.ledger.appendHistory(runDir, { ts: now(), from: state, to: state, event: "gate_opened", note: gate.artifact });
        this.deps.emit({ type: "gate_opened", runId, gate: state, artifactPath, ...(preview ? { preview } : {}) });
        return;
      }
      // 工作态（IMPLEMENT 逐任务循环，其余单步）
      const result = await this.#runWorkState(runDir, runId, def, state, rec.request, rec.worktree, rec.tier);
      rec = await this.deps.ledger.readRun(runDir);
      if (result.aborted) {
        if (rec.status === "stopped") return; // engine.stop 已发 run_stopped，不重复
        // 用户中断（escape//genpi-stop）：不扣 budget，转 stopped 可续跑（契约 19）
        rec.status = "stopped";
        await this.deps.ledger.writeRun(runDir, rec);
        await this.deps.ledger.appendHistory(runDir, { ts: now(), from: state, to: state, event: "aborted", note: result.summary });
        this.deps.emit({ type: "run_stopped", runId, reason: "用户中断" });
        return;
      }
      if (result.ok) {
        lastSummary = result.summary;
        const next = state === "DEBUG" && def.debugTo ? def.debugTo : chain[chain.indexOf(state) + 1]; // DEBUG 不在链上：诊断完成回修复态（契约 23）
        await this.deps.ledger.appendHistory(runDir, { ts: now(), from: state, to: next, event: state === "DEBUG" ? "debug_to_fix" : "step_ok", evidence: result.evidence, note: result.summary });
        rec.currentState = next;
        await this.deps.ledger.writeRun(runDir, rec);
      } else {
        const left = (rec.budget[state] ?? this.deps.config.budget) - 1;
        rec.budget[state] = left;
        await this.deps.ledger.writeRun(runDir, rec);
        await this.deps.ledger.appendHistory(runDir, { ts: now(), from: state, to: state, event: "step_fail", budgetLeft: left });
        this.deps.emit({ type: "budget_changed", runId, state, remaining: left });
        if (left <= 0) {
          rec.status = "stopped";
          await this.deps.ledger.writeRun(runDir, rec);
          this.deps.emit({ type: "run_stopped", runId, reason: `步骤 ${state} 连续失败 ${this.deps.config.budget} 次（fail budget 耗尽）` });
          return;
        }
        // 契约 23（T28b）：VERIFY 失败不盲重试——转 DEBUG 诊断（定位根因→回修复态→再验证）；VERIFY budget 仍为循环封顶
        if (state === "VERIFY" && def.debugTo) {
          rec.currentState = "DEBUG";
          await this.deps.ledger.writeRun(runDir, rec);
          await this.deps.ledger.appendHistory(runDir, { ts: now(), from: "VERIFY", to: "DEBUG", event: "verify_fail_debug", budgetLeft: left });
          continue;
        }
      }
    }
  }

  /** 工作态分发：IMPLEMENT 解析 tasks.md 逐任务执行；其余状态单步。 */
  async #runWorkState(runDir: string, runId: RunId, def: PathDef, state: StateId, request: string, worktree?: string, tier?: Tier): Promise<StepResult> {
    if (state !== "IMPLEMENT") return this.#runStep(runDir, runId, def, state, request, worktree, undefined, tier);
    const tasksPath = join(runDir, "tasks.md");
    if (!existsSync(tasksPath)) return this.#runStep(runDir, runId, def, state, request, worktree, undefined, tier); // 无任务清单则单步（鲁棒降级）
    let tasksMd = readFileSync(tasksPath, "utf8");
    const tasks = parseUnchecked(tasksMd);
    if (tasks.length === 0) return { ok: true, summary: "任务清单已全部勾选", artifacts: ["tasks.md"], evidence: [] };
    let last: StepResult = { ok: true, summary: "", artifacts: ["tasks.md"], evidence: [] };
    for (const t of tasks) {
      last = await this.#runStep(runDir, runId, def, state, request, worktree, `# 本任务\n${t.text}\n完成后把 tasks.md 中该任务行勾选为 [x]`, tier);
      if (!last.ok) return last; // 失败即返回（budget 扣减/STOP 由 drive 处理）
      tasksMd = tick(tasksMd, t.line);
      writeFileSync(tasksPath, tasksMd);
      await this.deps.ledger.appendHistory(runDir, { ts: now(), from: state, to: state, event: "task_done", note: t.text });
    }
    return { ok: true, summary: `完成 ${tasks.length} 个任务`, artifacts: ["tasks.md"], evidence: last.evidence };
  }

  /** 工作态执行：含内联问答（Q&A 重试不扣 budget）。 */
  async #runStep(runDir: string, runId: RunId, def: PathDef, state: StateId, request: string, worktree?: string, taskDirective?: string, tier?: Tier): Promise<StepResult> {
    let rounds = 0;
    for (;;) {
      // 契约 19：会话间隙（建会话/Q&A 等待）收到的中断在此消费，不再发起下一 step
      if (this.pendingAbort) {
        this.pendingAbort = false;
        return { ok: false, aborted: true, summary: "用户中断", artifacts: [], evidence: [] };
      }
      const questions: string[] = [];
      const spec: StepSpec = {
        state,
        instruction: [await this.#instruction(state, runId, request, runDir, tier, def), taskDirective ?? ""].filter(Boolean).join("\n\n"),
        methodology: this.deps.resources.byState(state),
        preamble: this.deps.resources.preamble(),
        workingDir: def.needsWorktree && worktree ? worktree : this.deps.projectRoot,
        role: this.#roleFor(state),
      };
      const result = await this.deps.runner.run(spec, (e: StepEvent) => {
        if (e.type === "question") questions.push(e.text);
        else if (e.type === "text") this.deps.emit({ type: "step_stream", runId, delta: e.delta });
        else if (e.type === "thinking") this.deps.emit({ type: "step_thinking", runId, delta: e.delta });
        else if (e.type === "tool") this.deps.emit({ type: "step_tool", runId, name: e.name, detail: e.detail });
      });
      this.deps.emit({ type: "step_finished", runId, state, ok: result.ok, ...(result.aborted ? { aborted: true } : { summary: result.summary }) });
      if (!result.ok || questions.length === 0 || ++rounds >= QA_MAX_ROUNDS) return result;
      for (const q of questions) {
        this.deps.emit({ type: "agent_question", runId, text: q });
        const a = await this.deps.ask(q);
        const prev = this.qa.get(runId) ?? "";
        this.qa.set(runId, `${prev}Q:${q}\nA:${a}\n`);
      }
      // Q&A 等待期间被 stop/abort：立即终止，不再多跑一步
      const recNow = await this.deps.ledger.readRun(runDir);
      if (recNow.status !== "active") {
        this.pendingAbort = false;
        return { ok: false, aborted: true, summary: "Q&A 期间停止", artifacts: [], evidence: [] };
      }
    }
  }

  /** 契约 24/E：run 终态写会话滚动摘要（一行：runId [path/status] 需求前 40 字 → 摘要前 60 字）；失败不阻塞主流程 */
  async #logConversation(runId: RunId, path: PathId, request: string, status: string, summary: string): Promise<void> {
    try {
      const clean = (t: string) => t.replace(/\n/g, " ").trim();
      await this.deps.ledger.appendConversation(this.deps.projectRoot, `- ${runId} [${path}/${status}] ${clean(request).slice(0, 40)} → ${clean(summary).slice(0, 60)}`);
    } catch {
      /* 摘要落盘失败不影响 run 主流程 */
    }
  }

  #roleFor(state: StateId): "implementer" | "reviewer" | undefined {
    if (state === "IMPLEMENT" || state === "FIX") return "implementer";
    if (state === "REVIEW") return "reviewer";
    return undefined;
  }

  async #instruction(state: StateId, runId: RunId, request: string, runDir: string, tier?: Tier, def?: PathDef): Promise<string> {
    const steering = (this.steering.get(runId) ?? []).join("\n");
    this.steering.set(runId, []);
    const qa = this.qa.get(runId) ?? "";
    const parent = this.parentCtx.get(runId);
    const recent = await this.deps.ledger.recentConversation(this.deps.projectRoot, 5); // 契约 24/E：滚动背景（最近 5 条）
    const followupHint =
      def?.id === "research" && parent
        ? "先读前轮 conclusion.md，在其基础上修订/追加（演进），不要从零重写"
        : (def?.id === "feature" || def?.id === "prd") && parent
          ? "前轮结论/产物可直接作为本轮输入（如调研结论作为设计输入）"
          : "";
    return [
      `# 状态任务：${STATE_INSTRUCTIONS[state] ?? state}`,
      `# 需求：${request}`,
      `# 运行目录: ${runDir}`,
      qa ? `# 已有问答上下文\n${qa}` : "",
      parent ? `# 前轮上下文（承接 run，契约 24）\n前轮需求：${parent.request}\n前轮产物目录：${parent.runDir}——先读再动手${followupHint ? `；${followupHint}` : ""}` : "",
      recent.length ? `# 近期会话背景（滚动摘要，参考）\n${recent.join("\n")}` : "",
      steering ? `# 用户新指示（steering）\n${steering}` : "",
      tier === "t2" && state === "DESIGN" ? "# T2 高风险（契约 20）：design.md 必须含「回滚预案」节——失败如何回退、影响面与止血步骤" : "",
      tier === "t2" && state === "REVIEW" ? "# T2 高风险（契约 20）：审查在 spec/quality 两轴外增加安全轴——认证/鉴权/加密/注入/越权/敏感信息泄露" : "",
      ARTIFACT_STATES.has(state) ? "# 产物文档标题用简短动宾短语概括目标（≤12字），禁止照抄需求原话" : "",
      (state === "IMPLEMENT" || state === "FIX") && existsSync(join(runDir, "diagnosis-latest.md"))
        ? "# 上次验证失败诊断（DEBUG 产出）：读运行目录 diagnosis-latest.md，按诊断修复，完成后删除该文件" 
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
}
