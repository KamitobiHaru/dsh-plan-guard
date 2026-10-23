/**
 * dsh-plan-guard Client half: the "Guarded context" drawer as a right-sidebar
 * tab, backed by the `plan-guard` Host Remote namespace and a self-refreshing
 * `dsh-resource://plan-guard-drawer/<sessionId>` resource.
 *
 * Plain-JS UI plugin (window.__ModuleLoader__ module): React comes from the
 * browser module table; behavior reaches the components through the inject
 * face, never through ctx.
 * @module dsh-plan-guard/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plan-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PLUGIN_ID = 'dsh-plan-guard'
    const TAB_KIND = 'plan-guard-drawer'
    const LOCALE_NS = 'plan-guard'
    const REMOTE_NS = 'plan-guard'

    const POLICY_OPTIONS = [
      { value: 'ask', key: 'policy.ask' },
      { value: 'allow-mount', key: 'policy.allowMount' },
      { value: 'allow-unmount', key: 'policy.allowUnmount' },
      { value: 'allow-all', key: 'policy.allowAll' },
      { value: 'deny-all', key: 'policy.denyAll' },
    ]

    /** UI copy; the plugin manager additionally reads locale/*.json meta from disk. */
    const DICTS = {
      en: {
        'meta.title': 'Guarded context',
        'meta.description': 'Pin plans, notes, and files so they stay model-visible after context compaction.',
        'drawer.title': 'Guarded context',
        'guide.title': 'Guarded context',
        'guide.description': 'Open the guarded-context drawer for this Session.',
        'common.loading': 'Loading…',
        'common.failed': 'Guarded context failed to load.',
        'common.unavailable': 'This Session is not live in the Host. Resume it to manage guarded context.',
        'policy.label': 'Model permission',
        'policy.hint': 'Applies to model actions only. You can always change guarded context yourself.',
        'policy.ask': 'Ask every time',
        'policy.allowMount': 'Allow mounting',
        'policy.allowUnmount': 'Allow unmounting',
        'policy.allowAll': 'Allow everything',
        'policy.denyAll': 'Do not allow',
        'request.hint': 'When a model action needs permission, a question appears in the conversation.',
        'compaction.hint': 'Mounted content is re-injected after the next successful context compaction.',
        'plans.section': 'Plans',
        'plans.empty': 'No plan documents yet. Submit a plan and it will appear here.',
        'plans.auto': 'Auto',
        'plans.awaiting': 'Auto after first compaction',
        'plans.followAuto': 'Follow auto',
        'plans.explicitMounted': 'Mounted by you',
        'plans.explicitUnmounted': 'Unmounted by you',
        'plans.notAuto': 'Not auto-mounted',
        'plans.userControlled': 'User-controlled',
        'plans.size': '{chars} chars',
        'plans.mountHint': 'Mount this plan',
        'plans.unmountHint': 'Unmount this plan',
        'plans.expand': 'Show plan',
        'plans.collapse': 'Hide plan',
        'items.section': 'Pinned items',
        'items.kindFile': 'File',
        'items.kindNote': 'Note',
        'items.expand': 'Show content',
        'items.collapse': 'Hide content',
        'items.empty': 'No pinned notes or files yet.',
        'items.limit': '{count} of {max} items',
        'items.mounted': 'Mounted',
        'items.unmounted': 'Unmounted',
        'items.locked': 'Locked',
        'items.unlocked': 'Unlocked',
        'items.lock': 'Lock',
        'items.unlock': 'Unlock',
        'items.delete': 'Delete',
        'items.deleteConfirm': 'Confirm delete',
        'items.cancel': 'Cancel',
        'items.addedByHuman': 'human',
        'items.addedByModel': 'model',
        'items.meta': '{state} · added by {by} · {size} chars',
        'items.lockHint': 'A locked item cannot be mounted or unmounted by the model.',
        'items.deleteHint': 'Deleting removes the item for good. Only you can delete items.',
        'items.mountHint': 'Mount this item',
        'items.unmountHint': 'Unmount this item',
        'items.contentError': 'This content could not be read:',
        'add.note': 'Add note',
        'add.file': 'Add file',
        'add.noteTitle': 'Title',
        'add.noteText': 'Note',
        'add.filePath': 'Workspace path',
        'add.submit': 'Add and mount',
        'add.cancel': 'Cancel',
        'add.titlePlaceholder': 'Optional title',
        'add.notePlaceholder': 'An important constraint that should survive compaction…',
        'add.filePlaceholder': 'src/important.md',
        'content.loading': 'Loading content…',
        'content.failed': 'Content failed to load.',
        'content.truncated': 'truncated',
        'content.unavailable': 'No content.',
        'row.error': 'The change failed:',
      },
      zh: {
        'meta.title': '上下文守护',
        'meta.description': '守护计划、备注与文件，让它们在上下文压缩后继续可见。',
        'drawer.title': '上下文守护',
        'guide.title': '上下文守护',
        'guide.description': '打开当前会话的守护上下文抽屉。',
        'common.loading': '正在加载……',
        'common.failed': '守护上下文加载失败。',
        'common.unavailable': '该会话当前不在宿主中运行。恢复会话后即可管理守护上下文。',
        'policy.label': '模型权限',
        'policy.hint': '只约束模型动作；你本人始终可以修改守护上下文。',
        'policy.ask': '每次询问',
        'policy.allowMount': '允许挂载',
        'policy.allowUnmount': '允许卸载',
        'policy.allowAll': '允许全部',
        'policy.denyAll': '不允许',
        'request.hint': '模型动作需要权限时，对话中会出现一个问题卡片。',
        'compaction.hint': '已挂载内容会在下一次成功压缩后重新注入。',
        'plans.section': '计划',
        'plans.empty': '还没有计划文档。提交一个计划后就会出现在这里。',
        'plans.auto': '自动',
        'plans.awaiting': '首次压缩后自动挂载',
        'plans.followAuto': '恢复自动',
        'plans.explicitMounted': '由你挂载',
        'plans.explicitUnmounted': '由你卸下',
        'plans.notAuto': '不自动挂载',
        'plans.userControlled': '人类控制',
        'plans.size': '{chars} 字符',
        'plans.mountHint': '挂载这份计划',
        'plans.unmountHint': '卸下这份计划',
        'plans.expand': '展开计划',
        'plans.collapse': '收起计划',
        'items.section': '已固定条目',
        'items.kindFile': '文件',
        'items.kindNote': '备注',
        'items.expand': '展开内容',
        'items.collapse': '收起内容',
        'items.empty': '还没有固定的备注或文件。',
        'items.limit': '{count}/{max} 条',
        'items.mounted': '已挂载',
        'items.unmounted': '未挂载',
        'items.locked': '已锁定',
        'items.unlocked': '未锁定',
        'items.lock': '锁定',
        'items.unlock': '解锁',
        'items.delete': '删除',
        'items.deleteConfirm': '确认删除',
        'items.cancel': '取消',
        'items.addedByHuman': '人类',
        'items.addedByModel': '模型',
        'items.meta': '{state} · 由{by}添加 · {size} 字符',
        'items.lockHint': '锁定后模型不能挂载或卸载该条目。',
        'items.deleteHint': '删除会永久移除该条目；只有人类可以删除。',
        'items.mountHint': '挂载这个条目',
        'items.unmountHint': '卸载这个条目',
        'items.contentError': '无法读取该内容：',
        'add.note': '添加备注',
        'add.file': '添加文件',
        'add.noteTitle': '标题',
        'add.noteText': '备注',
        'add.filePath': '工作区路径',
        'add.submit': '添加并挂载',
        'add.cancel': '取消',
        'add.titlePlaceholder': '可选标题',
        'add.notePlaceholder': '一条需要在压缩后继续保留的重要约束……',
        'add.filePlaceholder': 'src/important.md',
        'content.loading': '正在读取内容……',
        'content.failed': '内容加载失败。',
        'content.truncated': '已截断',
        'content.unavailable': '没有可显示的内容。',
        'row.error': '修改失败：',
      },
    }

    /** Localized theme-token styles; literal colors are fallbacks only. */
    const styles = {
      container: {
        display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 14px',
        fontSize: 13, lineHeight: 1.45, color: 'var(--dsw-alias-text-primary, inherit)',
      },
      header: { display: 'flex', flexDirection: 'column', gap: 6 },
      title: { margin: 0, fontSize: 14, fontWeight: 600 },
      hint: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-text-secondary, inherit)' },
      section: { display: 'flex', flexDirection: 'column', gap: 6 },
      sectionTitle: {
        margin: 0, fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.04em', color: 'var(--dsw-alias-text-secondary, inherit)',
      },
      row: {
        display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 0',
        borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.2))',
      },
      rowBody: { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 },
      rowTitle: {
        margin: 0, padding: 0, border: 0, background: 'none', color: 'inherit',
        font: 'inherit', fontWeight: 500, textAlign: 'left', cursor: 'pointer', overflowWrap: 'anywhere',
      },
      meta: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, inherit)' },
      path: {
        fontSize: 11, color: 'var(--dsw-alias-text-secondary, inherit)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all',
      },
      controls: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      badge: {
        fontSize: 10, padding: '1px 6px', borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.3))',
        color: 'var(--dsw-alias-text-secondary, inherit)', whiteSpace: 'nowrap',
      },
      button: {
        padding: '3px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-secondary, transparent)', color: 'inherit', font: 'inherit', cursor: 'pointer',
      },
      danger: {
        borderColor: 'var(--dsw-alias-border-danger, #b45353)',
        color: 'var(--dsw-alias-text-danger, #b45353)',
      },
      select: {
        padding: '3px 6px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-secondary, transparent)', color: 'inherit', font: 'inherit',
      },
      input: {
        boxSizing: 'border-box', width: '100%', padding: '5px 7px', borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-secondary, transparent)', color: 'inherit', font: 'inherit',
      },
      textarea: {
        boxSizing: 'border-box', width: '100%', minHeight: 72, resize: 'vertical', padding: '5px 7px', borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-secondary, transparent)', color: 'inherit', font: 'inherit',
      },
      form: {
        display: 'flex', flexDirection: 'column', gap: 6, padding: 8,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.25))', borderRadius: 8,
      },
      note: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-text-secondary, inherit)' },
      error: {
        margin: 0, padding: '6px 8px', borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap',
        border: '1px solid var(--dsw-alias-border-danger, #b45353)',
        color: 'var(--dsw-alias-text-danger, #b45353)',
      },
      document: {
        margin: 0, padding: 8, maxHeight: 320, overflow: 'auto', borderRadius: 6,
        background: 'var(--dsw-alias-bg-secondary, transparent)',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.25))',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12,
      },
      switch: (on) => ({
        position: 'relative', width: 30, height: 17, flex: '0 0 auto', padding: 0, borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.4))',
        background: on ? 'var(--dsw-alias-accent, #3b7f5f)' : 'transparent', cursor: 'pointer',
      }),
      knob: (on) => ({
        position: 'absolute', top: 2, left: on ? 15 : 2, width: 11, height: 11, borderRadius: 999,
        background: on ? 'var(--dsw-alias-bg-primary, #fff)' : 'var(--dsw-alias-text-secondary, rgba(127,127,127,0.7))',
        transition: 'left 120ms ease',
      }),
    }

    const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

    const RESOURCE_SCHEME = 'dsh-resource://'

    /** The one drawer resource address for a session. */
    const drawerAddress = (sessionId) => `${RESOURCE_SCHEME}${TAB_KIND}/${encodeURIComponent(sessionId)}`

    const sessionIdOfAddress = (address) => {
      const prefix = `${RESOURCE_SCHEME}${TAB_KIND}/`
      if (typeof address !== 'string' || !address.startsWith(prefix)) return undefined
      try { return decodeURIComponent(address.slice(prefix.length)) } catch (_error) { return undefined }
    }

    /** A resource frame may be the raw RemoteResult or its already-unwrapped value. */
    const unwrapFrame = (value) => (isRecord(value) && value.ok === true && isRecord(value.value) ? value.value : value)

    /** The drawer resource: list once, then refresh on a fixed interval until released. */
    function openDrawerResource(remote, address, { signal }) {
      const sessionId = sessionIdOfAddress(address)
      if (sessionId === undefined) {
        return (async function* once() {
          yield { ok: false, error: { code: 'malformed', message: `plan-guard drawer address "${address}" names no session` } }
        })()
      }
      return (async function* polling() {
        const wait = (ms) => new Promise((resolve) => {
          const timer = setTimeout(resolve, ms)
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
        })
        while (!signal.aborted) {
          let frame
          try {
            const result = await remote.list(sessionId)
            frame = result?.ok === true ? result : { ok: false, error: result?.error ?? { code: 'carrier', message: 'list failed' } }
          } catch (error) {
            frame = { ok: false, error: { code: 'carrier', message: String(error) } }
          }
          yield frame
          await wait(3000)
        }
      })()
    }

    // The browser module table seeds React but not zod. Strict codecs therefore
    // carry small hand-written parsers: the Client only checks mode, typeSymbol,
    // and create when mounting, while the Host validates arguments against its
    // own descriptors. Keeping create() honest costs little and avoids a
    // client-only dependency that cannot be resolved at runtime.
    const strictCodec = (typeSymbol, jsonSchema, schema) => ({
      mode: 'strict',
      typeSymbol,
      jsonSchema,
      create: () => schema,
    })
    const stringCodec = (minLength) => strictCodec(
      'dsh-plan-guard#String',
      minLength > 0 ? { type: 'string', minLength } : { type: 'string' },
      {
        parse(value) {
          if (typeof value !== 'string' || value.length < minLength) {
            throw new Error(`expected a string with at least ${minLength} character(s)`)
          }
          return value
        },
      },
    )
    const booleanCodec = strictCodec(
      'dsh-plan-guard#Boolean',
      { type: 'boolean' },
      {
        parse(value) {
          if (typeof value !== 'boolean') throw new Error('expected a boolean')
          return value
        },
      },
    )
    const enumCodec = (values) => strictCodec(
      'dsh-plan-guard#Policy',
      { type: 'string', enum: values },
      {
        parse(value) {
          if (!values.includes(value)) throw new Error(`expected one of ${values.join(', ')}`)
          return value
        },
      },
    )
    const resultCodec = strictCodec(
      'dsh-plan-guard#Result',
      {},
      { parse: (value) => value },
    )

    const stringParameter = (name, minLength = 1) => ({
      name, wire: name, source: 'json', codec: stringCodec(minLength),
    })
    const plainStringParameter = (name) => ({
      name, wire: name, source: 'json', codec: stringCodec(0),
    })
    const booleanParameter = (name) => ({
      name, wire: name, source: 'json', codec: booleanCodec,
    })
    const enumParameter = (name, values) => ({
      name, wire: name, source: 'json', codec: enumCodec(values),
    })
    const remoteMethod = (method, parameters) => ({
      id: `${PLUGIN_ID}/plan-guard#${method}`,
      service: REMOTE_NS,
      namespace: REMOTE_NS,
      method,
      invocation: { kind: 'direct' },
      parameters,
      result: resultCodec,
    })
    const remoteContribution = {
      package: PLUGIN_ID,
      descriptors: [
        remoteMethod('list', [stringParameter('sessionId')]),
        remoteMethod('setPolicy', [stringParameter('sessionId'), enumParameter('policy', ['ask', 'allow-mount', 'allow-unmount', 'allow-all', 'deny-all'])]),
        remoteMethod('setPlan', [stringParameter('sessionId'), stringParameter('callId'), enumParameter('choice', ['mounted', 'unmounted', 'auto'])]),
        remoteMethod('addNote', [stringParameter('sessionId'), plainStringParameter('title'), stringParameter('text')]),
        remoteMethod('addFile', [stringParameter('sessionId'), stringParameter('path')]),
        remoteMethod('setMounted', [stringParameter('sessionId'), stringParameter('itemId'), booleanParameter('mounted')]),
        remoteMethod('setLock', [stringParameter('sessionId'), stringParameter('itemId'), booleanParameter('locked')]),
        remoteMethod('removeItem', [stringParameter('sessionId'), stringParameter('itemId')]),
        remoteMethod('content', [stringParameter('sessionId'), stringParameter('id')]),
      ],
    }

    /** Accessible native switch. */
    function Switch({ checked, busy, label, onChange }) {
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label,
        disabled: busy === true, style: styles.switch(checked),
        onClick: () => { if (busy !== true) onChange(!checked) },
      }, h('span', { style: styles.knob(checked) }))
    }

    function Badge({ children }) {
      return h('span', { style: styles.badge }, children)
    }

    function PlanRow({ plan, busy, expanded, onToggle, onAuto, onExpand, t }) {
      let stateLabel
      if (plan.explicit === 'mounted') stateLabel = t('plans.explicitMounted')
      else if (plan.explicit === 'unmounted') stateLabel = t('plans.explicitUnmounted')
      else if (plan.auto) stateLabel = t('plans.auto')
      else if (plan.awaitingCompaction) stateLabel = t('plans.awaiting')
      else stateLabel = t('plans.notAuto')
      return h('div', { style: styles.row },
        h(Switch, {
          checked: plan.mounted, busy,
          label: t(plan.mounted ? 'plans.unmountHint' : 'plans.mountHint'),
          onChange: onToggle,
        }),
        h('div', { style: styles.rowBody },
          h('button', {
            type: 'button', style: styles.rowTitle, title: t(expanded ? 'plans.collapse' : 'plans.expand'),
            onClick: onExpand,
          }, plan.title),
          h('div', { style: styles.meta },
            `${stateLabel} · ${t('plans.size').replace('{chars}', String(plan.size))}`
            + (typeof plan.turn === 'number' ? ` · turn ${plan.turn}` : '')),
          h('div', { style: styles.controls },
            h(Badge, {}, t('plans.userControlled')),
            plan.explicit !== null && plan.autoEligible
              ? h('button', { type: 'button', style: styles.button, disabled: busy, onClick: onAuto }, t('plans.followAuto'))
              : null,
          ),
        ),
      )
    }

    function ItemRow({ item, busy, expanded, deleteConfirm, onToggle, onLock, onDelete, onConfirmDelete, onCancelDelete, onExpand, t }) {
      const by = item.createdBy === 'human' ? t('items.addedByHuman') : t('items.addedByModel')
      const meta = t('items.meta')
        .replace('{state}', item.mounted ? t('items.mounted') : t('items.unmounted'))
        .replace('{by}', by)
        .replace('{size}', String(item.size))
      return h('div', { style: styles.row },
        h(Switch, {
          checked: item.mounted, busy,
          label: t(item.mounted ? 'items.unmountHint' : 'items.mountHint'),
          onChange: onToggle,
        }),
        h('div', { style: styles.rowBody },
          h('button', {
            type: 'button', style: styles.rowTitle, title: t(expanded ? 'items.collapse' : 'items.expand'),
            onClick: onExpand,
          }, item.title),
          item.kind === 'file' && item.path !== null ? h('div', { style: styles.path }, item.path) : null,
          h('div', { style: styles.meta }, meta),
          h('div', { style: styles.controls },
            h(Badge, {}, item.kind === 'file' ? t('items.kindFile') : t('items.kindNote')),
            h(Badge, {}, item.locked ? t('items.locked') : t('items.unlocked')),
            h('button', {
              type: 'button', style: styles.button, disabled: busy,
              'aria-pressed': item.locked, title: t('items.lockHint'),
              onClick: () => onLock(!item.locked),
            }, item.locked ? t('items.unlock') : t('items.lock')),
            deleteConfirm
              ? h('span', { style: styles.controls },
                h('button', { type: 'button', style: { ...styles.button, ...styles.danger }, disabled: busy, onClick: onConfirmDelete }, t('items.deleteConfirm')),
                h('button', { type: 'button', style: styles.button, disabled: busy, onClick: onCancelDelete }, t('items.cancel')),
              )
              : h('button', { type: 'button', style: styles.button, disabled: busy, title: t('items.deleteHint'), onClick: onDelete }, t('items.delete')),
          ),
        ),
      )
    }

    function ContentBlock({ content, t }) {
      if (content === undefined || content.status === 'loading') {
        return h('p', { style: styles.note }, t('content.loading'))
      }
      if (content.status === 'failed') {
        return h('p', { style: styles.error }, `${t('content.failed')} ${content.error ?? ''}`)
      }
      const value = content.value
      if (!isRecord(value)) return h('p', { style: styles.note }, t('content.unavailable'))
      if (value.error !== null && value.error !== undefined) {
        return h('p', { style: styles.error }, `${t('items.contentError')} ${value.error}`)
      }
      const meta = [value.kind, value.title, value.truncated === true ? t('content.truncated') : undefined]
        .filter(part => typeof part === 'string' && part !== '')
        .join(' · ')
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        meta === '' ? null : h('div', { style: styles.meta }, meta),
        h('pre', { style: styles.document }, String(value.text ?? '')),
      )
    }

    /** The drawer body: permission mode, plans, items, add forms, previews. */
    function Drawer(props) {
      const { sessionId, useResource, t, api } = props
      const resource = useResource(drawerAddress(sessionId))
      const [state, setState] = React.useState(undefined)
      const [busy, setBusy] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [expanded, setExpanded] = React.useState(undefined)
      const [content, setContent] = React.useState(undefined)
      const [addKind, setAddKind] = React.useState(undefined)
      const [noteTitle, setNoteTitle] = React.useState('')
      const [noteText, setNoteText] = React.useState('')
      const [filePath, setFilePath] = React.useState('')
      const [deleteConfirm, setDeleteConfirm] = React.useState(undefined)

      React.useEffect(() => {
        if (resource.status === 'live') setState(unwrapFrame(resource.value))
      }, [resource.status, resource.value])

      const callRemote = async (operation) => {
        const result = await operation()
        if (result?.ok !== true) {
          const reason = result?.error?.message ?? result?.error?.code ?? 'Remote call failed'
          throw new Error(String(reason))
        }
        return result.value
      }

      const run = async (key, operation) => {
        setBusy(key)
        setError(undefined)
        try {
          const value = await callRemote(operation)
          if (isRecord(value) && 'live' in value) setState(value)
          return { ok: true, value }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return { ok: false }
        } finally {
          setBusy(undefined)
        }
      }

      const onExpand = async (id) => {
        if (expanded === id) {
          setExpanded(undefined)
          setContent(undefined)
          return
        }
        setExpanded(id)
        setContent({ id, status: 'loading' })
        try {
          const value = await callRemote(() => api.readContent(id))
          setContent({ id, status: 'ready', value })
        } catch (failure) {
          setContent({ id, status: 'failed', error: failure instanceof Error ? failure.message : String(failure) })
        }
      }

      const submitNote = async () => {
        const result = await run('add-note', () => api.addNote(noteTitle, noteText))
        if (result.ok === true) {
          setNoteTitle('')
          setNoteText('')
          setAddKind(undefined)
        }
      }

      const submitFile = async () => {
        const result = await run('add-file', () => api.addFile(filePath))
        if (result.ok === true) {
          setFilePath('')
          setAddKind(undefined)
        }
      }

      if (resource.status === 'loading') return h('p', { style: styles.note }, t('common.loading'))
      if (resource.status === 'failed') {
        return h('p', { style: styles.error, role: 'status' },
          `${t('common.failed')} ${String(resource.failure?.message ?? '')}`)
      }
      if (resource.status === 'none') return h('p', { style: styles.note }, t('common.failed'))
      if (state === undefined) return h('p', { style: styles.note }, t('common.loading'))
      if (state.live === false) return h('p', { style: styles.note }, t('common.unavailable'))

      const plans = Array.isArray(state.plans) ? state.plans : []
      const items = Array.isArray(state.items) ? state.items : []
      const limits = isRecord(state.limits) ? state.limits : {}
      const policy = state.policy ?? state.defaultPolicy ?? 'ask'
      const noteMax = typeof limits.maxCharsPerNote === 'number' ? limits.maxCharsPerNote : 20000
      const itemMax = typeof limits.maxItems === 'number' ? limits.maxItems : 24
      const planRows = plans.slice().reverse().map(plan => h(PlanRow, {
        key: plan.callId,
        plan,
        t,
        busy: busy === `plan:${plan.callId}`,
        expanded: expanded === plan.callId,
        onToggle: value => { void run(`plan:${plan.callId}`, () => api.setPlan(plan.callId, value ? 'mounted' : 'unmounted')) },
        onAuto: () => { void run(`plan:${plan.callId}`, () => api.setPlan(plan.callId, 'auto')) },
        onExpand: () => { void onExpand(plan.callId) },
      }))
      const itemRows = items.map(item => h(ItemRow, {
        key: item.id,
        item,
        t,
        busy: busy === `item:${item.id}`,
        expanded: expanded === item.id,
        deleteConfirm: deleteConfirm === item.id,
        onToggle: value => { void run(`item:${item.id}`, () => api.setMounted(item.id, value)) },
        onLock: value => { void run(`item:${item.id}`, () => api.setLock(item.id, value)) },
        onDelete: () => setDeleteConfirm(item.id),
        onConfirmDelete: () => {
          void run(`item:${item.id}`, () => api.removeItem(item.id)).then(result => {
            if (result.ok === true) setDeleteConfirm(undefined)
          })
        },
        onCancelDelete: () => setDeleteConfirm(undefined),
        onExpand: () => { void onExpand(item.id) },
      }))

      const addForm = addKind === 'note'
        ? h('div', { style: styles.form },
          h('input', {
            style: styles.input, value: noteTitle, maxLength: 200,
            placeholder: t('add.titlePlaceholder'), 'aria-label': t('add.noteTitle'),
            onChange: event => setNoteTitle(event.target.value),
          }),
          h('textarea', {
            style: styles.textarea, value: noteText, maxLength: noteMax,
            placeholder: t('add.notePlaceholder'), 'aria-label': t('add.noteText'),
            onChange: event => setNoteText(event.target.value),
          }),
          h('div', { style: styles.controls },
            h('button', {
              type: 'button', style: styles.button,
              disabled: busy === 'add-note' || noteText.trim() === '',
              onClick: () => { void submitNote() },
            }, t('add.submit')),
            h('button', {
              type: 'button', style: styles.button, disabled: busy === 'add-note',
              onClick: () => { setAddKind(undefined) },
            }, t('add.cancel')),
          ),
        )
        : addKind === 'file'
          ? h('div', { style: styles.form },
            h('input', {
              style: styles.input, value: filePath, maxLength: 4096,
              placeholder: t('add.filePlaceholder'), 'aria-label': t('add.filePath'),
              onChange: event => setFilePath(event.target.value),
            }),
            h('div', { style: styles.controls },
              h('button', {
                type: 'button', style: styles.button,
                disabled: busy === 'add-file' || filePath.trim() === '',
                onClick: () => { void submitFile() },
              }, t('add.submit')),
              h('button', {
                type: 'button', style: styles.button, disabled: busy === 'add-file',
                onClick: () => { setAddKind(undefined) },
              }, t('add.cancel')),
            ),
          )
          : h('div', { style: styles.controls },
            h('button', {
              type: 'button', style: styles.button, disabled: busy !== undefined,
              onClick: () => { setAddKind('note'); setError(undefined) },
            }, t('add.note')),
            h('button', {
              type: 'button', style: styles.button, disabled: busy !== undefined,
              onClick: () => { setAddKind('file'); setError(undefined) },
            }, t('add.file')),
          )

      return h('div', { style: styles.container },
        error === undefined ? null : h('p', { style: styles.error, role: 'alert' }, `${t('row.error')} ${error}`),
        h('div', { style: styles.header },
          h('h2', { style: styles.title }, t('drawer.title')),
          h('div', { style: styles.controls },
            h('label', { style: styles.meta, htmlFor: 'plan-guard-policy' }, t('policy.label')),
            h('select', {
              id: 'plan-guard-policy', style: styles.select, value: policy, disabled: busy === 'policy',
              onChange: event => { void run('policy', () => api.setPolicy(event.target.value)) },
            }, POLICY_OPTIONS.map(option => h('option', { key: option.value, value: option.value }, t(option.key)))),
          ),
          h('p', { style: styles.hint }, t('policy.hint')),
          h('p', { style: styles.hint }, t('request.hint')),
          h('p', { style: styles.hint }, t('compaction.hint')),
        ),
        h('section', { style: styles.section },
          h('h3', { style: styles.sectionTitle }, t('plans.section')),
          plans.length === 0 ? h('p', { style: styles.note }, t('plans.empty')) : planRows,
          expanded !== undefined && plans.some(plan => plan.callId === expanded)
            ? h(ContentBlock, { content, t })
            : null,
        ),
        h('section', { style: styles.section },
          h('h3', { style: styles.sectionTitle },
            t('items.section'),
            ' ',
            h('span', { style: styles.meta }, t('items.limit').replace('{count}', String(items.length)).replace('{max}', String(itemMax))),
          ),
          items.length === 0 ? h('p', { style: styles.note }, t('items.empty')) : itemRows,
          expanded !== undefined && items.some(item => item.id === expanded)
            ? h(ContentBlock, { content, t })
            : null,
          addForm,
        ),
      )
    }

    /** Plain text chip for the tab title seat; the framework owns the chip itself. */
    function DrawerTitle({ t }) { return h('span', {}, t('drawer.title')) }

    /** The namespace service this plugin mounts for itself. */
    const REMOTE_DEPENDENCY = `remote.${REMOTE_NS}`

    /**
     * Register dictionaries, the drawer resource and tab kind, and both slot
     * seats. Runs inside an `ctx.inject` group because a namespace this plugin
     * mounts itself cannot also sit in the static `inject` list: activation
     * would wait on a service its own `apply` has not created yet, and reading
     * `ctx.remote[namespace]` outside an inject group throws.
     */
    function registerUi(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      const remote = ctx.remote[REMOTE_NS]

      ctx.effect(() => ctx.locale.register(LOCALE_NS, DICTS), 'dsh-plan-guard: dictionaries')
      ctx.effect(
        () => ctx.resources.register({
          protocol: TAB_KIND,
          open(address, openCtx) { return openDrawerResource(remote, address, openCtx) },
        }),
        'dsh-plan-guard: drawer resource',
      )
      ctx.effect(
        () => ctx.sidebarRightTabs.register({
          id: PLUGIN_ID,
          kind: TAB_KIND,
          title: () => t('drawer.title'),
          guide: [{
            id: 'guarded-context',
            order: 20,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
          }],
        }),
        'dsh-plan-guard: sidebar tab type',
      )
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: PLUGIN_ID, locale: LOCALE_NS,
        inject: sessionId => ({
          api: {
            list: () => remote.list(sessionId),
            setPolicy: policy => remote.setPolicy(sessionId, policy),
            setPlan: (callId, choice) => remote.setPlan(sessionId, callId, choice),
            addNote: (title, text) => remote.addNote(sessionId, title, text),
            addFile: path => remote.addFile(sessionId, path),
            setMounted: (itemId, mounted) => remote.setMounted(sessionId, itemId, mounted),
            setLock: (itemId, locked) => remote.setLock(sessionId, itemId, locked),
            removeItem: itemId => remote.removeItem(sessionId, itemId),
            readContent: id => remote.content(sessionId, id),
          },
        }),
      }, Drawer))
      ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title', key: PLUGIN_ID, locale: LOCALE_NS,
      }, DrawerTitle))
    }

    return {
      inject: ['slots', 'locale', 'resources', 'remote', 'sidebarRight', 'sidebarRightTabs'],
      __testables: { drawerAddress, sessionIdOfAddress },
      /** Mount the Remote namespace, then join the UI once that namespace is readable. */
      async apply(ctx) {
        const disposeRemote = await ctx.remote.$mount(remoteContribution)
        const ui = ctx.inject([REMOTE_DEPENDENCY, 'slots', 'locale', 'resources', 'sidebarRightTabs'], registerUi)
        try {
          await ui
        } catch (error) {
          await ui.dispose()
          await disposeRemote()
          throw error
        }
        return async () => {
          await ui.dispose()
          await disposeRemote()
        }
      },
    }
  },
})
