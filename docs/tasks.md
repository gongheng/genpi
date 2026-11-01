# genpi v1 · 任务清单（tasks.md）

## 文档头

- **特性**：genpi v1——机器强制的开发循环（feature/bugfix/research 三路径端到端），界面直接复用 pi 本体 TUI
- **一句话目标**：业务项目目录敲 `genpi` → 打开 pi 本体 TUI → 跑通 `CLARIFY→DESIGN→GATE→PLAN→IMPLEMENT→VERIFY→GATE_MR` 的代码化状态机循环
- **架构**：LoopEngine（TS 状态机深模块）+ StepRunner（pi SDK 唯一适配 seam）+ pi InteractiveMode 嵌入（genpi 编排扩展接管输入/聊天式门禁/进度桥）+ router（模型路由）+ resources（12 方法论按状态注入）。台账唯一真相，GATE 死等人工（聊天命令 a/c/r/p）。
- **技术栈**：TypeScript（strict）· Node ≥ 22.19 · `@earendil-works/pi-coding-agent`（锁 ^1.4.0，含 InteractiveMode 与扩展 API；v1.1 起不再直接依赖 pi-tui）· Vitest · tsup 构建
- **全局约束**（照抄 design.md §3，逐条确切值）：
  1. 依赖仅上述两个 pi 公开包，**只从包根 import**，MUST NOT deep-import `src/`
  2. 数据根 `~/.genpi`：`cli.ts` 首行设 `process.env.PI_CODING_AGENT_DIR`（MUST NOT 读写 `~/.pi`）
  3. budget 默认 3/步；request_changes 不扣；GATE 无 `decide()` MUST NOT 转移
  4. 台账 `<项目根>/.genpi/runs/<runId>/`（run.json / design.md / tasks.md / phase-history.jsonl / conclusion.md）；MUST NOT 写循环外路径（worktree 除外）
  5. feature/bugfix MUST 走 worktree `.worktrees/<runId>/`；MUST NOT 碰主工作树与 `.gitignore`
  6. MR 创建失败 MUST NOT 失败 run → 降级 push + compare URL
  7. 同项目同时最多 1 个活跃 run
  8. 界面与产物中文；许可证 MIT；commit 格式 `<type>(<scope>): <summary>`
- **执行方式**：gen-subagent-dev（推荐）或内联执行。状态列由主 agent 维护。

## 文件结构映射

| 文件 | 职责 |
| --- | --- |
| `package.json` / `tsconfig.json` / `vitest.config.ts` | 工程：bin `genpi`、strict、Vitest |
| `src/types.ts` | 全部跨模块类型（PathId/StateId/StepSpec/StepResult/EngineEvent/RunRecord/…）——**单一类型源** |
| `src/config.ts` | 三级配置解析 + 数据根设定 + 首启检测 |
| `src/engine/paths.ts` | 三路径状态转移表（纯数据） |
| `src/engine/ledger.ts` | run 目录/台账读写/恢复快照 |
| `src/engine/loop-engine.ts` | 状态机驱动、GATE、budget、单活跃锁、steering 队列 |
| `src/engine/worktree.ts` | git worktree/分支/push/MR（含降级） |
| `src/router.ts` | 请求路由：模型判断 feature/bugfix/research，启发式兑底，前缀强制（纯函数可测） |
| `src/ext-manager.ts` | 扩展管理：一次性剥离 pi 继承（备份可回滚）+ createExtManager（复用 pi PackageManager 安装/卸载/列表） |
| `src/agent/step-runner.ts` | StepSpec → pi AgentSession → 事件流/StepResult |
| `src/resources/` | 12 方法论改写版 + `index.ts`（state→方法论映射 + preamble） |
| `src/tui/screens.ts` | 聊天消息格式化纯函数（renderWelcome/fmtRoute/renderGateBlock/gateHint/renderHeader，demo 模式与进度文案共用） |
| `src/tui/app.ts` | pi InteractiveMode 嵌入 + genpi 编排扩展：input 接管分流（routeUserInput）、聊天式门禁（a/c/r/p，无模态防误触）、sendMessage/setWidget/setStatus 进度桥、session_start 活跃 run 自动恢复 |
| `src/cli.ts` | 入口：数据根→配置→凭证检查→TUI/--resume/--demo-run/--selftest |
| `test/*.test.ts` | 各任务测试（就近放置于 `test/`） |

## 任务表

| ID | 切片 | 关键产出 | 验收命令 | 状态 |
| --- | --- | --- | --- | --- |
| T1 | 骨架+TUI spike | 工程+bin+四屏骨架渲染 | `npm test -- screens && ./bin/genpi.mjs --version` | done |
| T2 | 配置+数据根 | config.ts 独立凭证根 | `npm test -- config` | done |
| T3 | 引擎核心（headless） | paths/ledger/engine+GATE/budget/恢复 | `npm test -- engine` | done |
| T4 | StepRunner | pi SDK 适配+证据提取 | `npm test -- step-runner` | done |
| T5 | worktree+MR 降级 | git 隔离+push+MR 降级 | `npm test -- worktree` | done |
| T6 | 方法论资源包 | 12 份改写+映射 | `npm test -- resources && npm run check:resources` | done |
| T7 | headless E2E | 三路径端到端（fake runner） | `npm test -- e2e-headless` | done |
| T8 | TUI 全交互 | Gate/Run/Stop 接线+demo 模式 | `npm test -- tui && ./bin/genpi.mjs --demo-run` | done |
| T9 | 发布面 | README/--resume/自检/契约映射表 | `npm test && ./bin/genpi.mjs --selftest` | done |
| T10 | TUI 切换 pi 本体 | InteractiveMode 嵌入+编排扩展+活跃 run 自动恢复 | `npm test -- tui screens && PTY 手验` | done |
| T11 | 扩展独立管理 | pi 继承剥离迁移+genpi ext install/uninstall/list/update | `npm test -- ext-manager && genpi ext list` | done |
| T12 | 缺陷修复色 | abort/stop+GATE_MR 预览+模型角色+无 git 降级+-builtin 保留 | `npm test`（63 用例） | done |
| T14 | 门禁去模态化 | 聊天命令 a/c/r/p（防误触）+产物正文不默认上屏 | `npm test -- screens && genpi --demo-run` | done |
| T15 | research 去门禁 | 咨询/调研结论即交付，无批准/拒绝 | `npm test`（64 用例，engine ⑪b/e2e ②） | done |
| T13 | C 级 backlog | 进程锁/routing 输入保留/footer 预算/worktree 清理/日志命令/Windows | — | todo |
| T24 | 上下文连续性 E+A | parentRun 链+会话滚动摘要（契约 24） | `npm test`（90 用例，engine ㉓㉔/router ⑭） | done |

---

## T1 — 骨架 + TUI spike（tracer bullet：`genpi` 命令启动、四屏可渲染）

**接口**：产出 `src/types.ts`（本任务先落 UI 所需子集，后续任务只增不改）、`src/tui/screens.ts` 四个纯函数；`bin/genpi.mjs`。

**步骤**：

