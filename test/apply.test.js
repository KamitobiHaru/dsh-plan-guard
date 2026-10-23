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
    header: { cwd: '/repo' },
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

test('tool add_file fails clearly when the session has no working directory', async () => {
  const fake = await setup()
  fake.rootAgent.session.header = {}
  await assert.rejects(
    fake.tool().execute({ action: 'add_file', path: 'src/a.ts' }, execFor(fake, 'call-nocwd')),
    /no working directory/,
  )
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

test('a dismissed plan stays listed but never auto-mounts', async () => {
  const fake = await setup()
  fake.setProjection({
    docs: [{ callId: 'p1', title: 'Plan one', markdown: '# Plan one', turn: 1, accepted: false }],
    sawCompaction: true,
  })
  const service = fake.provided.get(SERVICE_KEY)
  const state = await service.list(SESSION_ID)
  assert.equal(state.plans[0].mounted, false)
  assert.equal(state.plans[0].auto, false)
  assert.equal(state.plans[0].accepted, false)

  const list = await fake.tool().execute({ action: 'list' }, execFor(fake, 'call-list'))
  assert.match(list.text, /rejected; never auto-mounts/)

  const mounted = await service.setPlan(SESSION_ID, 'p1', 'mounted')
  assert.equal(mounted.plans[0].mounted, true, 'an explicit human mount still wins')
})

/** Mark a delivered injection as live on the fake Session surface. */
function surfaceVisible(fake, message) {
  fake.session.surface.nodes.push('injected')
  fake.session.eventAt = seq => (seq === 'injected' ? { type: 'user/message', data: message } : undefined)
}

/** Run the pre-step waterfall with one claimed user message. */
async function preStep(fake, { turn = 1, step = 2, empty = false } = {}) {
  const entering = empty ? [] : [{ id: 'user-1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }]
  const decision = { kind: 'enter', messages: entering }
  const result = await fake.listeners.get('agent/pre-step')(
    { agent: fake.rootAgent, messages: entering, turn, step, signal: new AbortController().signal },
    async () => decision,
  )
  return result
}

test('pre-step injector sends the full snapshot while nothing is visible', async () => {
  const fake = await setup()
  fake.setProjection({
    docs: [{ callId: 'p1', title: 'Plan one', markdown: '# Plan one\nbody', turn: 1 }],
    sawCompaction: true,
  })
  const service = fake.provided.get(SERVICE_KEY)
  await service.addNote(SESSION_ID, 'Constraint', 'Keep it stable.')
  await service.addFile(SESSION_ID, 'src/a.ts')

  const result = await preStep(fake)
  assert.equal(result.messages.length, 2)
  const injected = result.messages[1]
  assert.equal(injected.source.kind, 'plan-guard')
  assert.match(injected.content[0].text, /Plan one/)
  assert.match(injected.content[0].text, /Constraint/)
  assert.match(injected.content[0].text, /export const a = 1/)
  // The snapshot accounted for every journal entry.
  assert.deepEqual(fake.records.get(SESSION_ID).pending, { added: {}, removed: {} })

  surfaceVisible(fake, injected)
  const again = await preStep(fake, { turn: 2 })
  assert.equal(again.messages.length, 1, 'a visible snapshot is never re-sent')
})

test('a mount is injected on the next step without waiting for a compaction', async () => {
  const fake = await setup()
  fake.setProjection({ docs: [], sawCompaction: false })
  await fake.provided.get(SERVICE_KEY).addNote(SESSION_ID, 'Immediate', 'Show it now.')

  const result = await preStep(fake)
  assert.equal(result.messages.length, 2)
  assert.match(result.messages[1].content[0].text, /Show it now\./)
})

test('an incremental delivery carries the addition and one removal sentence', async () => {
  const fake = await setup()
  fake.setProjection({ docs: [], sawCompaction: true })
  const service = fake.provided.get(SERVICE_KEY)
  await service.addNote(SESSION_ID, 'First', 'First body.')
  const first = await preStep(fake)
  surfaceVisible(fake, first.messages[1])

  await service.addNote(SESSION_ID, 'Second', 'Second body.')
  const added = await preStep(fake, { turn: 2 })
  assert.equal(added.messages.length, 2)
  const delta = added.messages[1].content[0].text
  assert.match(delta, /— update/)
  assert.match(delta, /Second body\./)
  assert.ok(!delta.includes('First body.'), 'an addition does not repeat the whole snapshot')

  const record = fake.records.get(SESSION_ID)
  const firstNote = Object.values(record.items).find(item => item.title === 'First')
  await service.setMounted(SESSION_ID, firstNote.id, false)
  const removed = await preStep(fake, { turn: 3 })
  const line = removed.messages[1].content[0].text
  const escapedId = firstNote.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.match(line, new RegExp(`Note "First" \\(${escapedId}\\) is no longer guarded\\.`))
  assert.ok(!line.includes('## Note:'), 'a removal carries no content')
  assert.ok(!line.includes('First body.'))

  const idempotent = await preStep(fake, { turn: 4 })
  assert.equal(idempotent.messages.length, 1, 'a delivered change is not repeated')
})

test('a newly auto-mounted plan displaces the previous auto plan', async () => {
  const fake = await setup()
  const planA = { callId: 'pA', title: 'Plan A', markdown: '# Plan A\nbody A', turn: 1, accepted: true }
  const planB = { callId: 'pB', title: 'Plan B', markdown: '# Plan B\nbody B', turn: 2, accepted: true }
  fake.setProjection({ docs: [planA], sawCompaction: true })
  const first = await preStep(fake)
  assert.equal(first.messages.length, 2)
  assert.match(first.messages[1].content[0].text, /body A/)
  surfaceVisible(fake, first.messages[1])

  fake.setProjection({ docs: [planA, planB], sawCompaction: true })
  const displaced = await preStep(fake, { turn: 2 })
  assert.equal(displaced.messages.length, 2)
  const text = displaced.messages[1].content[0].text
  assert.match(text, /— update/)
  assert.match(text, /## Plan: Plan B/)
  assert.match(text, /body B/)
  assert.match(text, /Plan "Plan A" \(pA\) is no longer guarded\./)
  assert.ok(!text.includes('body A'), 'the displaced plan text is not re-sent')

  const quiet = await preStep(fake, { turn: 3 })
  assert.equal(quiet.messages.length, 1, 'a displacement delivers once')
})

test('a rejected newcomer displaces nobody and adds nothing', async () => {
  const fake = await setup()
  const planA = { callId: 'pA', title: 'Plan A', markdown: '# Plan A\nbody A', turn: 1, accepted: true }
  fake.setProjection({ docs: [planA], sawCompaction: true })
  const first = await preStep(fake)
  surfaceVisible(fake, first.messages[1])

  fake.setProjection({
    docs: [planA, { callId: 'pB', title: 'Plan B', markdown: '# Plan B\nbody B', turn: 2, accepted: false }],
    sawCompaction: true,
  })
  const next = await preStep(fake, { turn: 2 })
  assert.equal(next.messages.length, 2)
  const text = next.messages[1].content[0].text
  assert.ok(!text.includes('body B'), 'a rejected plan is never injected')
  assert.match(text, /Plan "Plan A" \(pA\) is no longer guarded\./, 'the dead auto plan is still noticed')
})

test('a plan dismissed after auto-mount is noticed once and never re-sent', async () => {
  const fake = await setup()
  const plan = { callId: 'pA', title: 'Plan A', markdown: '# Plan A\nbody A', turn: 1, accepted: true }
  fake.setProjection({ docs: [plan], sawCompaction: true })
  const first = await preStep(fake)
  assert.equal(first.messages.length, 2)
  assert.match(first.messages[1].content[0].text, /body A/)
  surfaceVisible(fake, first.messages[1])
  assert.equal(fake.records.get(SESSION_ID).autoPlan, 'pA')

  // A refold (e.g. after the verdict-shape fix) settles the dismissal verdict.
  fake.setProjection({
    docs: [{ ...plan, accepted: false }],
    sawCompaction: true,
  })
  const noticed = await preStep(fake, { turn: 2 })
  assert.equal(noticed.messages.length, 2)
  const text = noticed.messages[1].content[0].text
  assert.match(text, /Plan "Plan A" \(pA\) is no longer guarded\./)
  assert.ok(!text.includes('body A'), 'a dismissal notice carries no plan text')
  assert.equal(fake.records.get(SESSION_ID).autoPlan, null)

  const quiet = await preStep(fake, { turn: 3 })
  assert.equal(quiet.messages.length, 1, 'a dismissal notice delivers once')
})

test('a compaction re-injects what is still guarded and drops the rest', async () => {
  const fake = await setup()
  fake.setProjection({ docs: [], sawCompaction: true })
  const service = fake.provided.get(SERVICE_KEY)
  await service.addNote(SESSION_ID, 'Keep', 'Keep body.')
  await service.addNote(SESSION_ID, 'Drop', 'Drop body.')
  const first = await preStep(fake)
  surfaceVisible(fake, first.messages[1])

  const record = fake.records.get(SESSION_ID)
  const drop = Object.values(record.items).find(item => item.title === 'Drop')
  await service.setMounted(SESSION_ID, drop.id, false)
  await preStep(fake, { turn: 2 })

  fake.session.surface.nodes = []
  fake.session.eventAt = () => undefined
  const snapshot = await preStep(fake, { turn: 3 })
  assert.equal(snapshot.messages.length, 2)
  const text = snapshot.messages[1].content[0].text
  assert.match(text, /Keep body\./)
  assert.ok(!text.includes('Drop body.'), 'an unmounted item is gone from the snapshot')
})

test('lock and policy changes inject nothing', async () => {
  const fake = await setup()
  fake.setProjection({ docs: [], sawCompaction: true })
  const service = fake.provided.get(SERVICE_KEY)
  await service.addNote(SESSION_ID, 'Locked', 'Body.')
  const first = await preStep(fake)
  surfaceVisible(fake, first.messages[1])

  const record = fake.records.get(SESSION_ID)
  const note = Object.values(record.items)[0]
  await service.setLock(SESSION_ID, note.id, true)
  await service.setPolicy(SESSION_ID, 'deny-all')
  assert.deepEqual(fake.records.get(SESSION_ID).pending, { added: {}, removed: {} })
  const result = await preStep(fake, { turn: 2 })
  assert.equal(result.messages.length, 1)
})

test('the tool reports availability from the next step', async () => {
  const fake = await setup()
  const added = await fake.tool().execute({ action: 'add_note', text: 'Keep it.' }, execFor(fake, 'call-copy'))
  assert.match(added.text, /from the next step/)
})
