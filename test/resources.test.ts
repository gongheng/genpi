import { describe, expect, it } from "vitest";
import { createResourceProvider } from "../src/resources";
import { PATHS } from "../src/engine/paths";
import type { StateId } from "../src/types";

describe("resources", () => {
  it("① 每个工作态的方法论非空（映射完备）", () => {
    const rp = createResourceProvider();
    for (const def of Object.values(PATHS)) {
      const working = def.states.filter((s) => !["INIT", "ARCHIVE", "DONE"].includes(s) && !s.startsWith("GATE_"));
      for (const s of working as StateId[]) {
        expect(rp.byState(s).length, `状态 ${s} 方法论为空`).toBeGreaterThan(0);
      }
    }
  });

  it("② preamble 非空且含三约束层", () => {
    const p = createResourceProvider().preamble();
    expect(p).toContain("安全操作");
    expect(p).toContain("简单优先");
    expect(p).toContain("外科手术式");
  });

  it("③ IMPLEMENT/FIX 含 git 纪律，RESEARCH 不含", () => {
    const rp = createResourceProvider();
    expect(rp.byState("IMPLEMENT").join("")).toContain("git 工作流纪律");
    expect(rp.byState("FIX").join("")).toContain("git 工作流纪律");
    expect(rp.byState("RESEARCH").join("")).not.toContain("git 工作流纪律");
  });

  it("④ PRD 方法论装载（契约 22）：用户故事/验收标准/非目标齐备", () => {
    const rp = createResourceProvider();
    const text = rp.byState("PRD").join("");
    expect(text).toContain("用户故事");
    expect(text).toContain("验收标准");
    expect(text).toContain("非目标");
  });
});
