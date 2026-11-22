# genpi · 项目学习指南（onboarding）

> 目标读者：第一次接触本仓库、要读懂并改动的开发者。
> 配套文档：[README.md](../README.md)（用户视角）；行为契约以源码内「契约 N」注释为准，演进史见 git log。
> 本文回答「代码在哪、为什么这样设计、按什么顺序读」。

---

## 1. 一句话理解

**genpi = 把一套软件开发工作流（澄清→设计→批准→计划→实现→验证→MR）从"提示词纪律"内化为"TypeScript 代码强制"的 TUI 工具**，跑在任意业务项目目录里，基于 pi（`@earendil-works/pi-coding-agent`）作为模型执行层。

它解决两个结构性问题：

| 问题 | 旧形态 | genpi 形态 |
| --- | --- | --- |
| 复用税 | 工作流技能随项目拷贝，副本漂移 | `npm i -g genpi` 装一次处处用，项目内**零引用零拷贝** |
| 纪律可绕过 | GATE 门禁/fail budget/两阶段 done 靠提示词，模型可"合理化"绕过 | 状态机/门禁/预算是**机器代码**，模型无法自我放行 |

设计哲学一句话：**引擎是本体（纪律=代码），方法论是弹药（11 份 md 按状态注入）**。

---

## 2. 心智模型：五个关键词

读懂下面五个概念，就读懂了 genpi 的一半：

1. **run**：一次需求交付的完整循环。唯一实体，台账落盘于 `<项目根>/.genpi/runs/<runId>/`（runId 形如 `20261031-1632-feature-add-login`）。同一项目同时**最多一个活跃 run**（契约 15）。
2. **路径（path）× 状态机**：需求路由到四条路径之一（另设 chat 闲聊放行出口），每条路径是一张**纯数据转移表**（`src/engine/paths.ts`）：

   ```text
   feature : INIT → CLARIFY → DESIGN → [GATE_DESIGN] → PLAN → IMPLEMENT → REVIEW → VERIFY → [GATE_MR] → ARCHIVE → DONE
            （VERIFY 失败 → DEBUG 诊断 → 回修复态 → 再验证，契约 23）
            （T0 短链：INIT → IMPLEMENT → VERIFY → [GATE_MR] → DONE；T2 链同 T1，指令强制回滚预案/安全轴）
   bugfix  : INIT → REPRODUCE → ROOT_CAUSE → FIX → REVIEW → VERIFY → [GATE_MR] → ARCHIVE → DONE
   research: INIT → RESEARCH → DONE          （只读、无门禁——结论即交付，v1.5）
   prd     : INIT → PRD → [GATE_PRD] → DONE   （只读产出 prd.md，一道人工批准，v1.9）
   ```
3. **GATE（门禁）**：状态机在此**暂停死等**人工 `decide()`——approve 进下一态 / request_changes 回退携注（不扣预算）/ reject 终止。引擎代码强制，模型输出**永远**不能放行（契约 3）。
4. **fail budget**：每工作态默认 3 次**连续**失败额度（v1.10 语义澄清：任务推进或状态成功即重置；VERIFY 例外——为诊断循环 VERIFY→DEBUG→修复→再验证累计封顶），扣完 run 转 stopped 转人工，绝不无限重试（契约 6/23）。用户中断（escape）≠失败，不扣预算（契约 19）。
5. **台账（ledger）**：`run.json`（当前状态）+ `phase-history.jsonl`（每次转移 append 一行，含证据/预算余量/token 用量）。**恢复只信台账文件，不信对话记忆**（compaction-resistant，契约 7/12）——进程随便杀，重启即续（承接上下文也从 parentRunId 合账重建，v1.10）。

---

## 3. 全景地图

### 3.1 架构图（分层，箭头=依赖方向）

