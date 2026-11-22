#!/usr/bin/env node
// 真模型 E2E 冒烟（流程改进#1）：玩具 git 仓 + 真凭证跑 T0 feature 全循环——
//   IMPLEMENT 真写文件 → VERIFY 真证据采集+交叉校验（T38「证据形状 bug」若复发，此处第一天红灯：
//   真模型自报证据与真实 bash 执行对不上 → VERIFY fail → 预算耗尽 → 冒烟 FAIL）→ GATE_MR 真预览 → done 真用量落账。
// 发布前必跑：npm run smoke:e2e（约 1-3 分钟、数角钱模型调用）。
// --if-creds：无凭证时警告退出 0（供 prepublishOnly；有凭证环境必须真跑过才许发版）。
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ifCreds = process.argv.includes("--if-creds");
const fail = (msg) => {
  failed = true;
  console.error(`SMOKE-E2E ✗ ${msg}`);
  process.exit(1);
};

// 看门狗：整体超时（默认 600s，--timeout-ms 可调）——超时打印诊断（最近转移史）后退出，防挂死无输出
const WATCHDOG_MS = Number(process.argv.find((a) => a.startsWith("--timeout-ms="))?.slice("--timeout-ms=".length) ?? 600_000);
let currentRunDir = null; // 供看门狗诊断
setTimeout(() => {
  if (currentRunDir) {
    try {
      const hist = readFileSync(join(currentRunDir, "phase-history.jsonl"), "utf8").split("\n").filter(Boolean).slice(-8);
      console.error(`SMOKE-E2E ✗ 看门狗超时（${WATCHDOG_MS}ms）。转移史尾部：\n${hist.join("\n")}`);
    } catch {}
  } else console.error(`SMOKE-E2E ✗ 看门狗超时（${WATCHDOG_MS}ms，未建 run）`);
  process.exit(1);
}, WATCHDOG_MS).unref?.();

// ---- 凭证预检（复用 dist/config 的判定，单一事实源） ----
const { hasCredentials } = await import("../dist/config.js");
if (!hasCredentials(join(homedir(), ".genpi"))) {
  const msg = "无模型凭证（~/.genpi/auth.json 或环境变量）——真模型 E2E 无法运行";
  if (ifCreds) {
    console.warn(`SMOKE-E2E ⚠ 跳过：${msg}（--if-creds）`);
    process.exit(0);
  }
  fail(msg);
}

const dirs = [];
const mkd = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
let failed = false; // 失败时保留现场（run 目录）供事后取证
const cleanup = () => {
  if (failed) {
    console.error(`（现场保留供取证：${dirs.join(" ")}）`);
    return;
  }
  for (const d of dirs) {
    try {
      execSync(`git -C ${JSON.stringify(d)} worktree prune || true`, { stdio: "pipe" });
    } catch {}
    rmSync(d, { recursive: true, force: true });
  }
};
process.on("exit", cleanup);

function toyRepo() {
  const root = mkd("genpi-e2e-repo-");
  const sh = (cmd) => execSync(cmd, { cwd: root, stdio: "pipe" });
  sh("git init -q -b main && git config user.email e2e@t && git config user.name e2e");
  writeFileSync(join(root, "README.md"), "# e2e\n");
  sh("git add -A && git commit -qm init");
  return root;
}

