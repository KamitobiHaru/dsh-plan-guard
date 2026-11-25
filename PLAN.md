# PLAN.md — dsh-plan-guard（守护上下文）

本文件是实现备忘：术语、已确认的设计决策、已验证的运行时结论与验收状态。面向用户的安装与使用说明以 README 为准。

## 术语速览

| 词 | 意思 |
|---|---|
| 会话日志 | 每个 session 在 `<DSH_HOME>/sessions/<项目>/<sessionId>/<version>.jsonl` 的追加式事件记录 |
| surface | 模型每一步真正看到的输入区间；压缩=把一段事件替换成摘要检查点，被替换事件仍在日志 |
| Plan 文档 | 本会话日志里一次 `exit_plan_mode` 提交的 plan markdown，按 callId 取一条，并从同 callId 的 `tool/result` 折叠接受/拒绝结论 |
| 守护上下文 | Plan + 备注 + 文件的集合；由插件按快照/增量注入 |
| pending 日记 | 记录里 `{added, removed}` 两张表，记未送达的挂载/卸载/增删，按条目 key 合并 |
| 快照 | surface 上没有守护消息时发的整份内容（首次、压缩把旧消息换成摘要检查点之后） |
| 增量 | 已可见时发的小消息：新增发正文，卸载/删除发一句带编号的 no longer guarded，挂载文件被改动重发 `(changed)` 全文 |
| 记账（sighting） | 文件条目上「模型最后一次看到的正文」的证据：`seenVersion`（`fs.stat` 的 `dev:ino:size:mtimeNs:ctimeNs`）+ `seenDigest`（实际注入正文的 sha256 前 16 位）+ `seenAt` |
| 结论三态 | `accepted === true`（确认批准）/ `false`（被驳回）/ `undefined`（未确认）。只有 true 具备自动挂载资格 |
| 条目 | 人类或模型添加的备注/文件，有 mounted/locked/createdBy |
| 权限模式 | 会话级，只约束模型：ask / allow-mount / allow-unmount / allow-all / deny-all |
| 锁定 | 条目级布尔值；锁定后模型不能挂载/卸载，人类仍可改 |
| ask | 对话内问题卡片（userQuestions），不是 approval 面板 |

## 用户已确认的决策

