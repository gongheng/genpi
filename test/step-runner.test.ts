import { describe, expect, it } from "vitest";
import { composePrompt, createPiStepRunner, crossCheckEvidence, extractQuestions, parseResult, setSessionFactoryForTest, toolDetail, type SessionLike } from "../src/agent/step-runner";
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
});

/** 构造 bash 真实执行事件对（start+end）。 */
function bashToolEvents(command: string, exitCode: number, output = "done"): unknown[] {
  return [
    { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command } },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { exitCode, output } },
  ];
}
