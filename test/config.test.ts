import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyDataRoot, hasCredentials, resolveConfig } from "../src/config";

const dirs: string[] = [];
function mkd(): string {
  const d = mkdtempSync("genpi-t2-");
  dirs.push(d);
  return d;
}
function mkdtempSync(prefix: string): string {
  const d = join(tmpdir(), `${prefix}${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("config", () => {
  it("① 仅默认值：github/feature//.worktrees/3", () => {
    const home = mkd();
    const project = mkd();
    const cfg = resolveConfig(project, join(home, ".genpi"));
    expect(cfg.mrTarget).toBe("github");
    expect(cfg.branchPrefix).toBe("feature/");
    expect(cfg.worktreeDir).toBe(".worktrees/");
    expect(cfg.budget).toBe(3);
  });

  it("② ~/.genpi/settings.json 覆盖 budget=5", () => {
    const home = mkd();
    const project = mkd();
    mkdirSync(join(home, ".genpi"), { recursive: true });
    writeFileSync(join(home, ".genpi", "settings.json"), JSON.stringify({ budget: 5, mrTarget: "gitee" }));
    const cfg = resolveConfig(project, join(home, ".genpi"));
    expect(cfg.budget).toBe(5);
    expect(cfg.mrTarget).toBe("gitee");
  });

  it("③ 项目 .genpi/config.json 最高优先：budget=2", () => {
    const home = mkd();
    const project = mkd();
    mkdirSync(join(home, ".genpi"), { recursive: true });
    writeFileSync(join(home, ".genpi", "settings.json"), JSON.stringify({ budget: 5 }));
    mkdirSync(join(project, ".genpi"), { recursive: true });
    writeFileSync(join(project, ".genpi", "config.json"), JSON.stringify({ budget: 2, models: { implementer: "anthropic/claude-sonnet-4-5" } }));
    const cfg = resolveConfig(project, join(home, ".genpi"));
    expect(cfg.budget).toBe(2);
    expect(cfg.models.implementer).toBe("anthropic/claude-sonnet-4-5");
  });

  it("④ applyDataRoot 设 PI_CODING_AGENT_DIR 并返回路径", () => {
    const home = mkd();
    const agentDir = applyDataRoot(home);
    expect(agentDir).toBe(join(home, ".genpi"));
    expect(process.env.PI_CODING_AGENT_DIR).toBe(join(home, ".genpi"));
  });

  it("⑤ 空/缺失 auth.json → 无凭证；环境变量凭证同样可用（v1.6）", () => {
    const home = mkd();
    const agentDir = join(home, ".genpi");
    expect(hasCredentials(agentDir)).toBe(false);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), "");
    expect(hasCredentials(agentDir)).toBe(false);
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ providers: {} }));
    expect(hasCredentials(agentDir)).toBe(true);
    // 环境变量凭证（pi 原生支持）：无 auth.json 也可用，不被误拦
    const bare = mkd();
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      expect(hasCredentials(join(bare, ".genpi"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
