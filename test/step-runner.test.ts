import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashExecResult, cachedServices, checkArtifacts, composePrompt, createPiStepRunner, crossCheckEvidence, extractQuestions, masksExitCode, parseResult, setSessionFactoryForTest, toolDetail, type SessionLike } from "../src/agent/step-runner";
import type { CommandEvidence, StepSpec } from "../src/types";

function fakeSession(finalText: string, opts: { deltas?: string[]; id?: string; streamEvents?: { type: string; delta?: string; toolCall?: { name?: string; arguments?: unknown } }[]; toolEvents?: unknown[] } = {}): SessionLike {
  const subs: ((e: unknown) => void)[] = [];
  const prompts: string[] = [];
  let disposed = false;
  return {
    id: opts.id,
    async prompt(text: string) {
      prompts.push(text);
      for (const d of opts.deltas ?? []) for (const s of subs) s({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: d } });
      for (const ev of opts.streamEvents ?? []) for (const s of subs) s({ type: "message_update", assistantMessageEvent: ev });
      for (const ev of opts.toolEvents ?? []) for (const s of subs) s(ev);
    },
    subscribe(cb) {
      subs.push(cb);
      return () => void subs.splice(subs.indexOf(cb), 1);
    },
    getLastAssistantText: () => finalText,
    dispose: () => {
      disposed = true;
    },
    // 测试钩子
    ...({ prompts, get disposed() { return disposed; } } as object),
  } as SessionLike;
}

const spec: StepSpec = {
  state: "DESIGN",
  instruction: "# 状态任务：写 design.md\n# 需求：定时发布",
  methodology: ["方法论:DESIGN"],
  preamble: "常驻约束",
  workingDir: "/tmp/blog",
};