1. 只自动挂载**最新一份** Plan；旧 Plan 默认不挂载。
2. 首次成功压缩后自动挂载，但**仅限确认批准通过的（`accepted === true`）**；被拒（`accepted === false`）与结论未确认（`undefined`）都永不自动挂载，人类仍可手动挂载。人类在此之前卸下则永久保持未挂载。
3. 模型不能挂载/卸载 Plan。
4. 单项锁定 = 模型完全不能改；人类仍可改。
5. 模型可添加文件 + 文字备注。
6. 模型**不能删除任何条目**（自己的也不行，审计保留）；只能卸载；删除仅人类。
7. 权限模式五种；人类动作永远允许。
8. 注入不等压缩：新增立刻（下一步）可见，卸载只加一行带编号的提示，快照只在 surface 无守护消息时发（首次、压缩清掉旧消息后）；所有注入都是尾部追加，不改写历史（KV cache 前缀不失效）。
9. 界面上不写说明书：抽屉只留标签、状态、按钮；说明放在 README 与 guide 卡片的一行描述里。
10. 被拒的计划只展示、不自动挂载：接受/拒绝结论以 `tool/result` 的 `toolCallId` + `isError` 为准（不硬匹配英文文案）；显式的人类挂载选择永远优先。
11. 卸载通知带标题和唯一编号（与正文段的 `item: <id>` 对应）；id 缺失时降级为纯标题。
12. 工具描述带一句引导模型主动持久化（facts/decisions/WIP → `add_note`/`add_file`），约 30 token，可删。
13. 新自动计划顶掉上一个自动计划：只算自动的（人类显式选择不碰）、pinned 不算（只写 `plan:` 键）、新增与顶掉走内部 op 不问权限；不写显式 `unmounted`，保持 auto-following（"恢复自动"语义不变）。
14. 原生 `<select>` 的弹窗 OS 渲染、CSS 够不着：权限下拉自绘（button + 弹窗），照抄官方 Menu token（`menu-surface-fill`/`elevation-prominent`/34px 行/hover=focus 填充/尾部对勾），不新增 require。
15. 宿主 tab 体（`dsh-client-ui-sidebar-right`：`height: 100%` + `overflow: hidden`）不滚动，内容区必须自滚动：`.pg-root` 照抄 files tab 配方（`flex: auto` + `min-height: 0` + `overflow: auto` + `scrollbar-gutter: stable`），滚动条用原生的，不自绘。
16. 抽屉预览 markdown 化：自带阅览器只认 `dsh-resource://file/**`，plan/备注是虚拟文本所以只做内联渲染——用阅览器同源的 `MarkdownText`（`dsh-client-ui-primitives`，`compact` 变体，不传本地链接/图片词表）；文件项另加"在阅览器中打开"按钮（tab slot 的 `useTabInfo` → `tab.actions.openResource(fileAddressFor(sessionId, undefined, item.path))`，`fileAddressFor` 来自 `dsh-util-workspace-path`）。新增 require 走工厂 `try/catch` 可选加载，缺包退回纯文本（0.2.2 教训）；Host 零改动。（0.6.2 起弃用 `compact`，见 17。）
17. 预览是**条目的一部分**，不是 section 末尾的附属块：`PlanRow`/`ItemRow` 外层 `.pg-entry`，内部固定「卡片 → 预览」；标题带展开箭头与 `aria-expanded`，预览头常驻「收起」，收起后焦点回到标题；单展开手风琴，请求序号 + `content.id` 防旧请求串台（0.6.2）。
18. 批准判定**宁可漏挂不可误挂**（0.9.0）：结论从结果正文关键词 + `plan/mode` 结构事件读，读不出来就停在「未确认」，与「被拒」同样不自动挂载。人类显式挂载永远优先，所以误判方向只会是「需要人多点一下开关」，不会是「把没批准的东西当约束」。文案再改版也只退化、不误挂。
19. 挂载文件的自动更新走**每步 stat + 按需读盘**（0.9.0）：`fs.stat` 的 `version` 就是 `dev:ino:size:mtimeNs:ctimeNs`，比正文摘要便宜；版本变了才读正文比 sha256，确实不同才注入。记账只在消息真的注入后与清账同一次写入（`deliver`），没注入就不盖章，下一步自然重新判定。不订阅 `workspace/changes`：那个事件只带 `{turn}`、由 git 快照与文件工具驱动，既认不出用户编辑器改的文件，也给不出路径。
20. **已挂载 = 全文送达，插件不替人类削减**（0.10.0）：截断与省略机制连同四个尺寸配置一起删除，而不是改成「更小但仍在砍」。判据是可达性而非预算：模型侧没有读回全文的动作（`content()` 只在 Remote 上给抽屉用），压缩后注入块是计划与备注的唯一副本；平台自带 `read` 也帮不上文件（默认 50KB / 单行 2000 字符）。pin 就是「必须完整在场」的声明，所以宁可可负担，不可不完整。
21. 删除的尺寸配置必须**被忽略而不是报错**：`apply` 对未知 config 字段是抛错的（0.2.1 那次激活失败就是这么来的），所以 `maxCharsPerPlan`/`maxCharsPerFile`/`maxCharsPerNote`/`maxTotalChars` 进 `DEPRECATED_CONFIG_FIELDS`，`validateConfig` 放行、不写入 resolved，`apply` 检测到就 warn 一次。
22. 给人看的预览与投递要分清：`previewChars` 只限制 `add_file` 返回值与权限卡片，卡片文案必须写明「这是卡片预览，存储与注入的都是全文」；`maxItems` 是拒绝式且默认不限，保留。

## 核心结论（已对安装版运行时验证）

