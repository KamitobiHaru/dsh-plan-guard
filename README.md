# dsh-plan-guard

给 DSH（DeepSeek Harness）的**守护上下文**插件：让 Plan、备注、文件跨上下文压缩持续可见。DSH 的压缩会把一段会话换成摘要检查点，模型随后只看得到摘要；本插件把当前守护内容拼成一条 user 消息注入：surface 上没有守护消息时（首次，或压缩把旧消息换成摘要检查点之后）发**完整快照**，**守护集合有变更的下一步**发**增量**（新增发正文，卸载只发一句提示），模型不必重新翻文件，人类也不必重述约束。

- **只自动挂载最新 Plan，且只挂通过的**：首次压缩后，最新一份**已接受**的 Plan 自动生效；被用户拒绝的 Plan 留在列表里但永不自动挂载（可手动挂载）。人类在此之前卸下，就一直保持未挂载。旧 Plan 留在列表里，可随时手动挂载。
- **模型可增不可删**：模型能加备注/文件、挂载/卸载；不能动 Plan，也不能删除任何条目（包括自己加的，留痕审计）。删除只有人类能做。
- **权限归人类**：会话级五档权限 + 条目级锁定；模型动作可以要求对话内批准，拒绝/超时都不写入。
- **变更立刻可见**：新增内容在下一个 step 就能被模型看到，卸载只在尾部追加一行提示，不等压缩。
- **文件实时读**：注入时才按工作区复核并读取文件，不存快照，避免把过期内容当约束。
- **正交**：不修改任何压缩配置或预设，可以和 [`dsh-compaction-tune`](https://github.com/KamitobiHaru/dsh-compaction-tune)（更快触发压缩的副本预设）同时安装。

> **v0.4.0 状态**：Host/Client 实现与 36 个测试已完成；已在临时安装的 `dsh web` 里用无头 Chrome 验收抽屉（浅色/深色）与真实模型回合的三条注入（快照 / 新增增量 / 卸载一行）。未覆盖项见「[已知限制](#已知限制)」。

## 工作原理

DSH 的会话日志是追加式的：压缩不删除事件，只是把一段事件从模型可见的 surface 里移走，换成一条检查点。Plan 正文本来就只存在于日志中 `exit_plan_mode` 的 `tool/call` 参数里，所以插件不复制 Plan：

1. **Plan 投影**：`sessionProjections` 从会话日志折叠出一份轻量投影 `plan-guard-docs`，记录每个 `exit_plan_mode`（含 PTC 派发）的 callId、标题、大小、提交轮次和 markdown（单条上限 64k），并记住是否发生过一次成功压缩，以及每份计划是被接受还是被拒（从同 callId 的 `tool/result` 的 `isError` 折叠）。被拒的计划只展示、不自动挂载。
2. **守护记录**：抽屉和工具把人类的选择写进 storage domain `plan-guard` 的 `sessions` 表，每个 session 一条 `{version: 2, policy, plans, items}`。Plan 只在记录里存 `mounted` / `unmounted` 标记；备注正文存记录，文件只存路径与元数据。
3. **注入时机**：`agent/pre-step` 瀑布在 `await next()` 之后拼一条 user 消息，插在本次进入的消息之后、runtime-context 之前。两条触发线：surface 上还没有守护消息时（首次注入，或压缩把它换成了摘要检查点）发**完整快照**；守护集合有变更时发**增量**。消息由 agent-loop 记成 `user/message`，满足「模型可见 ⟺ 已记录」。
4. **增量只追加**：新增条目发正文（与快照同一套 `## Plan` / `## Note` / `## File` 段落）；卸载或删除只发一句 `Note "…" (note:…) is no longer guarded.`（标题加唯一编号）。所有注入都追加在请求尾部，历史消息一字不改，所以 KV cache 的前缀照常复用；这段文字留到下次压缩为止。
5. **不重复、可恢复**：变更记在记录的 `pending` 日记里（按条目合并，add 与 remove 互相抵消），注入成功后按 key 清除；进程重启后日记还在，下一步补发。压缩后的快照覆盖此前所有未送达的变更。
6. **抽屉读活会话**：右侧栏抽屉通过 `dsh-resource://plan-guard-drawer/<sessionId>` 资源轮询，Host 端是 9 个 Remote 方法（list / policy / plan / item / note / file / content 等）。

注入是**纯附加**的：插件不注册新的事件类型，不碰压缩阈值、保留比例、预设或摘要器。压缩本身失败时不会注入；注入失败只记日志，不会让 step 失败。

## 权限模式

抽屉顶部的「模型权限」只约束模型，人类动作永远允许：

| 模式 | 模型 add / mount | 模型 unmount |
|---|---|---|
| `ask`（默认） | 询问 | 询问 |
| `allow-mount` | 允许 | 询问 |
| `allow-unmount` | 询问 | 允许 |
| `allow-all` | 允许 | 允许 |
| `deny-all` | 拒绝 | 拒绝 |

- **锁定**优先于模式：条目被人类锁定后，模型挂载/卸载一律拒绝；人类仍可改。
- **Plan 不在矩阵内**：模型不能挂载/卸载 Plan，工具收到 Plan id 会明确报错。
- **`ask` 是问题卡片，不是 approval 面板**：走 `ctx.userQuestions.askTimed`，卡片上带「允许 / Allow」「拒绝 / Deny」。因此全局 approval policy 为 `never` 时它照样能用；超时（默认 120 秒）、没有客户端、调用被取消，都按拒绝处理，记录不变。
- **无操作不打扰**：重复挂载、重复卸载、添加后本来就挂载这类 no-op，直接返回「已是该状态」，不弹卡片。

## 模型工具 `context_guard`

| action | 参数 | 说明 |
|---|---|---|
| `list` | 无 | 返回权限模式、Plan 列表（含自动/显式/接受状态）、条目列表（id / kind / title / mounted / locked / createdBy / path） |
| `add_file` | `path`，可选 `title` | 校验并挂载一个工作区 UTF-8 文本文件；返回 id 和有界预览 |
| `add_note` | `text`，可选 `title` | 添加并挂载一条备注 |
| `mount` | `itemId` | 挂载已有条目 |
| `unmount` | `itemId` | 卸载已有条目；条目保留，可再挂载 |

- 没有 `remove`；删除只能由人类在抽屉里做。
- 添加即挂载，**下一个 step** 就能看到内容；卸载会在尾部追加一行 `… (<id>) is no longer guarded.`。要立刻读文件内容，用 `add_file` 返回的预览。
- 参数由工具自己校验（工具框架不校验原始 JSON Schema 参数），错误以工具错误返回。
- 工具全局注册，所有 root 会话都能看到（包括 `minimal` 预设）；`agent/created` 时对子代理 `tools.restrict`，执行时再用 `agents.roots()` 兜底，所以子代理看不到也调不到。
- 不写自定义工具卡片，Web 用默认的通用卡片。

## 注入内容

surface 上没有守护消息时（首次，或压缩把旧消息换成摘要检查点之后），注入完整快照：

```text
Guarded context (plans, notes, files)
This block is background context, not a new request. You see the full set only the first time anything is guarded, or again after a compaction wiped it from the surface; afterwards you only get short updates when the guarded set changes (new content in full, removals as one-line notices).

## Plan: 重构存储层
plan: 019...
<plan markdown>

## Note: 不要改动公开 API
item: note:...
<note text>

## File: src/core/store.ts
item: file:...
<file content>
```

有变更时（消息已可见），只注入增量——新增发正文，卸载发一句：

```text
Guarded context (plans, notes, files) — update
Background context, not a new request.

## Note: 发布前不要改 schema
item: note:...

<note text>

Note "不要改动公开 API" (note:…) is no longer guarded.
```

- **Plan 从日志推导**，不复制正文到 storage；取不到时给标记，不会中断注入。
- **备注正文存 storage**；**文件在注入时实时读取**：添加时记下绝对路径和当时的 workspace root，注入时复核仍在该 root 内（除非显式允许越界），然后读最新内容。缺失、二进制、越界、超大都会写成可见标记，不会静默丢弃，也不会让 step 失败。
- **四层上限**：单 Plan、单文件、单备注、总字符。超出时截断并标记；总上限溢出时按顺序保留，剩下的以省略 id 列出。
- 快照只在 surface 上没有守护消息时发送；增量每条变更只发一次，卸载不重发正文。

## 配置

在 `cordis.patch.yml` 中 `plugin-plan-guard` 那一行加 `config`（profile patch 里改，或安装后改 profile）。所有字段都有默认值：

| 字段 | 默认 | 说明 |
|---|---|---|
| `disabled` | `false` | 关闭注入（工具与抽屉仍可用） |
| `toolEnabled` | `true` | 是否注册 `context_guard` |
| `header` | `Guarded context (plans, notes, files)` | 注入消息首行 |
| `maxCharsPerPlan` | `20000` | 单 Plan 注入上限（字符） |
| `maxCharsPerFile` | `20000` | 单文件注入上限 |
| `maxCharsPerNote` | `20000` | 单备注上限 |
| `maxTotalChars` | `100000` | 全部注入内容总上限 |
| `maxItems` | `24` | 备注 + 文件条目上限（Plan 不计） |
| `defaultPolicy` | `ask` | 没有存储记录时使用的权限模式 |
| `autoMountLatestPlan` | `true` | 首次压缩后自动挂载最新 Plan（被拒的不挂） |
| `askTimeoutMs` | `120000` | 权限问题等待上限 |
| `allowOutsideWorkspace` | `false` | 允许挂载工作区外的绝对路径文件 |
| `previewChars` | `4000` | `add_file` 返回的预览上限 |

**总上限与压缩振荡**：注入内容会进入下一轮压缩的输入。把 `maxTotalChars` 控制在压缩阈值（tokens）× 约 4 以下；如果观察到压缩后立刻又触发压缩，就调低它。插件本身不修改任何压缩参数。

## 安装

前置：可用的 DSH（开发验证于 `0.2.1-rc.2` 运行时），`dsh web` 能正常启动。安装 spec 固定到 tag：

    dsh plugin --profile web add github:KamitobiHaru/dsh-plan-guard#v0.4.0

**方式一：命令行** —— 上面的命令。

**方式二：GUI** —— 左侧「插件」页面，安装同一个 spec。

**方式三：让 DSH 里的 agent 装** —— 用 `plugin_manager` 工具，`install_bundle`，target 填同一个 spec。

> **装完请重启一次 `dsh web`。** 实测安装 bundle / 改 profile patch 之后，正在运行的会话会掉光工具（任何调用都返回 `unknown tool`），重启即恢复。之后新会话就能看到抽屉和 `context_guard`。

## 使用

右侧栏 guide 页 →「上下文守护」打开抽屉：

- **顶部**：选择模型权限，改动立即生效，写入当前会话记录。
- **Plans**：开关切换挂载；「自动」表示等首次压缩后自动挂载；「已拒绝」表示计划没通过，永不自动挂载（仍可手动挂载）；「恢复自动」清除人类的显式选择；点标题展开全文。
- **已固定条目**：开关挂载/卸载；锁形按钮锁定/解锁（锁后模型完全不能改）；删除需两步确认；点标题展开预览。
- **添加**：「添加备注」（标题 + 正文）或「添加文件」（工作区路径，服务端校验存在、UTF-8、在 workspace 内）。
- **Plan 的四种状态**：自动（最新、已压缩、已接受）/ 已挂载（人类显式）/ 已卸下（人类显式，之后不再自动挂载）/ 已拒绝（计划没通过，永不自动挂载）。旧 Plan 默认卸下，仍可手动挂载。

挂载/卸载在**下一步**就进入模型上下文；模型动作需要权限时，对话里出现问题卡片，允许后工具在同一次调用里完成，拒绝/超时则不写入。

## 已知限制

- **尚未做压缩矩阵验收**：v0.4.0 已在临时安装里跑过真实模型回合（快照、新增增量、卸载一行三条注入都对），但「压缩发生的那一刻」、问题卡片、权限矩阵与抽屉轮询刷新还没在真实会话里逐一跑过。
- **抽屉只读活会话**：会话未恢复时显示提示，不能编辑；归档会话的读取（projection `wire.view`）未做。
- **卸载提示只是一句话**：`… (<id>) is no longer guarded.` 不会删掉历史里的旧正文；旧正文要等下次压缩才真正离开 surface。
- **pending 有上限**：最多记 200 条未送达变更，超出丢最旧的；长时间停用注入（`disabled`）时可能少报几条。
- **文件默认限工作区**：越界、二进制、缺失都以标记出现；不支持目录、通配符、URL、图片。打开 `allowOutsideWorkspace` 后仍会拒绝符号链接逃逸。
- **备注不能原地编辑**：改内容要删除后重新添加。删除是 storage 操作，不额外写会话事件。
- **模型不能删除任何条目**：工具没有删除动作；只能卸载。调用与结果留在会话日志里，便于审计。
- **`ask` 不依赖 approval policy**：没有客户端或超时即拒绝；超时默认 120 秒，可在 config 里改。
- **没有自定义工具卡片**：Web 显示默认通用卡片，没有文件选择器。
- **总上限太大可能造成压缩振荡**：见「配置」一节的建议。
- **Plan 来源有限**：只认会话日志里的 `exit_plan_mode`（原生与 PTC 派发）；其它方式写出的计划不会被识别。

## 卸载

    dsh plugin --profile web remove dsh-plan-guard

或在 GUI 的「插件」页移除，然后重启 `dsh web`。卸载后注入与工具立即消失；已经写入 storage 的守护记录不会自动清理，重新安装后仍可读到。

## 维护与发版

- **验证**：`node --check index.js`、`node --check client.js`、`node --test test/*.test.js`（36 个用例）。测试用假 Cordis ctx，覆盖权限矩阵、Plan 自动/显式/接受状态、注入组合与截断、记录兼容、工具/Remote/注入路径。
- **发版约定**：`package.json` 的 `version` 与 tag 同名（`0.4.0` ↔ `v0.4.0`）。修 bug 升 patch，加功能升 minor；安装 spec 始终写 `#vX.Y.Z`，不要跟分支。
- **DSH 是 pre-stable**：插件用到的 `sessionProjections`、`storageDomain`、`tools.register`、`userQuestions.askTimed`、`agent/pre-step`、`fs`、Typert Remote 都是当前运行时接口。升级 DSH 后先跑测试，再按「已知限制」里的清单做一次手工验收；接口有变时以 `PLAN.md` 里列出的源码锚点为准。
- **与 `dsh-compaction-tune` 正交**：它改的是预设里的压缩阈值/保留比例，本插件只读会话事件和 storage，并在 pre-step 只追加注入消息；两者可以同时装。要强制制造压缩来验收，可用它的 `node scripts/set-ratio.mjs 0.01 --retain 0.0005`，测完恢复原值。

### `0.4.0` 被拒计划不再自动挂载 + 模型可见文案修正

投影开始折叠 `tool/result`：每份 Plan 记录接受/拒绝结论（`isError === true` 即拒绝），`effectivePlanState` 里被拒计划的自动挂载资格被拿掉——只展示、不自动挂载，但人类仍可手动挂载；结论未知（无 result、PTC 派生、老缓存）的保持原行为。抽屉与 `list` 显示「已拒绝 / rejected」标记。另三处文案修正：快照头与工具描述不再写「每次压缩后重发」，改为「surface 无守护消息时发全量、有变更时只发增量」；卸载通知带唯一编号（`Note "…" (note:…) is no longer guarded.`，与正文段的 `item: <id>` 对应）；工具描述加一句引导模型主动持久化（`When you hold facts… persist them with add_note/add_file…`）。投影 `stateVersion 1 → 2`，旧缓存行重折叠并从日志恢复结论。

### `0.3.0` 变更即时注入 + 抽屉重做

注入不再等压缩：`agent/pre-step` 用记录里的 `pending` 日记判断「有变更」，新增条目发正文、卸载删除发一行 `… is no longer guarded.`；surface 上没有守护消息时（首次、压缩把旧消息换成摘要检查点之后）才发完整快照。全部注入都追加在请求尾部，不改写历史，KV cache 前缀不失效。抽屉重做成主题 token（`--dsw-*`）与 `pg-` 类名样式表：卡片、开关、次按钮、focus ring 与原生右侧栏一致；删掉三段说明文案与重复徽标，新增 tab 图标、更短的 tab 标题与紧凑空状态。

### `0.2.4` 修复 Client 条目激活失败

装进 profile 后 `dsh web` 进程能起来，但浏览器整页是 “Failed to load plugins / web boot: 1 entry did not activate / dsh-plan-guard: failed”。原因是 Client 自己 `$mount` 的 Remote 命名空间没有进任何 inject 组：`ctx.remote['plan-guard']` 会抛 `cannot get property "remote.plan-guard" without inject`，条目直接进 failed。把它写进静态 `inject` 也不行——命名空间正是这个插件的 `apply` 自己创建的，静态依赖会让 fiber 永远停在 pending。0.2.4 改成官方 `dsh-experimental-client-ui-voice-input` 的写法：先 `await ctx.remote.$mount(...)`，再用 `ctx.inject(['remote.plan-guard', …], registerUi)` 在动态依赖组里注册抽屉，并返回同时回收 UI 与 Remote 的 disposer；失败时先 `ui.dispose()` 再 `disposeRemote()` 后抛出。`client.test.js` 新增断言：依赖组含 `remote.plan-guard`、静态 `inject` 不含它、`apply` 返回可回收的 disposer。

### `0.2.3` 修复抽屉资源地址

资源地址必须是 `dsh-resource://<protocol>/…`，`<protocol>` 就是 provider 注册的 host。0.2.2 用了 `plan-guard-drawer://<sessionId>`，`protocolOf` 认不出它，`useResource` 永远停在 `none`，抽屉会一直空白。0.2.3 改成 `dsh-resource://plan-guard-drawer/<sessionId>`，并让 `client.test.js` 断言地址的 host 与注册的 protocol 一致、session id 能往返编解码。

### `0.2.2` 修复 Client 导入失败

0.2.1 的 Host 能激活了，但浏览器端仍报 `import failed: client-modules: require("zod") missed the module table`。Web 的模块表只种了 React、Cordis 等平台模块，没有 zod；`client.js` 却用它构造 Remote 的严格 codec。0.2.2 去掉 zod，改成手写的最小 codec（`mode: 'strict'` + `typeSymbol` + `jsonSchema` + `create()` 返回带 `parse` 的对象），并新增一个 `vm` 测试：用假模块表加载 `client.js`、执行 `apply`，断言只 require 了 `react`，且每个 descriptor 都满足 typert 的严格 codec 校验。

### `0.2.1` 修复激活失败

`dsh-storage` 要求 domain / table 名匹配 `^[a-z][a-z0-9_]*$`。0.2.0 用了 `plan-guard`，`storageDomain.open` 在启动时抛 `StorageError: invalid unit name 'plan-guard'`，整个插件条目不激活（`dsh web` 日志里的 “1 entry did not activate”）。0.2.1 把 domain 名改为 `plan_guard`；0.2.0 从未成功打开过该 domain，所以没有数据需要迁移。发版前已在临时 `DSH_HOME` 里安装本地目录并真实启动 `dsh web`，确认不再出现激活警告。

## License

MIT，见 [LICENSE](LICENSE)。