describe("step-runner", () => {
  it("① 事件转发（text_delta→step 流）与 ❓ 问题识别", async () => {
    const s = fakeSession("❓ 时区按什么算？\n已完成\n```yaml\nok: true\nsummary: 设计完成\nartifacts: []\nevidence: []\n```", { deltas: ["正在", "写设计"] });
    setSessionFactoryForTest(async () => s);
    try {
      const events: { type: string; delta?: string; text?: string }[] = [];
      const result = await createPiStepRunner().run(spec, (e) => events.push(e as { type: string; delta?: string }));
      expect(events).toContainEqual({ type: "text", delta: "正在" });
      expect(events).toContainEqual({ type: "text", delta: "写设计" });
      expect(events).toContainEqual({ type: "question", text: "时区按什么算？" });
      expect(result.ok).toBe(true);
      expect(extractQuestions("❓ A?\n❓B?")).toEqual(["A?", "B?"]);
    } finally {
      setSessionFactoryForTest(null);
    }
  });

  it("①b T40 块提取：❓ 引导句吸收紧跟的模板/选项列表（多行问题体）", () => {
    // 用户实报场景：勾选模板写在引导句下方
    const tmpl = [
      "❓ 请按以下模板勾选回复（默认即推荐值，不同意处改掉即可）：",
      "- [ ] 技术栈：TypeScript + React",
      "- [x] 部署：Vercel",
      "2. 数据库：Postgres",
      "",
      "- [ ] 预算：500 元以内", // 松散列表：空行分隔的列表项继续吸收
      "",
      "以上齐备即进入下一阶段。", // 非列表行：吸收终止
    ].join("\n");
    expect(extractQuestions(tmpl)).toEqual([
      ["请按以下模板勾选回复（默认即推荐值，不同意处改掉即可）：", "- [ ] 技术栈：TypeScript + React", "- [x] 部署：Vercel", "2. 数据库：Postgres", "- [ ] 预算：500 元以内"].join("\n"),
    ]);
    // 引导句后直接普通段落：只取 ❓ 行
    expect(extractQuestions("❓ 时区按什么算？\n普通叙述段落")).toEqual(["时区按什么算？"]);
    // 非问题区的普通列表不被吸收（吸收仅从 ❓ 行开始）；多问题各自成块
    const multi = ["背景：", "- 普通列表", "", "❓ 选 A 还是 B？", "1. A", "2. B", "", "❓ 预算多少？"].join("\n");
    expect(extractQuestions(multi)).toEqual(["选 A 还是 B？\n1. A\n2. B", "预算多少？"]);
  });

  it("② yaml 块解析：evidence/artifacts 结构化", () => {
    const r = parseResult(
      "正文\n```yaml\nok: true\nsummary: 验证通过\nartifacts: [\"design.md\", \"tasks.md\"]\nevidence:\n  - command: npm test\n    exitCode: 0\n    outputTail: 3 passed\n  - command: npm run build\n    exitCode: 1\n    outputTail: error TS123\n```\n后记",
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("验证通过");
    expect(r.artifacts).toEqual(["design.md", "tasks.md"]);
    expect(r.evidence).toHaveLength(2);
    expect(r.evidence[0]).toEqual({ command: "npm test", exitCode: 0, outputTail: "3 passed" });
    expect(r.evidence[1].exitCode).toBe(1);
  });

  it("③ 解析失败降级：不抛异常，ok=false 带截断摘要", () => {
    const r = parseResult("模型没有输出结果块");
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("无法解析结果块");
    expect(r.evidence).toEqual([]);
  });

  it("④ prompt 组装含 preamble/方法论/任务/输出要求", () => {
    const p = composePrompt(spec);
    expect(p).toContain("常驻约束");
    expect(p).toContain("方法论:DESIGN");
    expect(p).toContain("# 状态任务：写 design.md");
    expect(p).toContain("ok: true");
  });

  it("⑤ thinking/toolcall 事件转发 + toolDetail 人读摘要", async () => {
    const s = fakeSession("完成\n```yaml\nok: true\nsummary: s\nartifacts: []\nevidence: []\n```", {
      streamEvents: [
        { type: "thinking_delta", delta: "先看现状" },
        { type: "toolcall_end", toolCall: { name: "bash", arguments: { command: "npm test" } } },
        { type: "toolcall_end", toolCall: { name: "write", arguments: { path: "src/a.ts" } } },
      ],
    });
    setSessionFactoryForTest(async () => s);
    try {
      const events: { type: string; delta?: string; name?: string; detail?: string }[] = [];
      await createPiStepRunner().run(spec, (e) => events.push(e as { type: string; delta?: string }));
      expect(events).toContainEqual({ type: "thinking", delta: "先看现状" });
      expect(events).toContainEqual({ type: "tool", name: "bash", detail: "npm test" });
      expect(events).toContainEqual({ type: "tool", name: "write", detail: "src/a.ts" });
      expect(toolDetail({ command: "a".repeat(100) })).toHaveLength(81);
      expect(toolDetail({ foo: "bar" })).toBe('{"foo":"bar"}');
      expect(toolDetail(null)).toBe("");
    } finally {
      setSessionFactoryForTest(null);
    }
  });

  it("⑥ abort：session.abort 被调后 prompt 拒绝 → aborted 结果（不扣 budget 语义由引擎消费）", async () => {
    let rejectPrompt: ((e: Error) => void) | null = null;
    const s: SessionLike = {
      async prompt() {
        await new Promise<void>((_, rej) => {
          rejectPrompt = rej; // 挂起，abort 时拒绝（模拟真实 session.abort）
        });
        throw new Error("unreachable");
      },
      subscribe: () => () => {},
      getLastAssistantText: () => "",
      dispose: () => {},
      abort: () => {
        rejectPrompt?.(new Error("aborted"));
      },
    };
    setSessionFactoryForTest(async () => s);
    try {
      const runner = createPiStepRunner();
      const p = runner.run(spec, () => {});
      await new Promise((r) => setTimeout(r, 10)); // 等 session 就位
      runner.abort?.();
      const result = await p;
      expect(result.aborted).toBe(true);
      expect(result.ok).toBe(false);
    } finally {
      setSessionFactoryForTest(null);
    }
  });

  it("⑦ 角色模型（契约 16）：implementer/reviewer 传入工厂，无角色跟随交互会话 /model", async () => {
    const seen: (string | undefined)[] = [];
    setSessionFactoryForTest(async (o) => {
      seen.push(o.model);
      return fakeSession("完成\n```yaml\nok: true\nsummary: s\nartifacts: []\nevidence: []\n```", { toolEvents: bashToolEvents("npm test", 0) });
    });
    try {
      const runner = createPiStepRunner({
        models: { implementer: "prov/impl-model", reviewer: "prov/review-model" },
        defaultModel: () => "prov/interactive-model",
      });
      await runner.run({ ...spec, state: "IMPLEMENT", role: "implementer" }, () => {});
      await runner.run({ ...spec, state: "REVIEW", role: "reviewer" }, () => {});
      await runner.run(spec, () => {}); // 无角色→跟随交互会话 /model
      expect(seen[0]).toBe("prov/impl-model");
      expect(seen[1]).toBe("prov/review-model");
      expect(seen[2]).toBe("prov/interactive-model"); // 跟随 /model（优先于 opts.model）
    } finally {
      setSessionFactoryForTest(null);
    }
  });

  it("⑧ 证据机器交叉校验（契约 4）：伪造 exitCode / VERIFY 无真实执行 → fail", async () => {
    // 纯函数：自报与真实不符
    const claimed: CommandEvidence[] = [{ command: "npm test", exitCode: 0, outputTail: "" }];
    const real: CommandEvidence[] = [{ command: "npm test", exitCode: 1, outputTail: "1 failed" }];
    expect(crossCheckEvidence(claimed, real, "VERIFY").ok).toBe(false);
    expect(crossCheckEvidence(claimed, [{ command: "npm test", exitCode: 0, outputTail: "" }], "VERIFY").ok).toBe(true);
    // VERIFY 自报无真实对应 → fail；非验证态放行
    expect(crossCheckEvidence(claimed, [], "VERIFY").ok).toBe(false);
    expect(crossCheckEvidence(claimed, [], "DESIGN").ok).toBe(true);
    // 集成：真实 exit 1 但自报 0 → ok=false
    const s = fakeSession("完成\n```yaml\nok: true\nsummary: 验证通过\nartifacts: []\nevidence:\n  - command: npm test\n    exitCode: 0\n    outputTail: ok\n```", {
      toolEvents: bashToolEvents("npm test", 1, "1 failed"),
    });
    setSessionFactoryForTest(async () => s);
    try {
      const result = await createPiStepRunner().run({ ...spec, state: "VERIFY" }, () => {});
      expect(result.ok).toBe(false);
      expect(result.summary).toContain("证据与真实执行不符");
    } finally {
      setSessionFactoryForTest(null);
    }
  });

  it("⑩ 恒真式/平凡命令识别（A1① + 证据强制 II：拒掩错复合与平凡命令，放行 pipefail 管道与不掩错构造）", () => {
    const deny = [
      "npm test || true",
      "npm test; echo ok",
      "npm test | tee log",
      "echo $(date)",
      "echo `date`",
      "! npm test",
      "npm test &",
      "npm test\nnpm test2",
      "set -o pipefail && npm test || echo fail", // pipefail 前缀不救 ||：仍拒
      "set -o pipefail; npm test | tail -5", // ; 分隔仍拒
      // 平凡命令：恒 exit 0，验收语义为空
      "true",
      ":",
      "pwd",
      "exit 0",
      "echo ok",
      "echo \"构建成功\"",
    ];
    for (const c of deny) expect(masksExitCode(c), c).toBe(true);
    const allow = [
      "npm test",
      "npm test && echo ok",
      "npm test 2>&1",
      "npm test > log.txt",
      "cd sub && npm test",
      "npm test -- --filter=a",
      // 管道 + pipefail 前缀：退出码取最右非零，长输出截断不再一刀切
      "set -o pipefail && npm test 2>&1 | tail -50",
      "set -o pipefail && cat a.txt | grep -c foo",
    ];
    for (const c of allow) expect(masksExitCode(c), c).toBe(false);
  });

  it("⑪ T38/A1① VERIFY 自报复合命令拒绝：`npm test || true` 骗不过交叉校验；非验证态放行", () => {
    const claimed: CommandEvidence[] = [{ command: "npm test || true", exitCode: 0, outputTail: "" }];
    const real: CommandEvidence[] = [{ command: "npm test || true", exitCode: 0, outputTail: "" }];
    const v = crossCheckEvidence(claimed, real, "VERIFY");
    expect(v.ok).toBe(false);
    expect(v.note).toContain("恒真式");
    expect(crossCheckEvidence(claimed, real, "DESIGN").ok).toBe(true); // 非验证态证据仅参考
  });

  it("⑫ T38/A1② pinned 验收命令覆盖强制：未执行/未通过/齐全三种情形", () => {
    const pinned = ["node test.js"];
    // 未真实执行 → fail
    expect(crossCheckEvidence([], [], "VERIFY", pinned).ok).toBe(false);
    // 真实执行但 exit 1 → fail（未通过）
    const failed = crossCheckEvidence([{ command: "node test.js", exitCode: 1, outputTail: "" }], [{ command: "node test.js", exitCode: 1, outputTail: "" }], "VERIFY", pinned);
    expect(failed.ok).toBe(false);
    expect(failed.note).toContain("未通过");
    // 齐全且 exit 0 → pass
    const good = crossCheckEvidence([{ command: "node test.js", exitCode: 0, outputTail: "" }], [{ command: "node test.js", exitCode: 0, outputTail: "" }], "VERIFY", pinned);
    expect(good.ok).toBe(true);
  });

  it("⑬ checkArtifacts：自报产物在解析根下存在且非空才放行（绝对/相对路径；空文件多为写入失败残留）", () => {
    const root = join(tmpdir(), `genpi-t38-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, "run"), { recursive: true });
    writeFileSync(join(root, "run", "design.md"), "# 设计");
    writeFileSync(join(root, "run", "empty.md"), ""); // 空文件：存在但无内容
    try {
      expect(checkArtifacts(["design.md"], [join(root, "run")]).ok).toBe(true);
      expect(checkArtifacts(["missing.md"], [join(root, "run")]).ok).toBe(false);
      expect(checkArtifacts(["empty.md"], [join(root, "run")]).ok).toBe(false); // 非空补强
      expect(checkArtifacts([join(root, "run", "design.md")], []).ok).toBe(true); // 绝对路径直接查
      expect(checkArtifacts(["empty.md"], [join(root, "run")]).note).toContain("不存在或为空");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("⑭ T38 集成：自报产物不存在 → step fail；存在 → pass 且携带 usage（D6 聚合）", async () => {
    const root = join(tmpdir(), `genpi-t38b-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, "run"), { recursive: true });
    const yaml = "```yaml\nok: true\nsummary: 完成\nartifacts:\n  - design.md\nevidence: []\n```";
    const usageEvents = [
      { type: "message_end", message: { role: "assistant", usage: { input: 1000, output: 200 } } },
      { type: "message_end", message: { role: "assistant", usage: { input: 500, output: 100 } } },
    ];
    try {
      const missing = fakeSession(yaml, { toolEvents: usageEvents });
      setSessionFactoryForTest(async () => missing);
      let result = await createPiStepRunner().run({ ...spec, artifactRoots: [join(root, "run")] }, () => {});
      expect(result.ok).toBe(false);
      expect(result.summary).toContain("自报产物不存在");
      expect(result.usage).toEqual({ input: 1500, output: 300 }); // 校验失败也聚合用量（失败重跑也是成本）

      writeFileSync(join(root, "run", "design.md"), "# 设计");
      const present = fakeSession(yaml, { toolEvents: usageEvents });
      setSessionFactoryForTest(async () => present);
      result = await createPiStepRunner().run({ ...spec, artifactRoots: [join(root, "run")] }, () => {});
      expect(result.ok).toBe(true);
      expect(result.usage).toEqual({ input: 1500, output: 300 });
    } finally {
      setSessionFactoryForTest(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("⑮ P1/#1 真实 SDK 事件形状钉子（契约 4/codemode）：嵌套 bash 调用照发 tool_execution_*（带 parentToolCallId），exitCode 在 structuredContent.exit_code——采集按真实形状工作", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const root = join(tmpdir(), `genpi-t-nested-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, "home", ".genpi"), { recursive: true });
    mkdirSync(join(root, "cwd"), { recursive: true });
    try {
      const services = await pi.createAgentSessionServices({
        cwd: join(root, "cwd"),
        agentDir: join(root, "home", ".genpi"),
        resourceLoaderOptions: { extensionFactories: [pi.createCodemodeExtension()] },
      });
      const { session } = await pi.createAgentSessionFromServices({
        services,
        sessionManager: pi.SessionManager.create(join(root, "cwd"), join(root, "home", ".genpi", "sessions")),
      });
      const events: { type?: string; toolName?: string; toolCallId?: string; parentToolCallId?: string; args?: { command?: string }; result?: unknown }[] = [];
      const unsub = session.subscribe((e) => events.push(e as never));
      // 注入 assistant message：runToolCall 管道要求存在发起方消息（SDK 公开赋值面）
      session.agent.state.messages = [{ role: "assistant", content: [{ type: "text", text: "probe" }] }] as never;
      // 经真实嵌套管道执行 bash（codemode 脚本内 tools.bash 即走此路径；_executeNestedToolCall 为 SDK 内部入口，
      // 无公开 API 驱动——此测试钉住其对外可观测行为，SDK 升级改形状会在此红灯）
      const nested = session as unknown as { _executeNestedToolCall: (parentId: string, name: string, args: unknown) => Promise<unknown> };
      await nested._executeNestedToolCall("call_probe", "bash", { command: "echo nested-ok" });
      await nested._executeNestedToolCall("call_probe", "bash", { command: "exit 3" });
      unsub();

      const ends = events.filter((e) => e.type === "tool_execution_end" && e.toolName === "bash");
      expect(ends).toHaveLength(2);
      expect(ends.every((e) => e.parentToolCallId === "call_probe")).toBe(true); // 嵌套标记（codemode 场景）
      // 采集逻辑对真实形状生效：exit 0 与非零 exit 3 都可读
      expect(bashExecResult(ends[0]?.result)).toEqual({ exitCode: 0, output: "nested-ok\n" });
      expect(bashExecResult(ends[1]?.result).exitCode).toBe(3);
      // 旧顶层形状兼容（防 SDK 形状回退/演进时静默丢证据）
      expect(bashExecResult({ exitCode: 0, output: "x" })).toEqual({ exitCode: 0, output: "x" });
      expect(bashExecResult(undefined)).toEqual({});
      await session.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("⑯ P2/#3 services 缓存：同 key 只建一次（含并发 Promise 级去重），失败驱逐可重试", async () => {
    const cache = new Map<string, Promise<{ id: number }>>();
    let next = 0;
    let fail = false;
    const create = async (): Promise<{ id: number }> => {
      if (fail) throw new Error("boom");
      return { id: next++ };
    };
    const a = await cachedServices(cache, "k", create);
    const b = await cachedServices(cache, "k", create);
    expect(a).toBe(b); // 同 key 复用同一实例
    expect(next).toBe(1);
    const [c, d] = await Promise.all([cachedServices(cache, "k2", create), cachedServices(cache, "k2", create)]);
    expect(c).toBe(d); // 并发去重：同一 Promise
    expect(next).toBe(2);
    fail = true;
    await expect(cachedServices(cache, "k3", create)).rejects.toThrow("boom");
    expect(cache.has("k3")).toBe(false); // 失败驱逐
    fail = false;
    await expect(cachedServices(cache, "k3", create)).resolves.toEqual({ id: 2 }); // 可重试
  });

  it("⑰ P3/#5 证据缺 exitCode 字段：VERIFY 报「结果块格式不完整」而非误导性「与真实执行不符」", () => {
    const malformed = [{ command: "npm test" }] as unknown as CommandEvidence[]; // 缺 exitCode
    const r = crossCheckEvidence(malformed, [{ command: "npm test", exitCode: 0, outputTail: "" }], "VERIFY");
    expect(r.ok).toBe(false);
    expect(r.note).toContain("缺 exitCode 字段");
    expect(r.note).toContain("格式不完整");
    // 非 VERIFY 态不因格式拒（证据仅参考）：放行
    expect(crossCheckEvidence(malformed, [], "RESEARCH").ok).toBe(true);
  });

  it("⑱ ESC 中断回归：pi abort 让 prompt 正常 resolve（非抛错）且无 assistant 文本 → 返回 aborted 而非 TypeError", async () => {
    // 模拟 pi 真实行为：abort() 不抛 AbortError，回合优雅中止，prompt() 平静 resolve；
    // 等首 token 窗口中断时 getLastAssistantText()=undefined——旧代码 extractQuestions(undefined).split 抛
    const s: SessionLike = {
      async prompt() {
        await new Promise((r) => setTimeout(r, 40));
      },
      subscribe: () => () => {},
      getLastAssistantText: () => undefined as never,
      dispose: () => {},
      abort: () => {},
    };
    setSessionFactoryForTest(async () => s);
    try {
      const runner = createPiStepRunner();
      const p = runner.run(spec, () => {});
      await new Promise((r) => setTimeout(r, 5)); // 等 factory 完成、active 已设、prompt 进行中
      expect(runner.abort).toBeDefined();
      runner.abort!();
      const r = await p;
      expect(r.aborted).toBe(true); // resolve 式中断同样认账
      expect(r.ok).toBe(false);
      // 无中断但无 assistant 文本：优雅 fail（无法解析结果块）而非崩
      const runner2 = createPiStepRunner();
      const r2 = await runner2.run(spec, () => {});
      expect(r2.aborted).toBeUndefined();
      expect(r2.ok).toBe(false);
      expect(r2.summary).toContain("无法解析结果块");
    } finally {
      setSessionFactoryForTest(null);
    }
  });
});

/** 构造 bash 真实执行事件对（start+end）。 */
function bashToolEvents(command: string, exitCode: number, output = "done"): unknown[] {
  // P1/#1：对齐真实 SDK 形状——exitCode/output 在 result.structuredContent（snake_case），不在顶层
  // （旧 mock 造的顶层形状与真实不符，掩盖了采集 bug）
  return [
    { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command } },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { structuredContent: { exit_code: exitCode, output, truncated: false } } },
  ];
}
