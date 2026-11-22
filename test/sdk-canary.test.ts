// SDK 金丝雀（制度化）：genpi 依赖的每个 pi SDK 行为，必须有真 SDK（无模型凭证）钉住它的测试——
// SDK 升级改行为在此红灯，而不是用户用出来（本会话三大 bug 全是 mock 想象 ≠ 真实 SDK：
// 证据事件形状 / resolve 式中止 / 旧版裸 ESC 判断）。
// 已有金丝雀（分居各文件，升级 SDK 时同受保护）：
//   - step-runner.test ⑮：tool_execution_* 事件形状（exitCode 在 structuredContent.exit_code，含 codemode 嵌套）
//   - step-runner.test ⑰/⑱：证据缺字段诊断 / resolve 式中止回归（fake 会话钉 genpi 侧行为）
//   - smoke-e2e.mjs：真模型全循环（含真实 abort 语义——需凭证，发布前必跑 npm run smoke:e2e）
// 本文件：无模型可钉的边界——默认工具集 / codemode 激活 / AgentSession 形状 / 模型解析回落。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
function mkd(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("SDK 金丝雀（真实 SDK、无模型——升级 pi 后此文件红灯即行为变更）", () => {
  it("① 默认工具集含 bash/read/edit/write：证据链（契约 4 采集 bash 事件）的前提", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const home = mkd("genpi-canary-home-");
    mkdirSync(join(home, ".genpi"), { recursive: true });
    const cwd = mkd("genpi-canary-cwd-");
    const services = await pi.createAgentSessionServices({ cwd, agentDir: join(home, ".genpi") });
    const { session } = await pi.createAgentSessionFromServices({
      services,
      sessionManager: pi.SessionManager.create(cwd, join(home, ".genpi", "sessions")),
    });
    const tools = session.getActiveToolNames();
    for (const t of ["bash", "read", "edit", "write"]) expect(tools, `缺工具 ${t}`).toContain(t);
    await session.dispose();
  });

  it("② codemode 经 setActiveToolsByName 增量激活（T39：注册是 defaultActive:false，genpi 显式装载+激活）", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const home = mkd("genpi-canary-home2-");
    mkdirSync(join(home, ".genpi"), { recursive: true });
    const cwd = mkd("genpi-canary-cwd2-");
    const services = await pi.createAgentSessionServices({
      cwd,
      agentDir: join(home, ".genpi"),
      resourceLoaderOptions: { extensionFactories: [pi.createCodemodeExtension()] },
    });
    const { session } = await pi.createAgentSessionFromServices({
      services,
      sessionManager: pi.SessionManager.create(cwd, join(home, ".genpi", "sessions")),
    });
    expect(session.getActiveToolNames()).not.toContain("codemode"); // 注册≠激活
    session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
    expect(session.getActiveToolNames()).toContain("codemode");
    await session.dispose();
  });

  it("③ AgentSession 满足 SessionLike 形状：prompt/subscribe/getLastAssistantText/dispose/abort 全为函数（SDK 改名即红灯）", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const home = mkd("genpi-canary-home3-");
    mkdirSync(join(home, ".genpi"), { recursive: true });
    const cwd = mkd("genpi-canary-cwd3-");
    const services = await pi.createAgentSessionServices({ cwd, agentDir: join(home, ".genpi") });
    const { session } = await pi.createAgentSessionFromServices({
      services,
      sessionManager: pi.SessionManager.create(cwd, join(home, ".genpi", "sessions")),
    });
    for (const m of ["prompt", "subscribe", "getLastAssistantText", "dispose", "abort"] as const) {
      expect(typeof (session as unknown as Record<string, unknown>)[m], `AgentSession.${m}`).toBe("function");
    }
    await session.dispose();
  });

  it("④ resolveCliModelSafe：假模型解析失败回落 undefined 不抛错（契约 16 回落全局默认的前提）", async () => {
    const { resolveCliModelSafe } = await import("../src/agent/step-runner");
    await expect(resolveCliModelSafe("nonexistent-provider/no-such-model")).resolves.toBeUndefined();
    await expect(resolveCliModelSafe(undefined)).resolves.toBeUndefined();
  });
});
