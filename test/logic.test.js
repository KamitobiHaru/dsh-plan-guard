import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  __testables as t,
} from '../index.js'

const baseConfig = () => t.validateConfig(undefined).value

const noteItem = (id, overrides = {}) => ({
  id,
  kind: 'note',
  title: `Title ${id}`,
  text: `Body ${id}`,
  size: 10,
  mounted: true,
  locked: false,
  createdBy: 'human',
  createdAt: 1,
  ...overrides,
})

const fileItem = (id, overrides = {}) => ({
  id,
  kind: 'file',
  title: 'a.ts',
  path: '/repo/src/a.ts',
  displayPath: 'src/a.ts',
  workspaceRoot: '/repo',
  size: 12,
  mounted: true,
  locked: false,
  createdBy: 'human',
  createdAt: 2,
  ...overrides,
})

const record = (overrides = {}) => ({
  version: 2,
  policy: 'ask',
  plans: {},
  items: {},
  ...overrides,
})

const planDoc = (callId, title, markdown) => ({ callId, title, markdown, turn: 1 })

test('config defaults and validation', () => {
  const defaults = baseConfig()
  assert.equal(defaults.defaultPolicy, 'ask')
  assert.equal(defaults.maxItems, 24)
  assert.equal(defaults.allowOutsideWorkspace, false)
  assert.equal(defaults.maxCharsPerNote, 20000)

  assert.ok(t.validateConfig({ defaultPolicy: 'nope' }).issues)
  assert.ok(t.validateConfig({ maxItems: 0 }).issues)
  assert.ok(t.validateConfig({ maxItems: 1.5 }).issues)
  assert.ok(t.validateConfig({ disabled: 'yes' }).issues)
  assert.ok(t.validateConfig({ unknownField: 1 }).issues)
  assert.ok(t.validateConfig({ header: '' }).issues)

  const custom = t.validateConfig({ maxItems: 3, defaultPolicy: 'deny-all', disabled: true }).value
  assert.equal(custom.maxItems, 3)
  assert.equal(custom.defaultPolicy, 'deny-all')
  assert.equal(custom.disabled, true)
})

test('record normalization accepts v2 and legacy guarded flags', () => {
  const legacy = t.normalizeRecord({ guarded: { a: true, b: true } })
  assert.deepEqual(legacy.plans, { a: 'mounted', b: 'mounted' })
  assert.equal(legacy.policy, undefined)
  assert.deepEqual(legacy.items, {})

  const v2 = t.normalizeRecord({
    version: 2,
    policy: 'allow-all',
    plans: { a: 'unmounted' },
    items: { 'note:x': noteItem('note:x'), 'file:y': fileItem('file:y') },
  })
  assert.equal(v2.policy, 'allow-all')
  assert.equal(v2.plans.a, 'unmounted')
  assert.equal(v2.items['note:x'].text, 'Body note:x')
  assert.equal(v2.items['file:y'].path, '/repo/src/a.ts')

  assert.throws(() => t.normalizeRecord({ version: 3 }))
  assert.throws(() => t.normalizeRecord({ plans: { a: 'maybe' } }))
  assert.throws(() => t.normalizeRecord({ guarded: { a: false } }))
  assert.throws(() => t.normalizeRecord({ items: { 'note:x': { ...noteItem('note:x'), kind: 'file' } } }))
})

