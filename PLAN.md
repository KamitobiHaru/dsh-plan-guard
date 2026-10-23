# PLAN.md — dsh-plan-guard（守护上下文）

本文件是实现备忘：术语、已确认的设计决策、已验证的运行时结论与验收状态。面向用户的安装与使用说明以 README 为准。

## 术语速览

| 词 | 意思 |
|---|---|
| 会话日志 | 每个 session 在 `<DSH_HOME>/sessions/<项目>/<sessionId>/<version>.jsonl` 的追加式事件记录 |
| surface | 模型每一步真正看到的输入区间；压缩=把一段事件替换成摘要检查点，被替换事件仍在日志 |
| Plan 文档 | 本会话日志里一次 `exit_plan_mode` 提交的 plan markdown，按 callId 取一条 |
| 守护上下文 | Plan + 备注 + 文件的集合；由插件按快照/增量注入 |
| pending 日记 | 记录里 `{added, removed}` 两张表，记未送达的挂载/卸载/增删，按条目 key 合并 |
| 快照 | surface 上没有守护消息时发的整份内容（首次、每次压缩后） |
| 增量 | 已可见时发的小消息：新增发正文，卸载/删除发一句 no longer guarded |
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
8. 注入不等压缩：新增立刻（下一步）可见，卸载只加一行提示，压缩后发快照；所有注入都是尾部追加，不改写历史（KV cache 前缀不失效）。
9. 界面上不写说明书：抽屉只留标签、状态、按钮；说明放在 README 与 guide 卡片的一行描述里。

## 核心结论（已对安装版运行时验证）

1. 外部 plain-JS profile 插件可直接 `ctx.tools.register(手写对象)`：`parameters` 是普通 JSON Schema，不需要 zod/defineTool；框架**不校验参数**，工具自己校验。
2. 工具全局注册；子代理用 `agent/created` + `agent.ctx.tools.restrict` 隐藏，执行时 `ctx.agents.roots()` 兜底。
3. `ctx.userQuestions.askTimed` 是带自定义选项的阻塞问题通道，不依赖 approval policy；本会话 `never` 下可用。
4. `ctx.storageDomain` 表 API 是 `put/update/delete/get`，**没有 `set`**；旧代码的 `.set` 已修正。domain 名必须匹配 `^[a-z][a-z0-9_]*$`：0.2.0 的 `plan-guard` 导致激活失败，0.2.1 改为 `plan_guard`，并加回归测试。
5. `ctx.fs` 提供 `resolve/stat/streamText/contains/processPath`；`ctx.workingDirectory.ensure(agent)` 给会话 cwd；读取在 pre-step 是官方模式（agent-instructions 同款）。
6. 注入：`agent/pre-step` 瀑布 `await next()` 后 splice 一条 user 消息，agent-loop 落事件（模型可见 ⟺ 已记录）。
7. 与 `dsh-compaction-tune` 零交集：不改压缩配置/预设，只读会话事件与 storage。
8. Web 模块表不含 `zod`；Client 的 strict codec 必须手写 `typeSymbol`/`create`，不能 `require('zod')`（0.2.2 修复，并加 vm 加载测试）。
9. 资源地址必须是 `dsh-resource://<protocol>/…`，不能自定义 `<protocol>://`；`useResource` 只认前者（0.2.3 修复）。
10. Client 自己 `$mount` 的 Remote 命名空间只能经 `ctx.inject(['remote.<ns>', …], cb)` 动态依赖组读取：
    静态 `inject` 里写 `remote.<ns>` 会让 fiber 永久 pending（命名空间正是自己的 apply 创建的）；
    不在任何 inject 组里直接读 `ctx.remote[ns]` 会抛 `cannot get property "remote.<ns>" without inject`，
    该异常会让 Client 条目进入 failed，整页显示 “Failed to load plugins”（0.2.4 修复）。
