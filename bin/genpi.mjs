#!/usr/bin/env node
// 过期守卫：genpi（npm link）运行的是 dist/ 构建产物——源码修复后未重建会静默运行旧代码
// （曾致 T21 欢迎重复修复 5 小时未达运行时）。src 比 dist 新即警告，不阻塞执行。
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(root, "dist", "cli.js");
if (existsSync(distEntry)) {
  const built = statSync(distEntry).mtimeMs;
  const stale = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|md)$/.test(name) && statSync(p).mtimeMs > built) stale.push(p);
    }
  })(join(root, "src"));
  if (stale.length > 0) {
    console.warn(`⚠ 源码比构建新（${stale.length} 个文件）——genpi 正在运行旧代码，请先执行: npm run build`);
  }
}

const { main } = await import("../dist/cli.js");
main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
