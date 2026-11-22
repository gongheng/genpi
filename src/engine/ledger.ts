// 台账：<项目根>/.genpi/runs/<runId>/（run.json + phase-history.jsonl）——契约 2/12
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandEvidence, PathId, RunId, RunRecord } from "../types";

export interface PhaseHistoryEntry {
  ts: string;
  from: string;
  to: string;
  event: string;
  evidence?: CommandEvidence[];
  budgetLeft?: number;
  note?: string;
  /** T38/D6：本步 token 用量（人读格式，如 "in 12.3k/out 1.2k tok"） */
  usage?: string;
}

export interface Ledger {
  initRun(projectRoot: string, path: PathId, request: string, title?: string): Promise<{ runId: RunId; runDir: string }>;
  runDir(projectRoot: string, runId: RunId): Promise<string>;
  listRuns(projectRoot: string): Promise<RunRecord[]>;
  readRun(runDir: string): Promise<RunRecord>;
  writeRun(runDir: string, rec: RunRecord): Promise<void>;
  appendHistory(runDir: string, entry: PhaseHistoryEntry): Promise<void>;
  /** 会话滚动摘要（契约 24/E 底座）：run 终态追加一行；新 run 注入最近 n 条作背景 */
  appendConversation(projectRoot: string, line: string): Promise<void>;
  recentConversation(projectRoot: string, n?: number): Promise<string[]>;
  /** 契约 15（P1/TOCTOU 原子化）：wx 独占创建单活跃占位；被 active/gate 的 run 占着→返回占位 runId；终态/崩溃残留→接管重写返回 null */
  tryAcquireActive(projectRoot: string, runId: RunId): Promise<RunId | null>;
  /** 释放占位（仅当占位属于该 run；幂等，防误删他人占位） */
  releaseActive(projectRoot: string, runId: RunId): Promise<void>;
}

export function runIdFor(path: PathId, titleOrRequest: string, now: () => Date, seq = 0): string {
  const d = now();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const slug =
    titleOrRequest
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .slice(0, 3)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter(Boolean)
      .join("-") || "run";
  return seq > 0 ? `${stamp}-${path}-${slug}-${seq}` : `${stamp}-${path}-${slug}`;
}