1. 外部 plain-JS profile 插件可直接 `ctx.tools.register(手写对象)`：`parameters` 是普通 JSON Schema，不需要 zod/defineTool；框架**不校验参数**，工具自己校验。
2. 工具全局注册；子代理用 `agent/created` + `agent.ctx.tools.restrict` 隐藏，执行时用 `agent.session.header.origin === 'subagent'` 兜底（0.8.0：`ctx.agents.roots()` 在 0.2.2-rc.5 已移除）。
3. `ctx.userQuestions.askTimed` 是带自定义选项的阻塞问题通道，不依赖 approval policy；本会话 `never` 下可用。
4. `ctx.storageDomain` 表 API 是 `put/update/delete/get`，**没有 `set`**；旧代码的 `.set` 已修正。domain 名必须匹配 `^[a-z][a-z0-9_]*$`：0.2.0 的 `plan-guard` 导致激活失败，0.2.1 改为 `plan_guard`，并加回归测试。
5. `ctx.fs` 提供 `resolve/stat/streamText/contains/processPath`；会话 cwd 取 live `Session.header.cwd`（`workingDirectory` 服务已在新 runtime 删除，0.6.1 起不再使用；`header` 恒存在，无 cwd 则报明确错误）；读取在 pre-step 是官方模式（agent-instructions 同款）。
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
13. `exit_plan_mode` 的接受/拒绝写在 `tool/result` 里：同 `toolCallId`、`isError: true` + `Error: The user dismissed…`
    即拒绝，`isError: false` + `Plan approved…` 即接受，随后跟 `plan/mode {"active": false}`。
    本会话 seq 1007/1035/1037 与 seq 1543/1544 实证；被拒的 0.3.1 计划在 seq 1547 仍被注入——这正是 0.4.0 要修的 bug。
    **补正（0.5.1）：v4 日志把结论包在 `data.message` 里嵌套**，扁平 `data.toolCallId`/`data.isError` 不存在，
    0.4.0–0.5.0 的 verdict 分支在生产环境是死代码（只在手造扁平事件的单元测试里跑过）。
    本会话 seq 2382（call）/2383（dismissal result，嵌套）/2386（仍注入全文）实证；复合 id `call_X|fc_X`
    两侧逐字相同，严格相等即可。修法：先读 `data.message`、回退扁平，投影 `stateVersion 2 → 3` 重折旧缓存。
    **再补正（0.9.0）：字段位置修好了，语义仍然是错的**——`dsh-plan-mode/lib/index.js:257` 把通过与拒绝
    都渲染成**成功**结果（`isError` 恒 `false`，只有正文不同），所以「`isError === true` 即拒绝」在当前运行时
    永远判不出拒绝，再叠上 `accepted !== false` 的 fail-open，任何计划都会被自动挂载。
    实证：会话 `session-40d81a8e…` seq 1222/1223（被拒，`isError:false` + `The user dismissed the plan review
    to reply in their own words; plan mode remains active.`）与 seq 1271/1272→1274（批准，正文 `Plan approved
    — plan mode exited…`，随后 `plan/mode {active:false}`）；投影缓存 `session_projcache/sessions/….json`
    的 `plan-guard-docs` 行（`ver:3`）把被拒那份也记成 `accepted: true`。修法见结论 17。
17. **批准/拒绝只能靠正文与 `plan/mode` 事件读**（0.9.0 实证）：`exit_plan_mode` 的 `output.render`
    把 `{ approved }` 渲成一条 text 块，两条都是 `kind:'success'`；结构化输出 `approved` 不进会话日志。
    批准路径额外留下结构证据：`plan/mode {active:false}` 由 `agent/pre-step` 在该步被接受时追加，
    实测紧跟在 `tool/result` + `step/end` 之后、下一个 `tool/call` 之前（`dsh-plan-mode/src/index.ts:12-13`）。
    PTC 派发的结论在 **`tool/ptc-dispatch`**（`subCallId` + `isError` + `content`，
    `dsh-tool-executor-ptc/src/ptc.ts:560-573`），不是 `tool/result`。
    离线重放本机 30 个真实会话：12 份计划全部判定成功（批准 10 / 拒绝 2 / 未确认 0），
    与旧 fold 相比恰有 2 处 `true → false`（两份被驳回的计划），无一处反向误判。
18. **文件版本可以当指纹用**（0.9.0 实证）：`dsh-fs` 的 `stat()` 返回 `{ version, type, size }`，
    `version` 在本地后端是 `dev:ino:size:mtimeNs:ctimeNs`（`dsh-fs-local/lib/index.js:146`），
    比读全文便宜得多，足以判断「这个文件被动过」。因此每步只做 `stat`，版本变了才读正文比摘要。
    **注意 storage 白名单**：`dsh-storage-domain/src/index.ts:126` 在读取时跑 `valueSchema.parse`，
    而本插件的 `normalizeItemStrict` 是逐字段重建对象——新字段不写进白名单就会被静默抹掉，
    表现为「每步都重新读盘」。
