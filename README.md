# genpi

机器强制的开发循环 TUI，基于 [pi](https://github.com/earendil-works/pi)。

> 业务项目目录敲 `genpi` → TUI → 跑通 `CLARIFY → DESIGN → GATE → PLAN → IMPLEMENT → VERIFY → GATE_MR` 的代码化状态机循环。
> 项目内**零引用、零拷贝**——工作流内化在 genpi 本体。

## 它解决什么

- **复用税**：工作流技能不再随项目拷贝，装一次 genpi 处处可用。
- **纪律可绕过**：门禁（GATE）、失败预算（fail budget）、两阶段 done、worktree 隔离由 **TypeScript 代码强制**，不靠提示词纪律——模型无法自我放行。

## 安装

```bash
npm i -g github:gongheng/genpi   # 直装（prepare 自动构建）
genpi                             # 任意项目目录直接用
```

或源码方式：

```bash
git clone https://github.com/gongheng/genpi.git && cd genpi
npm install && npm run build && npm link
```

npm 发包后（v0.2 计划）：`npm i -g genpi`。

## 首次配置

genpi 的数据根独立于 pi：`~/.genpi/`（凭证 `auth.json`、模型设置 `settings.json`、会话转录）。

二选一：
1. 已用 pi：把 `~/.pi/agent/auth.json`（及 `settings.json`）复制到 `~/.genpi/`；
2. 全新使用：参照 [pi 的 provider 配置](https://pi.dev/docs/latest/providers) 写入 `~/.genpi/settings.json`。

验证：`genpi --selftest`（数据根/配置/方法论资源/SDK 四项检查）。

## 使用

```bash
cd ~/code/你的项目
genpi                    # 打开聊天式 TUI，直接描述需求即可

genpi --resume <runId>   # 从台账恢复中断的循环
genpi --demo-run         # 无模型演示模式
```

- **直接复用 pi 的 TUI**：genpi 内嵌 pi 的 InteractiveMode——打开即 pi 本体界面（编辑器/footer/主题//model /theme 等命令/会话持久化），genpi 以编排扩展接入：接管输入分流、进度入聊天流、footer 常显状态机位置。路径由模型自动判断（启发式兑底，前缀 `1/2/3/4 ` 强制），无任何选项屏。
- **闲聊直答（T27）**：问候/闲聊/与开发无关的对话直接由 pi 原生回答——不进循环、不建 run、不落产物、不搁置在跑循环；含工作意图不误伤（整句精确匹配才放行，语义判断交给路由模型，存疑就工作）。
- **风险分级与澄清豁免（v1.9）**：feature 路径随路由自动判 T0/T1/T2——微改动（T0）走短链，跳过澄清/设计/设计批准，仅 MR 一道门；高风险（T2：认证/加密/迁移/公共契约）设计强制含回滚预案节、审查加安全轴；需求已附验收标准/复现命令则豁免澄清直入设计，均落台账可查。
- **未完循环用户主导（v1.7）**：打开 genpi 始终新鲜开始（`/new` 同样干净）；检测到未完成循环仅一行提示——回「继续」续跑、`/genpi-stop` 放弃、直接输入新需求则旧循环自动搁置（台账保留）；`--resume <runId>` 可指定恢复。
- **GATE 门禁（机器强制，聊天命令驱动）**：阶段完成时聊天流出现紧凑门禁块（审批对象 + 行数，不刷产物正文），回复 `a` 批准 / `c <修改意见>` 要求修改 / `r` 终止 / `p` 按需预览——必须打字+回车，不会误触；未决引擎不推进。Ctrl-C 按 pi 惯例双击退出，台账实时落盘。
- **运行中插话**：任何时刻输入文字 = 对当前步骤的 steering（在下一步边界注入）；回答 agent 追问也直接输入。
- **过程可观测（/genpi log [n]）**：查看当前/最近 run 的转移史尾部——路由决策（路径/分级/豁免/承接）、状态推进、预算消耗、验证失败诊断全程留痕，一步一账。
- **中断与废弃**：步骤流式期间按 `escape` 中断当前步骤（不扣预算，run 保留可续跑）；`/genpi-stop` 废弃当前 run（台账保留，可 `--resume`）。
- **模型角色**：`.genpi/config.json` 可配 `models.implementer` / `models.reviewer`（如 `"prov/model-id"`），对应状态自动切换；其余状态跟随 TUI 里 `/model` 当前选择，缺省用全局默认。环境变量凭证（`ANTHROPIC_API_KEY` 等）无需 auth.json 也可直接使用。
- **验证失败自动诊断（契约 23）**：VERIFY 失败不盲目重试——自动转 DEBUG 诊断（定位根因、产出修复方案），回修复态带着诊断修，修好再验；3 轮修不好如实停下转人工。
- **验证证据机器校验**：VERIFY 等状态的自报命令证据与会话内真实 bash 执行记录交叉校验，伪造 exitCode 或无法机器复核即判失败（两阶段 done 的第二阶段是真验证）。
- **无 git 目录**：feature/bugfix 自动降级为 research 并说明原因（代码路径需要隔离分支）。

## 循环产物

```text
<项目根>/.genpi/
├── config.json              # 可选：mrTarget / branchPrefix / worktreeDir / budget / models
└── runs/<runId>/            # design.md · tasks.md · run.json · phase-history.jsonl
```

feature/bugfix 在 `.worktrees/<runId>/` 隔离分支上实施，主工作树零污染；`GATE_MR` 批准后推送分支并建 MR（无 gh 时降级为 push + compare URL）。

## 路径

| 路径 | 状态机 |
| --- | --- |
| feature | CLARIFY → DESIGN → **GATE_DESIGN** → PLAN → IMPLEMENT → REVIEW → VERIFY → **GATE_MR** → DONE（T0 微改动短链：跳过澄清/设计/计划/审查，仅 MR 门禁） |
| bugfix | REPRODUCE → ROOT_CAUSE → FIX → REVIEW → VERIFY → **GATE_MR** → DONE |
| research | RESEARCH → DONE（只读，无 git 也可跑；咨询/调研类问答结论即交付，**无门禁**） |
| prd | PRD → **GATE_PRD** → DONE（只读产出需求文档，一道人工批准；无 git 也可跑，v1.9） |

## 开发

```bash
npm test            # 91 用例（引擎/路由/风险分级/上下文连续性/TUI 纯函数/E2E/扩展透传等）
npm run build       # tsup → dist/（源码改动后必须重建——genpi 命令运行 dist，未重建会静默跑旧代码；bin 自带过期警告）
npm run check:resources   # 方法论资源无项目耦合残留
```

## 扩展管理（初始零扩展，按需安装）

genpi **不继承 pi 的扩展**：首次启动会剥离复制 settings.json 带来的 `packages`/`extensions` 配置并把已装目录移入备份（`~/.genpi/.pi-inheritance-backup/`，可回滚）——genpi 从零扩展开始。

按需安装/卸载（命令与 pi 完全一致，仅对 genpi 生效，装于 `~/.genpi`）：

```bash
genpi install npm:pi-lens           # npm 包 / git URL / 本地路径
genpi uninstall pi-lens             # 按名或原始 source 卸载（别名 remove）
genpi list                          # 查看已安装
genpi update [名称]                 # 更新（缺省全部）
```

（`genpi ext …` 仍可用，为兼容别名。）

扩展写法与 pi 扩展完全一致，参见 [pi extensions 文档](https://pi.dev/docs/latest/extensions)。另：`bootstrap({ extensions })` 内联工厂是编程注入 seam（genpi 内部编排桥即基于此），不是用户扩展入口。

设计文档：[docs/design.md](docs/design.md)（行为契约 19 条）· 任务清单：[docs/tasks.md](docs/tasks.md) · 学习指南：[docs/onboarding.md](docs/onboarding.md)

MIT License.