```text
                    ┌──────────────────────────────────────────┐
   用户 ──genpi──▶  │ cli.ts          入口：数据根→配置→凭证→TUI │
                    │ ext-manager.ts  扩展安装/卸载/剥离 pi 继承  │
                    └───────────┬──────────────────────────────┘
                                │
                    ┌───────────▼──────────────────────────────┐
   交互层            │ tui/app.ts      pi InteractiveMode 编排扩展│  ← 渲染全部委托 pi
                    │ tui/screens.ts  纯函数：消息/门禁块格式化    │
                    │ router.ts       需求→四路径+chat（模型/前缀  │
                    │                 /启发式，router 角色小模型）  │
                    └───────────┬──────────────────────────────┘
                                │ engine.start/resume/decide/steer/abort/stop
                    ┌───────────▼──────────────────────────────┐
   引擎层（核心）     │ engine/loop-engine.ts  ★状态机驱动/GATE/  │
                    │    budget/steering/pinned 验收/依赖引导    │
                    │ engine/paths.ts        四路径转移表（数据）  │
                    │ engine/ledger.ts       台账读写             │
                    │ engine/tasks.ts        tasks.md 勾选/验收解析│
                    │ engine/worktree.ts     worktree 隔离+MR+清理 │
                    │ engine/bootstrap.ts    装配工厂（组合根）     │
                    └──────┬──────────────────────┬──────────────┘
                           │ StepRunner(seam)     │ ResourceProvider
                    ┌──────▼──────────┐   ┌───────▼─────────────┐
   执行层            │ agent/          │   │ resources/          │
                    │ step-runner.ts  │   │ 11 份方法论 md+索引   │
                    │ pi SDK 唯一适配点│   │ （preamble 每步必带） │
                    │ 证据/产物校验    │   └─────────────────────┘
                    └──────┬──────────┘
                           │ AgentSession（SDK public API）
                    ┌──────▼──────────┐
                    │ pi-coding-agent │  模型会话/凭证/扩展/TUI 组件
                    └─────────────────┘
```

### 3.2 模块清单（全部源码 ~2720 行 + 11 份方法论）

| 文件 | 行数 | 一句话职责 | 关键契约 |
| --- | --- | --- | --- |
| `src/types.ts` | 97 | **单一类型源**：StateId/StepSpec（artifactRoots/verifyCommands）/StepResult（usage）/EngineEvent/RunRecord/Tier | — |
| `src/engine/paths.ts` | 66 | 四路径状态与门禁**纯数据表** + tier 链变体（chainFor） | 3/5/20/22 |
| `src/engine/ledger.ts` | 116 | 台账：runId 生成（title slug）/run.json 读写/phase-history append（含 usage）/会话滚动摘要 | 2/12/24 |
| `src/engine/loop-engine.ts` | 487 | ★核心深模块：drive 循环/GATE 死等/budget（连续语义）/steering/中断/tier 链路由与豁免/pinned 验收注入/worktree 依赖引导/用量落账 | 3/6/13/15/19/20/21/23/24 |
| `src/engine/tasks.ts` | 45 | tasks.md 未勾选任务解析/回写勾选/验收命令提取（pinned 源） | — |
| `src/engine/worktree.ts` | 162 | ensureWorktree（created 标志+setup 引导）/mrPreview(提交完整性)/pushAndMr(降级)/planCleanup+executeCleanup | 5/8/14 |
| `src/agent/step-runner.ts` | 373 | **pi SDK 唯一适配点**：StepSpec→AgentSession→事件流；证据交叉校验+恒真式审计+产物存在性+用量聚合 | 4/4a/16/17/24a |
| `src/resources/` | 11 md | 方法论按状态注入 + preamble 常驻；缺失降级不崩溃 | 10 |
| `src/router.ts` | 131 | 五出口路由（chat 放行）+followUp 承接；附带 tier/豁免/标题生成；routerModel 小快模型穿插 | 20/21/24 |
| `src/config.ts` | 79 | `PI_CODING_AGENT_DIR=~/.genpi` + 三级配置合并（含 worktreeSetup/models.router）+ 凭证检测 | 9 |
| `src/engine/bootstrap.ts` | 69 | 组合根：把 runner/ledger/resources/git/config 装配成 engine | — |
| `src/tui/app.ts` | 546 | pi InteractiveMode 编排扩展：input 接管分流（同步返回不吊主循环）/进度桥/footer/session_start 幂等 | 15/18 |
| `src/tui/screens.ts` | 171 | 纯函数：欢迎语/路由说明/门禁块/步骤实时视图渲染/步末摘要（含用量） | 11 |
| `src/cli.ts` | 182 | `genpi` 命令面：--resume/--demo-run/--selftest/clean/install… | — |
| `src/ext-manager.ts` | 142 | 扩展独立管理：剥离 pi 继承(备份可回滚)+PackageManager | 17 |