export function createFsLedger(now: () => Date = () => new Date()): Ledger {
  const runsRoot = (projectRoot: string) => join(projectRoot, ".genpi", "runs");
  return {
    async initRun(projectRoot, path, request, title) {
      let seq = 0;
      let runId = runIdFor(path, title || request, now); // 空串 title 兑底原话（T23：?? 只挡 nullish，不挡 ""）
      let dir = join(runsRoot(projectRoot), runId);
      const { existsSync } = await import("node:fs");
      while (existsSync(dir)) {
        seq += 1;
        runId = runIdFor(path, title || request, now, seq); // 冲突重试同源（T23：曾误用 request 致 seq 变体 slug 基底不一致）
        dir = join(runsRoot(projectRoot), runId);
      }
      await mkdir(dir, { recursive: true });
      const rec: RunRecord = {
        id: runId,
        path,
        ...(title ? { title } : {}), // 标题落账（人读）；request 原文不修饰（审计）
        request,
        status: "active",
        currentState: "INIT",
        budget: {},
        createdTs: now().toISOString(),
        sessionIds: [],
      };
      await writeFile(join(dir, "run.json"), JSON.stringify(rec, null, 2)); // 首建无旧文件可损坏；后续一律走 writeRun 原子替换
      return { runId, runDir: dir };
    },
    async runDir(projectRoot, runId) {
      const dir = join(runsRoot(projectRoot), runId);
      const { existsSync } = await import("node:fs");
      if (!existsSync(join(dir, "run.json"))) throw new Error(`run 不存在: ${runId}`);
      return dir;
    },
    async listRuns(projectRoot) {
      const root = runsRoot(projectRoot);
      const { existsSync } = await import("node:fs");
      if (!existsSync(root)) return [];
      const names = (await readdir(root)).filter((n) => !n.startsWith(".") && n !== "active.lock");
      const runs: RunRecord[] = [];
      for (const n of names) {
        try {
          runs.push(JSON.parse(await readFile(join(root, n, "run.json"), "utf8")) as RunRecord);
        } catch {
          // 跳过损坏目录
        }
      }
      return runs.sort((a, b) => a.createdTs.localeCompare(b.createdTs));
    },
    async readRun(runDir) {
      return JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunRecord;
    },
    async writeRun(runDir, rec) {
      // 原子写（P0）：先写 tmp 再 rename——writeFile 直接覆盖在写入中途被杀会留半截 JSON，
      // 台账损坏则契约 7「进程随便杀重启即续」失效；rename 在 POSIX/Windows 上均原子替换。
      // tmp 带随机后缀：防并发写者同名相撞（一个 rename 掉另一个的 tmp → ENOENT，自审发现）
      const tmp = join(runDir, `run.json.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`);
      await writeFile(tmp, JSON.stringify(rec, null, 2));
      await rename(tmp, join(runDir, "run.json"));
    },
    async appendHistory(runDir, entry) {
      await writeFile(join(runDir, "phase-history.jsonl"), `${JSON.stringify(entry)}\n`, { flag: "a" });
    },
    async appendConversation(projectRoot, line) {
      const dir = join(projectRoot, ".genpi");
      const p = join(dir, "conversation.md");
      await mkdir(dir, { recursive: true }); // 父目录自洽：无 runs 先行时也能落盘（生产中被 try/catch 吞过）
      await writeFile(p, `${line}\n`, { flag: "a" });
      // P3/#6：滚动摘要无限增长防护——超 200 行裁到最近 100 行（背景注入只用最近 5 条，裁剪不损语义）
      try {
        const text = await readFile(p, "utf8");
        const lines = text.split("\n").filter(Boolean);
        if (lines.length > 200) await writeFile(p, `${lines.slice(-100).join("\n")}\n`);
      } catch {
        /* 回读失败不影响 append 主流程 */
      }
    },
    async recentConversation(projectRoot, n = 5) {
      try {
        const text = await readFile(join(projectRoot, ".genpi", "conversation.md"), "utf8");
        return text.split("\n").filter(Boolean).slice(-n);
      } catch {
        return []; // 无摘要文件 = 无背景，不崩（契约 10 精神）
      }
    },
    async tryAcquireActive(projectRoot, runId) {
      const lockPath = join(runsRoot(projectRoot), "active.lock");
      const write = () => writeFile(lockPath, `${JSON.stringify({ runId, ts: now().toISOString() })}\n`, { flag: "wx" });
      try {
        await write();
        return null;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      // 占位已存在：指向的 run 仍 active/gate 才拒绝（自持幂等）；终态/不可读/缺失（崩溃残留）→接管重写
      let heldActive = false;
      let held: RunId | undefined;
      try {
        held = (JSON.parse(await readFile(lockPath, "utf8")) as { runId: RunId }).runId;
        const rec = JSON.parse(await readFile(join(runsRoot(projectRoot), held, "run.json"), "utf8")) as RunRecord;
        heldActive = rec.status === "active" || rec.status === "gate";
      } catch {
        /* 占位不可读/run 缺失 → 可接管 */
      }
      if (held && heldActive) return held;
      await rm(lockPath, { force: true });
      try {
        await write();
        return null;
      } catch {
        // 接管窗口又输给并发者：重读占位者返回（不可读则占位符，调用方按冲突处理）
        try {
          return (JSON.parse(await readFile(lockPath, "utf8")) as { runId: RunId }).runId;
        } catch {
          return "?";
        }
      }
    },
    async releaseActive(projectRoot, runId) {
      const lockPath = join(runsRoot(projectRoot), "active.lock");
      try {
        const held = (JSON.parse(await readFile(lockPath, "utf8")) as { runId: RunId }).runId;
        if (held === runId) await rm(lockPath, { force: true });
      } catch {
        /* 无占位/不可读：幂等 */
      }
    },
  };
}
