# PLAN.md — dsh-plan-guard（守护上下文）

本文件是实现备忘：术语、已确认的设计决策、已验证的运行时结论与验收状态。面向用户的安装与使用说明以 README 为准。

## 术语速览

| 词 | 意思 |
|---|---|
| 会话日志 | 每个 session 在 `<DSH_HOME>/sessions/<项目>/<sessionId>/<version>.jsonl` 的追加式事件记录 |
| surface | 模型每一步真正看到的输入区间；压缩=把一段事件替换成摘要检查点，被替换事件仍在日志 |
| Plan 文档 | 本会话日志里一次 `exit_plan_mode` 提交的 plan markdown，按 callId 取一条 |
| 守护上下文 | Plan + 备注 + 文件的集合；压缩后由插件重新注入 |
| 条目 | 人类或模型添加的备注/文件，有 mounted/locked/createdBy |
| 权限模式 | 会话级，只约束模型：ask / allow-mount / allow-unmount / allow-all / deny-all |
| 锁定 | 条目级布尔值；锁定后模型不能挂载/卸载，人类仍可改 |
| ask | 对话内问题卡片（userQuestions），不是 approval 面板 |

## 用户已确认的决策

1. 只自动挂载**最新一份** Plan；旧 Plan 默认不挂载。
2. 首次成功压缩后自动挂载；人类在此之前卸下则永久保持未挂载。
3. 模型不能挂载/卸载 Plan。
4. 单项锁定 = 模型完全不能改；人类仍可改。
5. 模型可添加文件 + 文字备注。
6. 模型**不能删除任何条目**（自己的也不行，审计保留）；只能卸载；删除仅人类。
7. 权限模式五种；人类动作永远允许。

## 核心结论（已对安装版运行时验证）

1. 外部 plain-JS profile 插件可直接 `ctx.tools.register(手写对象)`：`parameters` 是普通 JSON Schema，不需要 zod/defineTool；框架**不校验参数**，工具自己校验。
2. 工具全局注册；子代理用 `agent/created` + `agent.ctx.tools.restrict` 隐藏，执行时 `ctx.agents.roots()` 兜底。
3. `ctx.userQuestions.askTimed` 是带自定义选项的阻塞问题通道，不依赖 approval policy；本会话 `never` 下可用。
4. `ctx.storageDomain` 表 API 是 `put/update/delete/get`，**没有 `set`**；旧代码的 `.set` 已修正。domain 名必须匹配 `^[a-z][a-z0-9_]*$`：0.2.0 的 `plan-guard` 导致激活失败，0.2.1 改为 `plan_guard`，并加回归测试。
5. `ctx.fs` 提供 `resolve/stat/streamText/contains/processPath`；`ctx.workingDirectory.ensure(agent)` 给会话 cwd；读取在 pre-step 是官方模式（agent-instructions 同款）。
6. 注入：`agent/pre-step` 瀑布 `await next()` 后 splice 一条 user 消息，agent-loop 落事件（模型可见 ⟺ 已记录）。
7. 与 `dsh-compaction-tune` 零交集：不改压缩配置/预设，只读会话事件与 storage。

## 实施状态

- [x] 决策：插件方案（不 fork DSH）
- [x] Host：storage 记录 v2、权限、文件读取、`context_guard`、Remote 9 方法、注入器
- [x] Client：权限选择、Plan/条目列表、添加/锁定/删除、预览、双语
- [x] 纯逻辑测试 + 假 ctx 集成测试（21 个用例通过）
- [x] `node --check index.js/client.js`
- [ ] 安装与活会话验收（发布前未做：只完成静态检查与单元测试）

## 端到端数据流

1. 模型提交 plan（原生或 PTC）→ projection `plan-guard-docs` 记 `{callId,title,size,turn,markdown(≤64k)}`；
   首次成功 `compaction/end` 把 `sawCompaction` 置真。
2. 抽屉/工具 → storage domain `plan-guard` 表 `sessions`，按 sessionId 一条记录：
   `{version:2, policy, plans:{callId:'mounted'|'unmounted'}, items:{file:/note:}}`。
3. 首次成功压缩后的 pre-step：取 projection + 记录 → 生效 Plan（最新自动，除非显式卸下）
   + 已挂载条目 → 实时读文件（上限/标记）→ 拼一条 user 消息 splice 进 `decision.messages`。
4. 抽屉走 `plan-guard-drawer://<sessionId>` 资源（3s 轮询）→ `plan-guard/list` 等 9 个 SRC 方法。
5. 模型 `context_guard`：list/add_file/add_note/mount/unmount；权限矩阵 + 条目锁定 + ask 卡片；
   写入前重新读记录复核，避免 ask 期间状态变化。

## 关键源码锚点（DeepSeek Harness 仓库）

- `packages/core/tools/src/index.ts` 工具注册/输出 schema 限制/pre-execute
- `packages/interaction/user-questions/src/index.ts` `askTimed`
- `packages/interaction/tool-ask-user/src/timed.ts` askTimed 调用方式
- `packages/fs/fs/src/index.ts` `resolve/stat/streamText/contains/processPath`
- `packages/session/working-directory/src/index.ts` `get/ensure`
- `packages/storage/storage-domain/src/domain.ts` `put/update`（无 set）
- `packages/core/agent-loop/src/agent.ts:427-441` loop 落 user/message
- `packages/context/agent-instructions/src/index.ts:334-360` pre-step 注入模板
- `packages/client/ui-tool/src/client/tool/ToolCallTree.tsx` 默认 GenericToolCard
- `packages/api/gateway/src/index.ts` SRC 发现

## 验证

- 已跑：`node --check index.js`、`node --check client.js`、`node --test test/*.test.js`（21/21）。
- 未跑：安装、`dsh web` 重启、真实注入、抽屉渲染、问题卡片、压缩矩阵。
- 后续：`plugin_manager install_bundle` → 重启 → `cordis_inspect_query` Tool/Slots →
  抽屉矩阵 → 工具权限矩阵 → `dsh-compaction-tune` 强制压缩（`set-ratio.mjs 0.01 --retain 0.0005`，测试后恢复）→ 重启/恢复自愈。
