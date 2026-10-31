# genpi · 项目学习指南（onboarding）

> 目标读者：第一次接触本仓库、要读懂并改动的开发者。
> 配套文档：[design.md](design.md)（行为契约 19 条，权威规格）· [tasks.md](tasks.md)（任务切片与演进史）· [README.md](../README.md)（用户视角）。
> 本文回答「代码在哪、为什么这样设计、按什么顺序读」。

---

## 1. 一句话理解

**genpi = 把一套软件开发工作流（澄清→设计→批准→计划→实现→验证→MR）从"提示词纪律"内化为"TypeScript 代码强制"的 TUI 工具**，跑在任意业务项目目录里，基于 pi（`@earendil-works/pi-coding-agent`）作为模型执行层。

它解决两个结构性问题（design §1.1）：

| 问题 | 旧形态 | genpi 形态 |
| --- | --- | --- |
| 复用税 | 工作流技能随项目拷贝，副本漂移 | `npm i -g genpi` 装一次处处用，项目内**零引用零拷贝** |
| 纪律可绕过 | GATE 门禁/fail budget/两阶段 done 靠提示词，模型可"合理化"绕过 | 状态机/门禁/预算是**机器代码**，模型无法自我放行 |

设计哲学一句话：**引擎是本体（纪律=代码），方法论是弹药（12 份 md 按状态注入）**。

---

## 2. 心智模型：五个关键词

读懂下面五个概念，就读懂了 genpi 的一半：

1. **run**：一次需求交付的完整循环。唯一实体，台账落盘于 `<项目根>/.genpi/runs/<runId>/`（runId 形如 `20261031-1632-feature-add-login`）。同一项目同时**最多一个活跃 run**（契约 15）。
2. **路径（path）× 状态机**：需求路由到三条路径之一，每条路径是一张**纯数据转移表**（`src/engine/paths.ts`）：

   ```text
   feature : INIT → CLARIFY → DESIGN → [GATE_DESIGN] → PLAN → IMPLEMENT → REVIEW → VERIFY → [GATE_MR] → ARCHIVE → DONE
            （VERIFY 失败 → DEBUG 诊断 → 回修复态 → 再验证，契约 23）
            （T0 短链：INIT → IMPLEMENT → VERIFY → [GATE_MR] → DONE；T2 链同 T1，指令强制回滚预案/安全轴）
   bugfix  : INIT → REPRODUCE → ROOT_CAUSE → FIX → REVIEW → VERIFY → [GATE_MR] → ARCHIVE → DONE
   research: INIT → RESEARCH → DONE          （只读、无门禁——结论即交付，v1.5）
   prd     : INIT → PRD → [GATE_PRD] → DONE   （只读产出 prd.md，一道人工批准，v1.9）
   ```
3. **GATE（门禁）**：状态机在此**暂停死等**人工 `decide()`——approve 进下一态 / request_changes 回退携注（不扣预算）/ reject 终止。引擎代码强制，模型输出**永远**不能放行（契约 3）。
4. **fail budget**：每工作态默认 3 次失败额度，扣完 run 转 stopped 转人工，绝不无限重试（契约 6）。用户中断（escape）≠失败，不扣预算（契约 19）。
5. **台账（ledger）**：`run.json`（当前状态）+ `phase-history.jsonl`（每次转移 append 一行）。**恢复只信台账文件，不信对话记忆**（compaction-resistant，契约 7/12）——进程随便杀，重启即续。

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
                    │ router.ts       需求→三路径（模型/前缀/启发式）│
                    └───────────┬──────────────────────────────┘
                                │ engine.start/resume/decide/steer/abort/stop
                    ┌───────────▼──────────────────────────────┐
   引擎层（核心）     │ engine/loop-engine.ts  ★状态机驱动/GATE/  │
                    │                        budget/steering    │
                    │ engine/paths.ts        三路径转移表（数据）  │
                    │ engine/ledger.ts       台账读写             │
                    │ engine/tasks.ts        tasks.md 勾选解析    │
                    │ engine/worktree.ts     git worktree 隔离+MR │
                    │ engine/bootstrap.ts    装配工厂（组合根）     │
                    └──────┬──────────────────────┬──────────────┘
                           │ StepRunner(seam)     │ ResourceProvider
                    ┌──────▼──────────┐   ┌───────▼─────────────┐
   执行层            │ agent/          │   │ resources/          │
                    │ step-runner.ts  │   │ 11 份方法论 md+索引   │
                    │ pi SDK 唯一适配点│   │ （preamble 每步必带） │
                    └──────┬──────────┘   └─────────────────────┘
                           │ AgentSession（SDK public API）
                    ┌──────▼──────────┐
                    │ pi-coding-agent │  模型会话/凭证/扩展/TUI 组件
                    └─────────────────┘
