> genpi 内置方法论 · 状态:IMPLEMENT/FIX（git 纪律，随实现注入；源:git-workflow，已参数化）

# git 工作流纪律

## 分支与隔离（genpi 已代办，你负责遵守）

- 所有改动只在 worktree 分支上进行（genpi 启动 run 时已创建：`<branchPrefix><runId>`，默认 `feature/`）
- 绝不直接改主分支/主工作树
- 分支命名与推送由 genpi 引擎处理，你只需在 worktree 内提交

## 提交

- 格式：`<type>(<scope>): <summary>`，type ∈ feat/fix/refactor/docs/test/chore
- 一次提交一个意图；绿灯即提交
- 推送与建 MR 由引擎在 GATE_MR 批准后执行——你不执行 push

## 项目差异

分支前缀、worktree 目录、MR 目标平台（github/gitee/gitlab）由项目 `.genpi/config.json` 配置，默认 github。
