#!/usr/bin/env node
// 构建后处理：把方法论 .md 拷进 dist/resources（npm files 白名单随之发布）
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

mkdirSync("dist/resources", { recursive: true });
for (const f of readdirSync("src/resources")) {
  if (f.endsWith(".md")) copyFileSync(join("src/resources", f), join("dist/resources", f));
}
console.log("dist/resources ✓");