```

### 3.2 模块清单（全部源码 ~2160 行 + 11 份方法论）

| 文件 | 行数 | 一句话职责 | 关键契约 |
| --- | --- | --- | --- |
| `src/types.ts` | 89 | **单一类型源**：StateId/StepSpec/StepResult/EngineEvent/RunRecord/Tier | — |
| `src/engine/paths.ts` | 61 | 四路径状态与门禁**纯数据表** + tier 链变体（chainFor） | 3/5/20/22 |
| `src/engine/ledger.ts` | 100 | 台账：runId 生成（title slug）/run.json 读写/phase-history append | 2/12 |
| `src/engine/loop-engine.ts` | 358 | ★核心深模块：drive 循环/GATE 死等/budget/steering/中断/tier 链路由与豁免 | 3/6/13/15/19/20/21 |
| `src/engine/tasks.ts` | 28 | tasks.md 未勾选任务解析与回写勾选 | — |
| `src/engine/worktree.ts` | 98 | ensureWorktree/mrPreview(含提交完整性检查)/pushAndMr(降级) | 5/8/14 |
| `src/agent/step-runner.ts` | 304 | **pi SDK 唯一适配点**：StepSpec→AgentSession→事件流；证据交叉校验 | 4/16/17 |
| `src/resources/` | 11 md | 方法论按状态注入 + preamble 常驻；缺失降级不崩溃 | 10 |
| `src/router.ts` | 124 | 五出口路由（chat 放行）+followUp 承接判定（lastRun 上下文）；附带 tier/豁免/标题生成 | 20/21/24 |
| `src/config.ts` | 75 | `PI_CODING_AGENT_DIR=~/.genpi` + 三级配置合并 + 凭证检测 | 9 |
| `src/engine/bootstrap.ts` | 69 | 组合根：把 runner/ledger/resources/git/config 装配成 engine | — |
| `src/tui/app.ts` | 450 | pi InteractiveMode 编排扩展：input 接管分流/进度桥/footer/session_start 幂等 | 15/18 |
| `src/tui/screens.ts` | 123 | 纯函数：欢迎语/路由说明（含 tier/豁免/标题）/门禁块/步骤实时视图渲染 | 11 |
| `src/cli.ts` | 140 | `genpi` 命令面：--resume/--demo-run/--selftest/install… | — |
| `src/ext-manager.ts` | 142 | 扩展独立管理：剥离 pi 继承(备份可回滚)+PackageManager | 17 |

> deletion test 结论（design §4）：LoopEngine 是 deep module（删了纪律散落 N 处）；StepRunner 是 adapter seam（删了 pi API 渗入引擎与测试）；TUI 层是薄桥（删了仍可 headless 跑）——三个"保留"的理由都值得背下来。

---

## 4. 五分钟跑起来

```bash
# 源码开发
npm install && npm run build && npm link
npm test                     # 83 用例（引擎/路由/风险分级/TUI 纯函数/E2E/扩展），全 mock 无需凭证
npm run check:resources      # 方法论无项目耦合残留

