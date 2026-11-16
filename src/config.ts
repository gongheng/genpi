// 数据根独立与三级配置解析（契约 9：MUST NOT 读写 ~/.pi）
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ResolvedConfig {
  agentDir: string;
  mrTarget: "github" | "gitee" | "gitlab" | "none";
  branchPrefix: string;
  worktreeDir: string;
  budget: number;
  /** 模型角色（契约 16）：implementer/reviewer 按状态生效；router 供路由分类（T38/F8，小快模型降延迟与成本） */
  models: Partial<Record<"implementer" | "reviewer" | "router", string>>;
  /** T38/C4：worktree 新建后执行的依赖引导命令（如 "npm ci"）；缺省不执行 */
  worktreeSetup?: string;
}

/** 设定 pi 数据根为 <home>/.genpi（经官方 PI_CODING_AGENT_DIR），返回 agentDir。 */
export function applyDataRoot(home: string): string {
  const agentDir = join(home, ".genpi");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return agentDir;
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 优先级：内置默认 < ~/.genpi/settings.json < <项目根>/.genpi/config.json */
export function resolveConfig(projectRoot: string, agentDir: string): ResolvedConfig {
  const defaults: ResolvedConfig = {
    agentDir,
    mrTarget: "github",
    branchPrefix: "feature/",
    worktreeDir: ".worktrees/",
    budget: 3,
    models: {},
  };
  const user = readJson(join(agentDir, "settings.json"));
  const project = readJson(join(projectRoot, ".genpi", "config.json"));
  const merged = { ...defaults, ...user, ...project } as Partial<ResolvedConfig> & { models?: ResolvedConfig["models"] };
  return {
    agentDir,
    mrTarget: merged.mrTarget ?? defaults.mrTarget,
    branchPrefix: merged.branchPrefix ?? defaults.branchPrefix,
    worktreeDir: merged.worktreeDir ?? defaults.worktreeDir,
    budget: typeof merged.budget === "number" ? merged.budget : defaults.budget,
    models: { ...(user.models as object), ...(project.models as object) } as ResolvedConfig["models"],
    ...(typeof merged.worktreeSetup === "string" && merged.worktreeSetup.trim() ? { worktreeSetup: merged.worktreeSetup.trim() } : {}),
  };
}

/** 凭证检测：agentDir/auth.json 存在且为非空 JSON 对象。 */
/** 常见 provider 环境变量凭证（pi 原生支持；无 auth.json 时同样可用）。 */
const ENV_CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "XAI_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY",
  "QWEN_API_KEY", "DASHSCOPE_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY", "CODEX_API_KEY",
];

export function hasCredentials(agentDir: string): boolean {
  const p = join(agentDir, "auth.json");
  if (existsSync(p)) {
    try {
      const raw = readFileSync(p, "utf8").trim();
      if (raw.length > 0) {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed === "object" && parsed !== null) return true;
      }
    } catch {
      /* auth.json 损坏时继续检查环境变量 */
    }
  }
  return ENV_CREDENTIAL_KEYS.some((k) => (process.env[k] ?? "").trim().length > 0);
}
