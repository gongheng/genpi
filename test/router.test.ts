import { describe, expect, it } from "vitest";
import { heuristicRoute, parsePrefix, polishTitle, routeRequest } from "../src/router";

describe("router", () => {
  it("① 启发式：research 优先于 bugfix（'调研修复方案'→research）", () => {
    expect(heuristicRoute("调研一下修复方案的取舍").path).toBe("research");
    expect(heuristicRoute("评论提交后列表不刷新").path).toBe("bugfix");
    expect(heuristicRoute("服务启动报错 crash").path).toBe("bugfix");
    expect(heuristicRoute("加一个定时发布功能").path).toBe("feature");
    expect(heuristicRoute("随便一句话").path).toBe("feature");
  });

  it("② 前缀强制：'2 修个bug' → bugfix 且剥离前缀", () => {
    expect(parsePrefix("2 修个 bug")).toEqual({ path: "bugfix", text: "修个 bug" });
    expect(parsePrefix("1 加功能")).toEqual({ path: "feature", text: "加功能" });
    expect(parsePrefix("没有前缀")).toEqual({ text: "没有前缀" });
  });

  it("③ 模型分类成功 → 用模型结果", async () => {
    const r = await routeRequest("帮我修登录报错", async () => ({ path: "bugfix", tier: "t1" as const, waive: false, title: "修复登录报错", reason: "修复类", by: "model" as const }));
    expect(r).toMatchObject({ path: "bugfix", by: "model", text: "帮我修登录报错" });
    expect(r.tier).toBe("t1");
    expect(r.waive).toBe(false);
    expect(r.title).toBe("修复登录报错");
  });

  it("④ 模型失败 → 启发式兜底不阻塞", async () => {
    const r = await routeRequest("调研 SSR 可行性", async () => {
      throw new Error("no creds");
    });
    expect(r).toMatchObject({ path: "research", by: "heuristic" });
  });

  it("⑤ 前缀优先于模型", async () => {
    const r = await routeRequest("3 就要调研", async () => ({ path: "feature", tier: "t1" as const, waive: false, title: "加功能", reason: "模型说", by: "model" as const }));
    expect(r).toMatchObject({ path: "research", by: "prefix" });
  });

  it("⑥ 无 git 目录：feature/bugfix 强制降级 research 并说明原因；prd 只读不降级（契约 22）", async () => {
    const r = await routeRequest("加个搜索功能", async () => ({ path: "feature", tier: "t1" as const, waive: false, title: "加搜索功能", reason: "新功能", by: "model" as const }), {
      allowCodePaths: false,
    });
    expect(r.path).toBe("research");
    expect(r.reason).toContain("无 git");
    expect(r.by).toBe("heuristic");
    const prd = await routeRequest("写份登录 PRD", async () => ({ path: "prd", tier: "t1" as const, waive: false, title: "登录需求文档", reason: "需求文档", by: "model" as const }), {
      allowCodePaths: false,
    });
    expect(prd.path).toBe("prd"); // prd 只读无 worktree，无 git 同样可跑
    // 前缀强制同样受限（无 git 建不了 worktree）
    const p = await routeRequest("1 加功能", undefined, { allowCodePaths: false });
    expect(p.path).toBe("feature"); // 前缀是用户明确意志，不覆盖——但引擎侧 worktree 会失败并给出 git 错误
  });

  it("⑦ prd 关键词路由（契约 22）：写 PRD/需求文档→prd，不影响 research 优先", () => {
    expect(heuristicRoute("写份登录功能的 PRD").path).toBe("prd");
    expect(heuristicRoute("出一份移动端需求文档").path).toBe("prd");
    expect(heuristicRoute("调研一下登录方案").path).toBe("research"); // research 优先级仍最高
  });

  it("⑧ 前缀 4 强制 prd 且剥离前缀", () => {
    expect(parsePrefix("4 写登录 PRD")).toEqual({ path: "prd", text: "写登录 PRD" });
  });

  it("⑨ tier 启发式（契约 20）：默认 t1；微改动 t0；高风险 t2；存疑就高", () => {
    expect(heuristicRoute("加一个定时发布功能").tier).toBe("t1");
    expect(heuristicRoute("补个测试盖住登录分支").tier).toBe("t0");
    expect(heuristicRoute("改下首页文案错别字").tier).toBe("t0");
    expect(heuristicRoute("给登录接入 OAuth 认证").tier).toBe("t2");
    expect(heuristicRoute("用户表数据迁移到新库").tier).toBe("t2");
    expect(heuristicRoute("给认证模块补个测试").tier).toBe("t2"); // t2 判定优先于 t0（存疑就高）
  });

  it("⑩ CLARIFY 豁免启发式（契约 21）：附验收/复现证据→waive", () => {
    expect(heuristicRoute("加导出功能，验收标准：导出 csv 打开正常").waive).toBe(true);
    expect(heuristicRoute("修复崩溃，复现步骤：点提交两次").waive).toBe(true);
    expect(heuristicRoute("随便一句话").waive).toBe(false); // 默认不豁免，行为与 v1.8 一致
  });

  it("⑪ 需求标题（T22）：本地修饰兑底；模型/前缀分支均出 title；原话不再直接成 runId", async () => {
    expect(polishTitle("我要抽取一个通用框架出来，我后续开发新项目")).toBe("抽取一个通用框架出来");
    expect(polishTitle("帮我修登录报错")).toBe("修登录报错");
    expect(polishTitle("现在什么进度")).toBe("什么进度");
    expect(polishTitle("add login page with oauth now")).toBe("add login page"); // 首语义段截 16
    expect(polishTitle("")).toBe(""); // 空输入兑底不炸
    // 模型分支：mock 返回 title 透传；title 行缺失→本地修饰兑底
    const m = await routeRequest("调研登录方案", async () => ({ path: "research", tier: "t1" as const, waive: false, title: "登录方案调研", reason: "调研", by: "model" as const }));
    expect(m.title).toBe("登录方案调研");
    const lost = await routeRequest("调研登录方案", async () => ({ path: "research", tier: "t1" as const, waive: false, title: "", reason: "调研", by: "model" as const }));
    expect(lost.title).toBe(polishTitle("调研登录方案"));
    // 前缀分支：剥离前缀后本地修饰
    const p = await routeRequest("1 帮我加个登录页");
    expect(p.title).toBe("加个登录页");
  });

  it("⑫ chat 第五出口（T27）：问候/闲聊放行原生会话，不建 run；工作意图不受误伤", () => {
    expect(heuristicRoute("你好").path).toBe("chat");
    expect(heuristicRoute("谢谢！").path).toBe("chat");
    expect(heuristicRoute("ok").path).toBe("chat");
    expect(heuristicRoute("辛苦了~").path).toBe("chat");
    expect(heuristicRoute("好的，帮我修一下登录").path).toBe("bugfix"); // 含工作意图不误伤（非整句匹配）
    expect(heuristicRoute("你好，我要加个登录页").path).toBe("feature");
    expect(heuristicRoute("帮我看看这个函数什么意思").path).not.toBe("chat"); // 启发式保守：语义判断交给模型
  });

  it("⑬ chat 模型分支与边界：无 git 不降级、前缀强制优先", async () => {
    const m = await routeRequest("在吗", async () => ({ path: "chat", tier: "t1" as const, waive: false, title: "闲聊", reason: "闲聊", by: "model" as const }));
    expect(m.path).toBe("chat");
    const nogit = await routeRequest("你好", async () => ({ path: "chat", tier: "t1" as const, waive: false, title: "闲聊", reason: "闲聊", by: "model" as const }), { allowCodePaths: false });
    expect(nogit.path).toBe("chat"); // chat 与路径无关，无 git 同样放行
    expect((await routeRequest("3 你好")).path).toBe("research"); // 前缀是明确意志，优先于 chat 判定
  });

  it("⑭ followUp 承接判定（契约 24/A）：指代词+存在上轮才承接；无上轮永不承接；模型分支透传", async () => {
    const lastRun = { runId: "20261031-0900-research-x", request: "调研登录方案" };
    const h = await routeRequest("深入这个方案的并发部分", async () => { throw new Error("no"); }, { lastRun });
    expect(h.followUp).toBe(true); // 兜底：指代词命中 + 有上轮
    const h2 = await routeRequest("全新需求加个搜索", async () => { throw new Error("no"); }, { lastRun });
    expect(h2.followUp).toBeUndefined(); // 无指代不承接
    const n = await routeRequest("深入这个方案", async () => { throw new Error("no"); });
    expect(n.followUp).toBeUndefined(); // 无上轮：永不承接
    const m = await routeRequest("接着上面做", async () => ({ path: "feature", tier: "t1" as const, waive: false, title: "承接", followUp: true, reason: "承接", by: "model" as const }), { lastRun });
    expect(m.followUp).toBe(true); // 模型分支透传
  });
});
