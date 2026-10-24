import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { test } from 'node:test'

/** Load the browser module the way the Client module table would. */
async function loadClientModule(seeded = {}, reactOverride = undefined) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let entry
  const window = {
    __ModuleLoader__: {
      load(value) { entry = value },
    },
  }
  const head = { children: [], appendChild(element) { this.children.push(element); return element } }
  const document = {
    querySelector(selector) {
      assert.equal(selector, 'style[data-plan-guard]')
      return head.children.find(element => element.attributes['data-plan-guard'] !== undefined) ?? null
    },
    createElement(tag) {
      return {
        tag,
        attributes: {},
        textContent: '',
        setAttribute(name, value) { this.attributes[name] = value },
        remove() {
          const index = head.children.indexOf(this)
          if (index >= 0) head.children.splice(index, 1)
        },
      }
    },
    head,
  }
  vm.runInContext(source, vm.createContext({ window, console, document }), { filename: 'client.js' })
  assert.equal(entry?.id, 'dsh-plan-guard')

  const elements = []
  const React = reactOverride ?? {
    createElement: (type, props, ...children) => {
      const element = { type, props: props ?? {}, children }
      elements.push(element)
      return element
    },
    useState: value => [value, () => {}],
    useEffect: () => {},
    useRef: value => ({ current: value }),
    useMemo: factory => factory(),
    useCallback: callback => callback,
    Fragment: 'Fragment',
  }
  const required = []
  const module = entry.factory((specifier) => {
    required.push(specifier)
    if (specifier === 'react') return React
    if (Object.hasOwn(seeded, specifier)) return seeded[specifier]
    throw new Error(`client module required an unseeded module: ${specifier}`)
  })
  return { module, required, head, elements }
}

/** Minimal Client context: enough of the registration surface for apply(). */
function fakeContext(captured) {
  const t = key => key
  const remote = new Proxy({}, { get: () => async () => ({ ok: true }) })
  const effect = (callback) => {
    const disposer = callback()
    const cleanup = typeof disposer === 'function' ? disposer : () => {}
    captured.effects.push(cleanup)
    return cleanup
  }
  const slots = {
    inject: (_name, callback) => callback(),
    register: definition => { captured.slots.push(definition); return () => {} },
  }
  const ctx = {
    locale: {
      bind: () => t,
      register: (namespace, dictionaries) => {
        captured.locale = { namespace, dictionaries }
        return () => {}
      },
    },
    remote: {
      $mount: async (contribution) => {
        captured.contribution = contribution
        return async () => {}
      },
      'plan-guard': remote,
    },
    resources: { register: definition => { captured.resources.push(definition); return () => {} } },
    sidebarRightTabs: { register: definition => { captured.tabs.push(definition); return () => {} } },
    slots,
    effect,
  }
  // Mirrors Cordis `ctx.inject(deps, callback)`: the group runs only once every
  // dependency is readable, and the returned fiber is awaitable and disposable.
  ctx.inject = (dependencies, callback) => {
    captured.injectGroups.push([...dependencies])
    const fiber = Promise.resolve(callback(ctx))
    fiber.dispose = async () => { captured.uiDisposed = true }
    return fiber
  }
  return ctx
}

const WIRE_NAME = /^[A-Za-z0-9_$.-]+$/

/** The checks `typert` applies to a hand-written strict descriptor. */
function assertStrictCodec(codec, subject) {
  assert.equal(codec.mode, 'strict', `${subject} must be strict`)
  assert.equal(typeof codec.typeSymbol, 'string', `${subject} needs a typeSymbol`)
  assert.ok(codec.typeSymbol.length > 0, `${subject} needs a nonempty typeSymbol`)
  assert.equal(typeof codec.jsonSchema, 'object', `${subject} needs a jsonSchema`)
  assert.equal(typeof codec.create, 'function', `${subject} needs a create() factory`)
  assert.equal(typeof codec.create().parse, 'function', `${subject} schema needs parse()`)
}

