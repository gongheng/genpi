# genpi · design.md

- 状态：**已批准**（用户书面批准，HARD-GATE 通过）
- 版本：v1.9（2026-10-31 修订九：风险分级 T0-T2 + CLARIFY 豁免 + prd 路径；修订八：stopped 可续跑与中断标志防泄漏。修订七：恢复改为用户主导——打开只提示不自动复活；「继续」续跑；新需求自动搁置旧循环；/new 天然新鲜。v1.6：证据机器校验等；v1.5：research 去门禁；v1.4：门禁去模态化；v1.3：契约 19；v1.2：扩展独立管理；v1.1：TUI 嵌入 InteractiveMode）
- 形态：**独立仓库**（单独 git 维护、单独开源，`npm i -g genpi` 即用）；fork（gongheng/pi）仅作上游只读镜像，不承载产品代码
- 对 pi 的依赖面：仅 `@earendil-works/pi-coding-agent`（SDK，含 InteractiveMode 与扩展 API），以 npm 发布版消费，升级=改版本号；调试 pi 内部时 MAY 临时 `file:` 链接本地 fork，用完拆除

---

## 1. 动机与范围

### 1.1 动机

gen 工作流已在长期实践中验证价值，但存在两个结构性问题：

1. **复用税**：以项目内技能文件形式存在，每个新项目都要拷贝/引用 `.agents/skills/` + `.pi/`，且各项目副本漂移。
2. **纪律可绕过**：核心强制力（GATE 门禁、fail budget、两阶段 done、worktree 隔离）依赖提示词纪律，模型可绕过、可"合理化借口"。

genpi 把这套能力内化为产品：**业务项目目录下敲 `genpi` → 打开工作流 TUI → 与 agent 交互 → 走完机器强制的开发循环**。状态机、门禁、预算是 TypeScript 代码（机器强制）；11 份方法论文本作为各状态的知识注入（引擎是本体，方法论是弹药）。业务项目内零引用、零拷贝。

### 1.2 范围（v1 = 单一可交付子项目）

四条路径端到端跑通：**feature / bugfix / research / prd**。

### 1.3 非目标（v1 明确不做）

- Web 控制台、远程/headless 服务化、插件市场（headless 引擎天然可测，是将来服务化的免费接缝，但 v1 不做产品化）
- deploy 路径、subagent 交叉审查（v2 候选）
- 修改 pi 内核、依赖 pi 内部 API（fork 只读镜像 + public-API-only 两条纪律）
- 自建模型接入层/账号体系（复用 pi SDK 的 provider 与认证机制，仅把存储重定向到 `~/.genpi/`）
- run 记录入库归档（v1 产物原地保留于 `.genpi/`）

---

## 2. 技术方案

### 2.1 架构总览

```text
genpi/（独立仓库根）
├── src/
│   ├── cli.ts                   # `genpi` 命令：数据根→配置→凭证检查→启动 TUI；`--resume <runId>`；`ext install/uninstall/list/update`
│   ├── ext-manager.ts           # 扩展管理：一次性剥离 pi 继承（备份可回滚）+ 复用 pi PackageManager 安装/卸载
│   ├── router.ts                # 请求路由：模型判断 feature/bugfix/research（启发式兑底，前缀强制）
│   ├── engine/                  # ★ 产品核心（深模块）
│   │   ├── loop-engine.ts       #   状态机驱动、GATE、budget、run 生命周期
│   │   ├── paths.ts             #   三条路径的状态与转移表（数据，非散落逻辑）
│   │   ├── ledger.ts            #   .genpi/runs/<id>/ 台账读写与恢复
│   │   └── worktree.ts          #   git worktree 隔离（代码路径强制）
│   ├── agent/
│   │   └── step-runner.ts       # seam：StepSpec → pi AgentSession → 事件流（唯一知道 SDK 的地方）
│   ├── tui/                     # 直接嵌入 pi InteractiveMode + genpi 编排扩展（input 接管分流/聊天式门禁/进度桥/活跃 run 自动恢复）；screens.ts 仅余消息格式化纯函数
│   └── resources/               # 11 份方法论改写版（含 prd.md，v1.9）+ 常驻约束，按状态索引
├── docs/design.md               # 本文件
└── package.json                 # bin: genpi；npm 依赖 pi 公开包（锁版本）
```

### 2.2 路径状态机（paths.ts 数据表）