14. plan 的 journal 只发生在人类显式翻转（`setPlan`）；自动翻转（新计划到来、`sawCompaction` 翻转）从不记 journal，
    而 injector `visible && keys empty → return`，所以快照可见时新批准计划永不注入、旧计划也无 notice——
    0.5.0 的 `syncAutoPlans` 补上这一环（新 auto 记 added、旧 auto 记 removed）。
15. `MarkdownText` 的 `compact` 变体不是「同一套样式的紧凑版」，而是 hint 样式：已发布 CSS 里
    `._compact_*` 显式 `color: var(--dsw-alias-label-tertiary)`，预览文字因此发灰；默认变体 `._markdown_*`
    才是 `label-primary`。0.6.2 起预览弃用 compact，用默认版式 + `.pg-previewBody` 作用域内收窄段落/标题间距。
16. **Session Projection 注册在 0.2.2 改为异步**：`ctx.sessionProjections.register(def)` 返回
    `ProjectionHandle`（带 `then` 的 thenable 函数），必须 `await` 并持有；读状态用
    `handle.stateOf(session)`，旧的 `ctx.sessionProjections.stateOf(session, key)` 已弃用（首次读取打
    deprecation warning）。注册仍是调用方 fiber 的 effect，卸载自动释放；句柄保留可继续折叠新事件
    （0.7.0 迁移）。源码锚点：`dsh-session-projection/lib/index.js` 的
    `SessionProjectionRegistry.register/acquire`。
    兼容旧运行时（返回裸 disposer）时，`await` 得到函数、无 `stateOf`，`apply` 立即以明确的版本错误拒绝。
19. **模型侧没有「读回全文」的通道**（0.10.0 实证，这条决定了截断机制必须删除而不是调参）：
    `context_guard` 的 `TOOL_ACTIONS` 只有 `list`/`add_file`/`add_note`/`mount`/`unmount`，
    `list` 的条目行只渲染 id/kind/title/path/flags（`renderItemLine`），正文要 `operations.content()`，
    而 `content` 只挂在 Remote（抽屉/人类）。计划正文的原始载体是 `exit_plan_mode` 的 `tool/call`
    arguments、备注是 `add_note` 的参数 —— 压缩替换掉的正是这些区间。所以截断 = 内容从模型世界消失。
20. **平台自带的 `read` 也不是无限取回路径**：`dsh-tool-fs` 默认 `READ_MAX_BYTES = 50 * 1024`、
    `READ_MAX_LINE_LENGTH = 2000`（`read-render.ts:11-14`），分页读取。所以「文件段带路径，模型自己读」
    这个说法对 >50KB 的文件同样不成立。
21. **`fs.readText` / `streamText` 在本地后端没有体积护栏**（`dsh-fs-local/lib/index.js:865-876`），
    只有 `readBytes(target, signal, maxBytes)` 会抛 `FS_TOO_LARGE`（同文件 `:387-400`）。
    删掉 `maxCharsPerFile` 后整读是新的真实成本：大文件会全量进上下文并驻留 Host 内存。
    这是「pin 即全文」选择的代价，按用户决定不加拦截；读失败仍写成 `file unreadable` 可见标记。

## 实施状态

- [x] 决策：插件方案（不 fork DSH）
- [x] Host：storage 记录 v2、权限、文件读取、`context_guard`、Remote 9 方法、注入器
- [x] Client：权限选择、Plan/条目列表、添加/锁定/删除、预览、双语
- [x] 纯逻辑测试 + 假 ctx 集成测试（0.8.0：57 个用例通过）
- [x] `node --check index.js/client.js`
- [x] 安装与启动验收（0.2.4，独立 profile + 无头 Chrome）：页面不再 “Failed to load plugins”，
      “New tab” 出现 Guarded context，抽屉渲染政策/Plan/条目三个区并成功 `remote.list`
- [x] 真实回合验收（0.3.0，临时安装 + 无头 Chrome + 真模型）：
      首轮注入快照（未压缩也发）、抽屉加备注后下一轮注入 `— update` + 正文、卸载后下一轮只注入一行
      `Note "E2E marker" (note:…) is no longer guarded.`，三次注入都不重复
