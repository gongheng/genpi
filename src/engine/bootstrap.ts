// 装配工厂：把各模块组成可运行引擎（T8 TUI 也用这里）
import { createInterface } from "node:readline";
import { applyDataRoot, resolveConfig } from "../config";
import { createFsLedger, type Ledger } from "./ledger";
import { LoopEngine, type EngineDeps } from "./loop-engine";
import { createResourceProvider } from "../resources";
import { createGitOps, createShellExec } from "./worktree";
import { createPiStepRunner } from "../agent/step-runner";
import type { ResolvedConfig } from "../config";
import type { EngineEvent, StepRunner } from "../types";

export function createReadlineAsk(): (q: string) => Promise<string> {
  return (q) =>
    new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`❓ ${q}\n> `, (a) => {
        rl.close();
        resolve(a);
      });
    });
}

export interface BootstrapOptions {
  projectRoot: string;
  home?: string; // 默认 os homedir()，数据根 <home>/.genpi
  runner?: StepRunner; // 缺省用真实 pi SDK runner
  emit?: (e: EngineEvent) => void;
  ask?: (q: string) => Promise<string>;
  /** 内联 pi 扩展（透传给 StepRunner，每 step 会话生效）。 */
  extensions?: import("../agent/step-runner").InlineExtension[];
  additionalExtensionPaths?: string[];
  /** 会话当前模型解析器（步骤会话跟随交互会话 /model 切换）；低于 config.models 角色配置。 */
  defaultModel?: () => string | undefined;
}

export interface Bootstrapped {
  engine: LoopEngine;
  config: ResolvedConfig;
  ledger: Ledger;
}

export function bootstrap(opts: BootstrapOptions): Bootstrapped {
  const agentDir = applyDataRoot(opts.home ?? homeDir());
  const config = resolveConfig(opts.projectRoot, agentDir);
  const ledger = createFsLedger();
  const deps: EngineDeps = {
    runner:
      opts.runner ??
      createPiStepRunner({
        extensions: opts.extensions,
        additionalExtensionPaths: opts.additionalExtensionPaths,
        models: config.models, // 契约 16：implementer/reviewer 角色模型
        defaultModel: opts.defaultModel, // 跟随交互会话 /model 切换（低于角色配置）
      }),
    ledger,
    resources: createResourceProvider(),
    git: createGitOps(createShellExec(), { ghPath: "gh" }),
    config,
    projectRoot: opts.projectRoot,
    emit: opts.emit ?? (() => {}),
    ask: opts.ask ?? createReadlineAsk(),
  };
  return { engine: new LoopEngine(deps), config, ledger };
}

function homeDir(): string {
  // 避免引入 os 类型差异；等价 os.homedir()
  return process.env.HOME ?? process.env.USERPROFILE ?? ".";
}