```text
feature : INIT → CLARIFY → DESIGN → GATE_DESIGN → PLAN → IMPLEMENT → REVIEW → VERIFY → GATE_MR → ARCHIVE → DONE（T28a：代码不审不送 MR）
           （T0 短链：INIT → IMPLEMENT → VERIFY → GATE_MR → ARCHIVE → DONE；T2 链同 T1，指令强化，见下）
bugfix  : INIT → REPRODUCE → ROOT_CAUSE → FIX → REVIEW → VERIFY → GATE_MR → ARCHIVE → DONE
research: INIT → RESEARCH → DONE（咨询/调研：结论即交付，不设门禁）
prd     : INIT → PRD → GATE_PRD → DONE（只读产出 prd.md，一道人工批准，无 worktree 无 MR）
```

规则：

- **风险分级（v1.9，契约 20）**：仅 feature 生效。路由时判 tier 落 run.json：T0（微改动：单文件修复/补测试/文案，无行为契约变化）走短链仅 MR 门禁；T1（常规）走全链；T2（触认证/加密/迁移/公共契约/影响≥ 3 模块）链同 T1 但 DESIGN 指令强制「回滚预案」节、REVIEW 加安全审查轴；存疑就高不就低。
- **CLARIFY 豁免（v1.9，契约 21）**：路由判定需求证据完整（附验收标准/复现命令/明确规格）时跳过 CLARIFY 直入 DESIGN，豁免理由记 phase-history（event: clarify_waived）；默认不豁免。

- **GATE 态**：引擎暂停，等待 `decide()`（approve / request_changes / reject）。approve → 下一态；request_changes → 回指定态并携带人工备注（不扣 budget）；reject → run 终止（status=rejected，产物保留）。
- **CLARIFY 内联问答**：office-hours 式追问在 step 内发生（agent 提问事件流到 TUI，用户在 Run 屏直接回答），不是独立 GATE。
- **中途插话（steering）**：Run 屏任意时刻可输入，作为对当前 step 会话的 steering 注入；不改变状态机位置，不扣 budget。
- **IMPLEMENT 逐任务**：引擎解析 tasks.md，每个任务一次 StepRunner 调用（tdd 方法论注入）；全部任务完成才进 VERIFY。
- **验证失败诊断循环（v1.9，契约 23）**：feature/bugfix 的 VERIFY 失败 SHALL 转 DEBUG 诊断态（重跑失败命令、定位根因、产出 diagnosis-latest.md），诊断完成回修复态（feature=IMPLEMENT / bugfix=FIX）并自动注入诊断（修复后删除该文件），再验证；VERIFY fail budget 仍为循环封顶，DEBUG 自身耗尽 SHALL STOP。
- **转移即落盘**：每次状态转移 append 到 phase-history.jsonl（含证据与 budget 余量）。

### 2.3 组件接口

```ts
// engine —— 深模块：吃"需求+路径"，吐"跑到 GATE 或终态"
export interface LoopEngine {
  start(path: "feature" | "bugfix" | "research" | "prd", request: string, onCreated?: (runId: RunId) => void, opts?: { tier?: Tier; waiveClarify?: boolean; waiveReason?: string; title?: string }): Promise<RunId>;
  resume(runId: RunId): Promise<void>; // stopped/gate 均可续（v1.8），done/rejected 拒绝
  decide(runId: RunId, decision: { kind: "approve" | "request_changes" | "reject"; note?: string }): Promise<void>;
  steer(runId: RunId, text: string): void;
  abort(): void;
  stop(runId: RunId, reason?: string): Promise<void>;
}
// 事件面：构造时注入 emit(e: EngineEvent) 回调（非 events() 迭代器）——TUI 与 headless 测试同一事件流（v1.9 对齐现实）

// EngineEvent（TUI 与 headless 测试共用同一事件面）
// state_entered | step_stream | agent_question | step_finished | gate_opened
// | gate_resolved | budget_changed | run_stopped | run_done

// step-runner —— seam/适配器
export interface StepRunner {
  run(spec: StepSpec, onEvent: (e: StepEvent) => void): Promise<StepResult>;
}
export interface StepSpec {
  state: StateId;
  instruction: string;      // 引擎按状态+台账生成的任务指令
  methodology: string[];    // 按状态索引注入的方法论资源
  preamble: string;         // 常驻约束（safe-ops/simplicity/surgical-edits 内化文本，每 step 必带）
  workingDir: string;       // 项目根（只读路径）或 worktree（代码路径）
}
export interface StepResult {
  ok: boolean;
  summary: string;
  artifacts: string[];                    // 本步产物相对路径
  evidence: { command: string; exitCode: number; outputTail: string }[];  // 两阶段 done 的机器证据
}
```text