- [x] 0.4.0：被拒计划不自动挂载（投影 fold `tool/result`、`stateVersion 2`、抽屉/`list` 标记），
      快照头与工具描述去掉「每次压缩后重发」，卸载通知带编号，工具描述加主动持久化一句
- [x] 0.5.0：`syncAutoPlans` 自动顶替（记录 `autoPlan` 字段、新 auto 记 added、旧 auto 记 removed 一行），
      权限下拉自绘原生菜单化（`pg-menu*` 四类 + 内联 chevron/check、无新增 require）
- [x] 0.5.1：verdict 折叠兼容 v4 嵌套形状（先读 `data.message`、回退扁平，`stateVersion 2 → 3`），43/43 测试
- [x] 0.5.2：抽屉自滚动（`.pg-root` 照抄 files tab：`flex: auto` + `min-height: 0` + `overflow: auto` + `scrollbar-gutter: stable`），43/43 测试
- [x] 0.6.0：抽屉预览 markdown 化（`MarkdownText` compact + 文件项"在阅览器中打开"按钮，可选 require + 纯文本降级，Host 零改动），44/44 测试
- [x] 0.6.1：`add_file` 改读 live `Session.header.cwd`（`workingDirectory` 服务已删），45/45 测试
- [x] 0.6.2：抽屉预览内联到展开条目正下方（`.pg-entry` 固定「卡片 → 预览」）、预览面板化（边框/左边线/`bg-layer-2`/`label-primary`，弃用 compact）、标题箭头 + 常驻收起 + 焦点回归、请求序号 + `content.id` 防串台，47/47 测试
- [x] 0.8.0：root 判定改用 `Session.header.origin`（rc.5 移除 `agents.roots`）、`maxItems` 默认 0（不限）、权限问题卡片按 `maxCharsPerNote` 展示完整备注、文件预览标注真实字节数与截断，抽屉按 kind 显示字节/字符，57/57 测试
- [x] 0.10.0：删除截断与省略（四个 maxChars…/maxTotalChars 配置废弃并忽略 + warn、投影 64k 上限移除、`fs.readText` 整读、`composeGuardText`/`composeUpdate` 去掉预算与 `omitted`、备注写入不再有长度限制、抽屉去掉 `maxLength` 与截断徽标、`stateVersion 4 → 5`），77/77 测试
- [x] 0.9.0：批准结论改读结果正文 + `plan/mode` 结构佐证（`isError` 恒 false 的修正）、PTC `tool/ptc-dispatch` 结论、`effectivePlanState` 改 fail-closed（只有 `accepted === true` 才自动挂）、投影 `stateVersion 4`、挂载文件每步 `stat` 探测 + `(changed)` 全文重注 + `deliver` 记账、pending 第三桶 `changed`、`refreshChangedFiles` 配置、抽屉「结论未确认 / 磁盘已改动」标记，72/72 测试
- [x] 0.9.0 离线重放验收：本机 30 个真实会话日志逐事件重折，12 份计划判定 10 批准 / 2 拒绝 / 0 未确认，与旧 fold 相比 2 处 `true → false`（均为 `The user dismissed…` 的被拒计划），无反向误判
- [x] 视觉验收（0.3.0）：浅色/深色截图、与 Workspace files 面板并排比对、guide 卡片图标、控制台零报错
- [ ] 压缩时刻验收（真实压缩触发后快照替换增量）、权限矩阵、问题卡片、抽屉轮询刷新

## 端到端数据流

1. 模型提交 plan（原生或 PTC）→ projection `plan-guard-docs` 记 `{callId,title,size,turn,markdown(全文)}`；
   结论由同 callId 的 `tool/result`（PTC 为 `tool/ptc-dispatch`）正文读 `planVerdict`，认不出挂 `awaitingVerdict`
   等 `plan/mode {active:false}` 佐证，中途被 `tool/call`/`user/message`/`command/run` 打断就停在未确认；
   首次成功 `compaction/end` 把 `sawCompaction` 置真。
2. 抽屉/工具 → storage domain `plan_guard` 表 `sessions`，按 sessionId 一条记录：
   `{version:2, policy, plans:{callId:'mounted'|'unmounted'}, items:{file:/note:}, pending:{added,changed,removed}, autoPlan:callId|null}`。
   每次改挂载状态都往 pending 记一条（按条目合并，add/remove 互相抵消）；file 条目另带 `seenVersion`/`seenDigest`/`seenAt` 记账。