> deletion test 结论：LoopEngine 是 deep module（删了纪律散落 N 处）；StepRunner 是 adapter seam（删了 pi API 渗入引擎与测试）；TUI 层是薄桥（删了仍可 headless 跑）——三个"保留"的理由都值得背下来。

---

## 4. 五分钟跑起来

```bash
# 源码开发
npm install && npm run build && npm link
npm test                     # 112 用例（引擎/路由/风险分级/证据强制/TUI 纯函数/E2E/扩展），全 mock 无需凭证
npm run check:resources      # 方法论无项目耦合残留

# 体验（无模型凭证也能看交互）
genpi --demo-run             # 无模型演示模式
genpi --selftest             # 数据根/配置/资源/SDK 四项自检
genpi clean                  # 列出可清理的终态 worktree（--force 执行；台账保留）

# 真实使用（需凭证：~/.genpi/auth.json 或 ANTHROPIC_API_KEY 等 15 个环境变量之一）
cd ~/code/任意项目 && genpi   # 打开即 pi 本体界面，直接输入需求
```

TUI 内交互速查：

| 输入 | 效果 |
| --- | --- |
| 直接描述需求 | 路由四选一自动开跑（`1/2/3/4 ` 前缀可强制指定路径） |
| 闲聊（你好/谢谢/在吗…） | chat 出口放行：pi 原生直接回答，不进循环不建 run（T27） |
| `继续` / `continue` / `resume` | 续跑挂起的旧循环（stopped/gate 均可，v1.7/v1.8） |
| `a` / `c <意见>` / `r` / `p` | 门禁期：批准/要求修改/终止/预览审批对象（聊天命令，防误触） |
| 运行中输入任意文字 | steering：下一 step 边界注入，不跳状态不扣预算 |
| `escape` | 中断当前步骤（不扣预算，run 转 stopped 可续跑） |
| `/genpi-stop` | 废弃当前 run（台账保留） |
| `/genpi log [n]` | 当前/最近 run 转移史尾部（路由/推进/预算/诊断留痕，T30） |
| `/model` `/theme` 等 | pi 原生命令照常可用 |

---

## 5. 核心机制精读

### 5.1 drive 循环（loop-engine.ts `#driveLoop`）——整个产品的心跳

```text
while (rec.status === "active") {
  emit(state_entered)
  ├─ INIT     → 直接跳 states[1]，continue
  ├─ ARCHIVE/DONE → status=done，run_done，退出
  ├─ 门禁态(查 PATHS[path].gates)
  │    → status="gate"，emit(gate_opened)，return   ← 死等 decide()，引擎不推进
  └─ 工作态   → #runWorkState() → StepResult
       ├─ aborted → status=stopped（不扣 budget），退出    ← 契约 19
       ├─ ok      → currentState=下一态，history(step_ok+evidence+usage)；
       │            budget[state] 重置（连续语义，v1.10；VERIFY 例外累计封顶）
       └─ fail    → budget[state]-1；≤0 → status=stopped  ← 契约 6
}
```

四个易错细节（都有回归测试）：

- **IMPLEMENT 是逐任务循环**：`#runWorkState` 用 `parseUnchecked()` 解析 tasks.md，**每个任务一次 StepRunner 调用**，完成一个 `tick()` 勾选一个并记 `task_done`（同时重置该态 budget——v1.10 连续失败语义；交错失败不误杀）；失败即返回由 drive 统一扣预算（engine.test ⑥⑦㉕）。
- **VERIFY 是 pinned 驱动**（v1.10）：tasks.md 验收行（extractAcceptanceCommands，含已勾选任务——验证是全量回归）升格为固定验收命令注入 spec.verifyCommands；含恒真式的验收命令在引擎侧剔除并落史（verify_pin_dropped）。
- **中断标志生命周期绑定 drive 循环**（v1.8，1607 回归）：`driving` 记录当前循环的 runId，`abort()` 仅在有活跃循环时置 `pendingAbort`；drive 启动清零、finally 复位——否则搁置旧 run 的残留标志会毒死下一个 run 的第一步（engine.test ⑮⑯）。
- **`start(onCreated?)` 回调在 drive 之前触发**：TUI 借此在初始 drive（CLARIFY/DESIGN…）期间就能响应 escape/steering，不会出现"第一步期间输入黑洞"。