1. `package.json`：
```json
{
  "name": "genpi", "version": "0.1.0", "type": "module", "license": "MIT",
  "bin": { "genpi": "./bin/genpi.mjs" },
  "engines": { "node": ">=22.19" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "check:resources": "node scripts/check-resources.mjs"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^1.4.0",
    "@earendil-works/pi-tui": "^1.4.0"
  },
  "devDependencies": { "typescript": "^5.7.0", "vitest": "^3.0.0", "tsup": "^8.0.0" }
}
```text
2. `tsconfig.json`：`strict`、`module: nodenext`、`outDir: dist`、`include: ["src"]`。
3. `src/types.ts`（首版子集）：
```ts
export type PathId = "feature" | "bugfix" | "research";
export interface LauncherState { projectDir: string; hasGit: boolean; activeRun?: string; input: string; }
export interface RunScreenState { path: PathId; state: string; stream: string[]; awaitingAnswer: boolean; }
export interface GateScreenState { gate: string; artifact: string; content: string; }
```text
4. `src/tui/screens.ts`（纯函数，字符串渲染——TUI spike 的可测核心）：
```ts
import type { GateScreenState, LauncherState, RunScreenState } from "../types.ts";

export function renderLauncher(s: LauncherState): string {
  return ["┌ genpi ────────────────────────┐",
    `│ ${s.projectDir} · git ${s.hasGit ? "✓" : "✗"}${s.activeRun ? ` · 活跃: ${s.activeRun}` : ""} │`,
    "│ [1] feature  [2] bugfix  [3] research │",
    `│ 需求: ${s.input}_`, "└──────────────────────────────┘"].join("\n");
}
export function renderRun(s: RunScreenState): string {
  return [`▸ ${s.path} · ${s.state}`, ...s.stream.slice(-20),
    s.awaitingAnswer ? "❓ 等你回答，直接输入…" : ""].filter(Boolean).join("\n");
}
export function renderGate(s: GateScreenState): string {
  return [`⏸ GATE · ${s.gate} · 审批对象: ${s.artifact}`, s.content,
    "[a] 批准  [c] 要求修改  [r] 终止  [q] 安全退出"].join("\n");
}
```text
5. `bin/genpi.mjs`：`--version` 打印 `genpi 0.1.0` 退出 0；`--selftest` 渲染三屏各一帧到 stdout 退出 0；无参数时打印"TUI 主体在 T8 接入"并以 0 退出（T1 阶段占位行为，T8 替换）。
6. `test/screens.test.ts`：断言三屏渲染含关键行（`[1] feature`、`⏸ GATE`、`[a] 批准`）。
7. 提交：`feat(scaffold): 工程骨架与四屏纯函数渲染`。

**验收**：`npm install && npm run build && npm test -- screens` 退出 0；`./bin/genpi.mjs --version` 输出 `genpi 0.1.0`。

## T2 — 配置与数据根（垂直：`~/.genpi` 独立生效 + 三级解析 + 首启检测）

**接口**：消费 T1 `src/types.ts`；产出：
```ts
// src/config.ts
export interface ResolvedConfig { agentDir: string; mrTarget: "github"|"gitee"|"gitlab"|"none";
  branchPrefix: string; worktreeDir: string; budget: number;
  models: Partial<Record<"implementer"|"reviewer", string>>; }
export function applyDataRoot(home: string): string;                       // 设 PI_CODING_AGENT_DIR，返回 agentDir
export function resolveConfig(projectRoot: string, agentDir: string): ResolvedConfig;  // 默认 < ~/.genpi/settings.json < <项目>/.genpi/config.json
export function hasCredentials(agentDir: string): boolean;                 // agentDir/auth.json 存在且非空
```text
**步骤**（TDD）：
1. 先写 `test/config.test.ts`：tmp 目录三个用例——①仅默认值（mrTarget=github, branchPrefix="feature/", budget=3）②`~/.genpi/settings.json` 覆盖 budget=5 ③项目 `.genpi/config.json` 再覆盖 budget=2（优先级断言）；④`applyDataRoot` 后 `process.env.PI_CODING_AGENT_DIR` 等于入参；⑤空 auth.json → `hasCredentials()===false`。跑：`npm test -- config` 确认红。
2. 实现 `src/config.ts`（Node `fs`/`path`，同步读 JSON，缺文件跳过；合并规则：深层浅合并一层即可——v1 配置全部扁平）。
3. 绿后提交：`feat(config): 独立数据根与三级配置解析`。

**验收**：`npm test -- config` 退出 0（5 用例全绿）。

## T3 — 引擎核心（headless，fake runner 跑通三路径到 GATE/终态）

**接口**：消费 T2 `ResolvedConfig`；产出 `src/engine/paths.ts`、`src/engine/ledger.ts`、`src/engine/loop-engine.ts` 与 `src/types.ts` 引擎子集：
```ts
// src/types.ts 增补
export type StateId = "INIT"|"CLARIFY"|"DESIGN"|"GATE_DESIGN"|"PLAN"|"IMPLEMENT"|"VERIFY"|"GATE_MR"|"ARCHIVE"|"DONE"
  |"REPRODUCE"|"ROOT_CAUSE"|"FIX"|"REVIEW"|"RESEARCH"|"GATE_CONCLUSION"|"STOP";
export type RunId = string;
export interface CommandEvidence { command: string; exitCode: number; outputTail: string; }
export interface StepSpec { state: StateId; instruction: string; methodology: string[]; preamble: string; workingDir: string; }
export interface StepResult { ok: boolean; summary: string; artifacts: string[]; evidence: CommandEvidence[]; }
export interface StepRunner { run(spec: StepSpec, onEvent: (e: StepEvent) => void): Promise<StepResult>; }
export type StepEvent = { type: "text"; delta: string } | { type: "question"; text: string };
export type GateDecision = { kind: "approve" | "request_changes" | "reject"; note?: string };
export type EngineEvent =
  | { type: "state_entered"; runId: RunId; state: StateId }
  | { type: "step_stream"; runId: RunId; delta: string }
  | { type: "agent_question"; runId: RunId; text: string }
  | { type: "step_finished"; runId: RunId; state: StateId; ok: boolean }
  | { type: "gate_opened"; runId: RunId; gate: StateId; artifactPath: string }
  | { type: "gate_resolved"; runId: RunId; gate: StateId; decision: GateDecision }
  | { type: "budget_changed"; runId: RunId; state: StateId; remaining: number }
  | { type: "run_stopped"; runId: RunId; reason: string }
  | { type: "run_done"; runId: RunId; summary: string };
export interface RunRecord { id: RunId; path: PathId; request: string;
  status: "active"|"gate"|"stopped"|"done"|"rejected"; currentState: StateId;
  budget: Record<string, number>; createdTs: string; sessionIds: string[]; }
```text
`paths.ts` 数据表（转移+门禁+worktree 标志）：
```ts
export interface GateDef { artifact: "design.md" | "tasks.md" | "conclusion.md" | "mr";
  approveTo: StateId; requestChangesTo: StateId; }
export interface PathDef { id: PathId; states: StateId[]; gates: Partial<Record<StateId, GateDef>>; needsWorktree: boolean; }
export const PATHS: Record<PathId, PathDef> = {
  feature: { id: "feature", needsWorktree: true,
    states: ["INIT","CLARIFY","DESIGN","GATE_DESIGN","PLAN","IMPLEMENT","VERIFY","GATE_MR","ARCHIVE","DONE"],
    gates: { GATE_DESIGN: { artifact: "design.md", approveTo: "PLAN", requestChangesTo: "DESIGN" },
             GATE_MR: { artifact: "mr", approveTo: "ARCHIVE", requestChangesTo: "IMPLEMENT" } } },
  bugfix: { id: "bugfix", needsWorktree: true,
    states: ["INIT","REPRODUCE","ROOT_CAUSE","FIX","REVIEW","VERIFY","GATE_MR","ARCHIVE","DONE"],
    gates: { GATE_MR: { artifact: "mr", approveTo: "ARCHIVE", requestChangesTo: "FIX" } } },
  research: { id: "research", needsWorktree: false,
    states: ["INIT","RESEARCH","GATE_CONCLUSION","DONE"],
    gates: { GATE_CONCLUSION: { artifact: "conclusion.md", approveTo: "DONE", requestChangesTo: "RESEARCH" } } },
};
```text
`ledger.ts`：`initRun/listRuns/readRun/writeRun/appendHistory`（runId 格式 `YYYYMMDD-HHmm-<path>-<slug>`；slug 由 request 前 3 词 kebab 化；转移即 append `{ts,from,to,event,evidence?,budgetLeft?,note?}`）。
`loop-engine.ts`：
```ts
export interface EngineDeps { runner: StepRunner; ledger: Ledger; resources: ResourceProvider;
  git: GitOps; config: ResolvedConfig; projectRoot: string;
  emit(e: EngineEvent): void; ask(prompt: string): Promise<string>; }
export class LoopEngine {
  constructor(deps: EngineDeps);
  async start(path: PathId, request: string): Promise<RunId>;   // 单活跃锁：已有 active/gate run → 抛 GenpiActiveRunError（契约15）
  async resume(runId: RunId): Promise<void>;                    // 只信台账
  async decide(runId: RunId, d: GateDecision): Promise<void>;   // approve/request_changes(不扣budget)/reject(产物保留)
  steer(runId: RunId, text: string): void;                      // 入队，下一 step 边界前置注入（契约13）
}
```text
驱动语义：非 GATE 态 → 组 StepSpec（instruction=状态指令+台账上下文+steering 队列；methodology=resources.byState(state)；preamble=resources.preamble()）→ `runner.run` → 失败 budget-- 并重试同态，budget=0 → STOP（契约 6）→ GATE 态 → 写产物、emit gate_opened、**死等 decide**（契约 3）→ ARCHIVE=标记 done。ResourceProvider/GitOps 以接口注入（T4/T5/T6 实现），本任务用 fake。