```ts
// tui —— pi InteractiveMode 编排扩展（relay 桥，零渲染逻辑；v1.1）
// 会话装配：createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions:{ extensionFactories:[genpiExtension] } })
//          + SessionManager.create(cwd, ~/.genpi/sessions) → createAgentSessionRuntime → new InteractiveMode
// input 事件 {action:"handled"} 接管用户输入 → routeUserInput 分流（纯函数）：
//   awaiting-answer → 回答当前追问；gate → parseGateCommand（a / c <意见> / r）；idle → routeRequest → engine.start；run 中 → engine.steer
// 门禁 → 聊天命令驱动（无模态弹窗，防误触）：a 批准 / c <意见> 要求修改 / r 终止 / p 按需预览审批对象；
// 产物正文不默认上屏（紧凑两行门禁块），预览经 p 拉取；未决引擎不推进（契约 3 的界面面）
// 引擎事件 → pi 呈现：sendMessage custom 入聊天流；setWidget 实时 step 尾随；setStatus footer 常显 path·STATE
// session_start：ledger.listRuns 发现 active/gate run → 自动 engine.resume（契约 15，不阻塞入口）
```text

### 2.4 方法论注入映射（resources/）

| gen 技能 | 内化去向 |
| --- | --- |
| gen-bootstrap | 引擎本体（纪律变代码，无文本） |
| gen-office-hours | CLARIFY 注入 |
| gen-brainstorming | DESIGN 注入 |
| gen-writing-plans | PLAN 注入 |
| gen-tdd + gen-subagent-dev | IMPLEMENT 注入（逐任务） |
| gen-verification | VERIFY 注入 |
| gen-code-review | REVIEW 注入 |
| gen-debugging | REPRODUCE / ROOT_CAUSE / FIX 注入 |
| gen-research-method | RESEARCH 注入 |
| /gen-prd（.pi/prompts 路径） | PRD 态注入（prd.md 写作方法论，v1.9） |
| gen-git-workflow | GATE_MR 及 push/MR 动作（**参数化**：MR 目标 github 默认/gitee/gitlab/none，分支前缀、worktree 目录可配） |
| gen-safe-ops / gen-simplicity / gen-surgical-edits | preamble 常驻约束，每 step 必带 |
| gen-archive | v1 简化为 ARCHIVE 态标记 done（入库归档 v2） |

改写要求：清除全部来源项目耦合引用（项目差异下沉到配置默认值）；保留方法论本体。

### 2.5 台账与产物

```
<业务项目根>/.genpi/
├── config.json                  # 可选：mr.target / branchPrefix / worktreeDir / budget / model 角色
└── runs/<runId>/                # runId = <YYYYMMDD-HHmm>-<path>-<title slug>；title 为路由归纳的≤12字动宾短语（失败时本地修饰兑底：剥语气词/首段/截16字），需求原话不再直接成目录名（T22）
    ├── run.json                 # { id, path, title?, request, status, currentState, budget, sessionIds, tier? }（title 人读，request 原文审计保真）
    ├── design.md                # DESIGN 产物（GATE_DESIGN 审批对象）
    ├── tasks.md                 # PLAN 产物（IMPLEMENT 逐任务台账）
    ├── phase-history.jsonl      # 每次转移一行：{ ts, from, to, event, evidence, budgetLeft }
    ├── conclusion.md            # research 路径产物（结论即交付，无门禁审批）
    └── prd.md                   # prd 路径产物（GATE_PRD 审批对象，v1.9）
```text

- 产物随项目走、人可直接读；compaction-resistant：恢复只信台账文件，不信对话记忆。
- genpi MUST NOT 修改项目 `.gitignore`；首次运行提示用户自行决定是否 ignore `.genpi/`。

### 2.6 数据流（feature 全程）

