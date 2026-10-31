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
      if (r.code !== 0) {
        // 已存在（中断恢复）：复用（基线未知，预览退回 HEAD~1）
        const reuse = await exec(projectRoot, `git worktree list --porcelain`);
        if (reuse.out.includes(dir)) return { path: dir, baseSha: undefined };
        throw new Error(`worktree 创建失败: ${r.out}`);
      }
      const shaR = await exec(dir, "git rev-parse HEAD");
      return { path: dir, baseSha: shaR.code === 0 ? shaR.out.trim() : undefined };
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
        `"${gh}" pr create --title "${o.summary.replace(/"/g, "'")}" --body "由 genpi 生成"`,
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
  const host = remote.includes("gitee.com") ? "gitee.com" : remote.includes("gitlab.com") ? "gitlab.com" : "github.com";
  return `https://${host}/${m[1]}/${m[2]}/compare/${branch}?expand=1`;
}