# 体验（无模型凭证也能看交互）
genpi --demo-run             # 无模型演示模式
genpi --selftest             # 数据根/配置/资源/SDK 四项自检

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
       ├─ ok      → currentState=下一态，history(step_ok+evidence)
       └─ fail    → budget[state]-1；≤0 → status=stopped  ← 契约 6
}
```

三个易错细节（都有回归测试）：

- **IMPLEMENT 是逐任务循环**：`#runWorkState` 用 `parseUnchecked()` 解析 tasks.md，**每个任务一次 StepRunner 调用**，完成一个 `tick()` 勾选一个并记 `task_done`；失败即返回由 drive 统一扣预算（engine.test ⑥⑦）。
- **中断标志生命周期绑定 drive 循环**（v1.8，1607 回归）：`driving` 记录当前循环的 runId，`abort()` 仅在有活跃循环时置 `pendingAbort`；drive 启动清零、finally 复位——否则搁置旧 run 的残留标志会毒死下一个 run 的第一步（engine.test ⑮⑯）。
- **`start(onCreated?)` 回调在 drive 之前触发**：TUI 借此在初始 drive（CLARIFY/DESIGN…）期间就能响应 escape/steering，不会出现"第一步期间输入黑洞"。

### 5.2 GATE 决策（`decide()`）与门禁定义

门禁在 paths.ts 是数据：`{ artifact, approveTo, requestChangesTo }`。decide 三分支：

- **approve**：GATE_MR 特殊——先 `pushAndMr()`（成功建 MR 或降级 push+compare URL，**都不算 run 失败**，契约 14），再进 approveTo；
- **request_changes**：跳回 `requestChangesTo` 携人工 note 重跑，**不扣 budget**（人工反馈≠失败）；
- **reject**：status=rejected，产物保留，run_done("人工终止")。

### 5.3 StepRunner（step-runner.ts）——唯一的 SDK 边界

- **可测性**：`setSessionFactoryForTest()` 可注入 mock 会话，全部引擎测试无需真模型；
- **会话构造**：`createAgentSessionServices` + `ModelRuntime`（按 agentDir 缓存免冷启动）+ `resolveCliModel` 解析角色模型；
- **模型三级优先**（契约 16）：`config.models[role]`（implementer/reviewer）> 交互会话当前模型（跟随 `/model`）> 全局默认；
- **两阶段 done 的机器验证**（v1.6，契约 4）：收集会话内 `tool_execution_*` 真实 bash 执行记录，与模型自报 `evidence[].exitCode` **交叉校验**——VERIFY 态自报命令无真实执行对应、或 exitCode 不符 → 直接 fail（伪造证据）。这是"agent 宣称→机器验证"第二阶段的实现。

### 5.4 台账与产物（ledger.ts + design §2.5）

```text
<项目根>/.genpi/
├── config.json                # 可选项目级配置（mrTarget/branchPrefix/worktreeDir/budget/models）
└── runs/<runId>/
    ├── run.json               # { id, path, title?, tier?, request, status, currentState, budget, sessionIds, worktree?, baseSha? }
    ├── design.md / tasks.md / conclusion.md   # 各状态产物（GATE 审批对象）
    └── phase-history.jsonl    # append-only：{ ts, from, to, event, evidence?, budgetLeft?, note? }
```

每次转移**先 append history 再 writeRun**，进程随时可杀。resume 从 run.json 重建：gate/stopped@门禁态 → 重开 GATE；其余 stopped → 转 active 续跑；done/rejected 拒绝（v1.8 语义）。

### 5.5 worktree 隔离（worktree.ts）

feature/bugfix 在 `.worktrees/<runId>/` 建独立分支（前缀 `feature/`），主工作树零污染；`baseSha` 记入 run.json 供 GATE_MR 预览 diff。`mrPreview()` 机器检查**提交完整性**：零提交（MR 将为空）或 worktree 有未提交变更（push 不含）→ 预览顶部警告。`pushAndMr()`：有 `gh` → 建 MR；无 → push + compare URL 降级。genpi 永不改 `.gitignore`/git 配置（契约 8）。

### 5.6 TUI 编排（tui/app.ts）——薄桥的设计

复用 pi `InteractiveMode`（不自绘），genpi 以**内联扩展**接入，只做三件事：