1. `genpi`（项目根）→ 凭证检查（读写 `~/.genpi/`，缺则引导）→ 打开 pi 本体 TUI（编辑器/footer//model 等命令/主题），无任何选项屏，始终新鲜开始；若存在未完成循环仅一行提示（继续续跑/新需求自动搁置）；用户直接输入，genpi 路由五出口（feature/bugfix/research/prd 四工作路径 + chat 闲聊放行，T27；模型判断为主、启发式兑底，`1/2/3/4 ` 前缀强制指定路径）
2. 引擎 INIT：建 run 目录与 run.json，feature 代码路径先建 worktree（`.worktrees/<runId>/`，独立分支）
3. CLARIFY → DESIGN：产物 design.md 落 run 目录 → **GATE_DESIGN**：聊天流紧凑门禁块（对象+行数，不倒正文）；回 `a` 批准 / `c <意见>` / `r` 终止 / `p` 拉取预览
4. PLAN：tasks.md 生成 → IMPLEMENT：逐任务 StepRunner（工作目录=worktree），完成后引擎按 tasks.md 勾销
5. VERIFY：在 worktree 跑验证命令（构建/测试/lint），exit code 为证据；fail → 重试计入 budget
6. **GATE_MR**：聊天流展示变更摘要 + MR 目标 → approve → push 分支 + 建 MR（按 config）→ ARCHIVE → DONE
7. 全程 pi 本体界面：footer 常显 `path · STATE`（setStatus），step 输出实时尾随编辑器上方（setWidget）并按步归档入聊天流（sendMessage），CLARIFY 内联问答与 steering 同一输入框

### 2.7 错误处理与恢复

| 情形 | 行为 |
| --- | --- |
| step 失败 | budget 计数（默认 N=3/步）；耗尽 → run_stopped，STOP 屏转人工，不无限重试 |
| 人工 request_changes | 回退指定态携带 note，**不扣 budget**（人工反馈≠失败） |
| 进程退出 / Ctrl-C（pi 惯例双击退出） | 台账已实时落盘（转移即 append）；再次打开 genpi 自动检测并恢复活跃 run；`genpi --resume <runId>` 可指定恢复 |
| agent 会话异常 | StepRunner 返回错误 → 同 step 失败处理；sessionId 已记台账，transcript 可审计 |
| MR 创建失败（API/gh 不可用） | MUST NOT 判定 run 失败；SHALL 降级为 push 分支 + 打印 compare URL，GATE_MR 转“人工建 MR”提示 |
| 并发启动第二个 run | 同一项目同时仅一个活跃 run：新需求自动搁置旧循环（台账保留）后启动，入口永不阻塞；显式并发 start 仍拒绝并列出（多 run 并行 v2） |
| 方法论资源缺失 | 降级为无注入 + 警告，MUST NOT 崩溃 |
| 项目无 git | feature/bugfix 拒绝启动并提示；research 只读可运行 |

### 2.8 配置解析

**数据根独立**：genpi MUST 以 `PI_CODING_AGENT_DIR=~/.genpi` 启动所有 AgentSession——凭证（auth.json）、模型/provider 设置（settings.json）、项目信任（trust.json）、会话转录（sessions/）全部落 `~/.genpi/`，与 `~/.pi/` 完全隔离；MAY 提供一次性“从 `~/.pi` 导入”。

优先级：内置默认 < `~/.genpi/settings.json` < `<项目根>/.genpi/config.json`。默认值：mr.target=github、branchPrefix=`feature/`、worktreeDir=`.worktrees/`、budget=3。

### 2.9 测试

1. **引擎单测（headless，StepRunner 全 mock，表驱动）**：三路径全转移表；GATE 语义（未 decide() MUST NOT 转移）；budget 耗尽→STOP；request_changes 不扣 budget；reject 终止保留产物
2. **恢复测试**：模拟中断 → resume() 从台账重建，状态与 budget 一致
3. **StepRunner 契约测试**：mock AgentSession（SDK seam），验证注入与方法论装载
4. **e2e 垂直切片（v1 完成定义）**：玩具 git 仓（含 fake remote）跑通 feature 全循环——断言：worktree 分支存在且主工作树零污染、design/tasks/phase-history 齐全、验证命令证据在案、MR payload 正确、`.genpi/` 未入 git
5. **TUI 交互面（纯函数）**：routeUserInput 分流（答题>门禁>继续>新循环>steering）与 parseGateCommand（a 批准 / c 附意见 / r 终止）；界面本体委托 pi InteractiveMode（PTY 手验：pi footer 出现、打开不自动复活、门禁命令响应、追问入聊天流）

---

## 3. 行为契约（RFC 2119）

### 3.1 需求条款