test('client module imports only seeded modules and mounts valid descriptors', async () => {
  const { module, required, head } = await loadClientModule()
  // The two platform modules are attempted and, unseeded here, degrade to the
  // plain-text preview without failing the entry (the try/catch in factory).
  assert.deepEqual(required, ['react', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-util-workspace-path'])
  assert.deepEqual([...module.inject], ['slots', 'locale', 'resources', 'remote', 'sidebarRight', 'sidebarRightTabs'])

  // Resource addresses must use the platform scheme; `<protocol>://` is not a
  // resource address and would leave `useResource` permanently unresolved.
  const { drawerAddress, sessionIdOfAddress } = module.__testables
  assert.equal(drawerAddress('a b'), 'dsh-resource://plan-guard-drawer/a%20b')
  assert.equal(new URL(drawerAddress('a b')).host, 'plan-guard-drawer')
  assert.equal(sessionIdOfAddress(drawerAddress('a b')), 'a b')
  assert.equal(sessionIdOfAddress('plan-guard-drawer://a'), undefined)

  const captured = { slots: [], resources: [], tabs: [], injectGroups: [], effects: [] }
  const disposeUi = await module.apply(fakeContext(captured))
  assert.equal(typeof disposeUi, 'function', 'apply must return the disposer joining UI and Remote')

  // The drawer installs its own token-based stylesheet once and removes it on unload.
  assert.equal(head.children.length, 1, 'exactly one stylesheet is installed')
  assert.match(head.children[0].textContent, /\.pg-root/)
  assert.match(head.children[0].textContent, /--dsw-alias-label-primary/)
  assert.match(head.children[0].textContent, /\.pg-menuTrigger/)
  assert.match(head.children[0].textContent, /\.pg-menuList/)
  assert.match(head.children[0].textContent, /\.pg-menuItem/)
  assert.match(head.children[0].textContent, /--dsw-menu-surface-fill/)
  assert.match(head.children[0].textContent, /--dsw-elevation-prominent/)
  assert.match(head.children[0].textContent, /--dsw-alias-interactive-bg-hover/)
  assert.ok(!head.children[0].textContent.includes('.pg-select'), 'the native select is gone')
  assert.ok(!head.children[0].textContent.includes('appearance: none'), 'no OS-popup styling hack remains')
  // The host tab body is height:100% + overflow:hidden, so the drawer root
  // must fill it and scroll itself (files-tab recipe); otherwise tall content
  // is clipped with no scrollbar.
  assert.match(head.children[0].textContent, /\.pg-root\s*\{[^}]*flex:\s*auto[^}]*\}/)
  assert.match(head.children[0].textContent, /\.pg-root\s*\{[^}]*min-height:\s*0[^}]*\}/)
  assert.match(head.children[0].textContent, /\.pg-root\s*\{[^}]*overflow:\s*auto[^}]*\}/)
  assert.match(head.children[0].textContent, /\.pg-root\s*\{[^}]*scrollbar-gutter:\s*stable[^}]*\}/)
  assert.ok(!('policy.hint' in captured.locale.dictionaries), 'the drawer carries no instructional copy')
  assert.ok(!('compaction.hint' in captured.locale.dictionaries))

  // The guide capsule draws its own glyph instead of the placeholder cube.
  assert.equal(typeof captured.tabs[0].guide[0].icon, 'function')


  // The plugin mounts its own Remote namespace, so that namespace can only be
  // readable inside a dynamic inject group. Joining it through the static
  // `inject` list instead would park the fiber on a service its own apply has
  // not created yet.
  assert.deepEqual(captured.injectGroups, [
    ['remote.plan-guard', 'slots', 'locale', 'resources', 'sidebarRightTabs'],
  ])
  assert.ok(!module.inject.includes('remote.plan-guard'), 'the self-mounted namespace stays out of the static inject list')

  const { contribution } = captured
  assert.equal(contribution.package, 'dsh-plan-guard')
  assert.equal(captured.locale.namespace, 'plan-guard')
  assert.equal(captured.tabs.length, 1)
  assert.equal(captured.tabs[0].kind, 'plan-guard-drawer')
  assert.equal(captured.resources.length, 1)
  assert.equal(captured.resources[0].protocol, 'plan-guard-drawer')
  assert.equal(new URL(drawerAddress('s1')).host, captured.resources[0].protocol)
  assert.equal(captured.slots.length, 2)

  const endpoints = new Set()
  for (const descriptor of contribution.descriptors) {
    assert.ok(descriptor.id.length > 0)
    assert.ok(!descriptor.service.includes('#'))
    assert.match(descriptor.namespace, WIRE_NAME)
    assert.match(descriptor.method, WIRE_NAME)
    assert.equal(descriptor.invocation.kind, 'direct')
    const endpoint = `${descriptor.namespace}/${descriptor.method}`
    assert.ok(!endpoints.has(endpoint), `duplicate endpoint ${endpoint}`)
    endpoints.add(endpoint)

    assertStrictCodec(descriptor.result, `${endpoint} result`)
    const wires = new Set()
    for (const parameter of descriptor.parameters) {
      assert.match(parameter.name, WIRE_NAME)
      assert.match(parameter.wire, WIRE_NAME)
      assert.ok(!wires.has(parameter.wire), `${endpoint} repeats wire ${parameter.wire}`)
      wires.add(parameter.wire)
      assert.equal(parameter.source, 'json')
      assertStrictCodec(parameter.codec, `${endpoint} parameter ${parameter.name}`)
    }
  }

  assert.equal(contribution.descriptors.length, 9)

  await disposeUi()
  assert.equal(captured.uiDisposed, true, 'the returned disposer drops the UI half')
  for (const dispose of captured.effects.reverse()) await dispose()
  assert.equal(head.children.length, 0, 'unloading removes the stylesheet')
})