1. **接管输入**：`pi.on("input")` 返回 `{action:"handled"}` → 纯函数 `routeUserInput()` 分流——**待答问题 > 门禁命令 > 挂起续跑 > 新循环(engine.start) > 运行中(steer)**；门禁命令解析 `parseGateCommand()`（a/c/r/p）。分流逻辑全部纯函数可测（tui.test）。
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
2. **路由**：用户输入 → `parsePrefix`（无前缀）→ `classifyWithModel`（一次性内存会话判断 feature）→ `heuristicRoute` 兜底；
3. **开 run**：`engine.start("feature", …)` → ledger.initRun 建 `runs/<id>/` → `ensureWorktree` 建隔离分支（记录 baseSha）→ `onCreated(runId)` 回调让 TUI 立即进入 run 相位；
4. **CLARIFY**：`#runStep` 构造 StepSpec（状态指令+需求+preamble+clarify.md 方法论）→ StepRunner 建 pi 会话跑 → agent 追问以 `question` 事件流出 → `deps.ask()` 经 TUI 收答案 → 问答上下文累积注入后续步骤（≤5 轮，不扣预算）；
5. **DESIGN**：产出 design.md 落 run 目录 → 进 GATE_DESIGN：status=gate，聊天流出紧凑门禁块（对象+行数），引擎死等；
6. **用户回 `a`**：`decide(approve)` → currentState=PLAN → tasks.md 生成；
7. **IMPLEMENT**：逐任务循环——每任务一个 step（工作目录=worktree，角色=implementer，注入 implement.md+git-workflow.md），完成即勾选；用户中途输入 = steering 排队下一任务边界注入；
8. **VERIFY**：跑测试/构建命令，`tool_execution_*` 真实记录与自报 exitCode 交叉校验；失败扣 budget 重试（3 次耗尽转 stopped）；
9. **GATE_MR**：mrPreview（diff 摘要+提交完整性警告）→ 用户 `a` → pushAndMr（gh 建 MR 或降级 push+compare URL）→ ARCHIVE → DONE，footer 归位，聊天流 run_done。

中断视角：任意时刻 `escape` → runner.abort → StepResult.aborted → 不扣预算转 stopped；重开 genpi 只提示一行，回"继续"→ resume 从台账续跑。

---

## 7. 测试地图（91 用例，全部无需真模型）

| 测试文件 | 覆盖 | 怎么 mock |
| --- | --- | --- |
| `engine.test.ts`（22） | ★drive 循环全语义：四路径转移/GATE 死等/budget/request_changes 不扣/steering/resume/中断/搁置不毒死新 run/T0 短链/T2 注入/prd 循环/CLARIFY 豁免/标题落账 | StepRunner 全 mock（makeWorld） |
| `step-runner.test.ts`（8） | SDK seam：注入装载/证据交叉校验（伪造 exitCode→fail） | `setSessionFactoryForTest` |
| `worktree.test.ts`（5） | 真实 git 仓：worktree 隔离/mrPreview/提交完整性警告 | 玩具 git 仓 |
| `e2e-headless.test.ts`（3） | 垂直切片：feature 全循环四件产物/push 降级/单活跃 | fake runner+玩具仓 |
| `tui.test.ts` + `screens.test.ts`（14） | 纯函数：routeUserInput 分流/parseGateCommand/渲染 | 无 mock（纯函数） |
| `router/config/ext-manager/extensions/resources`（32） | 四分类路由/tier 启发式/豁免判定/标题生成/三级配置/扩展管理/装载/资源 | 各自 seam |

测试哲学：**引擎 headless 可测是架构特性**——LoopEngine 不依赖 TUI，事件面（EngineEvent）即测试面；这也是"将来服务化的免费接缝"。

---

## 8. 行为契约速查（design §3.1，19 条）