**步骤**（TDD）：
1. `test/engine.test.ts` 先写六用例：①feature 全转移（fake runner 全 ok + 两次 decide approve → run_done，断言转移序恰为 states 序）②GATE 死等（不调 decide，轮询 200ms 无 state_entered(PLAN)）③budget 耗尽（runner 对 FIX 态恒败 → 3 次后 run_stopped）④request_changes 不扣（GATE_DESIGN → c → 回 DESIGN，budget 不变且再 approve 可达 DONE）⑤resume（start 后伪造进程重启——新 engine 实例 resume(runId) 从台账 currentState 继续）⑥单活跃锁（第二次 start 抛错）。跑红。
2. 实现三文件至全绿。
3. 提交：`feat(engine): 状态机/门禁/预算/台账/恢复核心`。

**验收**：`npm test -- engine` 退出 0（6 用例绿）。

## T4 — StepRunner（pi SDK 唯一适配点）

**接口**：实现 T3 的 `StepRunner`；产出 `src/agent/step-runner.ts`：
```ts
export interface PiStepRunnerOptions { agentDir: string; model?: string; }
export function createPiStepRunner(opts: PiStepRunnerOptions): StepRunner;
```text
实现要点（全部公开 API）：
- `applyDataRoot` 已在入口生效；`createAgentSession({ cwd: spec.workingDir, /* model: opts.model */ })`
- 会话持久（默认 SessionManager）→ `sessionIds` 回写台账（审计用）
- prompt 组装：`[spec.preamble]\n\n[spec.methodology.join("\n---\n")]\n\n# 任务\n${spec.instruction}\n输出要求：完成后给出 summary、产物相对路径列表、已执行验证命令及 exit code`
- `session.subscribe` → `text_delta` 转发 `onEvent({type:"text"})`；结尾消息含"❓"行 → `question` 事件（CLARIFY 用）
- StepResult 解析：从 `session.getLastAssistantText()` 提取末尾 ```yaml 块（`ok/summary/artifacts/evidence`），解析失败 → `ok:false` + 原文截断为 summary（MUST NOT 抛异常）

**步骤**（TDD）：1. `test/step-runner.test.ts`：注入 fake `createAgentSession`（模块级可替换：`setSessionFactoryForTest`）三用例：①事件转发与 question 识别 ②yaml 块解析成功 ③解析失败降级不抛。跑红。2. 实现至绿。3. 真模型冒烟（非 CI）：`GENPI_SMOKE=1 npm test -- step-runner` 跑一条真实 prompt 断言非空（无凭证自动 skip）。4. 提交：`feat(agent): StepRunner SDK 适配与证据解析`。

**验收**：`npm test -- step-runner` 退出 0。

## T5 — worktree 隔离与 MR 动作（含降级）

**接口**：实现 T3 的 `GitOps`；产出 `src/engine/worktree.ts`：
```ts
export interface GitOps {
  ensureWorktree(projectRoot: string, runId: string, branchPrefix: string, worktreeDir: string): Promise<string>; // 返回 worktree 绝对路径
  pushAndMr(worktreeDir: string, opts: { mrTarget: string; runId: string; summary: string }): Promise<{ mode: "mr"|"manual"; url: string }>;
}
export function createGitOps(exec: (cwd: string, cmd: string) => Promise<{ code: number; out: string }>): GitOps;
```text
实现：`git worktree add <dir> -b <branchPrefix><runId>`；push `git push -u origin <branch>`；MR：`gh pr create` 可用→`mode:"mr"`；不可用→`mode:"manual"`，URL=`https://github.com/<owner>/<repo>/compare/<branch>`（**MUST NOT 抛错**，契约 14）。
**步骤**（TDD）：`test/worktree.test.ts` 用 tmp `git init --bare` 远端 + tmp 项目：①worktree 建立且主工作树无新分支文件 ②无 gh 环境时 pushAndMr 返回 manual 模式 ③branch 命名符合前缀。红→绿→提交 `feat(git): worktree 隔离与 MR 降级`。
**验收**：`npm test -- worktree` 退出 0。

## T6 — 方法论资源包（12 份改写 + 映射）

**接口**：实现 T3 的 `ResourceProvider`；产出 `src/resources/*.md`（12 份，源=原 gen 工作流技能库 `gen-*/SKILL.md`，按 design §2.4 映射改名）+ `src/resources/index.ts`：
```ts
export interface ResourceProvider { byState(state: StateId): string[]; preamble(): string; }
export function createResourceProvider(): ResourceProvider;  // 内嵌 import *.md（经 tsup raw loader 或编译期 stringify）
```text
改写规则（确切）：①删除所有来源项目的路径/命令引用（项目名、项目专属命令/端口/工具链/产物目录）②项目差异替换为 `<由 genpi 配置提供：branchPrefix 等>` 占位符仅在示例中 ③中文保留 ④每份头部加一行 `> genpi 内置方法论·状态:<StateId>`。preamble=三份常驻约束合并。
**步骤**：1. 迁移改写 12 份+索引实现。2. `scripts/check-resources.mjs`：递归 grep 禁词表（来源项目名/专属目录/专属工具链）退出非零若命中；`test/resources.test.ts` 断言映射完备（每个 PathDef.states 中非 GATE/INIT/DONE/ARCHIVE 态的 methodology 非空，preamble 非空）。3. 提交 `feat(resources): 12 方法论内化与状态映射`。
**验收**：`npm test -- resources && npm run check:resources` 均退出 0。

## T7 — headless E2E（三路径端到端，fake runner，玩具仓）

**文件**：`test/e2e-headless.test.ts` + `src/engine/bootstrap.ts`（组装 deps 的工厂，T8 复用）。
**步骤**：tmp 玩具仓（含 bare remote、一个会失败的测试文件）；fake runner 脚本化（DESIGN 写 design.md、PLAN 写 tasks.md、IMPLEMENT 改文件+跑 `node test.js`、VERIFY 跑命令）。断言（=design §2.9.4）：①主工作树零污染（`git -C 主树 status --porcelain` 空）②产物四件齐 ③phase-history 含 exit code 证据 ④无 gh 时 GATE_MR approve 后 `mode:"manual"` 且 run_done ⑤research 路径在无 git 目录可跑完 ⑥第二 run 启动被拒。红→绿→提交 `feat(e2e): headless 三路径端到端`。
**验收**：`npm test -- e2e-headless` 退出 0。

## T8 — TUI 全交互（App 接线 + demo 模式）

