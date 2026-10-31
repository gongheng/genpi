import { describe, expect, it } from "vitest";
import {
  applyDelta,
  createStepLiveState,
  fmtRoute,
  fmtStepDigest,
  formatHistoryLines,
  gateHint,
  renderGateBlock,
  renderHeader,
  renderStepLiveView,
  renderWelcome,
  stepFlushText,
  stripAnsi,
  stripResultBlock,
} from "../src/tui/screens";

describe("chat screens（无选项语义）", () => {
  it("头部含版本/目录/git 状态与最少按键提示", () => {
    const out = renderHeader({ version: "genpi 0.1.0", projectDir: "/tmp/blog", hasGit: true });
    expect(out).toContain("genpi");
    expect(out).toContain("/tmp/blog");
    expect(out).toContain("git ✓");
    expect(out).toContain("Ctrl-C");
  });

  it("欢迎消息不出现编号/前缀/路径选项", () => {
    const out = renderWelcome();
    expect(out).toContain("genpi");
    expect(out).not.toMatch(/1\/2\/3|前缀|\[1\]|\[2\]|\[3\]/);
  });

  it("路线行是进度信息而非选择提示", () => {
    const out = fmtRoute("feature", "新功能", "model");
    expect(out).toContain("feature");
    expect(out).toContain("模型判断");
  });

  it("路线行展示 tier/豁免/标题（契约 20/21、T22/T23）：豁免仅对有 CLARIFY 的链路显示", () => {
    const out = fmtRoute("feature", "微改动", "model", { tier: "t0", waive: true });
    expect(out).toContain("T0");
    expect(out).not.toContain("豁免澄清"); // T0 短链无 CLARIFY，不显示无效豁免（T23 自洽性修复）
    const w1 = fmtRoute("feature", "常规", "model", { tier: "t1", waive: true });
    expect(w1).toContain("豁免澄清"); // t1 全链真豁免了澄清
    expect(fmtRoute("research", "调研", "model", { tier: "t1", waive: true })).not.toContain("豁免澄清"); // research 无 CLARIFY
    const t2 = fmtRoute("feature", "高风险", "model", { tier: "t2" });
    expect(t2).toContain("T2");
    expect(fmtRoute("feature", "新功能", "model", { tier: "t1", waive: false })).not.toContain("T1"); // 默认不打扰
    expect(fmtRoute("feature", "新功能", "model", { tier: "t1", waive: false, title: "抽取通用开发框架" })).toContain("「抽取通用开发框架」"); // 标题随路线行展示（T22）
    expect(fmtRoute("research", "深入", "model", { tier: "t1", waive: false, followUp: true })).toContain("承接上一轮"); // 契约 24：承接可见
  });

  it("门禁块紧凑不刷屏：无产物正文，含 a/c/r/p 命令说明", () => {
    const out = renderGateBlock({ gate: "GATE_DESIGN", artifact: "design.md（23 行）" });
    expect(out).toContain("GATE_DESIGN");
    expect(out).toContain("design.md（23 行）");
    expect(out).not.toContain("# 设计"); // 不倒产物正文（防刷屏）
    expect(out.split("\n")).toHaveLength(2); // 紧凑两行
    expect(out).toMatch(/a 批准/);
    expect(out).toMatch(/c <修改意见>/);
    expect(gateHint()).toContain("r 终止");
    expect(gateHint()).toContain("p 预览"); // 预览按需拉取
    // T26：首门禁教学一次，后续门禁 1 行化（无 hint 行）
    const collapsed = renderGateBlock({ gate: "GATE_MR", artifact: "MR 变更摘要" }, false);
    expect(collapsed.split("\n")).toHaveLength(1);
    expect(collapsed).toContain("GATE_MR");
    expect(collapsed).not.toMatch(/a 批准/); // 教学不重复
  });

  it("⑧ /genpi log 历史格式化（T30）：一行一事件，坏行跳过，空史提示", () => {
    const raw = [
      JSON.stringify({ ts: "2026-10-31T09:00:00.000Z", from: "INIT", to: "CLARIFY", event: "init" }),
      "not-json",
      JSON.stringify({ ts: "2026-10-31T09:01:02.000Z", from: "VERIFY", to: "DEBUG", event: "verify_fail_debug", budgetLeft: 2, note: "退出码 1" }),
    ];
    const out = formatHistoryLines(raw, 10);
    expect(out).toContain("09:00:00 INIT→CLARIFY init");
    expect(out).toContain("09:01:02 VERIFY→DEBUG verify_fail_debug budget=2 · 退出码 1");
    expect(out).not.toContain("not-json"); // 坏行跳过不崩
    expect(formatHistoryLines([], 10)).toBe("（无历史记录）");
  });

  it("步末一行摘要（T26）：✓/✗ + summary 首行截 40 字；无摘要只留状态", () => {
    expect(fmtStepDigest("DESIGN", true, "已写 design.md（23 行）\n含行为契约三节")).toBe("✓ DESIGN · 已写 design.md（23 行）");
    expect(fmtStepDigest("VERIFY", false, "测试未过：3 failed")).toBe("✗ VERIFY · 测试未过：3 failed");
    expect(fmtStepDigest("CLARIFY", true)).toBe("✓ CLARIFY");
    expect(fmtStepDigest("PLAN", true, "\n\n  空行开头\n第二行")).toBe("✓ PLAN · 空行开头"); // 跳过空行取首个非空行
    const long = "x".repeat(60);
    expect(fmtStepDigest("IMPL", true, long).length).toBeLessThanOrEqual("✓ IMPL · ".length + 40); // 截 40
  });
});

