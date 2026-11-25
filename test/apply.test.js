import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, PLAN_DOCS_PROJECTION_KEY, SERVICE_KEY, TOOL_NAME, __testables as t } from '../index.js'

const SESSION_ID = 's1'

/**
 * Filesystem fake with a mutable file table and call counters, so a test can
 * rewrite a mounted file between steps and assert what the probe read.
 */
function fakeFs() {
  const root = { targetKey: '/repo', displayPath: '/repo' }
  const files = new Map([
    ['/repo/src/a.ts', { version: 'v1', size: 19, text: 'export const a = 1' }],
    ['/repo/big.txt', { version: 'v2', size: 6000, text: 'q'.repeat(6000) }],
  ])
  const counts = { stat: 0, read: 0 }
  const named = (path, cwd) => {
    if (path === '/repo') return root
    if (path.startsWith('/repo/')) return { targetKey: path, displayPath: path }
    if (typeof cwd === 'string') return { targetKey: `/repo/${path}`, displayPath: `/repo/${path}` }
    return { targetKey: path, displayPath: path }
  }
  return {
    counts,
    /** Replace one file's on-disk state; `version` is what the probe compares. */
    writeFile(path, value) { files.set(path, value) },
    removeFile(path) { files.delete(path) },
    async resolve(path, opts = {}) { return named(path, opts.cwd) },
    async stat(target) {
      counts.stat += 1
      if (target.targetKey === '/repo') return { type: 'directory', version: 'v0' }
      const file = files.get(target.targetKey)
      if (file === undefined) return undefined
      return { type: 'file', size: file.size, version: file.version }
    },
    processPath(target) { return target.targetKey },
    contains(parent, child) { return child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`) },
    async streamText(target) {
      const file = files.get(target.targetKey)
      if (file === undefined) throw new Error(`ENOENT: no such file, open '${target.targetKey}'`)
      counts.read += 1
      return (async function* chunks() {
        for (let at = 0; at < file.text.length; at += 600) yield file.text.slice(at, at + 600)
      })()
    },
    /** Whole-file read, the path the injector uses now that nothing truncates. */
    async readText(target) {
      const file = files.get(target.targetKey)
      if (file === undefined) throw new Error(`ENOENT: no such file, open '${target.targetKey}'`)
      counts.read += 1
      return file.text
    },
  }
}

function fakeContext(options = {}) {
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
    session: {
      id: 'child',
      surface: { nodes: [] },
      eventAt() { return undefined },
      header: { cwd: '/repo', origin: 'subagent' },
    },
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
    sessionProjections: options.legacyProjections === true
      // Pre-0.2.2 runtime: register() returns a bare disposer, never a handle.
      ? { async register() { return () => {} } }
      : {
        /**
         * DSH 0.2.2: registration is asynchronous and resolves to a
         * `ProjectionHandle`. The fake mirrors that contract so `apply` exercises
         * the awaited path; `setProjection` swaps what the handle folds.
         */
        async register(spec) {
          assert.equal(spec.key, PLAN_DOCS_PROJECTION_KEY)
          applied.push(spec)
          return {
            stateOf(_session) { return projectionState },
            readerFor(_session) { return () => projectionState },
            async dispose() {},
          }
        },
      },
    tools: {
      register(definition) { tool = definition; return () => {} },
    },
    agents: {
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

test('apply rejects a runtime whose registration is not a ProjectionHandle', async () => {
  const fake = fakeContext({ legacyProjections: true })
  await assert.rejects(
    () => apply(fake.ctx, { defaultPolicy: 'allow-all' }),
    /requires DSH 0\.2\.2-rc\.5 or newer/,
  )
  assert.equal(fake.tool(), undefined, 'no tool is published when the projection handle is missing')
  assert.equal(fake.provided.has(SERVICE_KEY), false, 'no Remote service is published when the projection handle is missing')
})

test('delegated agents are restricted from the tool and root agents are not', async () => {
  const fake = await setup()
  fake.listeners.get('agent/created')({ agent: fake.rootAgent })
  assert.deepEqual(fake.restrictions, [])
  fake.listeners.get('agent/created')({ agent: fake.childAgent })
  assert.deepEqual(fake.restrictions, [{ deny: [TOOL_NAME] }])
})

test('the tool refuses delegated agents', async () => {
  const fake = await setup()
  const childExec = { ...execFor(fake), agent: fake.childAgent }
  await assert.rejects(
    fake.tool().execute({ action: 'list' }, childExec),
    /only available in the main Session/,
  )
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

test('the permission card carries the complete note body instead of a 500-character excerpt', async () => {
  const fake = await setup({ defaultPolicy: 'ask' })
  const head = 'HEAD-' + 'a'.repeat(600)
  const tail = 'TAIL-' + 'z'.repeat(600)
  const text = `${head}\n${tail}`
  await fake.tool().execute({ action: 'add_note', text }, execFor(fake, 'call-long'))
  const detail = fake.ctx.userQuestions.calls[0].request.questions[0].detail
  assert.match(detail, /scroll inside the card/)
  assert.match(detail, new RegExp(text.slice(-12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(detail.includes('[… truncated / 已截断]'), false)
  assert.ok(detail.length > 1200, 'the full body is present in the question detail')
})

test('items are unlimited by default and an explicit maxItems still bounds them', async () => {
  const fake = await setup()
  for (let index = 0; index < 25; index += 1) {
    await fake.tool().execute({ action: 'add_note', text: `note ${index}` }, execFor(fake, `call-many-${index}`))
  }
  assert.equal(Object.keys(fake.records.get(SESSION_ID).items).length, 25)
  assert.equal((await fake.provided.get(SERVICE_KEY).list(SESSION_ID)).limits.maxItems, 0)

  const bounded = await setup({ maxItems: 2 })
  await bounded.tool().execute({ action: 'add_note', text: 'one' }, execFor(bounded, 'call-a'))
  await bounded.tool().execute({ action: 'add_note', text: 'two' }, execFor(bounded, 'call-b'))
  await assert.rejects(
    bounded.tool().execute({ action: 'add_note', text: 'three' }, execFor(bounded, 'call-c')),
    /maximum of 2 pinned items/,
  )
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
    docs: [{ callId: 'p1', title: 'Plan one', markdown: '# Plan one', turn: 1, accepted: true }],
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

test('a dismissed or unconfirmed plan stays unmounted until a human mounts it', async () => {
  const fake = await setup()
  const service = fake.provided.get(SERVICE_KEY)
  for (const verdict of [undefined, false]) {
    fake.setProjection({
      docs: [{ callId: 'p1', title: 'Plan one', markdown: '# Plan one', turn: 1, accepted: verdict }],
      sawCompaction: true,
    })
    const state = await service.list(SESSION_ID)
    assert.equal(state.plans[0].mounted, false, `verdict ${String(verdict)} never auto-mounts`)
    assert.equal(state.plans[0].autoEligible, false)
    assert.equal(state.plans[0].awaitingCompaction, false)
    const mounted = await service.setPlan(SESSION_ID, 'p1', 'mounted')
    assert.equal(mounted.plans[0].mounted, true, 'a human mount still works')
    await service.setPlan(SESSION_ID, 'p1', 'auto')
  }
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
    docs: [{ callId: 'p1', title: 'Plan one', markdown: '# Plan one\nbody', turn: 1, accepted: true }],
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
  assert.deepEqual(fake.records.get(SESSION_ID).pending, { added: {}, changed: {}, removed: {} })
  // Every mounted file leaves a sighting of the exact bytes just delivered.
  const sighted = Object.values(fake.records.get(SESSION_ID).items).find(item => item.kind === 'file')
  assert.equal(sighted.seenVersion, 'v1')
  assert.equal(typeof sighted.seenDigest, 'string')
  assert.ok(sighted.seenDigest.length > 0)

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
  assert.deepEqual(fake.records.get(SESSION_ID).pending, { added: {}, changed: {}, removed: {} })
  const result = await preStep(fake, { turn: 2 })
  assert.equal(result.messages.length, 1)
})

test('the tool reports availability from the next step', async () => {
  const fake = await setup()
  const added = await fake.tool().execute({ action: 'add_note', text: 'Keep it.' }, execFor(fake, 'call-copy'))
  assert.match(added.text, /from the next step/)
})

test('the file permission card reports the real size and marks a capped preview', async () => {
  const fake = await setup({ defaultPolicy: 'ask', previewChars: 500 })
  await fake.tool().execute({ action: 'add_file', path: 'big.txt' }, execFor(fake, 'call-big'))
  const detail = fake.ctx.userQuestions.calls[0].request.questions[0].detail
  assert.match(detail, /文件共 6000 字节/)
  assert.match(detail, /6000 bytes total/)
  assert.match(detail, /first 500 characters shown/)
  assert.match(detail, /\[… truncated \/ 已截断\]/)
  assert.equal(detail.includes('scroll inside the card to read it'), false)
})

/** The one file item in the stored record. */
const onlyFile = (fake) => Object.values(fake.records.get(SESSION_ID).items).find(item => item.kind === 'file')

test('a mounted file rewritten on disk is re-injected in full on the next step', async () => {
  const fake = await setup()
  fake.setProjection({ docs: [], sawCompaction: true })
  await fake.provided.get(SERVICE_KEY).addFile(SESSION_ID, 'src/a.ts')
  const first = await preStep(fake)
  surfaceVisible(fake, first.messages[1])
  assert.match(first.messages[1].content[0].text, /## File: src\/a\.ts/)
  assert.equal(onlyFile(fake).seenVersion, 'v1', 'the snapshot leaves a sighting')

  fake.ctx.fs.writeFile('/repo/src/a.ts', { version: 'v9', size: 25, text: 'export const a = 42 // edited' })
  const changed = await preStep(fake, { turn: 2 })
  assert.equal(changed.messages.length, 2)
  const text = changed.messages[1].content[0].text
  assert.match(text, /— update/)
  assert.match(text, /File src\/a\.ts \(file:[0-9a-f-]+\) changed on disk; the section below is its current content\./)
  assert.match(text, /## File: src\/a\.ts \(changed\)/)
  assert.match(text, /export const a = 42 \/\/ edited/)

  const stamped = onlyFile(fake)
  assert.equal(stamped.seenVersion, 'v9')
  assert.equal(stamped.size, 25)
  const reads = fake.ctx.fs.counts.read
  const statsBefore = fake.ctx.fs.counts.stat

  const quiet = await preStep(fake, { turn: 3 })
  assert.equal(quiet.messages.length, 1, 'a delivered refresh is not repeated')
  assert.equal(fake.ctx.fs.counts.read, reads, 'an unchanged version never re-reads the body')
  assert.equal(fake.ctx.fs.counts.stat, statsBefore + 1, 'a quiet step costs one stat')

  const listed = await fake.tool().execute({ action: 'list' }, execFor(fake, 'call-list'))
  assert.ok(!/changed on disk/.test(listed.text), 'a delivered refresh clears the pending flag')
})

test('a same-bytes rewrite restamps silently and a second edit still reports', async () => {
  const fake = await setup()
  fake.setProjection({ docs: [], sawCompaction: true })
  await fake.provided.get(SERVICE_KEY).addFile(SESSION_ID, 'src/a.ts')
  const first = await preStep(fake)
  surfaceVisible(fake, first.messages[1])

  fake.ctx.fs.writeFile('/repo/src/a.ts', { version: 'v3', size: 19, text: 'export const a = 1' })
  const touched = await preStep(fake, { turn: 2 })
  assert.equal(touched.messages.length, 1, 'identical bytes never reach the model')
  assert.equal(onlyFile(fake).seenVersion, 'v3', 'the new version is still recorded')

  fake.ctx.fs.writeFile('/repo/src/a.ts', { version: 'v4', size: 21, text: 'export const a = 1\n//' })
  const edited = await preStep(fake, { turn: 3 })
  assert.equal(edited.messages.length, 2)
  assert.match(edited.messages[1].content[0].text, /## File: src\/a\.ts \(changed\)/)
})

test('a deleted mounted file is reported once, not on every step', async () => {
  const fake = await setup()
  fake.setProjection({ docs: [], sawCompaction: true })
  await fake.provided.get(SERVICE_KEY).addFile(SESSION_ID, 'src/a.ts')
  const first = await preStep(fake)
  surfaceVisible(fake, first.messages[1])

  fake.ctx.fs.removeFile('/repo/src/a.ts')
  const gone = await preStep(fake, { turn: 2 })
  assert.equal(gone.messages.length, 2)
  assert.match(gone.messages[1].content[0].text, /changed on disk/)
  assert.match(gone.messages[1].content[0].text, /\[plan-guard: file unreadable: /)
  assert.equal(onlyFile(fake).seenVersion, 'missing')

  const again = await preStep(fake, { turn: 3 })
  assert.equal(again.messages.length, 1, 'a still-missing file is noticed once')

  fake.ctx.fs.writeFile('/repo/src/a.ts', { version: 'v5', size: 19, text: 'export const a = 1' })
  const back = await preStep(fake, { turn: 4 })
  assert.match(back.messages[1].content[0].text, /export const a = 1/, 'the file coming back is a change again')
})

test('a changed file shows up in the tool list before its delivery', async () => {
  const fake = await setup()
  fake.setProjection({ docs: [], sawCompaction: true })
  await fake.provided.get(SERVICE_KEY).addFile(SESSION_ID, 'src/a.ts')
  const first = await preStep(fake)
  surfaceVisible(fake, first.messages[1])

  // Journal the change the way the injector does, then read the drawer state.
  const item = onlyFile(fake)
  await fake.provided.get(SERVICE_KEY).setMounted(SESSION_ID, item.id, false)
  await fake.provided.get(SERVICE_KEY).setMounted(SESSION_ID, item.id, true)
  const state = await fake.provided.get(SERVICE_KEY).list(SESSION_ID)
  assert.equal(state.items.find(entry => entry.id === item.id).changedPending, false)
  const listed = await fake.tool().execute({ action: 'list' }, execFor(fake, 'call-list2'))
  assert.match(listed.text, /mounted/)
})

test('refreshChangedFiles off skips the probe entirely', async () => {
  const fake = await setup({ refreshChangedFiles: false })
  fake.setProjection({ docs: [], sawCompaction: true })
  await fake.provided.get(SERVICE_KEY).addFile(SESSION_ID, 'src/a.ts')
  const first = await preStep(fake)
  surfaceVisible(fake, first.messages[1])
  assert.equal(onlyFile(fake).seenVersion, undefined, 'nothing is stamped while the probe is off')

  const stats = fake.ctx.fs.counts.stat
  fake.ctx.fs.writeFile('/repo/src/a.ts', { version: 'v9', size: 25, text: 'export const a = 42 // edited' })
  const next = await preStep(fake, { turn: 2 })
  assert.equal(next.messages.length, 1, 'a changed file is not reported')
  assert.equal(fake.ctx.fs.counts.stat, stats, 'and no stat happens')
})

test('an unapproved plan is never injected, folded from real session events', async () => {
  const fake = await setup()
  const callId = 'call_3b263a046fc3435ebfecca87'
  const events = [
    { type: 'plan/mode', data: { active: true } },
    {
      type: 'tool/call',
      data: {
        turn: 1, step: 127, callId, name: 'exit_plan_mode',
        arguments: JSON.stringify({ plan: '# 计划：未获批准\nsecret body' }),
      },
    },
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 127,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId },
          toolCallId: callId,
          content: [{ type: 'text', text: 'The user dismissed the plan review to reply in their own words; plan mode remains active.' }],
          isError: false,
        },
      },
    },
    { type: 'step/end', data: { turn: 1, step: 127 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'compaction/end', data: {} },
  ]
  const folded = events.reduce((state, event) => t.foldDocs(state, event), t.stateInit())
  assert.equal(folded.docs[0].accepted, false)
  fake.setProjection(folded)

  const quiet = await preStep(fake)
  assert.equal(quiet.messages.length, 1, 'a dismissed plan reaches the model as nothing at all')

  // Approving a later plan mounts that one, and only that one.
  const approvedId = 'call_22fad1704c5945beb92f3698'
  const more = [
    {
      type: 'tool/call',
      data: {
        turn: 2, step: 6, callId: approvedId, name: 'exit_plan_mode',
        arguments: JSON.stringify({ plan: '# 计划：已批准\napproved body' }),
      },
    },
    {
      type: 'tool/result',
      data: {
        turn: 2,
        step: 6,
        message: {
          role: 'tool',
          toolCallId: approvedId,
          content: [{ type: 'text', text: 'Plan approved — plan mode exited; carry out the plan starting with your next step.' }],
          isError: false,
        },
      },
    },
    { type: 'plan/mode', data: { active: false } },
  ]
  const settled = more.reduce((state, event) => t.foldDocs(state, event), folded)
  assert.equal(settled.docs[1].accepted, true)
  assert.equal(settled.docs[0].accepted, false)
  fake.setProjection(settled)

  const injected = await preStep(fake, { turn: 3 })
  assert.equal(injected.messages.length, 2)
  assert.match(injected.messages[1].content[0].text, /## Plan: 计划：已批准/)
  assert.match(injected.messages[1].content[0].text, /approved body/)
  assert.ok(!injected.messages[1].content[0].text.includes('secret body'), 'the dismissed plan stays out')
})

test('a huge mounted file reaches the model whole, with no cap in sight', async () => {
  const fake = await setup()
  const huge = `${'head\n'}${'x'.repeat(160000)}\nTAIL-END`
  fake.ctx.fs.writeFile('/repo/huge.txt', { version: 'h1', size: huge.length, text: huge })
  fake.setProjection({ docs: [], sawCompaction: true })
  await fake.provided.get(SERVICE_KEY).addFile(SESSION_ID, 'huge.txt')

  const result = await preStep(fake)
  assert.equal(result.messages.length, 2)
  const text = result.messages[1].content[0].text
  assert.ok(text.includes('head\nxxx'), 'the body starts where the file starts')
  assert.ok(text.includes('TAIL-END'), 'and the last byte of a 160k file is still there')
  assert.ok(text.length > huge.length, 'the block is at least as big as what was pinned')
  assert.ok(!/\[plan-guard:[^\]]*truncat/.test(text), 'no truncation marker')
  assert.ok(!/\[plan-guard: omitted/.test(text), 'no omission marker')
  const state = await fake.provided.get(SERVICE_KEY).list(SESSION_ID)
  assert.equal(state.limits.maxTotalChars, undefined, 'the drawer no longer receives size caps')
  assert.equal(state.limits.maxCharsPerFile, undefined)
})

test('an oversized note is stored and injected whole', async () => {
  const fake = await setup()
  fake.setProjection({ docs: [], sawCompaction: true })
  const body = `first line\n${'n'.repeat(70000)}\nLAST LINE OF THE NOTE`
  const added = await fake.tool().execute({ action: 'add_note', text: body }, execFor(fake, 'call-long'))
  assert.match(added.text, /Added and mounted note/)
  const result = await preStep(fake)
  const text = result.messages[1].content[0].text
  assert.ok(text.includes('LAST LINE OF THE NOTE'), 'a 70k note is not cut at the old 20k limit')
  const listed = await fake.tool().execute({ action: 'list' }, execFor(fake, 'call-list-long'))
  assert.match(listed.text, /note:/)
})

test('a plan longer than the old storage cap is kept and injected whole', async () => {
  const callId = 'call_long_plan'
  const markdown = `# 长计划\n${'p'.repeat(80000)}\nPLAN TAIL MARKER`
  const folded = t.foldDocs(t.stateInit(), {
    type: 'tool/call',
    data: { turn: 1, step: 3, callId, name: 'exit_plan_mode', arguments: JSON.stringify({ plan: markdown }) },
  })
  assert.equal(folded.docs[0].markdown.length, markdown.length, 'the projection stores the whole plan')
  assert.ok(!folded.docs[0].markdown.includes('truncated past'))
  const settled = t.foldDocs(folded, {
    type: 'tool/result',
    data: {
      turn: 1, step: 3,
      message: {
        role: 'tool', toolCallId: callId, isError: false,
        content: [{ type: 'text', text: 'Plan approved — plan mode exited; carry out the plan starting with your next step.' }],
      },
    },
  })
  const fake = await setup()
  fake.setProjection({ ...settled, sawCompaction: true })
  const result = await preStep(fake)
  assert.match(result.messages[1].content[0].text, /PLAN TAIL MARKER/)
})

test('deprecated cap fields activate with a warning instead of failing', async () => {
  const fake = fakeContext()
  const warnings = []
  fake.ctx.logger = { debug() {}, warn(message) { warnings.push(message) }, error() {} }
  await apply(fake.ctx, { defaultPolicy: 'allow-all', maxTotalChars: 5000, maxCharsPerNote: 2000 })
  assert.ok(fake.tool(), 'the plugin still registers its tool')
  assert.equal(warnings.filter(line => /deprecated config field/.test(line)).length, 1)
  assert.match(warnings.join(' '), /maxTotalChars/)
})