### 5.2 GATE 决策（`decide()`）与门禁定义

门禁在 paths.ts 是数据：`{ artifact, approveTo, requestChangesTo }`。decide 三分支：

- **approve**：GATE_MR 特殊——先 `pushAndMr()`（成功建 MR 或降级 push+compare URL，**都不算 run 失败**，契约 14），再进 approveTo；
- **request_changes**：跳回 `requestChangesTo` 携人工 note 重跑，**不扣 budget**（人工反馈≠失败）；
- **reject**：status=rejected，产物保留，run_done("人工终止")。

### 5.3 StepRunner（step-runner.ts）——唯一的 SDK 边界

- **可测性**：`setSessionFactoryForTest()` 可注入 mock 会话，全部引擎测试无需真模型；
- **会话构造**：`createAgentSessionServices` + `ModelRuntime`（按 agentDir 缓存免冷启动）+ `resolveCliModel` 解析角色模型；**codemode 工具显式装载+激活**（T39：SDK 会话默认连注册都没有——builtin 装载是 CLI 路径待遇；`createCodemodeExtension()` 入 extensionFactories + `setActiveToolsByName` 增量激活。沙箱脚本嵌套工具调用不进上下文，批量机械操作省 token；嵌套调用走同一工具管道，证据交叉校验照常生效）；
- **模型三级优先**（契约 16）：`config.models[role]`（implementer/reviewer；另有 `models.router` 供路由分类用小快模型，降延迟与成本）> 交互会话当前模型（跟随 `/model`）> 全局默认；
- **两阶段 done 的机器验证**（v1.6，契约 4）：收集会话内 `tool_execution_*` 真实 bash 执行记录，与模型自报 `evidence[].exitCode` **交叉校验**——VERIFY 态自报命令无真实执行对应、或 exitCode 不符 → 直接 fail（伪造证据）。这是"agent 宣称→机器验证"第二阶段的实现。v1.10 补强三件：①**恒真式审计** `masksExitCode`——VERIFY 自报命令含 `||`/`;`/`|`/`$(`/反引号/行首 `!`/末尾单 `&` 即 fail（`npm test || true` 骗不过；`&&`/重定向不掩错放行）；②**pinned 固定验收**——每条必须真实执行且 exit 0，模型无权自选/省略/替换；③**产物存在性** `checkArtifacts`——自报 artifacts 逐个在 artifactRoots（运行目录/工作目录/绝对路径）下 existsSync，未落盘进不了门禁（契约 4a）。
- **token 用量聚合**（契约 24a，v1.10）：订阅 `message_end`（assistant.usage）聚合 in/out → StepResult.usage → 事件与台账；失败重跑也计量（成本诚实）。

### 5.4 台账与产物（ledger.ts）

```text
<项目根>/.genpi/
├── config.json                # 可选项目级配置（mrTarget/branchPrefix/worktreeDir/worktreeSetup/budget/models+router）
├── conversation.md            # 会话滚动摘要（契约 24/E：每终态一行，新 run 注入最近 5 条背景）
└── runs/<runId>/
    ├── run.json               # { id, path, title?, tier?, request, status, currentState, budget, sessionIds, worktree?, baseSha?, parentRunId? }
    ├── design.md / tasks.md / conclusion.md / prd.md   # 各状态产物（GATE 审批对象）
    └── phase-history.jsonl    # append-only：{ ts, from, to, event, evidence?, budgetLeft?, note?, usage? }
```

每次转移**先 append history 再 writeRun**，进程随时可杀。resume 从 run.json 重建：gate/stopped@门禁态 → 重开 GATE；其余 stopped → 转 active 续跑；done/rejected 拒绝（v1.8 语义）；有 parentRunId 则从台账重建承接上下文（v1.10，不信进程内存）。

