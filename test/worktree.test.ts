import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitOps, createShellExec, normalizeCompareUrl } from "../src/engine/worktree";

const dirs: string[] = [];
function mkd(prefix: string): string {
  const d = join(tmpdir(), `genpi-t5-${prefix}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) {
    try {
      execSync(`git -C ${JSON.stringify(d)} worktree prune || true`);
    } catch {
      /* ignore */
    }
    rmSync(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});

import { execSync } from "node:child_process";
function sh(cmd: string, cwd?: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
}

function makeRepo(): { project: string; bare: string } {
  const project = mkd("proj");
  const bare = mkd("bare");
  sh(`git init --bare "${bare}"`);
  sh(`git init -b main`, project);
  sh(`git config user.email t@t && git config user.name t`, project);
  writeFileSync(join(project, "README.md"), "# demo\n");
  sh(`git add -A && git commit -m init`, project);
  sh(`git remote add origin "${bare}" && git push -u origin main`, project);
  return { project, bare };
}

describe("worktree + MR", () => {
  it("① worktree 建立：主工作树零污染、分支带前缀，返回基线 sha（契约 5）", async () => {
    const { project } = makeRepo();
    const exec = createShellExec();
    const ops = createGitOps(exec);
    const runId = "20260214-1430-feature-demo";
    const wt = await ops.ensureWorktree(project, runId, "feature/", ".worktrees/");
    expect(existsSync(wt.path)).toBe(true);
    expect(wt.path).toBe(join(project, ".worktrees", runId));
    expect(wt.baseSha).toMatch(/^[0-9a-f]{7,40}$/); // 基线 commit（GATE_MR 预览用）
    const branches = execSync(`git -C ${JSON.stringify(project)} branch --list`, { encoding: "utf8" });
    expect(branches).toContain(`feature/${runId}`);
    const status = execSync(`git -C ${JSON.stringify(project)} status --porcelain --untracked-files=no`, { encoding: "utf8" });
    expect(status.trim()).toBe(""); // 主工作树 tracked 文件零污染（.worktrees/ 未入 gitignore 属设计内，契约 8）
  });

  it("①b mrPreview：提交/变更统计 + 提交完整性警告（零提交/未提交变更）", async () => {
    const { project } = makeRepo();
    const exec = createShellExec();
    const ops = createGitOps(exec);
    const runId = "20260214-1435-feature-preview";
    const wt = await ops.ensureWorktree(project, runId, "feature/", ".worktrees/");
    // 零提交：警告 MR 将为空
    const empty = await ops.mrPreview(wt.path, wt.baseSha);
    expect(empty).toContain("零提交");
    writeFileSync(join(wt.path, "fix.txt"), "fix\n");
    sh(`git add -A && git commit -m "feat: 修复"`, wt.path);
    const preview = await ops.mrPreview(wt.path, wt.baseSha);
    expect(preview).toContain("feat: 修复");
    expect(preview).toContain("变更统计");
    expect(preview).toContain("fix.txt");
    expect(preview).not.toContain("零提交");
    // 未提交变更：警告 push 不包含
    writeFileSync(join(wt.path, "dirty.txt"), "dirty\n");
    const dirty = await ops.mrPreview(wt.path, wt.baseSha);
    expect(dirty).toContain("未提交变更");
    expect(dirty).toContain("dirty.txt");
    expect(await ops.mrPreview(wt.path, "deadbeef")).toBeNull(); // 预览失败不抛错（契约 14 精神）
  });

  it("② 无 gh 时降级 manual + compare URL，run 不失败（契约 14）", async () => {
    const { project } = makeRepo();
    const exec = createShellExec();
    const ops = createGitOps(exec, { ghPath: "/nonexistent/gh" });
    const runId = "20260214-1500-bugfix-x";
    const wt = await ops.ensureWorktree(project, runId, "feature/", ".worktrees/");
    writeFileSync(join(wt.path, "fix.txt"), "fix\n");
    sh(`git add -A && git commit -m fix`, wt.path);
    const r = await ops.pushAndMr(wt.path, { mrTarget: "github", runId, summary: "修复" });
    expect(r.mode).toBe("manual");
    expect(r.url).toContain("compare/feature/");
  });

  it("③ 无远端仓库：manual 且提示本地分支", async () => {
    const project = mkd("solo");
    sh(`git init -b main && git config user.email t@t && git config user.name t`, project);
    writeFileSync(join(project, "a.txt"), "a\n");
    sh(`git add -A && git commit -m init`, project);
    const ops = createGitOps(createShellExec(), { ghPath: "/nonexistent/gh" });
    const wt = await ops.ensureWorktree(project, "20260214-1600-feature-y", "feature/", ".worktrees/");
    writeFileSync(join(wt.path, "b.txt"), "b\n");
    sh(`git add -A && git commit -m b`, wt.path);
    const r = await ops.pushAndMr(wt.path, { mrTarget: "github", runId: "20260214-1600-feature-y", summary: "s" });
    expect(r.mode).toBe("manual");
    expect(r.url).toContain("本地分支");
  });

  it("④ compare URL 规范化（github/gitee）", () => {
    expect(normalizeCompareUrl("git@github.com:alice/blog.git", "feature/x")).toBe(
      "https://github.com/alice/blog/compare/feature/x?expand=1",
    );
    expect(normalizeCompareUrl("https://gitee.com/bob/app.git", "feature/y")).toBe(
      "https://gitee.com/bob/app/compare/feature/y?expand=1",
    );
  });
});
