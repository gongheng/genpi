// genpi 跨模块类型（单一类型源）——T1 子集，后续任务只增不改
export type PathId = "feature" | "bugfix" | "research" | "prd";

/** 风险分级（契约 20，仅 feature 生效）：t0 微改动短链 / t1 常规全链 / t2 高风险同 t1 链指令强化 */
export type Tier = "t0" | "t1" | "t2";

export interface GateScreenState {
  gate: string;
  /** 审批对象描述（路径 + 行数元信息） */
  artifact: string;
}

// ---- 引擎子集（T3）----
export type StateId =
  | "INIT" | "CLARIFY" | "DESIGN" | "GATE_DESIGN" | "PLAN" | "IMPLEMENT" | "VERIFY"
  | "GATE_MR" | "ARCHIVE" | "DONE"
  | "REPRODUCE" | "ROOT_CAUSE" | "FIX" | "REVIEW"
  | "RESEARCH" | "PRD" | "GATE_PRD" | "DEBUG" | "STOP";
export type RunId = string;

export interface CommandEvidence {
  command: string;
  exitCode: number;
  outputTail: string;
}

export interface StepSpec {
  state: StateId;
  instruction: string;
  methodology: string[];
  preamble: string;
  workingDir: string;
  /** 模型角色（契约 16）：IMPLEMENT/FIX→implementer，REVIEW→reviewer，缺省全局默认 */
  role?: "implementer" | "reviewer";
}

export interface StepResult {
  ok: boolean;
  /** 用户主动中断（escape//genpi-stop）：不扣 budget，run 转 stopped 可续跑 */
  aborted?: boolean;
  summary: string;
  artifacts: string[];
  evidence: CommandEvidence[];
}

export type StepEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "question"; text: string };

export interface StepRunner {
  run(spec: StepSpec, onEvent: (e: StepEvent) => void): Promise<StepResult>;
  /** 中断当前在跑的 step（若有）：底层调 AgentSession.abort，StepResult 置 aborted */
  abort?(): void;
}

export type GateDecision = { kind: "approve" | "request_changes" | "reject"; note?: string };

export type EngineEvent =
  | { type: "state_entered"; runId: RunId; state: StateId }
  | { type: "step_stream"; runId: RunId; delta: string }
  | { type: "step_thinking"; runId: RunId; delta: string }
  | { type: "step_tool"; runId: RunId; name: string; detail: string }
  | { type: "agent_question"; runId: RunId; text: string }
  | { type: "step_finished"; runId: RunId; state: StateId; ok: boolean; /** 步末摘要（T26 聊天流一行化）；aborted 步无摘要由 run_stopped 报 */ summary?: string; aborted?: boolean }
  | { type: "gate_opened"; runId: RunId; gate: StateId; artifactPath: string; /** 门禁审批对象预览（GATE_MR 为变更摘要；文件型门禁缺省由 TUI 读文件） */ preview?: string }
  | { type: "gate_resolved"; runId: RunId; gate: StateId; decision: GateDecision }
  | { type: "budget_changed"; runId: RunId; state: StateId; remaining: number }
  | { type: "run_stopped"; runId: RunId; reason: string }
  | { type: "run_done"; runId: RunId; summary: string };

export interface RunRecord {
  id: RunId;
  path: PathId;
  /** 需求标题（≤12字动宾短语，路由生成）：runId 与展示用；原话保留于 request（审计保真） */
  title?: string;
  /** 风险分级（契约 20）：仅 feature 落账；旧 run 无此字段→按 t1 全链处理 */
  tier?: Tier;
  request: string;
  status: "active" | "gate" | "stopped" | "done" | "rejected";
  currentState: StateId;
  budget: Record<string, number>;
  createdTs: string;
  sessionIds: string[];
  worktree?: string;
  /** worktree 创建时的基线 commit（GATE_MR 变更预览用） */
  baseSha?: string;
  /** 承接的前一轮 run（契约 24/T24）：指令注入前轮需求与产物路径；前轮已删除则静默跳过 */
  parentRunId?: RunId;
}