11. `decision.messages` 只是本步新 claim 的批次（`dsh-agent-loop/lib/index.js:904-920`），
    step 里逐条 `session.append('user/message', …, {surfaceOp:'append'})`（`:1061`）。
    所以「插在最后一条 claimed 之后」就是请求尾部、runtime-context 之前：纯追加，缓存友好。
12. 抽屉视觉必须用 Theme 实况 token：`--dsw-alias-label-*`、`--dsw-alias-border-l1..l4`、
    `--dsw-alias-bg-layer-1/2`、`--dsw-alias-state-business-primary`、`--dsw-radius-*`、`--dsw-font-*`。
    早期用的 `--dsw-alias-text-primary` 等并不存在，全部回退成继承/透明（0.3.0 修复）。

## 实施状态

- [x] 决策：插件方案（不 fork DSH）
- [x] Host：storage 记录 v2、权限、文件读取、`context_guard`、Remote 9 方法、注入器
- [x] Client：权限选择、Plan/条目列表、添加/锁定/删除、预览、双语
- [x] 纯逻辑测试 + 假 ctx 集成测试（31 个用例通过）
- [x] `node --check index.js/client.js`
- [x] 安装与启动验收（0.2.4，独立 profile + 无头 Chrome）：页面不再 “Failed to load plugins”，
      “New tab” 出现 Guarded context，抽屉渲染政策/Plan/条目三个区并成功 `remote.list`
- [x] 真实回合验收（0.3.0，临时安装 + 无头 Chrome + 真模型）：
      首轮注入快照（未压缩也发）、抽屉加备注后下一轮注入 `— update` + 正文、卸载后下一轮只注入一行
      `Note "E2E marker" is no longer guarded.`，三次注入都不重复
- [x] 视觉验收（0.3.0）：浅色/深色截图、与 Workspace files 面板并排比对、guide 卡片图标、控制台零报错
- [ ] 压缩时刻验收（真实压缩触发后快照替换增量）、权限矩阵、问题卡片、抽屉轮询刷新

## 端到端数据流

1. 模型提交 plan（原生或 PTC）→ projection `plan-guard-docs` 记 `{callId,title,size,turn,markdown(≤64k)}`；
   首次成功 `compaction/end` 把 `sawCompaction` 置真。
2. 抽屉/工具 → storage domain `plan_guard` 表 `sessions`，按 sessionId 一条记录：
   `{version:2, policy, plans:{callId:'mounted'|'unmounted'}, items:{file:/note:}, pending:{added,removed}}`。
   每次改挂载状态都往 pending 记一条（按条目合并，add/remove 互相抵消）。
3. pre-step：surface 上没有守护消息 → 取 projection + 记录 → 生效 Plan（最新自动，除非显式卸下）
   + 已挂载条目 → 实时读文件（上限/标记）→ 拼快照并清 pending；
   否则若有 pending → 只拼增量（新增正文 / 卸载一行）→ 发完按 key 清 pending。
   两种消息都 splice 在 `lastClaimed + 1`，即请求尾部。
4. 抽屉走 `dsh-resource://plan-guard-drawer/<sessionId>` 资源（3s 轮询）→ `plan-guard/list` 等 9 个 SRC 方法。
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

- 已跑：`node --check index.js`、`node --check client.js`、`node --test test/*.test.js`（31/31）。
- 已跑：独立 profile 安装 + `dsh web` 启动 + 无头 Chrome（浅/深色截图、抽屉增删挂载、guide 图标、控制台零报错）。
- 已跑：真实模型回合三条注入（快照 / 新增增量 / 卸载一行），直接读会话 jsonl 核对。
- 未跑：压缩时刻、问题卡片、权限矩阵、重启/恢复自愈。
- 后续：`plugin_manager install_bundle` → 重启 → `cordis_inspect_query` Tool/Slots →
  抽屉矩阵 → 工具权限矩阵 → `dsh-compaction-tune` 强制压缩（`set-ratio.mjs 0.01 --retain 0.0005`，测试后恢复）→ 重启/恢复自愈。
