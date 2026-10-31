// 四路径状态转移表（纯数据）——契约 3/5/20/22 的数据基础
import type { PathId, StateId, Tier } from "../types";

export interface GateDef {
  artifact: "design.md" | "conclusion.md" | "prd.md" | "mr";
  approveTo: StateId;
  requestChangesTo: StateId;
}

export interface PathDef {
  id: PathId;
  states: StateId[];
  gates: Partial<Record<StateId, GateDef>>;
  needsWorktree: boolean;
  /** 风险分级变体链（契约 20，仅 feature）：缺省回退 states（t1 全链） */
  tierChains?: Partial<Record<Tier, StateId[]>>;
  /** 契约 23：VERIFY 失败转入 DEBUG 诊断后回退的修复态（feature=IMPLEMENT，bugfix=FIX；无 VERIFY 的路径不设） */
  debugTo?: StateId;
}

export const PATHS: Record<PathId, PathDef> = {
  feature: {
    id: "feature",
    needsWorktree: true,
    // T28a：IMPLEMENT→REVIEW→VERIFY——代码不审不送 MR（对齐原工作流与 bugfix 链；T0 微改动不设分级审，风险与审查重量对等）
    states: ["INIT", "CLARIFY", "DESIGN", "GATE_DESIGN", "PLAN", "IMPLEMENT", "REVIEW", "VERIFY", "GATE_MR", "ARCHIVE", "DONE"],
    // 契约 20：T0 微改动短链（无澄清/设计/计划/设计批准/审查，仅 MR 门禁）；T2 链同 T1，指令强化由引擎注入
    tierChains: {
      t0: ["INIT", "IMPLEMENT", "VERIFY", "GATE_MR", "ARCHIVE", "DONE"],
    },
    gates: {
      GATE_DESIGN: { artifact: "design.md", approveTo: "PLAN", requestChangesTo: "DESIGN" },
      GATE_MR: { artifact: "mr", approveTo: "ARCHIVE", requestChangesTo: "IMPLEMENT" },
    },
    debugTo: "IMPLEMENT",
  },
  bugfix: {
    id: "bugfix",
    needsWorktree: true,
    states: ["INIT", "REPRODUCE", "ROOT_CAUSE", "FIX", "REVIEW", "VERIFY", "GATE_MR", "ARCHIVE", "DONE"],
    gates: {
      GATE_MR: { artifact: "mr", approveTo: "ARCHIVE", requestChangesTo: "FIX" },
    },
    debugTo: "FIX",
  },
  research: {
    id: "research",
    needsWorktree: false,
    states: ["INIT", "RESEARCH", "DONE"],
    gates: {}, // 咨询/调研：结论即交付物，无后续机器动作，不设门禁（v1.5）
  },
  prd: {
    id: "prd",
    needsWorktree: false,
    states: ["INIT", "PRD", "GATE_PRD", "DONE"],
    gates: {
      // 契约 22：一道人工批准（approve→DONE / request_changes→PRD 携注）；只读无 worktree 无 MR
      GATE_PRD: { artifact: "prd.md", approveTo: "DONE", requestChangesTo: "PRD" },
    },
  },
};

/** 取路径在指定 tier 下的状态链（契约 20）：tierChains 优先，缺省 t1 全链（旧 run 无 tier 同样回退）。 */
export function chainFor(def: PathDef, tier?: Tier): StateId[] {
  return def.tierChains?.[tier ?? "t1"] ?? def.states;
}