**接口**：消费 T1 `screens.ts` 与 T3 事件流；产出 `src/tui/app.ts`：
```ts
export function runTui(deps: { engine: LoopEngine; projectRoot: string; activeRuns: RunRecord[] }): Promise<void>;
export function runDemoMode(): Promise<void>;  // fake runner 驱动，确定性渲染，结束退出 0
```text
实现要点：pi-tui `Box/VStack/ScrollView/Editor/SelectList/Markdown` 组合；Launcher→路径选择/需求输入/续跑列表；Run→`renderRun` 流 + `agent_question` 时输入框前置"❓"；Gate→`Markdown` 渲染产物 + 键位 `a/c/r/q`（c 弹 note 输入）；任意屏 `Ctrl-C` → 台账已实时落盘，直接安全退出（契约 7）。demo 模式用 T7 的 fake runner 跑 feature 全程（自动 decide），帧间隔 50ms。
**步骤**（TDD）：`test/tui.test.ts` 测键位分发纯函数（`handleGateKey("a") → approve` 等）；实现 App；`--demo-run` 手验。提交 `feat(tui): 四屏交互接线与演示模式`。
**验收**：`npm test -- tui` 退出 0；`./bin/genpi.mjs --demo-run` 退出 0 且全程渲染无异常。

## T9 — 发布面（README / --resume / --selftest / 契约映射表）

**步骤**：1. `src/cli.ts` 定稿：数据根→配置→无凭证走首启引导（选 provider→提示 `~/.genpi` 登录方式）→Launcher；`--resume <runId>` 直达。2. README（安装、三路径、`.genpi/` 说明、配置表、MIT）。3. `--selftest`：数据根可写、配置解析、资源装载、pi 包可 import 四项检查，全过退出 0。4. 在本文件追加「契约→测试映射表」（16 条契约逐条指向测试用例/代码位置）。提交 `feat(cli): 首启引导/resume/selftest 与发布面`。
**验收**：`npm test`（全量）退出 0；`./bin/genpi.mjs --selftest` 退出 0。

## T10 — TUI 切换为 pi 本体（InteractiveMode 嵌入 + 编排扩展）

**背景**：用户验收指出自绘四屏违背「基于 pi」定位——pi 的 `InteractiveMode` 从 SDK 包根导出，可直接嵌入；另有可用性 bug：活跃 run 抛错阻塞入口（契约 15）。本任务为架构修订，引擎与契约 1-17 不变。

**接口**（`src/tui/app.ts`，均为公开 SDK API）：
```ts
export async function runTui(opts: RunTuiOptions): Promise<number>;
// 会话装配：createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions:{ extensionFactories:[genpiExtension] } })
//          + SessionManager.create(cwd, ~/.genpi/sessions) → createAgentSessionRuntime → new InteractiveMode
export function parseGateCommand(input: string): { command: GateCommand; hint?: string };  // 聊天内 a / c <意见> / r
export function routeUserInput(phase: InputPhase, currentRunId: string | null, input: string): { target: ...; gateCommand?; hint? };
```text

**步骤**：
1. `input` 事件返回 `{action:"handled"}`——pi 不自行启动 agent 轮，genpi 接管输入，分流复用纯函数 routeUserInput（答题>门禁>新循环>steering）。
2. 门禁：聊天命令驱动（无模态弹窗防误触）：`a` 批准 / `c <意见>` 要求修改（parseGateCommand）/ `r` 终止 / `p` 按需拉取预览；产物正文不默认上屏（紧凑两行门禁块）；未决不推进（契约 3 界面面）。（v1.3 曾用 ui.select 模态，v1.4 按用户反馈去除）
3. 进度桥：`sendMessage` custom 入聊天流；step 流式 `setWidget` 实时尾随（步末 flush 末 20 行入流）；`setStatus` footer 常显 `path · STATE`。
4. `session_start`：`ledger.listRuns` 发现 active/gate run → 自动 `engine.resume`（修复入口阻塞）；欢迎消息仅空闲时发送。
5. 移除 pi-tui 直接依赖（界面全部委托 InteractiveMode）；types.ts 删 LauncherState/RunScreenState，GateScreenState 保留（门禁块格式化）。
6. 测试改造：tui.test 改测 routeUserInput/parseGateCommand；screens.test 改测新格式化函数。

**验收**：`npm test`（44 用例）全绿；`npm run check:resources` 通过；PTY 手验清单：pi footer（模型/分支/上下文）出现、活跃 run 自动恢复进 CLARIFY、agent 追问入聊天流、`/model` 等 pi 命令可用。提交：`51fb244b`。

## T11 — 扩展独立管理（初始零扩展 + genpi ext 安装/卸载）

**背景**：用户验收指出「复制 settings.json 后 pi 的 9 个扩展包（powerline/subagents/web-access…）被自动装载进 genpi」——不是要复制 pi 的扩展，而是要 genpi 自己支持安装/卸载。契约 17 改写（design v1.2）。

**接口**（`src/ext-manager.ts`；安装/卸载复用 pi 公开的 `DefaultPackageManager`，不自造包机制）：
```ts
export function sourceName(source: string): string;                                  // npm:foo@1/npm:@scope/name/git URL/路径 → 展示名
export function resolveUninstallSource(pkgs, nameOrSource): string | undefined;       // 卸载按名反查原始 source
export function createExtManager(pm: ExtPackageManager): ExtManager;                   // install/uninstall/list（pm 为结构子集，可 fake）
export function migrateInheritedPiConfig(agentDir, now?): PiInheritanceMigration | null; // 一次性剥离 packages/extensions + 目录备份，幂等
export function describeMigration(m): string;                                         // 人读摘要
```text

**步骤**：
1. 迁移：settings.json 含继承 packages/extensions 且无备份标记（`.pi-inheritance-backup/`）→ 备份 settings 原件、按包名移根级同名目录与整个 `npm/` 目录入备份、剥离两键；标记存在即跳跳过（保护 `genpi ext` 之后的写入）。
2. `genpi ext install <source>`（npm/git/本地路径）/ `uninstall <名|source>`（别名 remove）/ `list` / `update [名]`：`SettingsManager.create + DefaultPackageManager({cwd, agentDir, settingsManager})`，装于 `~/.genpi` 仅对 genpi 生效。
3. cli 接线：ext 子命令先于凭证检查（安装不需模型凭证）；TUI 启动前跑迁移并打印摘要。
4. 编排桥（inline extensionFactories）保留为编程 seam——test/extensions.test.ts 语义改标「编程注入 seam」，不再是用户扩展入口。

**验收**：`npm test -- ext-manager`（7 用例：sourceName/卸载解析/迁移剥离备份/幂等/干净配置不触发）全绿；真机 `genpi ext list` 触发迁移并显示空列表；PTY 手验 `[Extensions] <inline:1>` 仅剩编排桥、9 个 pi 扩展零装载。提交：见 git log。

## T12 — 缺陷修复包（中断/门禁预览/角色模型/路由防护/迁移回归）

**背景**：用户验收提问「还有什么缺陷」→ 逐项核查后采纳的 A/B 级修复（契约 19 新增，契约 16/17 修订，design v1.3）。

