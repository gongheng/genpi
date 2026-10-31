import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildResourceLoader } from "../src/agent/step-runner";

const dirs: string[] = [];
function mkd(): string {
  const d = mkdtempSync(join(tmpdir(), "genpi-ext-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("内联扩展工厂（编程注入 seam，非用户扩展入口——用户扩展经 genpi ext 安装）", () => {
  it("① 内联扩展工厂被 pi 装载（<inline: 注册）", async () => {
    const loader = await buildResourceLoader({
      cwd: mkd(),
      agentDir: join(mkd(), ".genpi"),
      extensionFactories: [
        (pi) => {
          pi.on("agent_start", () => {});
        },
      ],
    });
    await loader.reload();
    const res = loader.getExtensions();
    expect(res.extensions.some((e) => e.path.startsWith("<inline:"))).toBe(true);
  });

  it("② 无扩展时 reload 正常，无 inline 注册、无错误冒泡", async () => {
    const agentHome = mkd();
    mkdirSync(join(agentHome, ".genpi"), { recursive: true });
    const loader = await buildResourceLoader({ cwd: mkd(), agentDir: join(agentHome, ".genpi") });
    await loader.reload();
    const res = loader.getExtensions();
    expect(res.extensions.some((e) => e.path.startsWith("<inline:"))).toBe(false);
  });

  it("③ bindExtensions 每次调用都 emit session_start（T21 前提：欢迎守卫的理由）", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const agentHome = mkd();
    const cwd = mkd();
    let fired = 0;
    const factory = (ext: { on: (e: "session_start", h: () => void) => void }) => {
      ext.on("session_start", () => {
        fired += 1;
      });
    };
    const services = await pi.createAgentSessionServices({
      cwd,
      agentDir: agentHome,
      resourceLoaderOptions: { extensionFactories: [factory as never] },
    });
    const { session } = await pi.createAgentSessionFromServices({
      services,
      sessionManager: pi.SessionManager.create(cwd, join(agentHome, "sessions")),
    });
    expect(fired).toBe(0); // 建会话不等于启动：事件由 bindExtensions 驱动
    await session.bindExtensions({ mode: "print" });
    expect(fired).toBe(1); // 首次 bind（TUI init 路径）
    await session.bindExtensions({ mode: "print" }); // 信任授予/重载路径的再 bind
    expect(fired).toBe(2); // 平台每次都重发——genpi 侧必须幂等（app.ts booted 守卫）
    await session.dispose();
  });
});
