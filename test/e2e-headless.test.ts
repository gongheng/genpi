import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap } from "../src/engine/bootstrap";
import { GenpiActiveRunError } from "../src/engine/loop-engine";
import type { StepEvent, StepResult, StepRunner, StepSpec } from "../src/types";

const dirs: string[] = [];
function mkd(prefix: string): string {
  const d = join(tmpdir(), `genpi-t7-${prefix}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) {
    try {
      execSync(`git -C ${JSON.stringify(d)} worktree prune || true`, { stdio: "pipe" });
    } catch {
      /* ignore */
    }
    rmSync(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function sh(cmd: string, cwd?: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
}
function shCapture(cmd: string, cwd: string): { code: number; out: string } {
  try {
    const out = execSync(cmd, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

const ok = (artifacts: string[] = []): StepResult => ({ ok: true, summary: "完成", artifacts, evidence: [] });

/** 脚本化 runner：真写文件/真跑命令/真提交——模拟一个守纪的 agent。 */
function createScriptedRunner(): StepRunner & { calls: StepSpec[] } {
  const calls: StepSpec[] = [];
  return {
    calls,
    async run(spec: StepSpec, onEvent: (e: StepEvent) => void): Promise<StepResult> {
      calls.push(spec);
      onEvent({ type: "text", delta: `[${spec.state}]` });
      const runDir = /# 运行目录: (\S+)/.exec(spec.instruction)?.[1] ?? "";
      switch (spec.state) {
        case "DESIGN":
          writeFileSync(join(runDir, "design.md"), "# 设计\nscheduled_at timestamptz，到点自动 visible\n");
          return { ok: true, summary: "设计完成", artifacts: ["design.md"], evidence: [] };
        case "PLAN":
          writeFileSync(join(runDir, "tasks.md"), "# 任务\n- [ ] T1 修好测试\n");
          return ok(["tasks.md"]);
        case "IMPLEMENT":
          writeFileSync(join(spec.workingDir, "test.js"), "console.log('pass');\n");
          sh(`git add -A && git commit -m "feat(test): 修复断言"`, spec.workingDir);
          return ok([]);
        case "VERIFY": {
          const r = shCapture("node test.js", spec.workingDir);
          return {
            ok: r.code === 0,
            summary: r.code === 0 ? "验证通过" : "验证失败",
            artifacts: [],
            evidence: [{ command: "node test.js", exitCode: r.code, outputTail: r.out.slice(-80) }],
          };
        }
        case "RESEARCH":
          writeFileSync(join(runDir, "conclusion.md"), "# 结论\n不需要 SSR。\n");
          return ok(["conclusion.md"]);
        default:
          return ok();
      }
    },
  };
}

function makeToyRepo(): { project: string; bare: string } {
  const project = mkd("proj");
  const bare = mkd("bare");
  sh(`git init --bare "${bare}"`);
  sh("git init -b main", project);
  sh("git config user.email t@t && git config user.name t", project);
  writeFileSync(join(project, "test.js"), "process.exit(1); // broken\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "toy", scripts: { test: "node test.js" } }, null, 2));
  sh("git add -A && git commit -m init", project);
  sh(`git remote add origin "${bare}" && git push -u origin main`, project);
  return { project, bare };
}

describe("headless E2E", () => {
  it("① feature 全循环：worktree 隔离/产物/证据/push 降级/完成", async () => {
    const { project, bare } = makeToyRepo();
    const runner = createScriptedRunner();
    const events: unknown[] = [];
    const home = mkd("home");
    const { engine } = bootstrap({ projectRoot: project, home, runner, emit: (e) => events.push(e), ask: async () => "好的" });

    const runId = await engine.start("feature", "修好测试");
    const runDir = join(project, ".genpi", "runs", runId);
    expect(readFileSync(join(runDir, "design.md"), "utf8")).toContain("scheduled_at");
    await engine.decide(runId, { kind: "approve" }); // GATE_DESIGN → … → GATE_MR
    await engine.decide(runId, { kind: "approve" }); // push + ARCHIVE → done

    // 契约 5：主工作树 tracked 零污染
    expect(shCapture("git status --porcelain --untracked-files=no", project).out.trim()).toBe("");
    // 产物四件（契约 2）
    for (const f of ["run.json", "design.md", "tasks.md", "phase-history.jsonl"]) {
      expect(existsSync(join(runDir, f)), `缺 ${f}`).toBe(true);
    }
    // 契约 4：exit code 证据在案
    const history = readFileSync(join(runDir, "phase-history.jsonl"), "utf8");
    expect(history).toContain('"command":"node test.js"');
    expect(history).toContain('"exitCode":0');
    // 契约 14：无 gh 降级 manual，run 完成
    expect(history).toContain("push_manual");
    expect(events.at(-1)).toMatchObject({ type: "run_done" });
    // 分支已推到远端
    expect(shCapture("git branch --list", bare).out).toContain(`feature/${runId}`);
    // worktree 分支上测试已修好
    expect(shCapture("node test.js", join(project, ".worktrees", runId)).code).toBe(0);
  });

  it("② research 路径：无 git 目录可跑完，结论即交付无门禁（场景 8，v1.5）", async () => {
    const dir = mkd("plain");
    const runner = createScriptedRunner();
    const { engine } = bootstrap({ projectRoot: dir, home: mkd("home"), runner, ask: async () => "好" });
    const runId = await engine.start("research", "要不要上 SSR");
    const runDir = join(dir, ".genpi", "runs", runId);
    expect(existsSync(join(runDir, "conclusion.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).status).toBe("done");
    expect(existsSync(join(dir, ".worktrees"))).toBe(false);
  });

  it("③ 单活跃 run：GATE 挂起时拒绝第二个（契约 15）", async () => {
    const { project } = makeToyRepo();
    const { engine } = bootstrap({ projectRoot: project, home: mkd("home"), runner: createScriptedRunner(), ask: async () => "好" });
    await engine.start("feature", "第一个");
    await expect(engine.start("bugfix", "第二个")).rejects.toBeInstanceOf(GenpiActiveRunError);
  });
});