**修复清单**：
1. **步骤可中断（契约 19）**：`StepRunner.abort`（session.abort 接线）+ `StepResult.aborted`（引擎不扣 budget，run 转 stopped 可 resume）；TUI 在 step 流式期间接管 escape（onTerminalInput，步末/门禁归还）；`/genpi-stop` 扩展命令废弃当前 run（GATE 期同样生效，pending 答题先释放）。
2. **GATE_MR 审批对象**：`ensureWorktree` 返回 baseSha（run.baseSha 落账）；门禁开门时 `git.mrPreview`（提交列表 + diff --stat）随 `gate_opened.preview` 上屏；恢复 GATE_MR 同样重算；失败降级为原标签不阻塞。
3. **模型角色（契约 16 兑现）**：StepSpec.role（IMPLEMENT/FIX→implementer，REVIEW→reviewer）；step-runner services 化（modelRuntime+resolveCliModel 解析 config.models），解析失败回落全局默认；会话仍持久供审计。
4. **无 git 路由防护**：`routeRequest(..., {allowCodePaths:false})` 把 feature/bugfix 降级 research 并说明原因（前缀强制是用户明确意志不覆盖）；TUI 按项目 hasGit 传入。
5. **迁移回归修复**：`-builtin:*` 禁用指令保留（仅剥可装载条目）；仅含禁用指令的 extensions 不触发迁移；真机 settings 已恢复 `-builtin:mcp`。

**验收**：`npm test` 63 用例全绿（worktree ①b 预览、engine ⑩⑪⑫、step-runner ⑤⑥⑦、router ⑥、ext-manager ⑤⑦ 修订）。

## T13 — C 级 backlog（记账未实施）

双终端同项目进程锁；routing 期间输入保留（而非丢弃）；footer 常显 budget 余量；rejected/stopped run 的 worktree 清理；步骤叙事全文查看（`/genpi log` 已有转移史，全文待扩展）；token 成本度量（需 SDK usage API 调研，T30 划出）；Windows 支持与测试。（原记 6/7/8 三项优化——ModelRuntime 缓存、/model 跟随、间隙 abort——已在 T16 实施，移出；原「[genpi/progress] 堆积治理」经意实为启动期重复触发，T21 已修，移出）

## T16 — 二轮自审缺陷修复包（证据机器校验/提交完整性/中断补全/模型跟随/env 凭证）

**背景**：用户要求二轮自审 → 核查出 5 缺陷 + 3 优化，全部采纳实施（design v1.6：契约 4 强化、契约 19 补全）。

**修复清单**：
1. **证据机器交叉校验（契约 4，核心）**：StepRunner 从 `tool_execution_start/end` 事件采集 bash 真实执行记录（command/exitCode/outputTail），`crossCheckEvidence` 与自报 evidence 交叉校验——exitCode 不符即 fail（伪造）；VERIFY 态自报无真实执行对应即 fail；非验证态放行（可引用只读操作）。
2. **GATE_MR 提交完整性**：mrPreview 增机器检查——零提交（⚠ MR 将为空）与未提交变更（⚠ push 不包含，列前 5 处）置顶警告，批准前可见 push 缺口。
3. **/genpi-stop 台账兜底**：currentRunId 丢失（resume 失败等）时回退 ledger 活跃 run，消除 TUI 内死锁。
4. **Q&A/间隙中断补全（契约 19）**：engine.pendingAbort——Q&A 等待期 stop/abort 不再多发一次模型调用（#runStep 轮头消费 + Q&A 后台账状态检查）；drive 的 aborted 分支遇 stop 已落 stopped 时不重复发 run_stopped。
5. **env 凭证放行**：hasCredentials 认可常见 provider 环境变量（ANTHROPIC/OPENAI/OPENROUTER/GEMINI/XAI/DEEPSEEK/GLM 等 15 个），不再误拦无 auth.json 用户。
6. **ModelRuntime 按 agentDir 缓存**（优化）：每 step 不再冷启动读盘建 ModelRuntime。
7. **步骤会话跟随 /model**（优化）：app.ts 捕获交互会话当前模型（provider/id）经 bootstrap.defaultModel 注入，无角色状态生效（低于 config.models 角色配置）。

**验收**：`npm test` 67 用例全绿（+3：step-runner ⑧证据校验、engine ⑬Q&A停/⑭间隙 abort；worktree ①b/config ⑤/step-runner ⑦ 扩展）。

## T17 — 扩展命令对齐 pi（genpi install/uninstall/list/update 顶层化）

**背景**：用户指出安装扩展应是 `genpi install npm:pi-lens`（与 pi 同习惯），而非嵌套子命令 `genpi ext install`。

**改动**：cli.ts 扩展管理提为顶层命令（install/uninstall/remove/update/list，与 `pi install …` 同形）；`genpi ext …` 保留为兼容别名；缺参时给出该命令用法而非「未知子命令」；README 用法示例更新。

**验收**：`genpi list`/`genpi install`（缺参提示）/`genpi ext list`（别名）实测通过。

## T18 — 恢复改用户主导（打开不自动复活旧 run，/new 干净）

**背景**：用户反馈「打开就显示上一个会话（恢复运行 …），/new 也一样」——自动恢复跟随台账而非会话，无法逃脱，每次打开都被旧 run 劫持。

**改动**（design v1.7，契约 15 修订）：
1. session_start 不再自动 resume：仅一行提示「⏸ 有未完成循环 <id>：回继续续跑 · /genpi-stop 放弃 · 新需求自动搁置」+ 欢迎语；`/new` 换会话同样干净。
2. routeUserInput 新增 resume 分流：空闲且有挂起循环时精确关键词（继续/continue/resume/续跑）→ 恢复；非精确关键词仍当新需求（不误触）；运行中不劫持插话。
3. beginRun 新需求优先：启动前自动搁置旧活跃 run（engine.stop「新需求优先，自动搁置」，台账保留），入口永不阻塞（承接原 T10 自动恢复要解决的问题，且不劫持用户）。
4. 显式 `--resume <id>` 仍直接续跑。

**验收**：`npm test` 68 用例全绿（tui ⑤b resume 分流）；PTY 实测：打开=欢迎语+提示、无自动「恢复运行」行。

## T19 — stopped 可续跑 + 中断标志防跨 run 泄漏（v1.8）

**背景**：1607 回归——搁置旧 run（stop）或 escape 中断后 `pendingAbort` 残留无人消费，毒死下一个 run 第一步（2ms 内假「用户中断」）；且契约 19「转 stopped 可续跑」与实现不符（resume 对 stopped 一律拒绝），提示语「可 --resume 续跑」名不副实。

**改动**（design v1.8，契约 19 补全）：
1. 中断标志生命周期绑定 drive 循环：`driving` 记录当前循环所属 run；`abort()` 仅在有活跃循环时置位；`drive()` 启动清零、finally 复位——残留标志不跨 run/跨代（测试 ⑮⑯）。
2. stopped 可续跑：`resume` 对 stopped 且停在门禁态重开 GATE 死等 decide（status 复写 gate 落账），其余 stopped 从 active 续跑；done/rejected 仍拒绝。
3. `run_stopped` 事件只发裸 reason，「可 --resume 续跑」提示由展示层统一追加，防 resume 后重复拼接。
4. TUI：`engine.start` 增 onCreated 回调，runId 创建即注入——初始 drive（CLARIFY/DESIGN…）期间 escape/steering 即可用（此前 await 返回后才就位，首步期间输入黑洞）；session_start 可续跑判定纳入 stopped（中断/搁置/耗尽均提示「回继续续跑」）。

**验收**：`npm test` 70 用例全绿（engine ⑩ 断言改裸 reason+stopped resume 走完、⑪ stopped@GATE 重开 gate_opened、新增 ⑮⑯ 回归）。

## T20 — 风险分级 T0-T2 + CLARIFY 豁免 + prd 路径（v1.9）

**背景**：与原 gen 工作流对照评估（gap analysis）出三件高价值差距：小改动比原工作流更重（无风险分级）、需求已明仍被澄清（无豁免）、prd 类产出无路径。采纳分批补齐策略的前三件。

