import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, PLAN_DOCS_PROJECTION_KEY, SERVICE_KEY, TOOL_NAME } from '../index.js'

const SESSION_ID = 's1'

function fakeFs() {
  const root = { targetKey: '/repo', displayPath: '/repo' }
  const file = { targetKey: '/repo/src/a.ts', displayPath: '/repo/src/a.ts' }
  return {
    async resolve(path, opts = {}) {
      if (path === '/repo') return root
      if (path === '/repo/src/a.ts') return file
      if (path === 'src/a.ts' && opts.cwd === '/repo') return file
      if (path === 'src/missing.ts' && opts.cwd === '/repo') {
        const missing = { targetKey: '/repo/src/missing.ts', displayPath: '/repo/src/missing.ts' }
        return missing
      }
      return { targetKey: path, displayPath: path }
    },
    async stat(target) {
      if (target.targetKey === '/repo') return { type: 'directory', version: 'v0' }
      if (target.targetKey === '/repo/src/a.ts') return { type: 'file', size: 19, version: 'v1' }
      return undefined
    },
    processPath(target) { return target.targetKey },
    contains(parent, child) { return child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`) },
    async streamText(target) {
      assert.equal(target.targetKey, '/repo/src/a.ts')
      return (async function* chunks() {
        yield 'export const a = 1'
      })()
    },
  }
}

function fakeContext() {
  const records = new Map()
  const listeners = new Map()
  const disposers = []
  const provided = new Map()
  const applied = []
  const restrictions = []
  const session = {
    id: SESSION_ID,
    surface: { nodes: [] },
    eventAt() { return undefined },
  }
  let projectionState = { docs: [], sawCompaction: true }
  let tool
  const rootAgent = { id: SESSION_ID, session }
  const childAgent = {
    id: 'child',
    session: { id: 'child', surface: { nodes: [] }, eventAt() { return undefined } },
    ctx: {
      effect(factory) { const disposer = factory(); applied.push(disposer); return disposer },
      tools: { restrict(filter) { restrictions.push(filter); return () => {} } },
    },
  }
  const domain = {
    table(name) {
      assert.equal(name, 'sessions')
      return {
        get: key => records.get(key),
        put: async (key, value) => { records.set(key, value) },
        delete: async (key) => records.delete(key),
        update: async (key, fn) => { const next = fn(records.get(key)); records.set(key, next); return next },
        entries: () => records.entries(),
        keys: () => records.keys(),
        size: records.size,
      }
    },
    async close() {},
  }
  const ctx = {
    storageDomain: {
      async open(spec) { assert.equal(spec.name, 'plan_guard'); return domain },
    },
    sessionProjections: {
      register(spec) { applied.push(spec); return () => {} },
      stateOf(_session, key) {
        assert.equal(key, PLAN_DOCS_PROJECTION_KEY)
        return projectionState
      },
    },
    tools: {
      register(definition) { tool = definition; return () => {} },
    },
    agents: {
      roots: () => [rootAgent],
      get: id => (String(id) === SESSION_ID ? rootAgent : undefined),
    },
    sessions: {
      get: id => (String(id) === SESSION_ID ? session : undefined),
    },
    fs: fakeFs(),
    workingDirectory: {
      async ensure(agent) { assert.equal(agent.id, SESSION_ID); return '/repo' },
    },
    userQuestions: {
      calls: [],
      async askTimed(request, callId, timeoutMs) {
        this.calls.push({ request, callId, timeoutMs })
        return { answers: [{ id: 'permission', selected: ['允许 / Allow'] }] }
      },
    },
    effect(factory) { const disposer = factory(); applied.push(disposer); return disposer },
    on(event, listener) {
      assert.equal(listeners.has(event), false)
      listeners.set(event, listener)
    },
    get(name) { return this[name] },
    provide(key, service) { provided.set(key, service) },
    logger: { debug() {}, warn() {}, error() {} },
  }
  return {
    ctx,
    records,
    listeners,
    applied,
    restrictions,
    provided,
    tool: () => tool,
    rootAgent,
    childAgent,
    setProjection(state) { projectionState = state },
    session,
  }
}

async function setup(config = {}) {
  const fake = fakeContext()
  await apply(fake.ctx, { defaultPolicy: 'allow-all', ...config })
  assert.ok(fake.tool(), 'context_guard registered')
  assert.ok(fake.provided.get(SERVICE_KEY), 'remote service provided')
  return fake
}

const execFor = (fake, callId = 'call-1') => ({
  callId,
  rootCallId: callId,
  name: TOOL_NAME,
  arguments: {},
  agent: fake.rootAgent,
  signal: new AbortController().signal,
  deferContext() {},
  concludeTurn() {},
})

test('apply registers the tool, service, projection, and both listeners', async () => {
  const fake = await setup()
  assert.equal(fake.tool().name, TOOL_NAME)
  assert.equal(fake.tool().parameters.additionalProperties, false)
  assert.equal(fake.tool().output.schema.additionalProperties, true)
  assert.ok(fake.listeners.has('agent/created'))
  assert.ok(fake.listeners.has('agent/pre-step'))
  assert.ok(fake.applied.some(entry => entry && typeof entry === 'object' && entry.key === PLAN_DOCS_PROJECTION_KEY))
})

test('delegated agents are restricted from the tool', async () => {
  const fake = await setup()
  fake.listeners.get('agent/created')({ agent: fake.childAgent })
  assert.deepEqual(fake.restrictions, [{ deny: [TOOL_NAME] }])
})

test('tool list and add_note produce storage state and a readable list', async () => {
  const fake = await setup()
  const list0 = await fake.tool().execute({ action: 'list' }, execFor(fake))
  assert.match(list0.text, /Plans \(user-controlled/)
  assert.match(list0.text, /Pinned items:/)

  const added = await fake.tool().execute({ action: 'add_note', text: 'Keep the API stable.' }, execFor(fake, 'call-2'))
  assert.match(added.text, /Added and mounted note/)
  const record = fake.records.get(SESSION_ID)
  const note = Object.values(record.items).find(item => item.kind === 'note')
  assert.ok(note)
  assert.equal(note.text, 'Keep the API stable.')
  assert.equal(note.mounted, true)
  assert.equal(note.createdBy, 'model')

  const list1 = await fake.tool().execute({ action: 'list' }, execFor(fake, 'call-3'))
  assert.match(list1.text, new RegExp(note.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(list1.text, /mounted/)
})

test('tool add_file resolves, validates, previews, and records the file', async () => {
  const fake = await setup()
  const added = await fake.tool().execute({ action: 'add_file', path: 'src/a.ts' }, execFor(fake, 'call-file'))
  assert.match(added.text, /Added and mounted file src\/a\.ts/)
  assert.match(added.text, /export const a = 1/)
  const record = fake.records.get(SESSION_ID)
  const file = Object.values(record.items).find(item => item.kind === 'file')
  assert.ok(file)
  assert.equal(file.path, '/repo/src/a.ts')
  assert.equal(file.displayPath, 'src/a.ts')
  assert.equal(file.workspaceRoot, '/repo')
})

test('tool mount/unmount respects lock and never touches plan ids', async () => {
  const fake = await setup()
  const added = await fake.tool().execute({ action: 'add_note', text: 'lock me' }, execFor(fake, 'call-note'))
  const record = fake.records.get(SESSION_ID)
  const note = Object.values(record.items).find(item => item.kind === 'note')
  const service = fake.provided.get(SERVICE_KEY)
  await service.setLock(SESSION_ID, note.id, true)
  await assert.rejects(
    fake.tool().execute({ action: 'unmount', itemId: note.id }, execFor(fake, 'call-unmount')),
    /locked by the user/,
  )
  await assert.rejects(
    fake.tool().execute({ action: 'mount', itemId: 'plan-call-id' }, execFor(fake, 'call-plan')),
    /No guarded item/,
  )
  assert.match(added.text, new RegExp(note.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('ask policy consults userQuestions and applies on allow', async () => {
  const fake = await setup({ defaultPolicy: 'ask' })
  const added = await fake.tool().execute({ action: 'add_note', text: 'ask me' }, execFor(fake, 'call-ask'))
  assert.equal(fake.ctx.userQuestions.calls.length, 1)
  assert.equal(fake.ctx.userQuestions.calls[0].callId, 'call-ask')
  assert.match(added.text, /Added and mounted note/)
  assert.ok(Object.values(fake.records.get(SESSION_ID).items).some(item => item.kind === 'note'))
})

test('service mutation methods return refreshed state and content reads files', async () => {
  const fake = await setup()
  const service = fake.provided.get(SERVICE_KEY)
  await service.addNote(SESSION_ID, 'Title', 'Body')
  const state = await service.list(SESSION_ID)
  assert.equal(state.live, true)
  assert.equal(state.policy, 'allow-all')
  const note = state.items.find(item => item.kind === 'note')
  assert.ok(note)
  const noteContent = await service.content(SESSION_ID, note.id)
  assert.equal(noteContent.text, 'Body')

  await service.addFile(SESSION_ID, 'src/a.ts')
  const state2 = await service.list(SESSION_ID)
  const file = state2.items.find(item => item.kind === 'file')
  assert.ok(file)
  const fileContent = await service.content(SESSION_ID, file.id)
  assert.equal(fileContent.text, 'export const a = 1')

  await service.setMounted(SESSION_ID, note.id, false)
  assert.equal((await service.list(SESSION_ID)).items.find(item => item.id === note.id).mounted, false)
  await service.setPolicy(SESSION_ID, 'deny-all')
  assert.equal((await service.list(SESSION_ID)).policy, 'deny-all')
  await service.removeItem(SESSION_ID, note.id)
  assert.ok(!(await service.list(SESSION_ID)).items.some(item => item.id === note.id))
})

test('service setPlan writes explicit choices and clears to auto', async () => {
  const fake = await setup()
  fake.setProjection({
    docs: [{ callId: 'p1', title: 'Plan one', markdown: '# Plan one', turn: 1 }],
    sawCompaction: true,
  })
  const service = fake.provided.get(SERVICE_KEY)
  let state = await service.list(SESSION_ID)
  assert.equal(state.plans[0].mounted, true)
  assert.equal(state.plans[0].auto, true)

  state = await service.setPlan(SESSION_ID, 'p1', 'unmounted')
  assert.equal(state.plans[0].mounted, false)
  assert.equal(state.plans[0].explicit, 'unmounted')

  state = await service.setPlan(SESSION_ID, 'p1', 'auto')
  assert.equal(state.plans[0].mounted, true)
  assert.equal(state.plans[0].explicit, null)
})

test('pre-step injector splices one message with plan, note, and file', async () => {
  const fake = await setup()
  fake.setProjection({
    docs: [{ callId: 'p1', title: 'Plan one', markdown: '# Plan one\nbody', turn: 1 }],
    sawCompaction: true,
  })
  const service = fake.provided.get(SERVICE_KEY)
  await service.addNote(SESSION_ID, 'Constraint', 'Keep it stable.')
  await service.addFile(SESSION_ID, 'src/a.ts')
  const entering = [{ id: 'user-1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }]
  const decision = { kind: 'enter', messages: entering }
  const injector = fake.listeners.get('agent/pre-step')
  const result = await injector({
    agent: fake.rootAgent,
    messages: entering,
    turn: 1,
    step: 2,
    signal: new AbortController().signal,
  }, async () => decision)
  assert.equal(result.messages.length, 2)
  const injected = result.messages[1]
  assert.equal(injected.source.kind, 'plan-guard')
  assert.match(injected.content[0].text, /Plan one/)
  assert.match(injected.content[0].text, /Constraint/)
  assert.match(injected.content[0].text, /export const a = 1/)

  const second = await injector({
    agent: fake.rootAgent,
    messages: entering,
    turn: 1,
    step: 3,
    signal: new AbortController().signal,
  }, async () => decision)
  assert.equal(second.messages.length, 2)
})
