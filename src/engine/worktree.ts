// worktree 隔离与 MR 动作（契约 5/8/14）：git 隔离强制；MR 失败降级不失败 run
import { exec as nodeExec } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitOps } from "./loop-engine";

const pexec = promisify(nodeExec);

export interface ExecResult {
  code: number;
  out: string;
}
export type ExecFn = (cwd: string, cmd: string) => Promise<ExecResult>;

export function createShellExec(): ExecFn {
  return async (cwd, cmd) => {
    try {
      const { stdout, stderr } = await pexec(cmd, { cwd, encoding: "utf8" });
      return { code: 0, out: stdout + stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
    }
  };
}

export interface GitOpsOptions {
  ghPath?: string; // 测试可指向不存在路径以强制降级
}

export function createGitOps(exec: ExecFn, opts: GitOpsOptions = {}): GitOps {
  const gh = opts.ghPath ?? "gh";
  return {
    async ensureWorktree(projectRoot, runId, branchPrefix, worktreeDir) {
      const dir = join(projectRoot, worktreeDir, runId);
      const branch = `${branchPrefix}${runId}`;
      const r = await exec(projectRoot, `git worktree add "${dir}" -b "${branch}"`);
      if (r.code === 0) {
        const shaR = await exec(dir, "git rev-parse HEAD");
        return { path: dir, baseSha: shaR.code === 0 ? shaR.out.trim() : undefined, created: true };
      }
      // 目录已注册但分支已存在（中断恢复/目录被清但分支保留）：prune 掉失效注册后挂回既有分支
      await exec(projectRoot, "git worktree prune");
      const reattach = await exec(projectRoot, `git worktree add "${dir}" "${branch}"`);
      if (reattach.code === 0) {
        const shaR = await exec(dir, "git rev-parse HEAD");
        return { path: dir, baseSha: shaR.code === 0 ? shaR.out.trim() : undefined, created: false };
      }
      // 已存在（中断恢复）：复用（补 rev-parse 当前 HEAD 作 baseSha——GATE_MR 预览不再退回 HEAD~1 猜基线）；created=false——不重复依赖引导（T38/C4）
      const reuse = await exec(projectRoot, `git worktree list --porcelain`);
      if (reuse.out.includes(dir)) {
        const shaR = await exec(dir, "git rev-parse HEAD");
        return { path: dir, baseSha: shaR.code === 0 ? shaR.out.trim() : undefined, created: false };
      }
      throw new Error(`worktree 创建失败: ${r.out}`);
    },

    async setup(worktreeDir, command) {
      const r = await exec(worktreeDir, command);
      return { code: r.code, out: r.out };
    },

    async mrPreview(worktreeDir, baseSha) {
      const base = baseSha ?? "HEAD~1";
      const log = await exec(worktreeDir, `git log --oneline "${base}..HEAD"`);
      const diff = await exec(worktreeDir, `git diff --stat "${base}..HEAD"`);
      if (log.code !== 0 && diff.code !== 0) return null; // 预览失败不阻塞门禁（契约 14 精神）
      const commits = log.code === 0 ? log.out.trim().split("\n").filter(Boolean) : [];
      const parts: string[] = [];
      // 提交完整性机器检查：push 只推 commit，未提交/零提交会让 MR 缺内容甚至为空
      if (commits.length === 0) parts.push("⚠ 基线后零提交：MR 将为空（实施内容未提交？）");
      const st = await exec(worktreeDir, "git status --porcelain");
      if (st.code === 0 && st.out.trim()) {
        const dirty = st.out.trim().split("\n").filter(Boolean);
        parts.push(`⚠ 有 ${dirty.length} 处未提交变更（push 不包含，需先提交）：`, ...dirty.slice(0, 5), ...(dirty.length > 5 ? [`… 共 ${dirty.length} 处`] : []));
      }
      if (commits.length) parts.push("提交：", ...commits);
      if (diff.code === 0 && diff.out.trim()) parts.push("", "变更统计：", diff.out.trim());
      return parts.length ? parts.join("\n") : null;
    },

    async pushAndMr(worktreeDir, o) {
      const branchR = await exec(worktreeDir, "git rev-parse --abbrev-ref HEAD");
      const branch = branchR.out.trim() || o.runId;
      const push = await exec(worktreeDir, `git push -u origin "${branch}"`);
      const remoteR = await exec(worktreeDir, "git remote get-url origin");
      const remote = remoteR.out.trim();
      if (push.code !== 0 || !remote) {
        // 契约 14：绝不因 MR/push 失败判 run 失败
        return { mode: "manual", url: `本地分支 ${branch}（无 origin 远端或推送失败），请手动处理` };
      }
      const compare = normalizeCompareUrl(remote, branch);
      if (o.mrTarget === "none") return { mode: "manual", url: compare };
      const ghOk = await exec(worktreeDir, `"${gh}" --version`);
      if (ghOk.code !== 0) return { mode: "manual", url: compare };
      const mr = await exec(
        worktreeDir,
        o.bodyFile
          ? `"${gh}" pr create --title "${o.summary.replace(/"/g, "'")}" --body-file "${o.bodyFile}"`
          : `"${gh}" pr create --title "${o.summary.replace(/"/g, "'")}" --body "由 genpi 生成"`,
      );
      if (mr.code !== 0) return { mode: "manual", url: compare };
      const url = mr.out.trim().split("\n").filter((l) => l.startsWith("http")).at(-1);
      return { mode: "mr", url: url ?? compare };
    },
  };
}

/** origin URL → compare URL（github/gitlab 形态；其余原样退回）。 */
export function normalizeCompareUrl(remote: string, branch: string): string {
  const m = remote.match(/(?:github\.com|gitlab\.com)[:/]([^/]+)\/([^/.]+)/) ?? remote.match(/gitee\.com[:/]([^/]+)\/([^/.]+)/);
  if (!m) return `${remote} （compare/${branch}）`;
  let host = "github.com";
  if (remote.includes("gitee.com")) host = "gitee.com";
  else if (remote.includes("gitlab.com")) host = "gitlab.com";
  return `https://${host}/${m[1]}/${m[2]}/compare/${branch}?expand=1`;
}

// ---------- worktree 清理（T38/C5）：genpi clean 干跑列示 / --force 执行；台账（.genpi/runs）永久保留 ----------

export interface CleanupEntry {
  runId: string;
  status: string;
  worktree: string;
  branch: string;
  /** worktree 目录现存（不存在则只剩分支可删） */
  dirExists: boolean;
}

/** 干跑计划：终态（done/rejected/stopped）且带 worktree 的 run 才入列。纯函数（existsCheck 注入可测）。 */
export function planCleanup(
  runs: { id: string; status: string; worktree?: string }[],
  opts: { worktreeDir: string; branchPrefix: string; existsCheck: (p: string) => boolean },
): CleanupEntry[] {
  return runs.flatMap((r) => {
    const finished = r.status === "done" || r.status === "rejected" || r.status === "stopped";
    if (!finished || !r.worktree) return [];
    return [{
      runId: r.id,
      status: r.status,
      worktree: r.worktree,
      branch: `${opts.branchPrefix}${r.id}`,
      dirExists: opts.existsCheck(r.worktree),
    }];
  });
}

/** 执行清理：防丢检查→worktree remove→branch -D；单条失败不阻断其余。
 * 防丢（P0）：分支 tip 未被任何远端引用包含（未推送/推送失败）时，commits 只存在于本地——
 * 删除即永久丢失（push 降级 manual 的 done run、中断的 stopped run 都会命中），整条保留并报出路。 */
export async function executeCleanup(
  exec: ExecFn,
  projectRoot: string,
  entries: CleanupEntry[],
): Promise<{ runId: string; ok: boolean; note: string }[]> {
  const results: { runId: string; ok: boolean; note: string }[] = [];
  for (const e of entries) {
    const notes: string[] = [];
    // 防丢检查：branch -r --contains 为空 = tip 不在任何远端分支上（命令失败同样按未推送保守处理）
    const rc = await exec(projectRoot, `git branch -r --contains "${e.branch}"`);
    const pushed = rc.code === 0 && rc.out.trim().length > 0;
    if (!pushed) {
      results.push({
        runId: e.runId,
        ok: false,
        note: e.dirExists
          ? `⚠ 分支未推送远端（含未交付工作，防丢保留）：worktree 与分支均保留；确认放弃请手动 git worktree remove --force "${e.worktree}" && git branch -D "${e.branch}"，或先 push 保留交付`
          : `⚠ 分支未推送远端（防丢保留）：分支保留；确认放弃请手动 git branch -D "${e.branch}"，或先 push 保留交付`,
      });
      continue;
    }
    if (e.dirExists) {
      const rm = await exec(projectRoot, `git worktree remove "${e.worktree}"`);
      if (rm.code === 0) {
        notes.push("worktree 已删");
      } else {
        // 脏 worktree：--force 丢弃的只有未提交变更（提交已在远端，GATE_MR 门禁期已警告过）
        const rmf = await exec(projectRoot, `git worktree remove --force "${e.worktree}"`);
        notes.push(rmf.code === 0 ? "worktree 已删（含未提交变更；提交已在远端）" : `worktree 删除失败：${(rmf.out || rm.out).slice(-80)}`);
      }
    } else notes.push("worktree 已不存在");
    const br = await exec(projectRoot, `git branch -D "${e.branch}"`);
    if (br.code === 0) notes.push(`分支已删：${e.branch}`);
    else notes.push(`分支删除失败（可能已合入/不存在）：${e.branch}`);
    const ok = notes.every((n) => !n.includes("失败"));
    results.push({ runId: e.runId, ok, note: notes.join("；") });
  }
  await exec(projectRoot, "git worktree prune");
  return results;
}