**改动**（design v1.9，契约 20/21/22）：
1. 风险分级（仅 feature）：路由小会话附带判 tier（不增调用次数），启发式兑底存疑就高（t2 先于 t0）；tier 落 run.json 并记 phase-history（event:tier）；T0 走短链 INIT→IMPLEMENT→VERIFY→GATE_MR→ARCHIVE→DONE（paths.ts tierChains + chainFor，无澄清/设计/计划/设计批准）；T2 链同 T1 但 DESIGN 指令强制「回滚预案」节、REVIEW 指令加安全轴（bugfix t2 同样生效）；旧 run 无 tier 字段→回退 t1 全链。
2. CLARIFY 豁免：路由判需求证据完整（附验收标准/复现命令/明确无需澄清）时 start 跳过 CLARIFY 直入 DESIGN，理由落 phase-history（event:clarify_waived）；默认不豁免，行为与 v1.8 一致；T0 短链无 CLARIFY 自然不触发。
3. prd 路径：INIT→PRD→GATE_PRD→DONE，只读无 worktree 无 MR；产物 prd.md（GATE_PRD 审批对象：approve→DONE/request_changes→PRD 携注不扣 budget/reject 终止）；无 git 同样可跑（router 降级分支放行 prd）；前缀 4 强制；新增 resources/prd.md（用户故事/验收标准/非目标写作方法论）。
4. TUI：fmtRoute 展示 tier（t0/t2 可见，t1 静默）与豁免；tier/豁免随路由透传 engine.start。

**验收**：`npm test` 80 用例全绿（+10：router ⑦⑧⑨⑩、engine ⑰⑱⑲⑳、screens tier 展示、resources ④）；tsc 零错；check:resources 无耦合。subagent 交叉审与 deploy 路径仍缓（v2 候选，见评估）。

## T21 — 修欢迎块重复：session_start 幂等守卫（TUI）

**背景**：用户实报——打开 genpi 欢迎块叠加重复。诊断：pi InteractiveMode 启动序列中 `bindExtensions` 可能多次执行（`init()` 直发一次 + 信任授予/运行时重载经 `setRebindSession` 再发），每次均 emit `session_start`；genpi 处理器无幂等保护，逐次补发欢迎块+续跑提示。另经查：progress 消息（sendMessage display 路径）不落会话转录（全部 jsonl 零命中），重复纯为内存渲染层叠加，无需转录清理。

**改动**：`booted` 进程级守卫——uiRef/onTerminalInput/模型跟随每次触发照带刷新（重绑后 UI 上下文是新的），欢迎与续跑提示只发一次（/new /resume 切会话不重发，状态与 session 无关）；诊断期临时打点已还原。

**验收**：`npm test` 80 全绿；tsc 零错；PTY 手验（信任新目录场景欢迎块仅一块）。

## T22 — 需求标题修饰：runId/台账/产物告别原话（TUI/router/ledger）

**背景**：用户实报——会话后的产物（run 目录名、台账、文档标题）是需求原话：长句整段成目录名（按标点切词，中文无空格成整段）、口语语气词全保留、分词破碎（如「现在有来 genpi-是不是可以把项目里面的-agent」），甚至前缀剥离后只剩「3」。

**改动**：
1. 标题生成（主）：路由小会话顺手多输出一行 title（≤12字动宾短语，概括目标禁止照抄原话）——零额外模型调用；RouteResult.title 必带，分类器丢行则本地修饰兑底。
2. 本地修饰兑底 polishTitle：剥前缀语气词（我想/我要/帮我/请/现在等）→ 取首语义段 → 截 16 字（英文按词边界截，避免半截词）；前缀/启发式分支均用它。
3. 落账：initRun 收 title，runId slug 用 title（无则回退原话，向后兼容）；run.json 双落 title（人读）+ request 原文（审计保真，不修饰）；已有 run 目录不动。
4. 展示：路线行「feature「标题」」；续跑提示显示「「标题」（runId）」。
5. 产物文档标题指令：DESIGN/PLAN/PRD/RESEARCH 注入「标题用简短动宾短语，禁止照抄需求原话」。

**验收**：`npm test` 83 用例全绿（+2：router ⑪ polishTitle/模型 title/前缀 title，engine ㉑ runId 用 title/run.json 双落/产物指令；screens 扩展标题断言）；design §2.5 runId 规则更新。

## T23 — 自洽性审计与清理（契约/文档/实现三方对齐）

**背景**：用户要求非讨好式自审。逐条核对契约 22 条、design/tasks/onboarding/README 与实现，查出 9 项不自洽。

**修复**：① 契约 20 措辞与实现对齐（tier 全路径落账、链变体仅 feature、bugfix t2 消费 REVIEW 安全轴；原「不分级」表述与实现/测试 ⑱ 直接矛盾）② design 场景表 10 行 v1.0 化石（自动恢复→v1.7 仅提示）③ §2.3 接口对齐现实（events() AsyncIterable 不存在→emit 回调；start 签名补 onCreated/title；PathId 四选一）④ §2.1 方法论计数 12→11 ⑤ 测试数统一 83（README/onboarding §4，原与 §7 不一致）⑥ fmtRoute 豁免提示按适用性显示（feature 且非 t0 才有 CLARIFY 可豁免）⑦ ledger title 空串兜底（`?? `→`|| `，防 API 直调退化为 …-run）。

**遗留**：E+A 上下文连续性已拍板未实施——记 T24（对话决策无强制落账机制，本次靠人工捕回）。

## T24 — 上下文连续性 E+A（已实施，done）

**背景**：用户实报「每句对话都重建产物，不承接上下文」——run 结束回 idle，下一句按新需求处理，跨 run 零上下文；step 间也无对话记忆（靠产物落盘，契约 7 设计使然）。标题修饰（T22）只让重建的目录好看，未改变重建本身。

**已拍板方案（2026-10-31 会话确认）**：E+A 组合——
1. **E 会话滚动摘要（底座）**：run 完成时向 `.genpi/conversation.md` 追加一行摘要（runId/路径/需求前 40 字/产物清单，摘要文本取末步 StepResult.summary）；新 run 注入最近 N（≤5）条作背景——多轮连续、无需 followUp 判定。
2. **A parentRun 精确承接**：路由判 followup（模型+指代词兑底：这个/上轮/据此/深入…），新 run 挂 parentRunId 落账，指令注入前轮需求+产物路径；research 续写语义（读前轮 conclusion.md 修订而非重写）；feature 可直接引用调研结论（调研→功能链路）。
3. B（会话延续/靠聊天记忆）/D（重开 done run）/F（transcript 注入）已评估否决（违背台账为真相/终态语义/信噪比）。

**实施记录（T28 攻坚第二击）**：契约 24（E+A 双轨）+ 场景 22；RunRecord.parentRunId + ledger appendConversation/recentConversation（窗口 5）；router followUp（classifyWithModel 带 lastRun 上下文，兜底=有上轮+指代词 FOLLOWUP_KW）；engine start opts.parentRunId（落账+context_attached+parentCtx 缓存，前轮缺失静默降级）、#instruction 改 async 注入前轮上下文（research 续写/feature 引用语义）与近期背景、终态写滚动摘要；TUI lastDone 台账捕获 + followUp 透传 + fmtRoute「承接上一轮」。90 测试全绿（engine ㉓㉔/router ⑭/screens 断言）。

## T25 — 步骤实时视图：思考为主，工具聚合（TUI）

**背景**：用户反馈——进入 TUI 后不希望完整列出工具使用，更关注思考过程而非工具。

**改动**：renderStepLiveView 工具区从逐条列表（近 3 条含详情）改为**聚合计数一行**（🛠 bash×2 · write×1，详情不入屏）；思考行数 4→6（腾出的空间给主角）。工具仍在 StepLiveState 采集中（近 12 条窗口），仅展示层收敛。

**验收**：screens ⑦ 重写为聚合计数断言（含详情不入屏、思考 6 行封顶）；83 全绿。

## T26 — 聊天流瘦身：叙事不归档、状态行退场、门禁块首启后一行化（TUI）

**背景**：用户反馈——一套循环下来进度信息占满聊天流（实测最坏 ~170 行：每步归档叙事尾部≤20 行 + 状态行×8 + 门禁块×2×2）；希望门禁块可调高/点击收缩。

