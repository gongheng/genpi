import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitOps, createShellExec, executeCleanup, normalizeCompareUrl, planCleanup, type ExecFn } from "../src/engine/worktree";

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

  it("⑤ T38/C5 planCleanup：终态且有 worktree 才入列；分支名 = 前缀+runId；dirExists 注入探测", () => {
    const runs = [
      { id: "20260101-1000-feature-a", status: "done", worktree: "/w/a" },
      { id: "20260101-1100-feature-b", status: "rejected", worktree: "/w/b" },
      { id: "20260101-1200-feature-c", status: "stopped", worktree: "/w/c" },
      { id: "20260101-1300-feature-d", status: "active", worktree: "/w/d" }, // 活跃不清
      { id: "20260101-1400-research-e", status: "done" }, // 无 worktree
    ];
    const plan = planCleanup(runs, { worktreeDir: ".worktrees/", branchPrefix: "feature/", existsCheck: (p) => p !== "/w/b" });
    expect(plan.map((e) => e.runId)).toEqual(["20260101-1000-feature-a", "20260101-1100-feature-b", "20260101-1200-feature-c"]);
    expect(plan[0]?.branch).toBe("feature/20260101-1000-feature-a");
    expect(plan[0]?.dirExists).toBe(true);
    expect(plan[1]?.dirExists).toBe(false); // 目录已不存在→仅删分支
  });

  it("⑥ T38/C5 executeCleanup：remove→branch -D→prune；失败降级 --force；单条失败不阻断", async () => {
    const cmds: string[] = [];
    const exec: ExecFn = async (_cwd, cmd) => {
      cmds.push(cmd);
      if (cmd.includes("branch -r --contains")) return { code: 0, out: "origin/main\n" }; // 已推送：可安全清理
      if (cmd.includes('worktree remove "/w/a"')) return { code: 1, out: "dirty" }; // 首次 remove 失败→--force
      if (cmd.includes('branch -D "/w/x-br"')) return { code: 1, out: "no branch" }; // 分支删除失败
      return { code: 0, out: "" };
    };
    const results = await executeCleanup(exec, "/proj", [
      { runId: "a", status: "done", worktree: "/w/a", branch: "feature/a", dirExists: true },
      { runId: "x", status: "done", worktree: "/w/x", branch: "/w/x-br", dirExists: false },
    ]);
    expect(cmds.some((c) => c.includes("worktree remove --force"))).toBe(true);
    expect(cmds.some((c) => c.includes("git worktree prune"))).toBe(true);
    expect(results[0]?.ok).toBe(true); // force 兜底成功
    expect(results[0]?.note).toContain("含未提交变更");
    expect(results[1]?.ok).toBe(false); // 分支删除失败不阻断其余
  });

  it("⑥b P0 防丢：分支未推送远端（含检查命令失败）→ worktree 与分支均保留，note 给出手动出路", async () => {
    const cmds: string[] = [];
    const exec: ExecFn = async (_cwd, cmd) => {
      cmds.push(cmd);
      if (cmd.includes('branch -r --contains "feature/a"')) return { code: 0, out: "" }; // 未被任何远端包含
      if (cmd.includes('branch -r --contains "feature/b"')) return { code: 128, out: "no such commit" }; // 命令失败→保守按未推送
      return { code: 0, out: "" };
    };
    const results = await executeCleanup(exec, "/proj", [
      { runId: "a", status: "stopped", worktree: "/w/a", branch: "feature/a", dirExists: true },
      { runId: "b", status: "done", worktree: "/w/b", branch: "feature/b", dirExists: false },
    ]);
    expect(results.every((r) => !r.ok)).toBe(true); // 两条均保留（需人工确认）
    expect(results[0]?.note).toContain("防丢保留");
    expect(results[0]?.note).toContain("git worktree remove --force"); // 出路可执行
    expect(results[1]?.note).toContain("git branch -D");
    // 不应出现任何删除动作
    expect(cmds.some((c) => c.includes("worktree remove"))).toBe(false);
    expect(cmds.some((c) => c.includes("branch -D"))).toBe(false);
  });

  it("⑦ P0 防丢（真实 git）：未推送分支 clean 保留（worktree+分支），push 后可清", async () => {
    const { project } = makeRepo();
    const exec = createShellExec();
    const ops = createGitOps(exec);
    const runId = "20260214-1700-feature-keep";
    const wt = await ops.ensureWorktree(project, runId, "feature/", ".worktrees/");
    writeFileSync(join(wt.path, "work.txt"), "w\n");
    sh(`git add -A && git commit -m work`, wt.path);
    const plan = () =>
      planCleanup([{ id: runId, status: "stopped", worktree: wt.path }], {
        worktreeDir: ".worktrees/",
        branchPrefix: "feature/",
        existsCheck: (p) => existsSync(p),
      });
    // 未推送：worktree 与分支均保留（stopped 可续跑，提交未上远端）
    const r1 = await executeCleanup(exec, project, plan());
    expect(r1[0]?.ok).toBe(false);
    expect(r1[0]?.note).toContain("防丢保留");
    expect(existsSync(wt.path)).toBe(true);
    expect(execSync(`git -C ${JSON.stringify(project)} rev-parse --verify "feature/${runId}"`, { encoding: "utf8", stdio: "pipe" }).trim()).toMatch(/^[0-9a-f]{7,40}$/);
    // push 后：可清（提交已在远端，--force 只可能丢未提交变更）
    sh(`git -C ${JSON.stringify(wt.path)} push -u origin "feature/${runId}"`);
    const r2 = await executeCleanup(exec, project, plan());
    expect(r2[0]?.ok).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
  });

  it("⑧ P0 resume 补建挂回：目录被清但分支保留时，ensureWorktree 挂回既有分支（created=false，工作不丢）", async () => {
    const { project } = makeRepo();
    const exec = createShellExec();
    const ops = createGitOps(exec);
    const runId = "20260214-1730-feature-reattach";
    const wt1 = await ops.ensureWorktree(project, runId, "feature/", ".worktrees/");
    writeFileSync(join(wt1.path, "w.txt"), "w\n");
    sh(`git add -A && git commit -m w`, wt1.path);
    const tip = execSync(`git -C ${JSON.stringify(wt1.path)} rev-parse HEAD`, { encoding: "utf8", stdio: "pipe" }).trim();
    rmSync(wt1.path, { recursive: true, force: true }); // 模拟目录被清（分支仍在）
    sh(`git -C ${JSON.stringify(project)} worktree prune`);
    const wt2 = await ops.ensureWorktree(project, runId, "feature/", ".worktrees/");
    expect(wt2.created).toBe(false); // 挂回≠新建：不重复依赖引导（T38/C4）
    expect(existsSync(wt2.path)).toBe(true);
    const tip2 = execSync(`git -C ${JSON.stringify(wt2.path)} rev-parse HEAD`, { encoding: "utf8", stdio: "pipe" }).trim();
    expect(tip2).toBe(tip); // 挂回的是既有分支（提交未丢）
  });

  it("⑧b 复用 worktree 补 baseSha：已注册时二次 ensure 返回当前 HEAD（GATE_MR 预览不再退回 HEAD~1 猜基线）", async () => {
    const { project } = makeRepo();
    const ops = createGitOps(createShellExec());
    const runId = "20260214-1800-feature-reuse";
    const wt1 = await ops.ensureWorktree(project, runId, "feature/", ".worktrees/");
    const wt2 = await ops.ensureWorktree(project, runId, "feature/", ".worktrees/"); // 已注册→复用
    expect(wt2.created).toBe(false);
    expect(wt2.baseSha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(wt2.baseSha).toBe(wt1.baseSha); // 未动过的 worktree：HEAD 即基线
  });

  it("⑨ P3 MR 描述富化：bodyFile 走 --body-file；缺省退回 --body 默认文案", async () => {
    const cmds: string[] = [];
    const exec: ExecFn = async (_cwd, cmd) => {
      cmds.push(cmd);
      if (cmd.includes('"gh" pr create')) return { code: 0, out: "https://example.com/pull/7\n" };
      if (cmd.includes('"gh" --version')) return { code: 0, out: "gh version 9.0.0\n" };
      if (cmd.includes("git remote get-url")) return { code: 0, out: "git@github.com:alice/blog.git\n" };
      if (cmd.includes("git rev-parse --abbrev-ref")) return { code: 0, out: "feature/x\n" };
      return { code: 0, out: "" }; // push 等
    };
    const ops = createGitOps(exec, { ghPath: "gh" });
    const r1 = await ops.pushAndMr("/w", { mrTarget: "github", runId: "x", summary: "s", bodyFile: "/run/mr-body.md" });
    expect(r1.mode).toBe("mr");
    expect(r1.url).toContain("pull/7");
    expect(cmds.find((c) => c.includes("pr create"))).toContain('--body-file "/run/mr-body.md"');
    cmds.length = 0;
    const r2 = await ops.pushAndMr("/w", { mrTarget: "github", runId: "x", summary: "s" });
    expect(r2.mode).toBe("mr");
    expect(cmds.find((c) => c.includes("pr create"))).toContain('--body "由 genpi 生成"');
  });
});
