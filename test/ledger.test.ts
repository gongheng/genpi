// P0 台账原子写：writeRun 走 tmp+rename，无 .tmp 残留、多次写以后写为准——契约 7「进程随便杀，重启即续」的落盘底座
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFsLedger } from "../src/engine/ledger";

const dirs: string[] = [];
function mkd(): string {
  const d = join(tmpdir(), `genpi-t-ledger-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("fs ledger", () => {
  it("P0 原子写：writeRun 不留 .tmp 残留，多次写以后写为准（rename 原子替换）", async () => {
    const root = mkd();
    const ledger = createFsLedger();
    const { runId, runDir } = await ledger.initRun(root, "feature", "加定时发布");
    expect(runId).toContain("feature");
    expect(existsSync(join(runDir, "run.json"))).toBe(true);

    const rec = await ledger.readRun(runDir);
    rec.status = "gate";
    await ledger.writeRun(runDir, rec);
    rec.status = "stopped";
    rec.worktree = join(root, ".worktrees", runId);
    await ledger.writeRun(runDir, rec);

    expect(existsSync(join(runDir, "run.json.tmp"))).toBe(false); // 无残留中间文件
    const onDisk = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as { status: string; worktree?: string };
    expect(onDisk.status).toBe("stopped"); // 以后写为准
    expect(onDisk.worktree).toBe(join(root, ".worktrees", runId));
    // listRuns 不被 tmp 干扰（tmp 在 run 目录内，不在 runs 根）
    const runs = await ledger.listRuns(root);
    expect(runs.map((r) => r.id)).toEqual([runId]);
  });
});