**结论先行**：pi 公开 API 不支持 entry 点击折叠（append-only 渲染文本无点击交互）——等价能力为「默认更矮 + 按需展开（p 预览）」。

**改动**：
1. 步末归档瘦身（最大头）：叙事尾部不再入聊天流（widget 看完即走）；step_finished 事件新增 summary/aborted 字段，聊天流落一行摘要 fmtStepDigest（✓/✗ 状态 · summary 首行截 40 字）；aborted 不落摘要（run_stopped 已报，防双报）。
2. 状态行退出聊天流：▸ STATE 不再发消息——footer(setStatus) 与 widget 标题已实时显示，聊天流只留需要用户在场的节点（GATE/问答/done/stopped）。
3. 门禁块首启后一行化：首个门禁两行含 a/c/r/p 教学，此后单行（gateTaught）。

**效果**：feature 全程聊天流 ~170 行 → ~10 行（8 摘要 + 2 门禁 + done）；叙事细节在 .genpi/runs 台账与 widget。

**验收**：84 用例全绿（+1：screens fmtStepDigest；门禁块 collapsed 断言、engine ① 扩 step_finished 摘要断言）；tsc/purity/markdown 零告警。

## T27 — chat 第五出口：闲聊放行原生会话，工作才进循环（router/TUI）

**背景**：用户确认——平常拿 genpi 聊天也会被塞进工作流（所有输入被接管、路由四选一无 chat 项、启发式兜底默认 feature）。对话与工作未分流。

**改动**：
1. 路由五出口：RouteResult.path 扩为 PathId|"chat"；模型 prompt 增 chat 类（闲聊/问候/致谢/无关对话/一句话可答小问题）与「存疑就工作」原则；启发式仅整句精确匹配（你好/谢谢/在吗/ok…）放行，含工作意图不误伤；无 git 分支 chat 免降级；前缀强制优先于 chat。
2. TUI 放行：input 处理器 start 分支改为 return beginRun(text)（async 处理器）——chat 时 {action:"continue"} 交 pi 原生会话直接回答：不建 run、不落产物、不预回显（原生已记录用户消息）、不搁置在跑循环；工作路径照旧（回显/搁置/启动）。

**验收**：86 用例全绿（+2：router ⑫ 启发式 chat 边界/⑬ 模型分支+无 git+前缀优先）；契约 18 增补 chat 出口、场景 21、README/onboarding 同步。

## T28 — 攻坚包总纲：垂直研发流程工具的健全与强大（差距地图）

**背景**：用户定标「健全且强大的垂直研发流程 Agent 工具」，要求全部攻坚、保质保量。非讨好式评估定性：**架构领先一个身位，产品成熟度落后架构一个身位（M1.5 装着 M3 级骨架）**——纪律机器化是真差异化，但流程完整性与真实交付可靠性未达标。

**差距地图与攻坚分解**：
- 🔴 T28a：feature 链缺 REVIEW——代码不审就送 MR（内化遇漏非取舍；原工作流与 bugfix 链均有）。
- 🔴 T28b：VERIFY 失败盲重试烧 budget，无诊断循环（契约 23：DEBUG 态定位根因→回修复态→再验证）。
- 🔴 T24：上下文连续性（已拍板 E+A，契约 24）——多轮协作基本盘。
- 🟡 T30：观测性——/genpi log + 路由决策全量落账；token 成本度量需 SDK usage 调研，列 backlog 不便估。
- 🔴 T31：真实交付校准——**工具无法替代的部分**：见下。

## T31 — 真实交付校准协议（待用户执行）

垂直工具的「强大」只能用真实交付衡量（mock/玩具仓测不出）。协议：
1. 选 1-2 个真实项目，完成 ≥10 次 run（覆盖 feature T0/T1、bugfix、research、prd）；
2. 每次记录人工干预点（门禁外的救火： steering 纠偏/手动修产物/重跑）；干预点回填 backlog；
3. 验收线：≥70% run 零人工救火直达 done；路由误判（tier/waive/chat/followUp）≤2 次/10；
4. 产出校准报告入 docs/（数据说话，不连自己感觉）。

**说明**：本包（T28a/b、T24、T30）为工具侧全部可交付项；T31 需真实模型与真实项目，工具无法自证，如实划界。

## T30 — 观测性：/genpi log + 路由决策全量落账（T28 攻坚第三击）

**改动**：
1. `/genpi log [n]`（缺省 15）：查看目标 run 的 phase-history 尾部（formatHistoryLines 纯函数：时分秒 from→to event · note，坏行跳过）；目标解析=当前 run→最近完成轮→台账最新。
2. 路由决策全量入史：engine.start 的 tier 事件升级为 routed 事件（note：path/by/tier/waive/followUp/title/理由）——/genpi log 可见，T31 真实校准的路由误判数据源。
3. token 成本度量：需 SDK usage API 调研（StepResult 未携带 usage），如实列 T13 backlog 不冒进。

**验收**：91 用例全绿（screens ⑧ 历史格式化；engine ⑰ 断言 routed/path=feature）；README/onboarding 同步。

## T32 — 欢迎块重复·根因三部曲终章：启动期聊天消息被 pi 追加式双添加（TUI）

**现象**：T21 守卫 + 重建后，打开 TUI 仍现两个完整 `[genpi/progress]` 欢迎块。

**根因链（三轮排查）**：① T21 修「发两次」（session_start 幂等）✓ 必要但不充分；② dist 未重建跑旧码（已加 bin 过期守卫）；③ **真根因（PTY 打点实锤）**：say 仅一次、entry 仅一条（同 id），但 pi 聊天容器把同一组件加两次——`entry_appended` 实时路径 + `renderInitialMessages→renderSessionItems` 追加式重画（不清空容器）：欢迎语落在 init 窗口内，两条路径都吃到。聊天通道对「启动期消息」结构性不安全。

**修复**：欢迎语+续跑提示改走 `setWidget("genpi-welcome")` 浮层——按键替换天然单份、零双添加暴露面；欢迎仅空闲相关，任意输入/开跑即隐。其余 say（路由/摘要/门禁）均在 init 后发生（单路径），保留 appendEntry 通道（custom entry + 自注册渲染器，不进 LLM 上下文）。

**验证**：PTY 驱动（应答终端能力查询，历次 script 方案盲区）端到端——欢迎语整流/末帧均 1 次，[genpi/progress] 标签块 0；91 用例全绿。

## T33 — 输入瞬间黑屏闪优化：结构变化合并，重排次数 3→1（TUI）

