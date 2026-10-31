> genpi 内置方法论 · 状态:IMPLEMENT（源:tdd + subagent-dev + git-workflow）

# 实现：TDD 纪律 + git 隔离纪律

## TDD 铁律（每任务）

1. **RED**：先写失败测试，跑一遍确认它因正确原因失败
2. **GREEN**：写最小实现让测试通过——不多不少
3. **REFACTOR**：在绿灯下整理，保持测试绿
4. 无失败测试不写生产代码；修 bug 先写复现测试

## git 纪律（genpi 已建 worktree，你在隔离分支上）

- 只在 worktree 内改动，绝不触碰主工作树
- commit 格式：`<type>(<scope>): <summary>`，type ∈ feat/fix/refactor/docs/test/chore
- 小步提交：每个绿灯一次提交
- 完成后将 tasks.md 中对应任务勾销

## 并行/派发纪律（多任务时）

- 每任务独立上下文，文件即上下文（不粘贴大段代码给同伴）
- 单一写入者：一个任务一个文件集，避免两把笔写同一文件
- 宣称完成前必须跑过验收命令并留存退出码

## 反模式

"先写代码边做边想" · "测试后面补" · "顺手重构无关代码" · "一次提交十个改动"。
