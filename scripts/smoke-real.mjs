#!/usr/bin/env node
// 真模型冒烟：验证 StepRunner→createAgentSession 真链路 + 扩展随会话生效（P3 验证欠账）
// 用法：node scripts/smoke-real.mjs   （需要 ~/.genpi/auth.json 凭证）
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiStepRunner } from "../dist/agent/step-runner.js";
import { createResourceProvider } from "../dist/resources/index.js";
import { applyDataRoot } from "../dist/config.js";

const agentDir = applyDataRoot(process.env.HOME ?? ".");
const cwd = mkdtempSync(join(tmpdir(), "genpi-smoke-"));

let extensionFired = 0;
const runner = createPiStepRunner({
  extensions: [
    (pi) => {
      pi.on("agent_start", () => {
        extensionFired++;
      });
    },
  ],
});

const spec = {
  state: "DESIGN",
  instruction:
    "# 状态任务：链路冒烟测试\n# 需求：验证 genpi→pi 真模型链路\n# 运行目录: " + cwd + "\n\n本步为冒烟：不要读写任何文件、不要调用工具，直接用一句话确认链路可用，然后按输出要求给出结果块（ok: true, artifacts: [], evidence: []）。",
  methodology: createResourceProvider().byState("DESIGN"),
  preamble: createResourceProvider().preamble(),
  workingDir: cwd,
};

console.log("smoke: 数据根", agentDir, "· 工作目录", cwd);
const t0 = Date.now();
const result = await runner.run(spec, (e) => {
  if (e.type === "text") process.stdout.write(e.delta);
});
console.log("\n---");
console.log("elapsed_ms:", Date.now() - t0);
console.log("extension_fired:", extensionFired);
console.log("parsed_ok:", result.ok, "· summary:", result.summary);
const pass = result.ok && extensionFired > 0;
console.log(pass ? "SMOKE ✓ 真链路+扩展透传通过" : "SMOKE ✗");
process.exit(pass ? 0 : 1);
