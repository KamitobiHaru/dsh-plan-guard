# dsh-plan-guard

给 DSH（DeepSeek Harness）的**守护上下文**插件：让 Plan、备注、文件跨上下文压缩持续可见。DSH 的压缩会把一段会话换成摘要检查点，模型随后只看得到摘要；本插件把当前守护内容拼成一条 user 消息注入：surface 上没有守护消息时（首次，或压缩把旧消息换成摘要检查点之后）发**完整快照**，**守护集合有变更的下一步**发**增量**（新增发正文，卸载只发一句提示），模型不必重新翻文件，人类也不必重述约束。

- **只自动挂载最新 Plan，且只挂确认批准通过的**：首次压缩后，最新一份**已批准**的 Plan 自动生效。被用户拒绝的、以及结论读不出来的 Plan 留在列表里但永不自动挂载（可手动挂载）。人类在此之前卸下，就一直保持未挂载。旧 Plan 留在列表里，可随时手动挂载。
- **新自动 Plan 顶掉旧自动 Plan**：新批准的计划自动挂载时，上一个**自动挂载**的计划收到一行 `Plan "…" (<callId>) is no longer guarded.`；人类显式挂载的 Plan 和 pinned 条目不受影响。该记账走内部 op，不问权限。
- **模型可增不可删**：模型能加备注/文件、挂载/卸载；不能动 Plan，也不能删除任何条目（包括自己加的，留痕审计）。删除只有人类能做。
- **权限归人类**：会话级五档权限 + 条目级锁定；模型动作可以要求对话内批准，拒绝/超时都不写入。
- **变更立刻可见**：新增内容在下一个 step 就能被模型看到，卸载只在尾部追加一行提示，不等压缩。
- **已挂载 = 全文送达**：插件不截断、不省略任何已挂载内容，也没有体积上限。`context_guard` 里没有「读回全文」的动作，压缩后注入块就是唯一副本——给一半比不给更危险，所以干脆不给留半个的余地。
- **文件改动自动更新**：注入时才按工作区复核并读取文件，不存快照；每个 step 再对挂载的文件做一次 `stat`，版本变了才读正文——真变了就在下一步把新全文重送一遍（段标题带 `(changed)`），内容没变（`touch`、重写同内容）只更新记账。
- **正交**：不修改任何压缩配置或预设，可以和 [`dsh-compaction-tune`](https://github.com/KamitobiHaru/dsh-compaction-tune)（更快触发压缩的副本预设）同时安装。

> **v0.10.0 状态**：Host/Client 实现与 77 个测试已完成。0.10.0 **删掉了截断与省略机制**：`maxCharsPerPlan` / `maxCharsPerFile` / `maxCharsPerNote` / `maxTotalChars` 四个配置连同行为一起移除，已挂载的计划、备注、文件一律全文送达（旧 profile 里还写着这些字段会被忽略并 warn 一次，插件照常激活）。0.9.0 修好了「没批准的计划也被挂载」（结论改读结果正文与 `plan/mode`，判定 fail-closed）并给挂载文件加了磁盘改动自动更新（每步一次 `stat`，正文真变了才重送）；0.8.0 适配 DSH 0.2.2-rc.5、默认取消条目数量上限、权限卡片展示完整备注。需重启 `dsh web` 生效。

## 工作原理

DSH 的会话日志是追加式的：压缩不删除事件，只是把一段事件从模型可见的 surface 里移走，换成一条检查点。Plan 正文本来就只存在于日志中 `exit_plan_mode` 的 `tool/call` 参数里，所以插件不复制 Plan：

1. **Plan 投影**：`sessionProjections` 从会话日志折叠出一份轻量投影 `plan-guard-docs`，记录每个 `exit_plan_mode`（含 PTC 派发）的 callId、标题、大小、提交轮次和**完整** markdown，并记住是否发生过一次成功压缩。批准/拒绝的结论从**结果正文**读（`tool/result`，PTC 走 `tool/ptc-dispatch`）：当前运行时两个方向都是成功结果，`isError` 只在硬失败时为真，所以判定靠正文里的 `Plan approved` / `dismissed`。正文认不出来时先挂起，若紧接着出现 `plan/mode {active:false}`（退出计划模式，批准路径的结构标记）就算批准；中间被 `user/message` / `tool/call` / `command/run` 打断就永远算「未确认」。**未确认与被拒同样处理：不自动挂载**。
2. **守护记录**：抽屉和工具把人类的选择写进 storage domain `plan-guard` 的 `sessions` 表，每个 session 一条 `{version: 2, policy, plans, items}`。Plan 只在记录里存 `mounted` / `unmounted` 标记；备注正文存记录，文件只存路径与元数据。
3. **注入时机**：`agent/pre-step` 瀑布在 `await next()` 之后拼一条 user 消息，插在本次进入的消息之后、runtime-context 之前。三条触发线：surface 上还没有守护消息时（首次注入，或压缩把它换成了摘要检查点）发**完整快照**；守护集合有变更时发**增量**；挂载的文件在磁盘上被改动（`stat` 的版本变了、正文摘要也确实不同）时也发**增量**，把新全文重送一遍。新批准计划自动挂载时，内部 `syncAutoPlans` 先把它的 `added` 与旧自动计划的 `removed` 记进日记（人类显式选择不碰），随增量同发。消息由 agent-loop 记成 `user/message`，满足「模型可见 ⟺ 已记录」。
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
- 工具全局注册，所有 root 会话都能看到（包括 `minimal` 预设）；`agent/created` 时对子代理 `tools.restrict`，执行时再用 `session.header.origin` 兜底，所以子代理看不到也调不到。
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

有变更时（消息已可见），只注入增量——新增发正文，卸载发一句，文件被改动重发全文：

```text
Guarded context (plans, notes, files) — update
Background context, not a new request.

Note "不要改动公开 API" (note:…) is no longer guarded.
File src/core/store.ts (file:…) changed on disk; the section below is its current content.

## File: src/core/store.ts (changed)
item: file:…

<current file content>
```

- **Plan 从日志推导**，不复制正文到 storage；取不到时给标记，不会中断注入。
- **备注正文存 storage**；**文件在注入时实时读取**：添加时记下绝对路径和当时的 workspace root，注入时复核仍在该 root 内（除非显式允许越界），然后读最新内容。缺失、二进制、越界、超大都会写成可见标记，不会静默丢弃，也不会让 step 失败。
- **文件带「记账」**：每次注入把实际送出的正文摘要与 `stat` 版本（`dev:ino:size:mtime:ctime`）写回条目。下一步只做一次 `stat`：版本没动就什么都不发生；动了才读正文比对摘要，确实不同才重发。所以 `touch`、`git checkout` 重写同内容，都不会打扰模型；正文是全文比对，改在尾部也算改动。
- **没有体量上限，也没有截断**：0.10.0 起删掉了 `maxCharsPerPlan` / `maxCharsPerFile` / `maxCharsPerNote` / `maxTotalChars` 四个配置与它们的全部行为（曾经的实现是「超了就砍尾」或「装不下就整段不发，只在尾部列 id」）。原因：模型侧没有读回全文的动作，压缩后注入块是计划与备注的唯一副本，被砍掉的那一半在模型的世界里根本不存在——而 pin 这个动作本身就是「这必须完整在场」的声明。文件读失败仍会写成可见标记（`file unreadable: …`），因为那是失败而不是削减。
- 快照只在 surface 上没有守护消息时发送；增量每条变更只发一次，卸载不重发正文。

## 配置

在 `cordis.patch.yml` 中 `plugin-plan-guard` 那一行加 `config`（profile patch 里改，或安装后改 profile）。所有字段都有默认值：

| 字段 | 默认 | 说明 |
|---|---|---|
| `disabled` | `false` | 关闭注入（工具与抽屉仍可用） |
| `toolEnabled` | `true` | 是否注册 `context_guard` |
| `header` | `Guarded context (plans, notes, files)` | 注入消息首行 |
| `maxItems` | `0` | 备注 + 文件条目上限；`0` = 不限（Plan 不计） |
| `defaultPolicy` | `ask` | 没有存储记录时使用的权限模式 |
| `autoMountLatestPlan` | `true` | 首次压缩后自动挂载最新 Plan（被拒、结论未确认的不挂） |
| `refreshChangedFiles` | `true` | 每步探测挂载文件的磁盘改动，正文变了就重送；关掉后只在注入时读 |
| `askTimeoutMs` | `120000` | 权限问题等待上限 |
| `allowOutsideWorkspace` | `false` | 允许挂载工作区外的绝对路径文件 |
| `previewChars` | `4000` | 预览上限：只作用于 `add_file` 的返回值与权限卡片，不影响注入 |

**体量由挂载的人负责**：注入内容会进入下一轮压缩的输入，而现在没有任何东西替你削减它。挂载很大或很多内容时，压缩会更频繁、历史更快被摘要掉——守护块仍会在每次压缩后全文重发，所以丢的是历史，不是约束。插件本身不修改任何压缩参数（要控制压缩节奏用 [`dsh-compaction-tune`](https://github.com/KamitobiHaru/dsh-compaction-tune)）。

**废弃字段**：profile 里若还写着 `maxCharsPerPlan`、`maxCharsPerFile`、`maxCharsPerNote`、`maxTotalChars`，插件照常激活，Host 日志里 warn 一次并忽略这些字段（不会当成未知字段报错）。

## 安装

前置：可用的 DSH（开发验证于 `0.2.2-rc.5` 运行时），`dsh web` 能正常启动。安装 spec 固定到 tag：

    dsh plugin --profile web add github:KamitobiHaru/dsh-plan-guard#v0.10.0

**方式一：命令行** —— 上面的命令。

**方式二：GUI** —— 左侧「插件」页面，安装同一个 spec。

**方式三：让 DSH 里的 agent 装** —— 用 `plugin_manager` 工具，`install_bundle`，target 填同一个 spec。

> **装完请重启一次 `dsh web`。** 实测安装 bundle / 改 profile patch 之后，正在运行的会话会掉光工具（任何调用都返回 `unknown tool`），重启即恢复。之后新会话就能看到抽屉和 `context_guard`。

## 使用

右侧栏 guide 页 →「上下文守护」打开抽屉：

- **顶部**：选择模型权限，改动立即生效，写入当前会话记录。
- **Plans**：开关切换挂载；「自动」表示等首次压缩后自动挂载；「已拒绝」/「结论未确认」表示这份计划没有拿到批准，永不自动挂载（仍可手动挂载）；「恢复自动」清除人类的显式选择；点标题或右侧箭头展开，预览紧贴该计划下方，右上角「收起」。
- **已固定条目**：开关挂载/卸载；锁形按钮锁定/解锁（锁后模型完全不能改）；删除需两步确认；文件条目在改动待送达时标「磁盘已改动」；点标题或右侧箭头展开，预览紧贴该条目下方，右上角「收起」。
- **添加**：「添加备注」（标题 + 正文）或「添加文件」（工作区路径，服务端校验存在、UTF-8、在 workspace 内）。
- **Plan 的五种状态**：自动（最新、已压缩、已确认批准）/ 已挂载（人类显式）/ 已卸下（人类显式，之后不再自动挂载）/ 已拒绝（计划被驳回）/ 结论未确认（日志里读不出批准证据）。后三种都不自动挂载，人类仍可手动挂。旧 Plan 默认卸下，仍可手动挂载；上一个自动 Plan 会被新自动 Plan 顶掉（只发一行提示，不写显式选择，"恢复自动"语义不变）。

挂载/卸载在**下一步**就进入模型上下文；模型动作需要权限时，对话里出现问题卡片，允许后工具在同一次调用里完成，拒绝/超时则不写入。

问题卡片是给人审阅的面板，所以备注与文件都只预览前 `previewChars` 个字符，卡片会写明总长与「这是卡片预览、存储与注入的都是全文」。内容超过 1000 字符时，顶部提示向下滚动、允许 / 拒绝按钮在正文之后。这条预览限制**不影响投递**：注入的是完整正文。

## 已知限制

- **尚未做压缩矩阵验收**：v0.4.0 已在临时安装里跑过真实模型回合（快照、新增增量、卸载一行三条注入都对），但「压缩发生的那一刻」、问题卡片、权限矩阵与抽屉轮询刷新还没在真实会话里逐一跑过。
- **抽屉只读活会话**：会话未恢复时显示提示，不能编辑；归档会话的读取（projection `wire.view`）未做。
- **卸载提示只是一句话**：`… (<id>) is no longer guarded.` 不会删掉历史里的旧正文；旧正文要等下次压缩才真正离开 surface。文件被改动时同理：新的 `(changed)` 段追加在尾部，旧正文留在历史上直到下次压缩。
- **批准判定靠结果正文的关键词**：`Plan approved` / `dismissed` 是当前运行时 `exit_plan_mode` 渲染出的英文文本（两个方向都是成功结果，`isError` 帮不上）。DSH 若改文案，结论会退化成「未确认 → 不自动挂载」，只会漏挂、不会误挂；`plan/mode {active:false}` 作为结构佐证兜住一部分。
- **首次探测前的等长改动**：升级到 0.9.0 时已有条目没有记账，第一次 `stat` 只在字节数变化时判定为改动；升级期间发生的等长改动要等下次真实改动或压缩快照才纠正。
- **pending 有上限**：最多记 200 条未送达变更，超出丢最旧的；长时间停用注入（`disabled`）时可能少报几条。
- **默认不限条目数量，也不限单条大小**：`maxItems: 0` 时 storage 随备注/文件增长，而每条内容都是全文投递。需要控制数量时在 config 里把 `maxItems` 设为正整数；**大小没有任何闸门**——挂载一个 5MB 的文本就会把 5MB 送进上下文，并且整份读进 Host 进程内存（`fs.readText` 在本地后端没有体积护栏），这是「pin 即全文」这个选择的直接代价，插件不会替你偷偷削减。
- **文件默认限工作区**：越界、二进制、缺失都以标记出现；不支持目录、通配符、URL、图片。打开 `allowOutsideWorkspace` 后仍会拒绝符号链接逃逸。
- **备注不能原地编辑**：改内容要删除后重新添加。删除是 storage 操作，不额外写会话事件。
- **模型不能删除任何条目**：工具没有删除动作；只能卸载。调用与结果留在会话日志里，便于审计。
- **`ask` 不依赖 approval policy**：没有客户端或超时即拒绝；超时默认 120 秒，可在 config 里改。
- **没有自定义工具卡片**：Web 显示默认通用卡片，没有文件选择器。
- **Plan 来源有限**：只认会话日志里的 `exit_plan_mode`（原生与 PTC 派发）；其它方式写出的计划不会被识别。

## 卸载

    dsh plugin --profile web remove dsh-plan-guard

或在 GUI 的「插件」页移除，然后重启 `dsh web`。卸载后注入与工具立即消失；已经写入 storage 的守护记录不会自动清理，重新安装后仍可读到。

## 维护与发版

- **验证**：`node --check index.js`、`node --check client.js`、`node --test test/*.test.js`（77 个用例）。测试用假 Cordis ctx / 假模块表 / 假文件系统（可变文件表 + `stat`/读取计数），覆盖权限矩阵、Plan 自动/显式/批准/拒绝/未确认/顶替状态、真实会话日志的 `exit_plan_mode` 事件形状、文件改动探测与记账、注入组合与全文送达、废弃配置兼容、记录兼容、工具/Remote/注入路径、抽屉 markdown 渲染、预览面板与内联位置降级、异步投影句柄与旧运行时拒绝。
- **发版约定**：`package.json` 的 `version` 与 tag 同名（`0.10.0` ↔ `v0.10.0`）。修 bug 升 patch，加功能升 minor；安装 spec 始终写 `#vX.Y.Z`，不要跟分支。
- **DSH 是 pre-stable**：插件用到的 `sessionProjections`（0.2.2 起为异步注册，启动时 `await` 并持有句柄）、`storageDomain`、`tools.register`、`userQuestions.askTimed`、`agent/pre-step`、`fs`、Typert Remote 都是当前运行时接口。升级 DSH 后先跑测试，再按「已知限制」里的清单做一次手工验收；接口有变时以 `PLAN.md` 里列出的源码锚点为准。
- **与 `dsh-compaction-tune` 正交**：它改的是预设里的压缩阈值/保留比例，本插件只读会话事件和 storage，并在 pre-step 只追加注入消息；两者可以同时装。要强制制造压缩来验收，可用它的 `node scripts/set-ratio.mjs 0.01 --retain 0.0005`，测完恢复原值。

### `0.10.0` 移除截断与省略：已挂载 = 全文送达

- **为什么要删**：上一版的行为是「超过 `maxCharsPerPlan` / `maxCharsPerNote` 就砍尾并留标记，超过 `maxCharsPerFile` 干脆不读全，超过 `maxTotalChars` 就整段不发只在尾部列 id」。而核实后的事实是：`context_guard` 只有 `list`/`add_file`/`add_note`/`mount`/`unmount`，**没有任何读回全文的动作**（`content()` 只在 Remote 上给抽屉用）；计划正文原本只存在于那条 `exit_plan_mode` 的 `tool/call` arguments 里，备注只存在于 `add_note` 的参数里，而压缩正是把它们从 surface 换掉的机制。所以压缩之后注入块就是**唯一副本**，砍掉的后半在模型的世界里根本不存在。连「文件可以让模型自己 Read」也不成立：平台自带 `read` 工具默认 `READ_MAX_BYTES = 50KB`、单行 `2000` 字符。pin 这个动作本身就是「这必须完整在场」的声明，插件没有立场替它削减。
- **删了什么**：`planDocument` 的 65536 存储上限、`planSectionText` / `noteSectionText` / `itemBodyText` 的三处砍尾与 `[plan-guard: … truncated at …]` 标记、`readStoredFile` 的 `readTextCapped(…, maxCharsPerFile)`（改 `fs.readText` 整读）、`composeGuardText` 与 `composeUpdate` 里的预算累加、`omitted` 列表与 `[plan-guard: omitted over the total cap: …]` 行、`addNote` 对超长备注的拒绝、`validateToolArgs` 对 `add_note` 文本的上限、`state().limits` 里的四个字段、抽屉备注 textarea 的 `maxLength` 与「已截断」徽标。
- **顺带消失的两个毛病**：0.9.0 里「提示行说正文在下面，正文却被预算挤掉」的自相矛盾（不再有挤掉）；以及「只改 `maxCharsPerFile` 之后的尾部不算改动」（`seenDigest` 现在覆盖完整正文，尾部改动也会重发）。
- **配置兼容**：四个字段进 `DEPRECATED_CONFIG_FIELDS`，`validateConfig` 不再报「unknown config field」、也不写进 resolved；`apply` 检测到就 `logger.warn` 一次。这样老 profile 不会像 0.2.0 那次因字段名直接激活失败。
- **保留的两处「预览」**：`previewChars` 只管 `add_file` 返回值和权限卡片给人看的那一眼，卡片文案明确写「卡片预览，存储与注入的都是全文」；`maxItems`（默认 0 = 不限）本来就是拒绝式而非削减。
- **代价（写进已知限制）**：没有任何大小闸门了。挂载 5MB 文本就是把 5MB 送进上下文，并且 `fs.readText` 在本地后端没有体积护栏（只有 `readBytes(..., maxBytes)` 会抛 `FS_TOO_LARGE`），整份会进 Host 进程内存；压缩会更频繁、历史更快被摘要——但守护内容不丢，每次压缩后仍全文重发。
- 投影 `stateVersion 4 → 5`：被旧 64k 上限存成截断副本的缓存行整表重折，从会话日志恢复全文；storage record 仍为 version 2。
- 测试：77 个用例（新增 160k 文件全文注入、70k 备注全文注入、80k 计划投影与注入全文、四个废弃字段被忽略且 warn 一次、快照与增量里 grep 不到 truncat/omit 标记、抽屉无 `maxLength` 无截断徽标；移除旧的总上限省略与截断标记断言）。

### `0.9.0` 修「没批准也挂载」+ 挂载文件自动更新（结论改读正文与 `plan/mode`）

- **根因**：0.4.0–0.8.0 用 `tool/result` 的 `isError` 判批准，但当前 `dsh-plan-mode` 把通过与拒绝都渲染成**成功**结果（`lib/index.js:257` 只换正文：`Plan approved — plan mode exited; …` / `The user dismissed the plan review to reply in their own words; plan mode remains active.`），`isError` 恒为 `false` → 被驳回的计划折叠成 `accepted: true`，再叠上 `doc.accepted !== false` 这条 fail-open 判定，任何计划都会在首次压缩后被自动挂载。真实日志实证：会话 `session-40d81a8e…` seq 1222/1223 被拒、seq 1271/1272+1274 批准，而投影缓存 `plan-guard-docs` 行把两者都记成 `accepted: true`。单元测试当时用的是手造扁平事件 + `isError: true` + 旧文案，所以没暴露。
- **判定重写**：新增纯函数 `planVerdict(data)`——先读嵌套 `data.message` 回退扁平（兼容旧日志）；`isError === true` 直接算拒绝；否则按正文关键词判 `dismissed` / `Plan approved`；认不出来返回 `undefined`。正文认不出时记下 `awaitingVerdict`，若紧接着出现 `plan/mode {active:false}`（批准才有的结构标记，实测在 result 之后、下一个 step 的 `pre-step` 落账）结算为批准；中间出现 `tool/call` / `tool/ptc-dispatch-start` / `user/message` / `command/run` 则撤销归因，结论停在「未确认」。
- **PTC 派发也有结论了**：`run_code` 子调用的结果写在 `tool/ptc-dispatch`（按 `subCallId` 配对，见 `dsh-tool-executor-ptc/src/ptc.ts:560-573`），此前 fold 完全不认，导致 PTC 提交的计划永远「未知 → 被 fail-open 当成批准」。
- **fail-closed**：`effectivePlanState` 的自动挂载资格改为 `doc.accepted === true`。被拒与未确认的计划只展示、不自动挂载；人类显式挂载照旧优先。投影 `stateVersion 3 → 4`，重启后旧缓存整表重折，历史误判一次性结算；storage 记录仍是 version 2，0.8.0 读新记录只会忽略新字段（可降级）。
- **挂载文件自动更新**：文件条目新增记账字段 `seenVersion` / `seenDigest` / `seenAt`（`normalizeItemStrict` 白名单保留，否则 storage 读回时被抹掉）；`observeFileChanges` 每步对挂载文件做一次 `fs.stat`（版本 = `dev:ino:size:mtimeNs:ctimeNs`），版本没动就零读盘；动了才读正文并比对 sha256，确实不同才记 `pending.changed` 并在增量里重发 `## File: <path> (changed)` 全文 + 一行「以本次为准」。`touch`、重写同内容、越出 `maxCharsPerFile` 的尾部改动都不打扰模型；文件缺失先报一次 `file unreadable`，之后停在 `missing` 记账不重复。config 加 `refreshChangedFiles`（默认 `true`）。
- **pending 日记加第三桶 `changed`**：与 `added`/`removed` 互抵（新增未送达时改动不重复记；卸载吃掉改动记录），仍受 200 条上限。盖章只在消息真的注入后随清账一次写入（`deliver`），失败的 step 下个 step 自愈。
- **可见性**：抽屉计划行新增「结论未确认 / Verdict unconfirmed」标记，文件条目在待送达改动时标「磁盘已改动 / Changed on disk」；`context_guard list` 输出同步（`rejected; never auto-mounts` / `verdict unconfirmed; never auto-mounts` / `changed on disk; its current content is sent on the next step`）；工具描述与快照头去掉「只要没被拒」的说法，改为「只有明确批准的计划才会自动挂载」并说明 `(changed)` 段覆盖旧正文。
- **离线重放验收**：把本机 30 个真实会话日志逐事件喂给新 fold——12 份计划、批准 10 / 拒绝 2 / 未确认 0，与旧 fold 相比恰好 2 处由 `true` 翻成 `false`（会话 `session-ca9aa2…` 与 `session-40d81a8e…` 各一份被驳回的计划，正文均为 `The user dismissed the plan review…`）。
- 测试：72 个用例（新增当前运行时拒绝形状、PTC 结论、`plan/mode` 佐证与撤销、未确认不自动挂载、`changed` 桶合并、`(changed)` 段、文件改动端到端与读盘计数、缺失只报一次、开关关闭、抽屉新标记）。

### `0.8.0` 追的是 DSH `0.2.2-rc.5`（root 判定、条目上限、完整备注卡片）

- **移除 `ctx.agents.roots()`**：0.2.2-rc.5 的 `Agent` 只剩 `id`；root/subagent 改用
  `agent.session.header.origin === 'subagent'` 判断。`agent/created` 只对子代理
  `tools.restrict`，工具执行时再兜底拒绝；行为与 0.7.0 相同，只是不再依赖已删除的 API。
- **条目数量上限默认取消**：`maxItems` 默认从 24 改为 0（不限），抽屉中文显示「N 条（不限）」、英文显示 `N items (no limit)` 并按单复数切换；
  仍可在 config 里设 `maxItems > 0` 保留上限。storage 记录格式不变，已有数据无需迁移。
- **权限问题卡片展示完整备注**：去掉 `permissionQuestion()` 的 500 字符截断，按
  `maxCharsPerNote` 完整展示备注并提示可在卡片内滚动；内置问题卡片本身即可滚动，之前
  「看不全」是内容被截断，而不是滚动容器缺失。内容超过 1000 字符时，卡片顶部额外提示
  允许 / 拒绝按钮在正文之后。文件仍只预览前 `previewChars` 个字符，但卡片现在会写明文件
  字节数、标记截断，并说明这是预览而非全文。
- **抽屉单位修正**：文件条目按字节显示，备注按字符显示；英文「不限」计数补上
  `no limit` 并区分单复数。
- 测试：57 个用例（新增 root 判定、子代理拒绝、完整备注、文件预览截断、完整预览、默认 25 条、
  显式上限、抽屉不限计数与单复数）。

### `0.7.0` 追的是 DSH `0.2.2-rc.1`（投影注册改为异步句柄）

DSH 0.2.2 把 `ctx.sessionProjections.register()` 改成异步：返回值从「裸 disposer」变成带 `then` 的
`ProjectionHandle`，官方要求插件启动时 `await` 并**持有**句柄，读状态用 `handle.stateOf(session)`；
旧的 `ctx.sessionProjections.stateOf(session, key)` 已标 deprecation（首次读取会在 Host 日志里打 warning）。

- `apply` 现在 `await` 注册、先校验句柄再发布 service/tool/listener；注册仍是本 fiber 的 effect，
  卸载自动释放，句柄保留可继续折叠新事件。
- 4 处状态读取从 registry 级 `stateOf(session, key)` 改为 `planProjection.stateOf(session)`；
  投影 key、`stateSchema`、`stateVersion: 3` 与 storage 记录格式都没变，**已有数据无需迁移**。
- 兼容性护栏：若 `register()` 解析出的不是句柄（旧运行时返回裸 disposer），`apply` 直接抛
  「requires DSH 0.2.2-rc.1 or newer」，不会静默把所有会话读成空。
- 测试：假 `sessionProjections` 改为异步句柄，新增一条「非句柄即拒绝」的回归用例（48 个）。
- Client 无需改动：`sidebarRightTabs` / `slots` / `resources` / `remote.$mount` / Typert 描述符在
  0.2.2 均未变。

### `0.6.2` 预览紧跟条目 + 内容面板化

纯 Client 改动，Host 不动。展开的预览从 section 末尾移到**展开条目正下方**：`PlanRow`/`ItemRow` 外层改成 `.pg-entry`，内部固定「卡片 → 预览」，浏览长列表时不再跳到列表底部。标题加展开箭头与 `aria-expanded`，预览头右侧常驻「收起」按钮，收起后焦点回到条目标题。

预览不再像 hint：面板用 `.5px` `border-l2` + 2px 商务蓝左边线 + `bg-layer-2`，正文 `label-primary`；`MarkdownText` 去掉 `compact` 变体（它自带的 `color: label-tertiary` 正是深灰观感的来源），改用与阅览器一致的默认版式，再用 `.pg-previewBody` 收窄段落/标题间距；纯文本降级去掉重复边框。正文区 `max-height: 360px` 自滚动（原生滚动条 + stable gutter），抽屉根仍整体滚动。另修快速切换条目时旧请求结果短暂串台（请求序号 + `content.id` 双重校验）。

### `0.6.1` 修复 `add_file` 在新 runtime 不可用

`workingDirectory` 服务在当前 DSH 里整个删除了（类型表里一个引用都不剩），`prepareFile` 的 `wd.ensure` 对谁都抛错。改读 live `Session.header.cwd`（`dsh-session` 实证：`Session.header` 恒存在，`cwd` 是会话创建时的绝对工作区）。会话无 cwd 时报明确错误而不是服务缺失。

### `0.6.0` 抽屉预览 markdown 渲染 + 文件项一键进自带阅览器

纯 Client 改动，Host 不动。展开 plan/备注/文件时，内容区改用共享组件 `MarkdownText`（`dsh-client-ui-primitives`，正是文档阅览器用的 GFM + TeX 渲染，自动去掉 raw HTML 与不安全协议）渲染，`compact` 变体适配抽屉窄栏；文件行多一个"在阅览器中打开"按钮，经 tab slot 的 `useTabInfo` → `tab.actions.openResource(fileAddressFor(sessionId, undefined, item.path))` 在侧边栏开内置文档 tab。自带阅览器只认 `dsh-resource://file/**` 文件地址，plan/备注是虚拟文本所以只做内联渲染（不写临时文件、不污染工作区）。新增的两个 require 都有多个 shipped bundle 在用，工厂里 `try/catch` 可选加载——缺包时退回纯文本 `<pre>`、无按钮，抽屉不白屏。

### `0.5.1` 修复 v4 日志下 verdict 折叠（拒绝的 plan 真的不再 mount）

0.4.0–0.5.0 的 verdict 分支读扁平 `data.toolCallId` / `data.isError`，但 v4 会话日志里 `tool/result` 把结论包在 `data.message` 里（`{turn, step, message: {toolCallId, content, isError, …}}`），顶层没有这两个字段——生产环境里结论从未折叠成功，被拒的 plan 照样自动挂载（本会话 seq 2382/2383/2386 实证；0.3.1 被拒计划在 seq 1547 被注入是同一病因）。0.5.1 先读 `data.message`、缺失回退扁平形状（兼容旧日志与旧测试），接受/拒绝判定逻辑不变，复合 id（`call_X|fc_X`）两侧逐字相同、严格相等即可匹配。投影 `stateVersion 2 → 3`，重启后旧缓存重折、历史结论一次性结算；storage 记录结构不变（仍是 version 2）。

### `0.5.2` 修复抽屉无纵向滚动条

宿主 tab 体是 `height: 100%` + `overflow: hidden`（`dsh-client-ui-sidebar-right` 实证），内容区必须自己滚动——之前 `.pg-root` 没有高度约束也没有 overflow，超长直接被裁掉且永远不出滚动条。照抄 files tab 的配方：`flex: auto` 撑满 + `min-height: 0` + `overflow: auto` + `scrollbar-gutter: stable`，滚动条就是原生/自带的那个，不自绘。

### `0.5.0` 新自动计划顶掉旧自动计划 + 权限下拉原生菜单化

pre-step 注入器在早退前先跑内部 `syncAutoPlans`：新批准计划自动挂载时记 `added`（全文下一步送达），上一个自动计划记 `removed`（一行 `Plan "…" (<callId>) is no longer guarded.`）；人类显式选择一律不碰，pinned 条目不动，权限不问。记录多一个可选字段 `autoPlan`（version 不 bump，缺失按 null 计）。权限下拉把原生 `<select>`（弹窗 OS 渲染、CSS 够不着）换成自绘 button + 弹窗，照抄官方 Menu 的 token（卡片 `radius-lg` + `menu-surface-fill` + `elevation-prominent`，行 34px + hover/focus 同填充，选中行尾对勾），Esc/箭头/回车全键盘可用，不新增 require。

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