### 5.5 worktree 隔离与生命周期（worktree.ts）

feature/bugfix 在 `.worktrees/<runId>/` 建独立分支（前缀 `feature/`），主工作树零污染；`baseSha` 记入 run.json 供 GATE_MR 预览 diff。`ensureWorktree` 返回 `created` 标志：新建后按需执行 `worktreeSetup` 配置命令（如 `npm ci`）——新 worktree 无 gitignored 依赖，不引导则首次 VERIFY 必白烧一轮 budget+DEBUG 才发现「依赖没装」（v1.10；失败告警不阻塞）。目录被清但分支保留时自动挂回既有分支（`created=false`，resume 补建用）。`mrPreview()` 机器检查**提交完整性**：零提交（MR 将为空）或 worktree 有未提交变更（push 不含）→ 预览顶部警告。`pushAndMr()`：有 `gh` → 建 MR；无 → push + compare URL 降级。终态 run 的 worktree/分支用 `genpi clean [--force]` 清理（干跑列示，台账永久保留）；**防丢检查**：分支 tip 未被任何远端引用包含（未推送/推送降级/中断的 run）时 worktree 与分支均自动保留并给出手动出路——本地未推送提交永不因 clean 丢失。genpi 永不改 `.gitignore`/git 配置（契约 8）。

### 5.6 TUI 编排（tui/app.ts）——薄桥的设计

复用 pi `InteractiveMode`（不自绘），genpi 以**内联扩展**接入，只做三件事：

1. **接管输入**：`pi.on("input")` 返回 `{action:"handled"}` → 纯函数 `routeUserInput()` 分流——**待答问题 > 门禁命令 > 挂起续跑 > 新循环(engine.start) > 运行中(steer)**；门禁命令解析 `parseGateCommand()`（a/c/r/p）。分流逻辑全部纯函数可测（tui.test）。**关键纪律（T37）**：input handler 必须同步返回——`engine.start` 后台驱动（`void + .catch`），绝不在 await 链上等引擎（否则 pi 主循环被首条 prompt 吊死，后续输入落入 pendingUserInputs 缓冲被静默吞掉——「问答答案被吞」的根因）；闲聊放行走 `sendUserMessage({deliverAs:"followUp"})` 程序化发送（streaming 期排队下一轮，Promise.resolve 桥接挂 catch 防 unhandled rejection）。
2. **进度桥**：引擎 emit 的 EngineEvent → `sendMessage`(入聊天流)/`setWidget`(步骤实时尾随)/`setStatus`(footer 常显 `path·STATE`)。
3. **会话启动钩子**：`session_start` 时 listRuns 找 active/gate/stopped → **仅提示不自动复活**（v1.7 用户主导：回"继续"才续跑；直接输新需求则旧 run 自动搁置）。

### 5.7 配置与数据根（config.ts，契约 9）

- `applyDataRoot()`：`PI_CODING_AGENT_DIR=~/.genpi`——凭证/模型设置/会话转录与 `~/.pi` **完全隔离**；
- 三级合并：内置默认 < `~/.genpi/settings.json` < `<项目根>/.genpi/config.json`；
- `hasCredentials()`：auth.json **或** 15 个常见 provider 环境变量（v1.6 放行）。

### 5.8 扩展独立管理（ext-manager.ts，契约 17）

初始**零扩展**：首次启动一次性剥离从 pi 复制 settings.json 带来的 packages/extensions 配置并把已装目录移入 `~/.genpi/.pi-inheritance-backup/`（可回滚）；此后仅 `genpi install/uninstall/list/update`（复用 pi PackageManager，装于 `~/.genpi`）。内联 `extensionFactories` 是编程 seam（genpi 编排桥自身基于它），不是用户入口。

---

## 6. 一次 feature 需求的生命周期（把模块串起来）

以"给我的网站加个登录页"为例：

