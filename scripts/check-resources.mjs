#!/usr/bin/env node
// 检查 genpi 是纯粹工具：全仓扫描无来源项目耦合残留（命中禁词退出非零）
// 范围：src/ test/ scripts/（自身除外） bin/ docs/ README.md —— 「与项目无关」机器强制
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const self = relative(root, fileURLToPath(import.meta.url));
const SELF_AND_LOCAL = new Set([self, join("scripts", "forbidden.local.txt")]); // 检查器与私有禁词文件自排除
// 内置禁词只含通用项目耦合特征；私有禁词（如来源项目代号）放 scripts/forbidden.local.txt（gitignored，不入库）
const BUILTIN = /\.ai\/auto|flyway|archunit|pnpm --dir web/i;
let localWords = [];
try {
  localWords = readFileSync(join(root, "scripts", "forbidden.local.txt"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
} catch {
  /* 无本地私有禁词文件：仅内置表 */
}
const forbidden = localWords.length > 0 ? new RegExp([...localWords, BUILTIN.source].join("|"), "i") : BUILTIN;

const TEXT_EXT = /\.(ts|mjs|md|json|txt)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".idea", ".genpi", ".worktrees"]);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(root, p);
    if (SELF_AND_LOCAL.has(rel)) continue; // 检查器自身与私有禁词文件自排除
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p);
    } else if (TEXT_EXT.test(name)) {
      files.push(p);
    }
  }
})(root);

const hits = [];
for (const p of files) {
  const lines = readFileSync(p, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (forbidden.test(line)) hits.push(`${relative(root, p)}:${i + 1}: ${line.trim()}`);
  });
}
if (hits.length > 0) {
  console.error(`耦合残留 ${hits.length} 处（genpi MUST 与具体项目无关）：\n` + hits.join("\n"));
  process.exit(1);
}
console.log(`purity ✓ 全仓 ${files.length} 个文本文件无项目耦合残留${localWords.length > 0 ? `（含本地私有禁词 ${localWords.length} 项）` : ""}`);