describe("步骤实时视图（思考/工具/文本，修复碎片单字堆叠）", () => {
  it("⑤ 逐字符增量按行缓冲：无换行全在 partial，渲染不再单字成行", () => {
    const s = createStepLiveState("CLARIFY");
    for (const ch of "类似这种：与当前 run 状态：") applyDelta(s, "text", ch);
    expect(s.text).toEqual([]);
    expect(s.textPartial).toBe("类似这种：与当前 run 状态：");
    applyDelta(s, "text", "\n先看仓库现状");
    expect(s.text).toEqual(["类似这种：与当前 run 状态："]);
    const view = renderStepLiveView(s, 60).map(stripAnsi);
    expect(view.join("\n")).toContain("CLARIFY");
    expect(view.join("\n")).toContain("类似这种：与当前 run 状态：");
    const body = view.slice(1).filter((l) => l.trim());
    expect(body.some((l) => l.trim().length <= 2)).toBe(false); // 无单字独行
  });

  it("⑥ 产物信息不入屏：结尾 yaml 结果块被剥离（渲染与归档均不含）", () => {
    const s = createStepLiveState("VERIFY");
    applyDelta(s, "text", "验证通过，3 个用例全绿。\n```yaml\nok: true\nsummary: 验证通过\nartifacts: []\nevidence:\n  - command: npm test\n    exitCode: 0\n```\n");
    const view = renderStepLiveView(s, 80).map(stripAnsi).join("\n");
    expect(view).toContain("验证通过，3 个用例全绿。");
    expect(view).not.toContain("```yaml");
    expect(view).not.toContain("artifacts");
    const flushed = stepFlushText(s);
    expect(flushed).toBe("验证通过，3 个用例全绿。");
    expect(stripResultBlock("```yaml\nok: true\n```")).toBe(""); // 开头即结果块
  });

  it("⑦ 思考为主、工具聚合：工具一行计数不入详情，思考 6 行封顶", () => {
    const s = createStepLiveState("IMPLEMENT");
    applyDelta(s, "thinking", "先看测试文件结构\n再决定改哪里\n");
    applyDelta(s, "text", "开始修改");
    s.tools.push({ name: "bash", detail: "npm test" }, { name: "write", detail: "src/a.ts" }, { name: "bash", detail: "npm run build" });
    const view = renderStepLiveView(s, 80).map(stripAnsi).join("\n");
    expect(view).toContain("IMPLEMENT");
    expect(view).toContain("思考");
    expect(view).toContain("先看测试文件结构");
    expect(view).toContain("bash×2 · write×1"); // 聚合计数一行（T25）
    expect(view).not.toContain("npm test"); // 工具详情不入屏（用户关注思考而非工具）
    expect(view).toContain("开始修改");
    for (let i = 0; i < 40; i++) applyDelta(s, "thinking", `思考行${i}\n`);
    const tail = renderStepLiveView(s, 80);
    expect(tail.filter((l) => l.includes("思考行")).length).toBeLessThanOrEqual(6); // 视觉行封顶（T25：4→6）
  });
});