1. genpi SHALL 在启动目录（业务项目根）运行循环，MUST NOT 要求项目内存在任何 gen/genpi 技能或配置文件。
2. genpi MUST 将全部循环产物写入 `<项目根>/.genpi/runs/<runId>/`；MUST NOT 写循环范围外的任何路径（worktree 内与 `.genpi/` 除外）。
3. 引擎 MUST 在 GATE 态暂停并等待显式 `decide()`；MUST NOT 由模型输出自我放行。
4. VERIFY MUST 以命令 exit code 为完成证据；证据 MUST 与会话内真实 bash 执行记录（tool_execution_* 事件）交叉校验：自报与真实 exitCode 不符即 fail（伪造证据）；VERIFY 态自报命令无真实执行对应即 fail（无法机器复核）；非验证态无对应则放行。无机器可复核的证据 MUST NOT 宣告完成（两阶段 done：agent 宣称 → 机器验证）。
5. feature/bugfix MUST 在独立 git worktree 分支上实施；MUST NOT 修改主工作树。
6. fail budget 默认每步 3 次；耗尽 MUST 进入 STOP 态转人工，MUST NOT 自动无限重试。
7. 进程中断后 `--resume` SHALL 从台账文件恢复（不信对话记忆）；恢复后状态与 budget MUST 与台账一致。
8. genpi MUST NOT 修改项目 `.gitignore` 或 git 配置。
9. genpi MUST 将凭证、模型/provider 设置、项目信任与会话转录独立维护于 `~/.genpi/`（经 `PI_CODING_AGENT_DIR` 重定向），MUST NOT 读写 `~/.pi/`；SHOULD 提供首次运行配置引导；MAY 提供从 `~/.pi` 的一次性导入。
10. 方法论资源缺失 SHALL 降级为无注入并警告，MUST NOT 崩溃。
11. 界面与产物语言 SHOULD 为中文（与源工作流一致）；英文 MAY 后续提供。
12. GATE 决策（含 note）与每次转移 MUST 记入 phase-history.jsonl（审计）。
13. Run 屏任意时刻的用户新输入 SHOULD 作为当前 step 的 steering 注入；MUST NOT 引发状态跳跃或扣减 budget。
14. MR 创建失败 MUST NOT 判定 run 失败，SHALL 降级为 push + compare URL 转人工。
15. 同一项目 SHALL 同时最多一个活跃 run；显式并发 `start` MUST 拒绝并列出活跃 run。打开 genpi 检测到未完成循环时 SHALL 仅提示（不自动恢复，`/new` 换会话同样干净）；回「继续」SHALL 续跑；输入新需求 SHALL 自动搁置旧循环（status=stopped，台账保留）后启动新循环——入口 MUST NOT 以「单活跃」为由阻塞。
16. `.genpi/config.json` MAY 按 step 角色指定模型（如 implementer/reviewer）；缺省继承 `~/.genpi/settings.json` 全局设置。
17. genpi 扩展独立管理：初始零扩展——MUST NOT 继承 `~/.pi` 或复制 settings.json 带来的 `packages`/`extensions` 配置；首次启动 SHALL 一次性剥离并备份（含已装目录，可回滚）；`-builtin:*` 禁用指令是用户偏好而非扩展装载，SHALL 保留。扩展仅经 `genpi ext install`（复用 pi PackageManager，装于 `~/.genpi`）显式安装，`genpi ext uninstall/list` 对应卸载与查看；内联 extensionFactories 保留为编程注入 seam（genpi 编排桥即基于此），非用户扩展入口。
18. genpi TUI SHALL 直接复用 pi 公开的 `InteractiveMode`（SDK 包根导出）而非自绘界面；genpi 以 pi 扩展机制接入：`input` 事件 `{action:"handled"}` 接管用户输入分流（v1.9 起 T27 增 chat 出口：路由判定为闲聊/问候/与开发工作无关的对话时 SHALL 放行 `{action:"continue"}`，pi 原生会话直接回答——不建 run、不落产物、不搁置在跑循环；启发式仅整句精确匹配放行，语义判断交路由模型，存疑 SHALL 就工作不闲聊），进度经 `sendMessage`/`setWidget`/`setStatus` 呈现；headless LoopEngine 与契约 1-17 MUST NOT 因此改变。门禁 SHALL 为聊天命令驱动（`a`/`c <意见>`/`r`/`p` 预览），MUST NOT 使用模态选择框（防误触）；产物正文 MUST NOT 默认上屏，预览按需拉取；未决引擎不推进的强制力在引擎，不依赖弹窗。
19. 中断与废弃：step 流式进行时 `escape` SHALL 中断当前步骤（StepResult.aborted，不扣 budget，run 转 stopped 可 resume）；会话间隙（建会话/Q&A 等待）收到的中断 SHALL 经 pendingAbort 在下一 step 前生效，MUST NOT 多发起一次模型调用；`/genpi-stop` SHALL 废弃当前 run（台账保留，currentRunId 丢失时 SHALL 回退台账活跃 run）；GATE 期废弃同样 SHALL 落 stopped。用户中断 MUST NOT 与失败同语义（不烧预算、不重试）。
20. 风险分级（v1.9）：路由时 SHALL 判定 tier（t0/t1/t2）并全路径落 run.json.tier 与 phase-history（审计统一）；**链变体仅 feature**——T0 走短链（INIT→IMPLEMENT→VERIFY→GATE_MR→ARCHIVE→DONE，仅 MR 一道门禁），T1 走全链；**T2 指令强化按状态生效**：DESIGN 强制「回滚预案」节（feature），REVIEW 加安全审查轴（bugfix 同样消费）；research/prd 记而不消费。判定存疑 SHALL 就高不就低；tier 与判定理由 SHALL 记入 phase-history。
21. CLARIFY 豁免（v1.9）：路由判定需求证据完整（请求已含验收标准/复现命令/明确规格，或用户明确表示无需澄清）时 SHALL 跳过 CLARIFY 直入 DESIGN，豁免理由 MUST 记入 phase-history（event: clarify_waived）；未判豁免 SHALL 默认进入 CLARIFY（行为与 v1.8 一致）；豁免不影响 budget。
22. prd 路径（v1.9）：仅读不改代码，SHALL 产出 prd.md（背景/用户故事/验收标准/非目标）；GATE_PRD SHALL 人工批准后交付（approve→DONE / request_changes→PRD 携注 / reject 终止）；无 worktree、无 MR；无 git 目录 SHALL 同样可运行。
23. 验证失败诊断循环（T28b）：feature/bugfix 的 VERIFY 失败 MUST NOT 原地盲重试——SHALL 转 DEBUG 诊断态（重跑失败命令、定位根因、把最小修复方案写入运行目录 diagnosis-latest.md）；诊断成功 SHALL 回修复态（PathDef.debugTo：feature=IMPLEMENT、bugfix=FIX）且修复态指令 MUST 自动注入诊断引用（存在即注入，修复完成后 agent SHALL 删除该文件）；VERIFY fail budget（契约 6）SHALL 仍为诊断循环封顶，DEBUG 自身 budget 耗尽 SHALL STOP 转人工。
24. 上下文连续性（T24）：跨 run 协作 SHALL 双轨——**E 滚动摘要**：每个 run 到达终态（done/stopped/rejected）SHALL 向 `<项目根>/.genpi/conversation.md` 追加一行摘要（runId/路径/状态/需求前 40 字/末步摘要前 60 字），新 run 的每步指令 SHALL 注入最近 5 条作背景（缺失降级为无注入，MUST NOT 崩溃）；**A 前轮承接**：路由在调用方提供上轮上下文时 SHALL 判定 followUp（模型为主，指代词兜底：有上轮+指代命中才承接，无上轮永不承接），判承接的新 run SHALL 落 parentRunId 并在指令注入前轮需求与产物目录（先读再动手）；research 承接 research SHALL 注入「修订/追加而非重写」续写语义，feature/prd 承接 SHALL 注入「前轮结论可作输入」；前轮已删除 SHALL 静默降级。承接关系与滚动摘要均为台账文件（compaction-resistant，与契约 7 同源）。