| # | 一句话 | 实现锚点 |
| --- | --- | --- |
| 1 | 项目内零前置文件 | cli 启动即用 |
| 2 | 产物只写 `.genpi/runs/`（worktree 除外） | ledger/initRun |
| 3 | GATE 无 decide 不转移（模型不能自我放行） | driveLoop 门禁分支 return |
| 4 | VERIFY 证据 exit code + 与真实执行交叉校验（两阶段 done） | step-runner crossCheck |
| 5 | feature/bugfix 必在 worktree，不碰主树 | GitOps.ensureWorktree |
| 6 | budget 默认 3，耗尽 STOP 不无限重试 | driveLoop fail 分支 |
| 7 | 恢复只信台账，不信对话记忆 | resume 读 run.json |
| 8 | 不改 .gitignore/git 配置 | worktree.ts 无此操作 |
| 9 | 数据根 `~/.genpi` 独立（PI_CODING_AGENT_DIR） | config.applyDataRoot |
| 10 | 方法论缺失降级警告不崩溃 | resources/index load() |
| 11 | 界面/产物中文 | screens.ts |
| 12 | 决策与转移入 phase-history | appendHistory（每次转移） |
| 13 | steering 边界注入，不跳状态不扣预算 | steer()/#instruction |
| 14 | MR 失败不判 run 失败，降级 push+URL | pushAndMr |
| 15 | 单项目单活跃 run；打开仅提示不自动复活（v1.7） | start 检查/session_start |
| 16 | 角色模型 implementer/reviewer | #roleFor+resolveCliModel |
| 17 | 扩展初始零，显式安装 | ext-manager 剥离+install |
| 18 | TUI 复用 pi InteractiveMode，门禁聊天命令化非模态 | app.ts 编排扩展 |
| 19 | escape 不扣预算转 stopped 可续跑；间隙中断 pendingAbort 下一 step 前生效；中断≠失败 | abort/stop/#runStep（v1.8 补全 stopped 可续跑） |
| 20 | 风险分级：feature 判 T0/T1/T2 落台账，T0 短链仅 MR 门，T2 强制回滚预案/安全轴，存疑就高 | router ⑨ + engine ⑰⑱ + chainFor |
| 21 | CLARIFY 豁免：需求证据完整直入 DESIGN，理由落史；默认不豁免 | router ⑩ + engine ⑲ |
| 22 | prd 路径：只读产出 prd.md，GATE_PRD 人工批准，无 worktree/无 MR，无 git 可跑 | router ⑥⑦⑧ + engine ⑳ + resources ④ |
| 23 | VERIFY 失败转 DEBUG 诊断→回修复态携诊断→再验证；VERIFY budget 封顶循环 | engine ㉒ + paths.debugTo |
| 24 | 上下文连续性：滚动摘要注入 + followUp 承接（前轮需求/产物注入，research 续写不重写） | router ⑭ + engine ㉓㉔ |

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

> 演进主线：**强制力不断从"提示词/界面"下沉到"引擎代码"**，同时交互不断向"pi 原生习惯"收敛。

---

## 10. 建议阅读路线（半天到一天）

```text
第 1 站（跑通直觉）   npm test → genpi --demo-run → design.md §2.2 状态机
第 2 站（核心 500 行） types.ts → paths.ts → ledger.ts → loop-engine.ts
                     对照 test/engine.test.ts 逐用例读（⑩⑪⑮⑯ 是契约 19 的活文档）
第 3 站（两个边界）   agent/step-runner.ts（SDK seam+证据校验）
                     engine/worktree.ts（git 隔离+MR 降级）
第 4 站（周边一圈）   resources/index.ts（注入映射）→ router.ts → config.ts
                     → engine/bootstrap.ts（组合根）→ engine/tasks.ts
第 5 站（交互面）     tui/screens.ts（纯函数）→ tui/app.ts（runTui 主线+
                     genpiExtension 两个事件处理器）→ cli.ts → ext-manager.ts
第 6 站（回归源头）   docs/tasks.md 各 T 节 + git log --oneline 对照
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
| 升级 pi SDK | package.json 版本号（设计 §5：升级独立成任务，不混功能分支） |

## 12. 未读先知（backlog，design 内已记账）

T13 C 级 backlog：进程锁/routing 期间输入保留/footer 常显预算/stopped run 的 worktree 清理/`/genpi log`/Windows 支持。v2 候选：prd/deploy 路径、run 入库归档、多 run 并行、headless 服务化（引擎已就绪的免费接缝）。