1. **入口**：`cli.ts` → 数据根/配置/凭证检查 → `tui/app.ts runTui()` → 装配 pi InteractiveMode；
2. **路由**：用户输入 → `parsePrefix`（无前缀）→ `classifyWithModel`（一次性内存会话判断 feature，可用 `models.router` 小快模型）→ `heuristicRoute` 兜底；
3. **开 run**：`engine.start("feature", …)` → ledger.initRun 建 `runs/<id>/` → `ensureWorktree` 建隔离分支（记录 baseSha）→ `onCreated(runId)` 回调让 TUI 立即进入 run 相位；
4. **CLARIFY**：`#runStep` 构造 StepSpec（状态指令+需求+preamble+clarify.md 方法论）→ StepRunner 建 pi 会话跑 → agent 追问以 `question` 事件流出 → `deps.ask()` 经 TUI 收答案 → 问答上下文累积注入后续步骤（≤5 轮，不扣预算）；
5. **DESIGN**：产出 design.md 落 run 目录 → 进 GATE_DESIGN：status=gate，聊天流出紧凑门禁块（对象+行数），引擎死等；
6. **用户回 `a`**：`decide(approve)` → currentState=PLAN → tasks.md 生成；
7. **IMPLEMENT**：逐任务循环——每任务一个 step（工作目录=worktree，角色=implementer，注入 implement.md+git-workflow.md），完成即勾选；用户中途输入 = steering 排队下一任务边界注入；
8. **VERIFY**：跑 pinned 固定验收命令与项目验证命令，`tool_execution_*` 真实记录与自报 exitCode 交叉校验（恒真式构造拒绝）；失败扣 budget 转 DEBUG 诊断→修复→再验证（3 次累计耗尽转 stopped）；
9. **GATE_MR**：mrPreview（diff 摘要+提交完整性警告）→ 用户 `a` → pushAndMr（gh 建 MR 或降级 push+compare URL）→ ARCHIVE → DONE，footer 归位，聊天流 run_done。

中断视角：任意时刻 `escape` → runner.abort → StepResult.aborted → 不扣预算转 stopped；重开 genpi 只提示一行，回"继续"→ resume 从台账续跑。

---

## 7. 测试地图（112 用例，全部无需真模型）

| 测试文件 | 覆盖 | 怎么 mock |
| --- | --- | --- |
| `engine.test.ts`（32） | ★drive 循环全语义：四路径转移/GATE 死等/budget 连续语义（交错重置）/request_changes 不扣/steering/resume（含承接重建与补建 worktree）/中断/搁置不毒死新 run/T0 短链/T2 注入/prd 循环/CLARIFY 豁免/标题落账/pinned 接线/worktreeSetup/用量落账/worktree 失败置 stopped | StepRunner 全 mock（makeWorld） |
| `step-runner.test.ts`（13） | SDK seam：注入装载/证据交叉校验（伪造 exitCode→fail）/恒真式审计拒绝与放行清单/pinned 三情形/产物存在性/用量聚合 | `setSessionFactoryForTest` |
| `worktree.test.ts`（10） | 真实 git 仓：worktree 隔离/挂回既有分支/mrPreview/提交完整性警告/planCleanup+executeCleanup（干跑与执行，未推送分支防丢保留） | 玩具 git 仓/fake exec |
| `ledger.test.ts`（1） | 台账原子写：tmp+rename 无残留、后写为准（契约 7 落盘底座） | 临时目录 |
| `e2e-headless.test.ts`（3） | 垂直切片：feature 全循环四件产物/push 降级/单活跃 | fake runner+玩具仓 |
| `tui.test.ts` + `screens.test.ts`（17） | 纯函数：routeUserInput 分流/parseGateCommand/渲染（含用量展示） | 无 mock（纯函数） |
| `router/config/ext-manager/extensions/resources`（35） | 四分类路由/tier 启发式/豁免判定/标题生成/routerModel 穿插/三级配置（worktreeSetup、models.router）/扩展管理/装载/资源 | 各自 seam |

测试哲学：**引擎 headless 可测是架构特性**——LoopEngine 不依赖 TUI，事件面（EngineEvent）即测试面；这也是"将来服务化的免费接缝"。

---

## 8. 行为契约速查（以源码「契约 N」注释为准，24+1 条）

