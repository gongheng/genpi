// P0 台账原子写：writeRun 走 tmp+rename，无 .tmp 残留、多次写以后写为准——契约 7「进程随便杀，重启即续」的落盘底座
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("P1 active.lock 原子单活跃：wx 独占；active 占用返回占位者；终态/崩溃残留接管；释放验主幂等；listRuns 不受占位干扰", async () => {
    const root = mkd();
    const ledger = createFsLedger();
    const a = await ledger.initRun(root, "feature", "需求A");
    const b = await ledger.initRun(root, "feature", "需求B");
    const lockPath = join(root, ".genpi", "runs", "active.lock");

    expect(await ledger.tryAcquireActive(root, a.runId)).toBeNull(); // A 占位（run 初始即 active）
    expect(await ledger.tryAcquireActive(root, b.runId)).toBe(a.runId); // 被占→返回占位者
    await ledger.releaseActive(root, b.runId); // 验主：B 释放不动 A 的占位
    expect(existsSync(lockPath)).toBe(true);
    expect(await ledger.tryAcquireActive(root, b.runId)).toBe(a.runId);

    const recA = await ledger.readRun(a.runDir);
    recA.status = "done";
    await ledger.writeRun(a.runDir, recA);
    expect(await ledger.tryAcquireActive(root, b.runId)).toBeNull(); // 占位指向终态→接管

    await ledger.releaseActive(root, a.runId); // 旧主释放：幂等无操作
    await ledger.releaseActive(root, b.runId); // 本人释放
    expect(await ledger.tryAcquireActive(root, b.runId)).toBeNull(); // 重新可占

    writeFileSync(lockPath, JSON.stringify({ runId: "不存在的run" })); // 崩溃残留
    expect(await ledger.tryAcquireActive(root, b.runId)).toBeNull(); // 指向缺失 run→接管
    expect(await ledger.tryAcquireActive(root, b.runId)).toBe(b.runId); // 自持幂等：返回自身

    await ledger.releaseActive(root, b.runId);
    expect(await ledger.listRuns(root)).toHaveLength(2); // 占位文件不入台账列表
  });

  it("P3/#6 会话滚动摘要裁剪：跨过 200 行触发裁剪到最近 100（渐进式），bounded 且 recentConversation 取尾不变", async () => {
    const root = mkd();
    const ledger = createFsLedger();
    for (let i = 1; i <= 205; i++) await ledger.appendConversation(root, `line-${i}`);
    const lines = readFileSync(join(root, ".genpi", "conversation.md"), "utf8").split("\n").filter(Boolean);
    // 渐进语义：第 201 次 append 触发裁剪到最近 100（102..201），其后 4 次追加 → 104 行
    expect(lines).toHaveLength(104);
    expect(lines[0]).toBe("line-102"); // 裁剪保留最近 100
    expect(lines.at(-1)).toBe("line-205");
    expect(lines.length).toBeLessThanOrEqual(201); // bounded：永不超跟一个窗口
    expect(await ledger.recentConversation(root, 5)).toEqual(["line-201", "line-202", "line-203", "line-204", "line-205"]);
    // 未超限不裁
    const root2 = mkd();
    for (let i = 1; i <= 51; i++) await ledger.appendConversation(root2, `l-${i}`);
    expect(readFileSync(join(root2, ".genpi", "conversation.md"), "utf8").split("\n").filter(Boolean)).toHaveLength(51);
  });
});