/** Flatten recorded elements (arrays, component props excluded) for assertions. */
function flatElements(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) flatElements(child, out)
    return out
  }
  if (node !== null && typeof node === 'object' && 'type' in node) {
    out.push(node)
    flatElements(node.children, out)
  }
  return out
}

const viewerButtonOf = (tree) => flatElements(tree).filter(
  node => node.type === 'button' && Array.isArray(node.children) && node.children.includes('items.openViewer'),
)

test('preview is a content panel that renders shared markdown or plain text', async () => {
  const MarkdownText = () => null
  const seeded = await loadClientModule({
    '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText },
    '@deepseek-ai/dsh-util-workspace-path': { fileAddressFor: (sessionId, cwd, path) => `addr:${sessionId}:${path}` },
  })
  assert.deepEqual(seeded.required, ['react', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-util-workspace-path'])
  const { ContentBlock, ItemRow } = seeded.module.__testables
  const t = key => key
  const ready = {
    id: 'x',
    status: 'ready',
    value: { kind: 'note', title: 'T', text: '# Hi\nbody', truncated: false },
  }
  const markdown = {
    Text: MarkdownText,
    labels: { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' },
  }

  let collapses = 0
  const rendered = ContentBlock({ content: ready, t, markdown, onCollapse: () => { collapses += 1 } })
  const nodes = flatElements(rendered)
  assert.equal(nodes[0].props.className, 'pg-preview', 'the preview owns a bordered panel')
  assert.ok(nodes.some(node => node.type === 'span' && node.children.includes('preview.label')))
  const md = nodes.filter(node => node.type === MarkdownText)
  assert.equal(md.length, 1, 'the shared renderer owns the preview body')
  assert.equal(md[0].props.text, '# Hi\nbody')
  assert.equal(md[0].props.streaming, false)
  assert.equal(md[0].props.variant, undefined, 'the default reading variant keeps primary text')
  assert.deepEqual(md[0].props.labels, markdown.labels)
  assert.equal(nodes.filter(node => node.type === 'pre').length, 0)
  const toggle = nodes.find(node => node.type === 'button' && node.props.className === 'pg-previewToggle')
  assert.ok(toggle, 'the panel header owns an explicit collapse control')
  assert.ok(toggle.children.includes('preview.collapse'))
  toggle.props.onClick()
  assert.equal(collapses, 1)

  const loading = flatElements(ContentBlock({ content: undefined, t, markdown }))
  assert.equal(loading[0].props.className, 'pg-preview', 'loading keeps the panel shell')

  const fallback = ContentBlock({ content: ready, t, markdown: undefined })
  const fallbackNodes = flatElements(fallback)
  assert.equal(fallbackNodes[0].props.className, 'pg-preview')
  assert.equal(fallbackNodes.filter(node => node.type === 'pre').length, 1)
  assert.equal(fallbackNodes.filter(node => node.type === MarkdownText).length, 0)

  const fileItem = {
    kind: 'file', id: 'file:/a.md', title: 'a.md', path: '/repo/a.md',
    mounted: true, locked: false, createdBy: 'human', size: 3,
  }
  const rowProps = {
    item: fileItem, busy: false, expanded: false, deleteConfirm: false,
    onToggle() {}, onLock() {}, onDelete() {}, onConfirmDelete() {}, onCancelDelete() {}, onExpand() {}, t,
  }
  assert.equal(viewerButtonOf(ItemRow({ ...rowProps, onOpenViewer: undefined })).length, 0)
  assert.equal(viewerButtonOf(ItemRow({ ...rowProps, onOpenViewer() {} })).length, 1)
})

test('the preview renders directly under its expanded row', async () => {
  const seeded = await loadClientModule()
  const { PlanRow, ItemRow } = seeded.module.__testables
  const t = key => key
  const preview = { type: 'PreviewMarker', props: {}, children: [] }
  const plan = {
    callId: 'call_1|fc_1', title: 'P', mounted: true, explicit: null, auto: true,
    awaitingCompaction: false, accepted: true, autoEligible: true, size: 10, turn: 2,
  }
  const planRow = PlanRow({
    plan, t, busy: false, expanded: true, preview, titleRef: undefined,
    onToggle() {}, onAuto() {}, onExpand() {},
  })
  const planEntry = flatElements(planRow)[0]
  assert.equal(planEntry.props.className, 'pg-entry pg-entryExpanded')
  assert.equal(planEntry.children.length, 2)
  assert.equal(planEntry.children[0].props.className, 'pg-card')
  assert.equal(planEntry.children[1], preview)

  const item = {
    kind: 'note', id: 'note:1', title: 'N', path: null,
    mounted: true, locked: false, createdBy: 'human', size: 3,
  }
  const itemRow = ItemRow({
    item, t, busy: false, expanded: true, preview, titleRef: undefined, deleteConfirm: false,
    onToggle() {}, onLock() {}, onDelete() {}, onConfirmDelete() {}, onCancelDelete() {}, onExpand() {},
  })
  const itemEntry = flatElements(itemRow)[0]
  assert.equal(itemEntry.props.className, 'pg-entry pg-entryExpanded')
  assert.equal(itemEntry.children.length, 2)
  assert.equal(itemEntry.children[0].props.className, 'pg-card')
  assert.equal(itemEntry.children[1], preview)

  const title = flatElements(planRow).find(node => node.type === 'button' && node.props.className === 'pg-title')
  assert.equal(title.props['aria-expanded'], true)

  const collapsed = PlanRow({
    plan, t, busy: false, expanded: false, preview: undefined,
    onToggle() {}, onAuto() {}, onExpand() {},
  })
  const collapsedEntry = flatElements(collapsed)[0]
  assert.equal(collapsedEntry.props.className, 'pg-entry')
  // React.createElement keeps a null child in this fake; React itself drops it.
  assert.equal(collapsedEntry.children.filter(child => child !== null).length, 1, 'collapsed rows carry no preview')
})

test('the drawer attaches the preview to the expanded row element', async () => {
  const plan = {
    callId: 'call_1|fc_1', title: 'P', mounted: true, explicit: null, auto: true,
    awaitingCompaction: false, accepted: true, autoEligible: true, size: 10, turn: 2,
  }
  const item = {
    kind: 'note', id: 'note:1', title: 'N', path: null,
    mounted: true, locked: false, createdBy: 'human', size: 3,
  }
  const state = { live: true, policy: 'ask', plans: [plan], items: [item], limits: {} }
  const content = { id: item.id, status: 'ready', value: { kind: 'note', title: 'N', text: 'body', truncated: false } }
  // The Drawer's useState order: state, busy, error, expanded, content, addKind,
  // noteTitle, noteText, filePath, deleteConfirm.
  const initial = [
    state, undefined, undefined, item.id, content,
    undefined, '', '', '', undefined,
  ]
  let hook = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: () => [initial[hook++], () => {}],
    useEffect: () => {},
    useRef: value => ({ current: value }),
    useMemo: factory => factory(),
    useCallback: callback => callback,
    Fragment: 'Fragment',
  }
  const seeded = await loadClientModule({}, React)
  const { Drawer } = seeded.module.__testables
  const tree = Drawer({
    sessionId: 's1',
    useResource: () => ({ status: 'live', value: state }),
    t: key => key,
    api: {},
    useTabInfo: undefined,
  })
  const nodes = flatElements(tree)
  const planRow = nodes.find(node => node.type?.name === 'PlanRow')
  const itemRow = nodes.find(node => node.type?.name === 'ItemRow')
  assert.ok(planRow !== undefined && itemRow !== undefined)
  assert.equal(planRow.props.preview, undefined)
  assert.ok(itemRow.props.preview, 'the expanded item owns the preview element')
  assert.equal(itemRow.props.preview.type.name, 'ContentBlock')
  assert.equal(itemRow.props.preview.props.content.id, item.id)
  assert.equal(
    nodes.filter(node => node.type?.name === 'ContentBlock').length,
    0,
    'no preview is appended after the section',
  )
})
