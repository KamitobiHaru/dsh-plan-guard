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

  const afterCompaction = t.foldDocs(withPlan, { type: 'compaction/end', data: {} })
  assert.equal(afterCompaction.sawCompaction, true)
  assert.equal(t.foldDocs(afterCompaction, { type: 'compaction/end', data: { error: 'x' } }).sawCompaction, true)
  assert.equal(t.foldDocs(initial, { type: 'compaction/end', data: { error: 'x' } }).sawCompaction, false)
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