test('effective plan state: newest only, explicit choices win, first compaction gates auto', () => {
  const cfg = baseConfig()
  const docs = [planDoc('old', 'Old', '# Old'), planDoc('new', 'New', '# New')]
  const fresh = record()

  assert.deepEqual(
    t.effectivePlanState(docs[0], 0, docs, fresh, cfg, true),
    { mounted: false, explicit: undefined, auto: false, autoEligible: false, awaitingCompaction: false },
  )
  assert.deepEqual(
    t.effectivePlanState(docs[1], 1, docs, fresh, cfg, true),
    { mounted: true, explicit: undefined, auto: true, autoEligible: true, awaitingCompaction: false },
  )
  assert.deepEqual(
    t.effectivePlanState(docs[1], 1, docs, fresh, cfg, false),
    { mounted: false, explicit: undefined, auto: false, autoEligible: true, awaitingCompaction: true },
  )
  assert.equal(
    t.effectivePlanState(docs[1], 1, docs, record({ plans: { new: 'unmounted' } }), cfg, true).mounted,
    false,
  )
  assert.equal(
    t.effectivePlanState(docs[0], 0, docs, record({ plans: { old: 'mounted' } }), cfg, true).mounted,
    true,
  )
  const noAuto = { ...cfg, autoMountLatestPlan: false }
  assert.equal(t.effectivePlanState(docs[1], 1, docs, fresh, noAuto, true).mounted, false)
})

test('permission matrix and item lock', () => {
  const cfg = baseConfig()
  const decide = (policy, action, item) => t.authorizeModelAction(record({ policy }), action, item, cfg).decision

  assert.equal(decide('ask', 'add'), 'ask')
  assert.equal(decide('ask', 'mount'), 'ask')
  assert.equal(decide('ask', 'unmount'), 'ask')
  assert.equal(decide('allow-mount', 'add'), 'allow')
  assert.equal(decide('allow-mount', 'mount'), 'allow')
  assert.equal(decide('allow-mount', 'unmount'), 'ask')
  assert.equal(decide('allow-unmount', 'add'), 'ask')
  assert.equal(decide('allow-unmount', 'unmount'), 'allow')
  assert.equal(decide('allow-all', 'mount'), 'allow')
  assert.equal(decide('allow-all', 'unmount'), 'allow')
  assert.equal(decide('deny-all', 'add'), 'deny')
  assert.equal(decide('allow-all', 'unmount', { locked: true }), 'deny')
  assert.equal(decide('allow-all', 'mount', { locked: true }), 'deny')
})

test('tool argument validation enforces per-action fields', () => {
  const cfg = baseConfig()
  assert.deepEqual(t.validateToolArgs({ action: 'list' }, cfg), { action: 'list' })
  assert.equal(t.validateToolArgs({ action: 'add_file', path: 'a.ts' }, cfg).path, 'a.ts')
  assert.equal(t.validateToolArgs({ action: 'add_note', text: 'hello', title: 'T' }, cfg).title, 'T')
  assert.equal(t.validateToolArgs({ action: 'mount', itemId: 'file:x' }, cfg).itemId, 'file:x')

  assert.throws(() => t.validateToolArgs({ action: 'add_file' }, cfg))
  assert.throws(() => t.validateToolArgs({ action: 'add_note', text: '   ' }, cfg))
  assert.throws(() => t.validateToolArgs({ action: 'mount' }, cfg))
  assert.throws(() => t.validateToolArgs({ action: 'remove', itemId: 'x' }, cfg))
  assert.throws(() => t.validateToolArgs({ action: 'list', itemId: 'x' }, cfg))
  assert.throws(() => t.validateToolArgs({ action: 'add_file', path: 'a.ts', text: 'x' }, cfg))
})

