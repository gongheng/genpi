import { describe, expect, it } from "vitest";
import { parseGateCommand, routeUserInput, type InputPhase } from "../src/tui/app";

describe("门禁命令解析（聊天内 a/c/r）", () => {
  it("① a/批准/通过/approve → 批准", () => {
    for (const t of ["a", "A", "批准", "通过", "approve", "ok"]) {
      expect(parseGateCommand(t).command).toEqual({ kind: "approve" });
    }
  });
  it("② r/终止/reject → 终止", () => {
    for (const t of ["r", "终止", "停止", "reject"]) {
      expect(parseGateCommand(t).command).toEqual({ kind: "reject" });
    }
  });
  it("③ c <意见> → request_changes 携 note；裸 c 给出补意见提示", () => {
    expect(parseGateCommand("c 补时区").command).toEqual({ kind: "request_changes", note: "补时区" });
    expect(parseGateCommand("改：加索引").command).toEqual({ kind: "request_changes", note: "加索引" });
    const bare = parseGateCommand("c");
    expect(bare.command).toBeNull();
    expect(bare.hint).toContain("修改意见");
  });
  it("④ 非门禁命令 → null + 用法提示", () => {
    const r = parseGateCommand("再想想");
    expect(r.command).toBeNull();
    expect(r.hint).toContain("a 批准");
  });
});

describe("输入分流（聊天单输入框的调度核心）", () => {
  const cases: [InputPhase, string | null, string, string][] = [
    ["idle", null, "加定时发布", "start"],
    ["routing", null, "等等", "ignore"],
    ["run", "r1", "把超时调大", "steer"],
    ["awaiting-answer", "r1", "是", "answer"],
    ["gate", "r1", "a", "gate"],
  ];
  it("⑤ 各 phase 输入落到正确目标", () => {
    for (const [phase, runId, text, target] of cases) {
      expect(routeUserInput(phase, runId, text).target).toBe(target);
    }
  });
  it("⑤b 未完循环：继续→resume，无挂起/非精确关键词/运行中不误触（v1.7）", () => {
    expect(routeUserInput("idle", null, "继续", true).target).toBe("resume");
    expect(routeUserInput("idle", null, "continue", true).target).toBe("resume");
    expect(routeUserInput("idle", null, "继续", false).target).toBe("start"); // 无挂起：当新需求
    expect(routeUserInput("idle", null, "继续于上次", true).target).toBe("start"); // 非精确关键词不当恢复
    expect(routeUserInput("run", "r1", "继续", true).target).toBe("steer"); // 运行中仍是插话
  });
  it("⑥ 门禁期非命令输入 → gate-hint；空输入忽略", () => {
    const r = routeUserInput("gate", "r1", "看看再说");
    expect(r.target).toBe("gate-hint");
    expect(r.hint).toContain("a 批准");
    expect(routeUserInput("idle", null, "   ").target).toBe("ignore");
  });
});