| # | 一句话 | 实现锚点 |
| --- | --- | --- |
| 1 | 项目内零前置文件 | cli 启动即用 |
| 2 | 产物只写 `.genpi/runs/`（worktree 除外） | ledger/initRun |
| 3 | GATE 无 decide 不转移（模型不能自我放行） | driveLoop 门禁分支 return |
| 4 | VERIFY 证据 exit code + 与真实执行交叉校验；恒真式构造拒绝；pinned 固定验收命令无权自选/省略/替换（两阶段 done，v1.10 补强） | step-runner crossCheck+masksExitCode / engine pinned |
| 4a | 自报产物存在性校验：未落盘进不了门禁（v1.10） | step-runner checkArtifacts |
| 5 | feature/bugfix 必在 worktree，不碰主树 | GitOps.ensureWorktree |
| 6 | budget 默认 3 **连续**失败耗尽 STOP；任务推进/状态成功重置；VERIFY 累计封顶（v1.10 澄清） | driveLoop fail/ok 分支 + #runWorkState |
| 7 | 恢复只信台账，不信对话记忆 | resume 读 run.json |
| 8 | 不改 .gitignore/git 配置 | worktree.ts 无此操作 |
| 9 | 数据根 `~/.genpi` 独立（PI_CODING_AGENT_DIR） | config.applyDataRoot |
| 10 | 方法论缺失降级警告不崩溃 | resources/index load() |
| 11 | 界面/产物中文 | screens.ts |
| 12 | 决策与转移入 phase-history | appendHistory（每次转移） |
| 13 | steering 边界注入，不跳状态不扣预算 | steer()/#instruction |
| 14 | MR 失败不判 run 失败，降级 push+URL | pushAndMr |
| 15 | 单项目单活跃 run；打开仅提示不自动复活（v1.7） | start 检查/session_start |
| 16 | 角色模型 implementer/reviewer/**router**；worktreeSetup 依赖引导；`genpi clean` 清理（v1.10 扩展） | #roleFor+resolveCliModel / config / cli |
| 17 | 扩展初始零，显式安装 | ext-manager 剥离+install |
| 18 | TUI 复用 pi InteractiveMode，门禁聊天命令化非模态 | app.ts 编排扩展 |
| 19 | escape 不扣预算转 stopped 可续跑；间隙中断 pendingAbort 下一 step 前生效；中断≠失败 | abort/stop/#runStep（v1.8 补全 stopped 可续跑） |
| 20 | 风险分级：feature 判 T0/T1/T2 落台账，T0 短链仅 MR 门，T2 强制回滚预案/安全轴，存疑就高 | router ⑨ + engine ⑰⑱ + chainFor |
| 21 | CLARIFY 豁免：需求证据完整直入 DESIGN，理由落史；默认不豁免 | router ⑩ + engine ⑲ |
| 22 | prd 路径：只读产出 prd.md，GATE_PRD 人工批准，无 worktree/无 MR，无 git 可跑 | router ⑥⑦⑧ + engine ⑳ + resources ④ |
| 23 | VERIFY 失败转 DEBUG 诊断→回修复态携诊断→再验证；VERIFY budget 封顶循环 | engine ㉒ + paths.debugTo |
| 24 | 上下文连续性：滚动摘要注入 + followUp 承接（前轮需求/产物注入，research 续写不重写）；resume 从台账重建承接（v1.10） | router ⑭ + engine ㉓㉔ |
| 24a | 用量记账：每步 token 用量入事件与台账，步末摘要与 /genpi log 可见（v1.10） | step-runner message_end 聚合 + fmtUsage |

---

## 9. 版本演进（为什么代码长这样）

| 版本 | 主题 | 关键变化 |
| --- | --- | --- |
| v1.0（T1-T9） | 垂直跑通 | 自绘四屏 TUI → 全部契约的 headless 引擎 + E2E |
| v1.1（T10） | TUI 换芯 | 自绘屏废除，嵌入 pi **InteractiveMode** + 编排扩展（契约 18） |
| v1.2（T11） | 扩展独立 | 初始零扩展、剥离 pi 继承（契约 17） |
| v1.3（T12） | 缺陷修复包 | 中断/废弃（契约 19）、GATE_MR 预览、模型角色、无 git 降级 |
| v1.4（T14） | 门禁去模态 | 聊天命令 a/c/r/p，产物正文不默认上屏 |
| v1.5（T15） | research 去门禁 | 咨询类结论即交付，GATE_CONCLUSION 删除 |
| v1.6（T16） | 机器校验 | 证据交叉校验（契约 4 强化）、提交完整性、env 凭证 |
| v1.7（T17/T18） | 用户主导 | 打开不自动复活旧 run；扩展命令顶层化 |
| v1.8（T19） | stopped 可续跑 | resume 支持stopped（门禁态重开 GATE）；中断标志绑定 drive 循环防跨 run 泄漏（1607 回归） |
| v1.9（T20） | 风险分级 + prd 路径 | feature 判 T0/T1/T2（短链/强化注入）；CLARIFY 豁免；新增 prd 只读路径（对照原 gen 工作流补齐三件套） |
| v1.9.x（T22-T36） | 打磨与观测 | 标题落账（T22/T23）；stopped 可续跑；/genpi log 观测性+路由决策全量落史（T30）；TUI 系列：欢迎块去重（T32）/黑屏闪优化（T33）/步末摘要带产物指路（T34）/pi 命令透传+回显先行（T35/T36）；chat 闲聊放行（T27） |
| v1.10（T37/T38） | 证据强制补全 + 工程化 | Q&A 答案被吞修复（T37：input handler 同步返回，不吊 pi 主循环）；八项：恒真式审计+pinned 验收（A1）/产物存在性（A2）/budget 连续语义（B3）/worktreeSetup 引导（C4）/genpi clean（C5）/用量记账（D6）/resume 重建承接（E7）/models.router（F8）；SDK 1.4→1.5.2；文档精简为单一 onboarding |

> 演进主线：**强制力不断从"提示词/界面"下沉到"引擎代码"**，同时交互不断向"pi 原生习惯"收敛。

---

## 10. 建议阅读路线（半天到一天）

```text
第 1 站（跑通直觉）   npm test → genpi --demo-run → 本文 §2 状态机
第 2 站（核心 500 行） types.ts → paths.ts → ledger.ts → loop-engine.ts
                     对照 test/engine.test.ts 逐用例读（⑩⑪⑮⑯ 是契约 19 的活文档）
第 3 站（两个边界）   agent/step-runner.ts（SDK seam+证据校验）
                     engine/worktree.ts（git 隔离+MR 降级）
第 4 站（周边一圈）   resources/index.ts（注入映射）→ router.ts → config.ts
                     → engine/bootstrap.ts（组合根）→ engine/tasks.ts
第 5 站（交互面）     tui/screens.ts（纯函数）→ tui/app.ts（runTui 主线+
                     genpiExtension 两个事件处理器）→ cli.ts → ext-manager.ts
第 6 站（回归源头）   git log --oneline 对照（各提交说明即演进史）
```

## 11. 常见改动指南

| 想做什么 | 改哪里 |
| --- | --- |
| 调 budget/分支前缀/MR 目标 | `<项目>/.genpi/config.json`（不用改代码） |
| 改某状态的方法论注入 | `src/resources/*.md` + `resources/index.ts` 映射表；跑 `npm run check:resources` |
| 加/改一个门禁 | `paths.ts` gates 表 + types StateId（+ 测试） |
| 加一条路径 | types PathId + `paths.ts` PATHS + router 分类提示词/关键词 + STATE_INSTRUCTIONS |
| 改状态指令文案 | loop-engine.ts `STATE_INSTRUCTIONS` |
| 改门禁命令键位 | tui/app.ts `parseGateCommand`（纯函数+测试同步） |
| 升级 pi SDK | package.json 版本号（纪律：升级独立成任务，不混功能分支；改完必 `npm run build`——dist 过期守卫会提醒） |
| 清理终态 worktree/分支 | `genpi clean`（干跑）→ `genpi clean --force`（执行；台账保留） |

## 12. 未读先知（backlog）

C 级 backlog：进程锁/routing 期间输入保留/footer 常显预算/Windows 支持。v2 候选：deploy 路径、run 入库归档、多 run 并行、headless 服务化（引擎已就绪的免费接缝）。（已清账：stopped run 的 worktree 清理→`genpi clean`；`/genpi log`→T30。）