### 3.2 场景表

| # | GIVEN / WHEN | THEN |
| --- | --- | --- |
| 1 | 全新业务项目首次 `genpi` | 打开即 pi 本体界面，直接输入需求；无任何前置文件要求，无选项屏 |
| 2 | DESIGN 完成 | 聊天流紧凑门禁块（对象+行数）；未回 a/c/r 则引擎停在 GATE_DESIGN；p 可拉取预览 |
| 3 | GATE_DESIGN 输入 request_changes | 回 DESIGN 携带 note，budget 不变 |
| 4 | IMPLEMENT 某任务连败 3 次 | run_stopped + STOP 屏，台账可查 |
| 5 | VERIFY 测试命令 exit≠0 | 不宣告完成，重试计数，3 次后 STOP |
| 6 | 循环中 Ctrl-C 后重启 | 打开仅一行提示（不自动复活）；回「继续」从断点续跑；`--resume` 可指定；直接输入新需求则旧循环自动搁置 |
| 7 | 在已含其它 agent 工作流目录（如 `.ai/`、`.agents/`）的项目内跑 genpi | 两套互不干扰（`.genpi/` 独立命名空间） |
| 8 | 项目无 git 跑 feature | 拒绝并提示；research 可运行 |
| 9 | 向 StepRunner 传入内联扩展工厂 | 该扩展随每个 step 会话装载（`<inline:` 注册）；项目 `.pi/extensions/` 文件同样被发现 |
| 10 | 打开 genpi 时存在未完成 run（如上次 Ctrl-C 离开） | 仅一行提示不自动复活（契约 15，v1.7）：回「继续」续跑、直接输入新需求自动搜置、--resume 可指定 |
| 11 | 在 pi TUI 里使用 `/model` `/theme` 等 pi 命令 | 正常工作（InteractiveMode 原生能力，genpi 仅接管会提交给 agent 的输入） |
| 12 | 从 pi 复制 settings.json 后首次启动 genpi | 剥离继承的 packages/extensions（备份在 `.pi-inheritance-backup/`），pi 扩展零装载；`genpi ext install` 后仅装载显式安装项 |
| 13 | 无 git 目录提交 feature/bugfix 类需求 | 路由强制降级 research 并说明原因（前缀强制是用户明确意志，不覆盖） |
| 14 | step 流式中按 escape / 输入 /genpi-stop | 中断当前步骤（不扣 budget 可续跑）/ 废弃 run（台账保留） |
| 15 | `.genpi/config.json` 配置 implementer/reviewer 模型 | 对应状态会话用指定模型；解析失败回落全局默认 |
| 16 | TUI 内 /model 切换模型 | 步骤会话跟随交互会话当前模型（低于角色配置）；无角色状态立即生效 |
| 17 | GATE_MR 开门时 worktree 有未提交变更/零提交 | 预览顶部机器警告（⚠ 未提交/零提交），批准前可见 push 缺口 |
| 18 | 输入「改个文案/补个测试」类微改动（路由判 t0） | 走短链：无 CLARIFY/DESIGN/PLAN/设计批准，VERIFY 后直挂 GATE_MR；run.json.tier=t0 |
| 19 | 请求已附验收标准/复现命令（路由判 waive） | 跳过 CLARIFY 直入 DESIGN，phase-history 记 clarify_waived 及理由 |
| 20 | 「写份 PRD」类请求（路由判 prd） | 只读产出 prd.md，GATE_PRD 批准后 done；项目无 git 同样可跑 |
| 21 | 闲聊/问候（「你好」「谢谢」「在吗」） | chat 出口放行：pi 原生直接回答，不建 run、不落产物、不搁置在跑循环（T27） |
| 22 | 上轮刚 done，输入「深入这个方案的并发部分」 | followUp 承接：新 run 落 parentRunId，指令注入前轮需求与产物目录，research 续写不重写（契约 24） |

---

## 4. 模块 deletion test 记录

| 模块 | 删除后复杂度去向 | 结论 |
| --- | --- | --- |
| LoopEngine | 门禁/budget/台账强制散布到 TUI 与 runner 的 N 个调用点 | 保留（deep module，赚回成本） |
| StepRunner | pi API 直接渗入引擎与测试，上游变动波及面扩大 | 保留（adapter seam，接口即测试面） |
| TUI 层（编排扩展） | 引擎仍可 headless 运行（测试/未来服务化入口不受损）；退回 pi 原生 REPL 仍可用 | 保留为薄桥：分流核心是纯函数 routeUserInput/parseGateCommand（可测），渲染全部委托 pi InteractiveMode |
| resources/ | 方法论回到用户手工拷贝，产品退化 | 保留（核心弹药） |

## 5. 风险

- **SDK 界面/扩展 API 演进**（InteractiveMode、input 事件 handled 均为 pi 1.4 公开契约）→ npm 依赖锁 ^1.4.0；升级独立成任务，不混入功能分支。
- **长循环跨会话一致性** → 台账为唯一真相（设计内已保证），transcript 仅审计用。