test('injection composition includes mounted plans, notes, and files', () => {
  const cfg = baseConfig()
  const docs = [planDoc('old', 'Old plan', '# Old plan\nold body'), planDoc('new', 'New plan', '# New plan\nnew body')]
  const rec = record({
    plans: { old: 'mounted' },
    items: {
      'note:n1': noteItem('note:n1', { title: 'Constraint', text: 'Keep it stable.' }),
      'file:f1': fileItem('file:f1', { title: 'a.ts' }),
      'note:n2': noteItem('note:n2', { title: 'Model note', createdBy: 'model', createdAt: 3 }),
    },
  })
  const composed = t.composeGuardText({
    docs,
    record: rec,
    config: cfg,
    sawCompaction: true,
    contents: { 'file:f1': { text: 'export const a = 1', truncated: false } },
  })
  assert.ok(composed)
  for (const expected of [
    'New plan', 'new body', 'Old plan', 'old body',
    'Constraint', 'Keep it stable.', 'a.ts', 'export const a = 1',
    'Model note', 'context_guard', 'not a new request',
  ]) {
    assert.match(composed.text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.ok(composed.text.indexOf('New plan') < composed.text.indexOf('Old plan'))
  assert.ok(composed.text.indexOf('Constraint') < composed.text.indexOf('Model note'))
})

test('injection composition marks unreadable and truncated files', () => {
  const cfg = baseConfig()
  const rec = record({
    items: {
      'file:bad': fileItem('file:bad', { displayPath: 'missing.ts' }),
      'file:big': fileItem('file:big', { displayPath: 'big.ts', title: 'big.ts' }),
    },
  })
  const composed = t.composeGuardText({
    docs: [],
    record: rec,
    config: cfg,
    sawCompaction: true,
    contents: {
      'file:bad': { error: 'FS_NOT_FOUND: missing' },
      'file:big': { text: 'x'.repeat(20), truncated: true },
    },
  })
  assert.ok(composed)
  assert.match(composed.text, /file unreadable: FS_NOT_FOUND/)
  assert.match(composed.text, /file truncated at 20000 characters/)
})

test('injection composition enforces the total cap and lists omissions', () => {
  const cfg = { ...baseConfig(), maxTotalChars: 5000, maxCharsPerNote: 2000 }
  const items = {}
  for (let i = 0; i < 6; i += 1) {
    const id = `note:n${i}`
    items[id] = noteItem(id, { title: `Note ${i}`, text: 'y'.repeat(1400), size: 1400, createdAt: i })
  }
  const composed = t.composeGuardText({
    docs: [],
    record: record({ items }),
    config: cfg,
    sawCompaction: true,
  })
  assert.ok(composed)
  assert.ok(composed.omitted.length > 0)
  assert.match(composed.text, /omitted over the total cap:/)
  assert.ok(composed.included.length + composed.omitted.length === 6)
})

test('removal notices carry the title and the unique id', () => {
  const cfg = baseConfig()
  const docs = [{ ...planDoc('p1', 'Plan one', '# Plan one'), accepted: true }]
  const update = t.composeUpdate({
    pending: {
      added: {},
      removed: {
        'plan:p1': { kind: 'plan', id: 'p1', label: 'Plan one' },
        'note:noid': { kind: 'note', label: 'No id' },
      },
    },
    record: record({ plans: { p1: 'unmounted' } }),
    docs,
    config: cfg,
    sawCompaction: true,
    contents: {},
  })
  assert.ok(update)
  assert.match(update.text, /Plan "Plan one" \(p1\) is no longer guarded\./)
  assert.match(update.text, /Note "No id" is no longer guarded\./)
  assert.ok(!/undefined/.test(update.text), 'a missing id degrades to the title, never "undefined"')
})

test('plan projection folds accepted submissions and successful compactions', () => {
  const initial = t.stateInit()
  const withPlan = t.foldDocs(initial, {
    type: 'tool/call',
    data: {
      callId: 'c1',
      name: 'exit_plan_mode',
      arguments: JSON.stringify({ plan: '# Real plan\nbody' }),
      turn: 4,
    },
  })
  assert.equal(withPlan.docs.length, 1)
  assert.equal(withPlan.docs[0].title, 'Real plan')
  assert.equal(withPlan.docs[0].turn, 4)
  assert.equal(withPlan.docs[0].accepted, undefined)

  const afterCompaction = t.foldDocs(withPlan, { type: 'compaction/end', data: {} })
  assert.equal(afterCompaction.sawCompaction, true)
  assert.equal(t.foldDocs(afterCompaction, { type: 'compaction/end', data: { error: 'x' } }).sawCompaction, true)
  assert.equal(t.foldDocs(initial, { type: 'compaction/end', data: { error: 'x' } }).sawCompaction, false)
})

test('plan projection folds the accept/dismiss verdict from tool results', () => {
  const initial = t.stateInit()
  const called = t.foldDocs(initial, {
    type: 'tool/call',
    data: {
      callId: 'c1',
      name: 'exit_plan_mode',
      arguments: JSON.stringify({ plan: '# Real plan\nbody' }),
      turn: 4,
    },
  })
  const approved = t.foldDocs(called, { type: 'tool/result', data: { toolCallId: 'c1', isError: false } })
  assert.equal(approved.docs[0].accepted, true)
  assert.equal(
    t.foldDocs(approved, { type: 'tool/result', data: { toolCallId: 'c1', isError: false } }),
    approved,
    'a repeated verdict keeps the state reference',
  )
  const dismissed = t.foldDocs(called, { type: 'tool/result', data: { toolCallId: 'c1', isError: true } })
  assert.equal(dismissed.docs[0].accepted, false)
  assert.equal(called.docs[0].accepted, undefined, 'folding never mutates the incoming state')

  assert.equal(t.foldDocs(called, { type: 'tool/result', data: { toolCallId: 'unknown' } }), called)
  assert.equal(t.foldDocs(called, { type: 'tool/result', data: {} }), called)
  assert.equal(
    t.foldDocs(called, { type: 'tool/call', data: { callId: 'x', name: 'bash', arguments: '{}' } }),
    called,
  )
})

test('a dismissed plan never auto-mounts but an explicit choice still wins', () => {
  const cfg = baseConfig()
  const docs = [{ ...planDoc('p1', 'P', '# P'), accepted: false }]
  assert.deepEqual(
    t.effectivePlanState(docs[0], 0, docs, record(), cfg, true),
    { mounted: false, explicit: undefined, auto: false, autoEligible: false, awaitingCompaction: false },
  )
  assert.equal(
    t.effectivePlanState(docs[0], 0, docs, record({ plans: { p1: 'mounted' } }), cfg, true).mounted,
    true,
  )
  const approved = [{ ...planDoc('p1', 'P', '# P'), accepted: true }]
  assert.equal(t.effectivePlanState(approved[0], 0, approved, record(), cfg, true).mounted, true)
})

test('projection schema accepts the verdict and rejects junk', () => {
  const withVerdict = { docs: [{ callId: 'c', title: 'T', markdown: 'm', accepted: true }], sawCompaction: false }
  assert.deepEqual(t.stateSchema.parse(withVerdict), withVerdict)
  const legacy = { docs: [{ callId: 'c', title: 'T', markdown: 'm' }], sawCompaction: false }
  assert.deepEqual(t.stateSchema.parse(legacy), legacy)
  assert.throws(() => t.stateSchema.parse({
    docs: [{ callId: 'c', title: 'T', markdown: 'm', accepted: 'yes' }],
    sawCompaction: false,
  }))
})

test('plan titles come from the first heading, else the first line', () => {
  assert.equal(t.planDocument('c', '# Heading\ntext', 1).title, 'Heading')
  assert.equal(t.planDocument('c', 'plain first line\ntext', 1).title, 'plain first line')
  assert.equal(t.planDocument('c', '   ', 1).title, 'Untitled plan')
})

test('notes and titles normalize predictably', () => {
  assert.equal(t.normalizeTitle('  a\n b  '), 'a b')
  assert.equal(t.normalizeTitle('   '), undefined)
  assert.equal(t.titleFromText('\n\n  first line  \nsecond'), 'first line')
  assert.equal(t.titleFromText('   '), 'Note')
})

test('storage domain and table names satisfy the storage unit rule', () => {
  // `dsh-storage` requires every unit and table name to match this pattern;
  // a hyphen makes `storageDomain.open` throw during plugin activation.
  const unitName = /^[a-z][a-z0-9_]*$/
  assert.match(t.GUARD_DOMAIN_NAME, unitName)
  for (const table of Object.keys(t.guardDomainSpec.tables)) assert.match(table, unitName)
})

test('record autoPlan bookkeeping survives normalization', () => {
  assert.equal(t.normalizeRecord({}).autoPlan, null)
  assert.equal(t.normalizeRecord({ autoPlan: 'p1' }).autoPlan, 'p1')
  assert.equal(t.normalizeRecord({ autoPlan: 42 }).autoPlan, null)
  assert.equal(t.normalizeRecord({ autoPlan: '' }).autoPlan, null)
})

test('auto displacement journals the new plan and notices the old one', () => {
  const cfg = baseConfig()
  const docA = { ...planDoc('pA', 'Plan A', '# Plan A'), accepted: true }
  const docB = { ...planDoc('pB', 'Plan B', '# Plan B'), accepted: true }
  assert.deepEqual(
    t.planAutoTransition([docA], record(), cfg, true),
    { autoPlan: 'pA', addPlan: { id: 'pA', label: 'Plan A' }, removePlan: null },
  )
  assert.deepEqual(
    t.planAutoTransition([docA, docB], record({ autoPlan: 'pA' }), cfg, true),
    {
      autoPlan: 'pB',
      addPlan: { id: 'pB', label: 'Plan B' },
      removePlan: { id: 'pA', label: 'Plan A' },
    },
  )
  assert.equal(t.planAutoTransition([docA, docB], record({ autoPlan: 'pB' }), cfg, true), undefined)
  const rejectedB = { ...docB, accepted: false }
  assert.deepEqual(
    t.planAutoTransition([docA, rejectedB], record({ autoPlan: 'pA' }), cfg, true),
    { autoPlan: null, addPlan: null, removePlan: { id: 'pA', label: 'Plan A' } },
  )
  assert.equal(t.planAutoTransition([], record({ autoPlan: null }), cfg, true), undefined)
})

test('displacement never touches explicitly chosen plans', () => {
  const cfg = baseConfig()
  const docA = { ...planDoc('pA', 'Plan A', '# Plan A'), accepted: true }
  const docB = { ...planDoc('pB', 'Plan B', '# Plan B'), accepted: true }
  const kept = t.planAutoTransition([docA, docB], record({ autoPlan: 'pA', plans: { pA: 'mounted' } }), cfg, true)
  assert.equal(kept.autoPlan, 'pB')
  assert.deepEqual(kept.addPlan, { id: 'pB', label: 'Plan B' })
  assert.equal(kept.removePlan, null)
  const dropped = t.planAutoTransition([docA, docB], record({ autoPlan: 'pA', plans: { pA: 'unmounted' } }), cfg, true)
  assert.equal(dropped.removePlan, null)
  const unknownB = { ...planDoc('pB', 'Plan B', '# Plan B') }
  assert.equal(t.planAutoTransition([docA, unknownB], record({ autoPlan: 'pA' }), cfg, true).autoPlan, 'pB')
  assert.equal(t.planAutoTransition([docA], record(), cfg, false), undefined)
})

test('pending journal coalesces by key and stays bounded', () => {
  const added = t.applyPending(undefined, { action: 'added', key: 'note:a', kind: 'note', id: 'note:a', label: 'A' })
  assert.deepEqual(added.added['note:a'], { kind: 'note', id: 'note:a', label: 'A' })
  const removed = t.applyPending(added, { action: 'removed', key: 'note:a', kind: 'note', id: 'note:a', label: 'A' })
  assert.deepEqual(removed.added, {})
  assert.deepEqual(removed.removed['note:a'], { kind: 'note', id: 'note:a', label: 'A' })
  const readded = t.applyPending(removed, { action: 'added', key: 'note:a', kind: 'note', id: 'note:a', label: 'A' })
  assert.deepEqual(readded.removed, {})
  assert.ok(readded.added['note:a'])

  let pending
  for (let i = 0; i < 205; i += 1) {
    pending = t.applyPending(pending, { action: 'added', key: `note:${i}`, kind: 'note', id: `note:${i}`, label: `N${i}` })
  }
  const keys = Object.keys(pending.added)
  assert.equal(keys.length, 200)
  assert.equal(keys[0], 'note:5')
})

test('incremental update reports removals as one sentence and adds content', () => {
  const cfg = baseConfig()
  const docs = [planDoc('p1', 'Plan one', '# Plan one')]
  const rec = record({
    plans: { p1: 'mounted' },
    items: {
      'note:n1': noteItem('note:n1', { title: 'Keep API', text: 'Do not rename.', size: 13 }),
      'file:f1': fileItem('file:f1'),
    },
  })
  const pending = {
    added: {
      'note:n1': { kind: 'note', id: 'note:n1', label: 'Keep API' },
      'plan:p1': { kind: 'plan', id: 'p1', label: 'Plan one' },
      'file:f1': { kind: 'file', id: 'file:f1', label: 'src/a.ts' },
    },
    removed: {
      'note:old': { kind: 'note', id: 'note:old', label: 'Old note' },
      'file:gone': { kind: 'file', id: 'file:gone', label: 'src/gone.ts' },
    },
  }
  const update = t.composeUpdate({
    pending,
    record: rec,
    docs,
    config: cfg,
    sawCompaction: true,
    contents: { 'file:f1': { text: 'export const a = 1', truncated: false } },
  })
  assert.ok(update)
  assert.match(update.text, /— update/)
  assert.match(update.text, /Note "Old note" \(note:old\) is no longer guarded\./)
  assert.match(update.text, /File src\/gone\.ts \(file:gone\) is no longer guarded\./)
  assert.ok(!/Note "Keep API" is no longer guarded/.test(update.text))
  for (const expected of ['## Note: Keep API', 'Do not rename.', '## File: src/a.ts', 'export const a = 1', '## Plan: Plan one']) {
    assert.match(update.text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.equal(update.added.length, 3)
  assert.equal(update.removed.length, 2)
})

test('incremental update drops changes that no longer hold', () => {
  const cfg = baseConfig()
  const rec = record({ items: { 'note:n1': noteItem('note:n1', { mounted: false }) } })
  const update = t.composeUpdate({
    pending: { added: { 'note:n1': { kind: 'note', id: 'note:n1', label: 'A' } }, removed: {} },
    record: rec,
    docs: [],
    config: cfg,
    sawCompaction: true,
    contents: {},
  })
  assert.equal(update, undefined)

  const readded = t.composeUpdate({
    pending: { added: {}, removed: { 'note:n1': { kind: 'note', id: 'note:n1', label: 'A' } } },
    record: record({ items: { 'note:n1': noteItem('note:n1') } }),
    docs: [],
    config: cfg,
    sawCompaction: true,
    contents: {},
  })
  assert.equal(readded, undefined, 'a removal that was undone reports nothing')
})

test('incremental update respects the total cap', () => {
  const cfg = { ...baseConfig(), maxTotalChars: 5000, maxCharsPerNote: 2000 }
  const items = {}
  const added = {}
  for (let i = 0; i < 6; i += 1) {
    const id = `note:n${i}`
    items[id] = noteItem(id, { title: `Note ${i}`, text: 'y'.repeat(1400), size: 1400, createdAt: i })
    added[id] = { kind: 'note', id, label: `Note ${i}` }
  }
  const update = t.composeUpdate({
    pending: { added, removed: {} },
    record: record({ items }),
    docs: [],
    config: cfg,
    sawCompaction: true,
    contents: {},
  })
  assert.ok(update)
  assert.match(update.text, /omitted over the total cap:/)
  assert.ok(update.added.length < 6)
})