**现象**：输入需求后黑屏一闪再出交互。定性（PTY 实证）：非 bug——输入触发全会话最大布局重排（欢迎浮层移除+聊天插入+步骤浮层出现），不支持同步输出（\x1b[?2026）的终端把大面积重绘显示为闪。

**优化**：① 输入瞬间不再清欢迎浮层（顺带闲聊时欢迎保留）；② 欢迎浮层与步骤浮层在 scheduleWidget 首绘回调里**同帧替换**（两次结构变化并为一次重排）；③ 删「正在理解需求…」聊天消息（footer「路由中…」已覆盖，减一次容器追加）。

**验证**：PTY 注入需求——输入 +1.5s 欢迎仍在（未提前清除）、输入后全屏清屏 0 次、运行 UI（CLARIFY/思考中）正常浮现；91 用例全绿。终端建议：iTerm2/kitty/WezTerm 支持同步输出可根治闪感。

## T34 — 步末摘要优化：边界截断 + 落盘产物指路 + 完成行带要点（TUI/engine）

**现象**：用户实报——结论已写入产物，聊天摘要却硬切在第 40 字（切在引号/括号中间），且不指路（如「✓ RESEARCH · …推荐"git clone 本地仓重建 .git（避开」）。

**改动**：① cutBoundary 边界截断（限长内找最后一个标点/空格切齐，无处可切才硬切+省略号）；② step_finished 事件携带 artifacts，摘要行附产物指路「（→ conclusion.md）」（>2 个收敛为 2+…）；③ run_done 摘要携带末步要点（结论即交付的 research/prd 完成行不再只说「循环完成」），✔ 行边界截 80。
**顺带修真 bug**：lastSummary 原为 #driveLoop 局部变量——GATE 批准后重新 drive 即清零，feature 的 run_done 与 T24 会话摘要行一直拿到空要点；改实例级 Map（与 steering/qa 同模式）。

**验收**：91 用例全绿（screens digest 边界/指路断言重写、engine ① 扩 artifacts 透传与 run_done 要点）。

## T14 — 门禁去模态化（防误触 + 产物正文不默认上屏）

**背景**：用户验收反馈两点——①门禁消息把产物正文大量刷屏；②阶段完成后弹出批准/要求修改/终止选择框容易误触。

**改动**：
1. 门禁块改紧凑两行（`⏸ GATE <名> · 审批对象: <路径>（N 行）` + 命令提示），不再内嵌产物正文；文件行数等元信息仍可见。
2. 移除 `ui.select`/`ui.input` 模态：审批纯聊天命令（必须打字+回车，物理上无法误触）——`a` 批准 / `c <意见>` 要求修改 / `r` 终止 / `p` 按需拉取预览（GATE_MR 为 diff 统计，文件型为头部 12 行+全文路径）。
3. 机器强制力不变：未 decide 引擎不推进（契约 3），强制力在引擎非弹窗（契约 18 修订）。
4. GateScreenState 去掉 content 字段；demo 模式增加 `p` 预览帧示例。

**验收**：`npm test`（63 用例，screens 门禁断言改紧凑+p）全绿；`genpi --demo-run` 可见紧凑门禁块与 p 预览帧。

## T15 — research 路径去门禁（咨询类问答无需批准/拒绝）

**背景**：用户质疑「咨询类、讨论性问答为什么也要批准/拒绝」——门禁价值在于批准后接不可逆/高成本动作（GATE_MR→push/MR，GATE_DESIGN→后续实施）；调研结论本身就是交付物，读完即得，无机器后果，GATE_CONCLUSION 纯属官僚步骤。

**改动**：paths.ts research 状态机 `INIT→RESEARCH→DONE`（gates 置空），GATE_CONCLUSION 出 StateId；conclusion.md 照写（台账留档），RESEARCH 完成 run 直接 done。想追问/纠正？直接输入下一条（新 run 或对结论补充），对话式延续，无需门禁循环。

**验收**：`npm test` 64 用例全绿（engine ⑪b：research 无 gate_opened 直达 done；e2e ② 去 decide）；feature/bugfix 门禁不变。

---

## 自审记录

- design §3 契约 1-17 → 任务映射：1/9→T2、2/4/5/6/12→T3、3/13→T3+T8、7→T3、8→T5、10→T4、11→T6/T8、14→T5、15→T3/T7、16→T2 ✓ 无漏
- T10 架构修订：新增契约 18（TUI 复用 pi InteractiveMode）；契约 15 行为修订（打开时自动恢复，不阻塞入口）；契约 3/13 验证位置随迁；依赖面收窄为仅 pi-coding-agent ✓
- T11 扩展修订（design v1.2）：契约 17 从「透传三层发现」改写为「初始零扩展 + genpi ext 显式安装/卸载」；extensions.test 语义改为编程注入 seam；场景表增 12 ✓
- 占位符：T1 bin 无参行为的"T8 接入"为显式阶段性说明（T8 任务内消除），非规格占位 ✓
- 类型一致：StepSpec/StepResult/EngineEvent/RunRecord 在 T3 定义，T4-T10 消费同名同形；T10 删 LauncherState/RunScreenState（四屏遇场，仅存历史任务描述） ✓

## 契约→测试映射表（T9 收录）

| # | 契约 | 验证位置 |
| --- | --- | --- |
| 1 | 项目内零前置文件 | e2e-headless ①（玩具仓无 gen 文件跑通） |
| 2 | 产物落 .genpi/runs | e2e-headless ①（四件断言） |
| 3 | GATE 死等不自我放行 | engine ②（无 decide 200ms 零转移）+ tui ②④（parseGateCommand）+ T14 手验（门禁期非命令仅提示，不推进） |
| 4 | exit code 证据才宣告（v1.6 起机器交叉校验） | step-runner ⑧（伪造 exitCode→fail；VERIFY 无真实执行→fail）+ e2e-headless ① |
| 5 | worktree 隔离主树零污染 | worktree ① + e2e-headless ① |
| 6 | budget 耗尽 STOP | engine ③（2,1,0 → stopped） |
| 7 | 中断恢复只信台账 | engine ⑤（新实例 resume 走完） |
| 8 | 不碰 .gitignore/git 配置 | worktree ①（.worktrees/ 未入 git 属设计内）；全库无 .gitignore 写操作 |
| 9 | 数据根 ~/.genpi 独立 | config ④⑤ + `--selftest` ① |
| 10 | 资源缺失降级不崩溃 | resources/index.ts load() 警告降级路径 + resources ①②③装载 |
| 11 | 界面/产物中文 | screens ①②③ + tui ②（中文输入） |
| 12 | 决策/转移入 phase-history | engine ④（note 落史） |
| 13 | steering 边界注入不扣预算 | engine ①（问答上下文进下一轮 instruction，同一注入路径）+ tui ⑤（run 相位输入→steer 分流）+ loop-engine #instruction |
| 14 | MR 失败降级不失败 run | worktree ②③ + e2e-headless ①（push_manual + run_done） |
| 15 | 单项目单活跃 run（打开自动恢复） | engine ⑥ + e2e-headless ③ + app.ts session_start 自动恢复（T10 PTY 手验） |
| 16 | 模型角色配置 | config ③（models 三级合并）；运行时直传待 SDK Model 解析（step-runner.ts 注释留痕） |
| 17 | 扩展独立管理（初始零扩展，genpi ext 安装/卸载；-builtin: 禁用指令保留） | ext-manager ①—⑦ + T11 PTY 手验 |
| 19 | 中断/废弃（escape 不扣 budget//genpi-stop 台账保留；v1.8 起 stopped 可续跑） | step-runner ⑥（abort→aborted）+ engine ⑩⑪（stopped resume 走完/GATE 重开）+ engine ⑮⑯（中断标志不跨 run 泄漏） |
| 20 | 风险分级（feature 判 T0/T1/T2 落台账；T0 短链仅 MR 门；T2 强制回滚预案/安全轴；存疑就高） | router ⑨（启发式 tier）+ engine ⑰（T0 短链+tier 落账）⑱（T2 注入） |
| 21 | CLARIFY 豁免（证据完整直入 DESIGN，理由落史；默认不豁免） | router ⑩ + engine ⑲ |
| 22 | prd 路径（只读产出 prd.md，GATE_PRD 人工批准，无 git 可跑） | router ⑥⑦⑧（prd 路由/前缀 4/无 git 放行）+ engine ⑳ + resources ④ |
| 23 | VERIFY 失败转 DEBUG 诊断→回修复态携诊断→再验证；VERIFY budget 封顶循环 | engine ㉒ + paths.debugTo |
| 24 | 上下文连续性：滚动摘要注入 + followUp 前轮承接（parentRunId 落账、续写语义） | router ⑭ + engine ㉓㉔ + app.ts captureLastDone |
| 18 | TUI 复用 pi InteractiveMode（不自绘；门禁聊天命令化防误触） | app.ts（InteractiveMode+input handled）+ tui ⑤⑥ 纯函数 + screens 门禁紧凑块 + T14 demo 手验 |