3. pre-step：先跑 `syncAutoPlans`（纯 `planAutoTransition` + mutate；新 auto 记 added、旧 auto 记 removed，显式选择不碰）→
   `observeFileChanges` 对挂载文件各做一次 `stat`（版本没动零读盘；动了才读正文比摘要；只有记账变化则静默落盘）→
   surface 上没有守护消息 → 取 projection + 记录 → 生效 Plan（最新自动：须压缩过、须 `accepted === true`；显式选择优先）
   + 已挂载条目 → 读文件（上限/标记，复用探测已读的正文）→ 拼快照，`deliver` 清 pending 并盖章；
   否则若有 pending（含本轮 `changed`）→ 只拼增量（新增正文 / 卸载一行带编号 / `(changed)` 新全文 + 一行提示）→ 发完按 key 清 pending 并盖章。
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
- `packages/tool/fs/src/index.ts` + `read-render.ts` `readMaxBytes`/`READ_MAX_BYTES`（自带 read 的分页与字节上限）
- `packages/agent/agent/src/runtime-types.ts` `Agent.session.header.origin`（root/subagent 判定；0.2.2-rc.5 无 `agents.roots()`）

### 安装版运行时锚点（本机能直接核对的 0.2.2-rc.5 包）

- `@deepseek-ai/dsh-plan-mode/lib/index.js:250-257`（`output.properties.approved` + `render` 两条英文文本；两者都是 success）
- `@deepseek-ai/dsh-plan-mode/src/index.ts:12-13,152-154`（`plan/mode` 由 `agent/pre-step` 在接受时追加；projection fold）
- `@deepseek-ai/dsh-tool-executor-ptc/src/ptc.ts:560-573`（`tool/ptc-dispatch` 带 `subCallId`/`isError`/`content`）
- `@deepseek-ai/dsh-fs/src/types.ts:76-83`（`FsInfo = { version, type, size }`）
- `@deepseek-ai/dsh-fs-local/lib/index.js:146-148,842-852`（`version = dev:ino:size:mtimeNs:ctimeNs`）
- `@deepseek-ai/dsh-storage-domain/src/index.ts:126`（读取时跑 `valueSchema.parse`）
- `@deepseek-ai/dsh-session-projection/src/index.ts:642`（缓存行 `ver !== stateVersion` 即整表重折）

## 验证

- 已跑：`node --check index.js`、`node --check client.js`、`node --test test/*.test.js`（77/77；含 160k 文件 / 70k 备注 / 80k 计划的全文注入端到端，以及注入文本里 grep 不到 `truncat`/`omit` 标记）。
- 已跑（0.9.0）：离线重放本机 `/root/.dsh/sessions/*/*/session.v4.jsonl.zstd` 全部 30 个会话，逐事件喂给 `foldDocs`；
  12 份计划 → 批准 10 / 拒绝 2 / 未确认 0，与旧 fold 逐份对比只有 2 处 `true → false`（`session-ca9aa2…`、
  `session-40d81a8e…` 里被驳回的计划），无 `false → true` 误判，且被拒计划 `effectivePlanState.mounted === false`。
- 已跑：独立 profile 安装 + `dsh web` 启动 + 无头 Chrome（浅/深色截图、抽屉增删挂载、guide 图标、控制台零报错）。
- 已跑：真实模型回合三条注入（快照 / 新增增量 / 卸载一行），直接读会话 jsonl 核对。
- 未跑（需重启 `dsh web`，会打断当前会话，留给人类验收）：
  0.9.0 的两条新路径在真实回合里的表现——被拒计划压缩后不出现 `## Plan` 段、批准后出现；
  外部编辑器改动挂载文件 → 下一步注入 `## File: … (changed)` 全文，`touch` 同内容不注入；
  `plan-guard-docs` 缓存行 `ver` 升到 4、`storages/plan_guard.json` 里 file 条目出现 `seenVersion`/`seenDigest`。
- 后续：`plugin_manager install_bundle` → 重启 → `cordis_inspect_query` Tool/Slots →
  抽屉矩阵 → 工具权限矩阵 → `dsh-compaction-tune` 强制压缩（`set-ratio.mjs 0.01 --retain 0.0005`，测试后恢复）→ 重启/恢复自愈。
