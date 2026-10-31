// 台账：<项目根>/.genpi/runs/<runId>/（run.json + phase-history.jsonl）——契约 2/12
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
      await writeFile(join(dir, "run.json"), JSON.stringify(rec, null, 2));
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
      const names = (await readdir(root)).filter((n) => !n.startsWith("."));
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
      await writeFile(join(runDir, "run.json"), JSON.stringify(rec, null, 2));
    },
    async appendHistory(runDir, entry) {
      await writeFile(join(runDir, "phase-history.jsonl"), JSON.stringify(entry) + "\n", { flag: "a" });
    },
    async appendConversation(projectRoot, line) {
      await writeFile(join(projectRoot, ".genpi", "conversation.md"), line + "\n", { flag: "a" });
    },
    async recentConversation(projectRoot, n = 5) {
      try {
        const text = await readFile(join(projectRoot, ".genpi", "conversation.md"), "utf8");
        return text.split("\n").filter(Boolean).slice(-n);
      } catch {
        return []; // 无摘要文件 = 无背景，不崩（契约 10 精神）
      }
    },
  };
}