const waitFor = async (pred, timeoutMs, what) => {
  const t0 = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - t0 > timeoutMs) fail(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

// ---- 金丝牙 A：真实 abort 语义（resolve 式非抛错——ESC 修复所依据的行为） ----
{
  const pi = await import("@earendil-works/pi-coding-agent");
  const cwd = mkd("genpi-e2e-abort-");
  const agentDir = join(homedir(), ".genpi");
  const services = await pi.createAgentSessionServices({ cwd, agentDir });
  const { session } = await pi.createAgentSessionFromServices({ services, sessionManager: pi.SessionManager.inMemory() });
  let threw = null;
  const p = session.prompt("只回复两个字符：ok").catch((e) => {
    threw = e;
    return "THREW";
  });
  await new Promise((r) => setTimeout(r, 400)); // 请求已发、大概率未完成（完成也不影响断言）
  session.abort?.();
  const out = await p;
  if (threw !== null || out === "THREW") fail(`abort 语义变更：prompt 抛错而非优雅 resolve（${String(threw).slice(0, 120)}）`);
  console.log("✓ 金丝雀 A：abort 后 prompt 正常 resolve（非抛错）");
  await session.dispose();
}

// ---- 主循环：T0 feature 全链（真模型） ----
const { bootstrap } = await import("../dist/engine/bootstrap.js");
const projectRoot = toyRepo();
const events = [];
const { engine, ledger } = bootstrap({
  projectRoot,
  home: homedir(),
  emit: (e) => {
    events.push(e);
    if (e.type === "state_entered") console.log(`  ▸ ${e.state}`);
    else if (e.type === "step_finished" && !e.aborted) {
      // 失败步骤打全量摘要（含 ｜⚠ 原因——v3 教训：60 字截断把失败原因全切掉了）
      const line = `  ${e.ok ? "✓" : "✗"} ${e.state}：${e.summary}`;
      console.log(e.ok ? line.slice(0, 100) : line);
    }
    else if (e.type === "gate_opened") console.log(`  ⏸ ${e.gate}（自动批准）`);
    else if (e.type === "budget_changed") console.log(`  ⚠ ${e.state} 失败，预算余 ${e.remaining}`);
  },
  ask: async (q) => {
    console.log(`  ❓ ${q}\n  ↳ 自动作答：按你的判断执行`);
    return "按你的判断执行";
  },
});

const request = "在仓库根目录创建 hello.txt，内容为一行：hello genpi e2e。验收：运行 cat hello.txt 应输出该行。信息已完整，无需澄清，直接实现。";
console.log("── T0 feature 全循环（IMPLEMENT→VERIFY→GATE_MR）──");
const runId = await engine.start("feature", request, undefined, {
  tier: "t0",
  title: "e2e冒烟",
  routeBy: "e2e",
  routeReason: "真模型全循环冒烟",
});

// start 在 GATE_MR 开门时返回——此刻实施与验证已完成
const runDir = await ledger.runDir(projectRoot, runId);
const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
if (!run.worktree || !existsSync(join(run.worktree, "hello.txt"))) {
  const hist = readFileSync(join(runDir, "phase-history.jsonl"), "utf8");
  fail(`hello.txt 未在 worktree 产生（实施失败）。转移史尾部：\n${hist.split("\n").slice(-6).join("\n")}`);
}
console.log("✓ IMPLEMENT：hello.txt 已落盘（worktree）");

const hist = readFileSync(join(runDir, "phase-history.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const verifyOk = hist.find((h) => h.event === "step_ok" && h.from === "VERIFY");
if (!verifyOk) fail(`VERIFY 未成功（证据链或实施失败）。转移史：\n${JSON.stringify(hist.map((h) => `${h.event}:${h.from}→${h.to}`))}`);
if (!verifyOk.evidence?.length) fail("VERIFY 证据为空——真模型未自报命令，或采集链路断裂（契约 4 空转回归！）");
if (!verifyOk.evidence.every((e) => e.exitCode === 0)) fail(`VERIFY 证据含非零退出码：${JSON.stringify(verifyOk.evidence)}`);
console.log(`✓ VERIFY：${verifyOk.evidence.length} 条证据全 exit 0（真实采集+交叉校验生效——契约 4 非空转）`);

await engine.decide(runId, { kind: "approve" }); // GATE_MR → pushAndMr（玩具仓无远端→manual，契约 14 不算失败）→ DONE
await waitFor(() => events.some((e) => e.type === "run_done"), 30_000, "run_done");
const done = events.find((e) => e.type === "run_done");
const finalRun = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
if (finalRun.status !== "done") fail(`终态非 done：${finalRun.status}`);
if (!done?.usage || done.usage.input + done.usage.output <= 0) fail("run_done 未携带全程用量（日常手感#4 断裂）");
console.log(`✓ DONE：终态 done，全程 in ${Math.round(done.usage.input / 1000)}k/out ${Math.round(done.usage.output / 1000)}k tok`);

console.log("\nSMOKE-E2E ✓ 真模型全循环通过（证据链/门禁/用量/abort 语义四项钉住）");
