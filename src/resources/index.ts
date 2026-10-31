// 方法论资源装载：state → 方法论文本（契约 10：缺失降级警告，不崩溃）
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ResourceProvider } from "../engine/loop-engine";
import type { StateId } from "../types";

// 状态 → 资源文件（IMPLEMENT/FIX 额外带 git 纪律）
const STATE_RESOURCES: Partial<Record<StateId, string[]>> = {
  CLARIFY: ["clarify.md"],
  DESIGN: ["design.md"],
  PLAN: ["plan.md"],
  IMPLEMENT: ["implement.md", "git-workflow.md"],
  VERIFY: ["verify.md"],
  REVIEW: ["review.md"],
  REPRODUCE: ["debug.md"],
  ROOT_CAUSE: ["debug.md"],
  FIX: ["debug.md", "git-workflow.md"],
  RESEARCH: ["research.md"],
  PRD: ["prd.md"],
  DEBUG: ["debug.md"],
};

function resolveResourceDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [here, join(here, "resources"), join(process.cwd(), "src", "resources")];
  for (const c of candidates) if (existsSync(join(c, "preamble.md"))) return c;
  return here;
}

const warned = new Set<string>();

function load(name: string): string {
  try {
    return readFileSync(join(resolveResourceDir(), name), "utf8");
  } catch {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[genpi] 方法论资源缺失，降级为无注入: ${name}`);
    }
    return "";
  }
}

export function createResourceProvider(): ResourceProvider {
  return {
    byState(state: StateId): string[] {
      return (STATE_RESOURCES[state] ?? []).map(load).filter((s) => s.length > 0);
    },
    preamble(): string {
      return load("preamble.md");
    },
  };
}
