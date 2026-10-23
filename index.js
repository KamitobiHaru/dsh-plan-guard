/**
 * dsh-plan-guard Host half: guarded-context projection, storage, the
 * `context_guard` tool, Remote methods, and post-compaction re-injection.
 *
 * A plan document is one accepted `exit_plan_mode` submission keyed by its
 * tool call id, derived from logged session events. Notes and files are items
 * stored in the plugin's storage domain. After each successful compaction the
 * latest plan (unless the human dismissed it) and every mounted item re-enter
 * the model surface through one `agent/pre-step` message splice, which the
 * agent loop logs as a durable `user/message` event.
 *
 * The Web drawer and the model tool share one set of operations. The tool is
 * the only model-facing entry point; the drawer is human-only and ignores the
 * session permission mode.
 * @module dsh-plan-guard
 */

import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, relative } from 'node:path'

/** Cordis plugin name. */
export const name = 'plan-guard'
/** Framework services this Host half requires. */
export const inject = ['sessionProjections', 'storageDomain', 'tools', 'agents']

/** Projection key this plugin owns for per-session plan-derivation state. */
export const PLAN_DOCS_PROJECTION_KEY = 'plan-guard-docs'
/** Cordis service key this plugin provides; also the wire namespace. */
export const SERVICE_KEY = 'plan-guard'
/** Storage domain this plugin owns. */
export const GUARD_DOMAIN_NAME = 'plan_guard'
/** Merge-extensible MessageSourceMap `kind` (consumers fall through unknown kinds). */
export const SOURCE_KIND = 'plan-guard'
/** Model-facing tool name. */
export const TOOL_NAME = 'context_guard'
/** Tool whose `arguments.plan` is the plan markdown. */
const PLAN_TOOL = 'exit_plan_mode'
/** Remote descriptor marker recorded by the Typert `@Remote` decorator. */
const REMOTE_MARKER_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Closed session permission-mode vocabulary. */
export const POLICIES = Object.freeze(['ask', 'allow-mount', 'allow-unmount', 'allow-all', 'deny-all'])
/** Closed explicit plan-choice vocabulary; absence means the auto rule applies. */
export const PLAN_CHOICES = Object.freeze(['mounted', 'unmounted', 'auto'])
/** Closed tool action vocabulary. */
export const TOOL_ACTIONS = Object.freeze(['list', 'add_file', 'add_note', 'mount', 'unmount'])

const DEFAULT_CONFIG = {
  /** Global switch; while true the plugin never injects. */
  disabled: false,
  /** Whether to register the model-facing tool. */
  toolEnabled: true,
  /** Injected message header line. */
  header: 'Guarded context (plans, notes, files)',
  /** Per-plan injectable character cap; a longer plan truncates with a marker. */
  maxCharsPerPlan: 20000,
  /** Per-file injectable character cap. */
  maxCharsPerFile: 20000,
  /** Per-note injectable character cap. */
  maxCharsPerNote: 20000,
  /** Total injected character cap across plans and items. */
  maxTotalChars: 100000,
  /** Maximum number of stored notes/files (plans are derived, not counted). */
  maxItems: 24,
  /** Permission mode for Sessions without a stored choice. */
  defaultPolicy: 'ask',
  /** Auto-mount the newest plan once the Session has compacted. */
  autoMountLatestPlan: true,
  /** Foreground permission-question timeout in milliseconds. */
  askTimeoutMs: 120000,
  /** Allow file items whose absolute path is outside the Session workspace. */
  allowOutsideWorkspace: false,
  /** Character cap for the file preview returned by `add_file`. */
  previewChars: 4000,
}

const CONFIG_FIELD_LIMITS = {
  maxCharsPerPlan: [1000, 200000],
  maxCharsPerFile: [1000, 200000],
  maxCharsPerNote: [1000, 200000],
  maxTotalChars: [5000, 1000000],
  maxItems: [1, 100],
  askTimeoutMs: [5000, 600000],
  previewChars: [500, 20000],
}

const CONFIG_BOOLEAN_FIELDS = ['disabled', 'toolEnabled', 'autoMountLatestPlan', 'allowOutsideWorkspace']

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0
/** Own-record item lookup; never walks Object.prototype for a hostile id. */
const ownItem = (record, id) => (Object.hasOwn(record.items, id) ? record.items[id] : undefined)
/** Empty change journal for the guarded set. */
const emptyPending = () => ({ added: {}, removed: {} })
/** Shallow copy of the journal's two buckets. */
const clonePending = (pending) => ({
  added: { ...(pending?.added ?? {}) },
  removed: { ...(pending?.removed ?? {}) },
})
/** Kinds a pending change can name; anything else is dropped on read. */
const PENDING_KINDS = new Set(['plan', 'file', 'note'])
/** Bound on the journal so a long offline gap cannot grow the record. */
const PENDING_LIMIT = 200

const cloneRecord = (record) => ({
  version: 2,
  policy: record.policy,
  plans: { ...record.plans },
  items: { ...record.items },
  pending: clonePending(record.pending),
})

/**
 * Record one change in the pending journal, coalescing by key: the newest
 * action wins, so add-then-remove leaves nothing to report and a removal that
 * is immediately undone never reaches the model.
 * @param pending - current journal, possibly missing on a legacy record.
 * @param change - `{ action: 'added'|'removed', key, kind, id, label }`.
 * @returns a new journal, capped at `PENDING_LIMIT` entries.
 */
export function applyPending(pending, change) {
  const next = clonePending(pending)
  const entry = { kind: change.kind, id: change.id, label: String(change.label).slice(0, 200) }
  if (change.action === 'added') {
    delete next.removed[change.key]
    next.added[change.key] = entry
  } else {
    delete next.added[change.key]
    next.removed[change.key] = entry
  }
  return trimPending(next)
}

/** Drop the oldest journal entries once the cap is exceeded. */
function trimPending(pending) {
  let total = Object.keys(pending.added).length + Object.keys(pending.removed).length
  while (total > PENDING_LIMIT) {
    const bucket = Object.keys(pending.added).length > 0 ? pending.added : pending.removed
    const oldest = Object.keys(bucket)[0]
    if (oldest === undefined) break
    delete bucket[oldest]
    total -= 1
  }
  return pending
}

/**
 * Validate one raw loader-row config, applying defaults.
 * @param value - raw config from the loader row, possibly undefined.
 * @returns a Standard Schema v1 result: `{ value }` or `{ issues }`.
 */
export function validateConfig(value) {
  if (value !== undefined && value !== null && !isRecord(value)) {
    return { issues: [{ message: 'plan-guard config must be an object' }] }
  }
  const record = isRecord(value) ? value : {}
  const resolved = { ...DEFAULT_CONFIG }
  const issues = []
  const pushIssue = (message) => { issues.push({ message }) }
  for (const [field, [min, max]] of Object.entries(CONFIG_FIELD_LIMITS)) {
    const raw = record[field]
    if (raw === undefined) continue
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
      pushIssue(`${field} must be an integer from ${min} through ${max}`)
      continue
    }
    resolved[field] = raw
  }
  for (const field of CONFIG_BOOLEAN_FIELDS) {
    const raw = record[field]
    if (raw === undefined) continue
    if (typeof raw !== 'boolean') pushIssue(`${field} must be a boolean`)
    else resolved[field] = raw
  }
  if (record.defaultPolicy !== undefined) {
    if (typeof record.defaultPolicy !== 'string' || !POLICIES.includes(record.defaultPolicy)) {
      pushIssue(`defaultPolicy must be one of ${POLICIES.join(', ')}`)
    } else {
      resolved.defaultPolicy = record.defaultPolicy
    }
  }
  if (record.header !== undefined) {
    if (!isNonEmptyString(record.header) || record.header.length > 200) {
      pushIssue('header must be a non-empty string of at most 200 characters')
    } else {
      resolved.header = record.header
    }
  }
  for (const key of Object.keys(record)) {
    if (!(key in DEFAULT_CONFIG)) pushIssue(`unknown config field ${JSON.stringify(key)}`)
  }
  return issues.length > 0 ? { issues } : { value: resolved }
}

/**
 * Standard Schema v1 validating face (the Loader reads `Config['~standard']`
 * only). Hand-rolled: the bundle imports nothing beyond Node builtins.
 */
export const Config = {
  '~standard': {
    version: 1,
    validate(value) { return validateConfig(value) },
  },
}

// #region projection — plan documents derived from logged events

/**
 * Per-session projected state. Plain JSON by the projection contract: each doc
 * carries the bounded full markdown so both the drawer and the injector read it
 * without re-scanning the log; `sawCompaction` records that this session had at
 * least one successful compaction, the point where guarding starts to matter.
 */
const stateInit = () => ({ docs: [], sawCompaction: false })

/** Validates prior state before it seeds a fold from a persisted cache row. */
const stateSchema = {
  parse(value) {
    if (!isRecord(value) || !Array.isArray(value.docs) || typeof value.sawCompaction !== 'boolean') {
      throw new Error('plan-guard projection state does not match its shape')
    }
    for (const doc of value.docs) {
      if (!isRecord(doc) || !isNonEmptyString(doc.callId) || !isNonEmptyString(doc.title)
        || typeof doc.markdown !== 'string') {
        throw new Error('plan-guard projection document does not match its shape')
      }
    }
    return value
  },
}

/**
 * One plan document reduced from an accepted submission. The text is stored
 * capped with a tail marker so the projection state cannot grow without limit.
 */
export function planDocument(callId, markdown, turn) {
  const capped = markdown.length > 65536
    ? `${markdown.slice(0, 65536)}\n[plan-guard: plan stored truncated past 65536 characters]`
    : markdown
  const heading = /^#\s+(\S[^\r\n]*)/.exec(capped.trim())?.[1]
  const firstLine = /^[^\r\n]*/.exec(capped.trim())[0]
  const title = (heading ?? firstLine).trim() || 'Untitled plan'
  return { callId, turn, title, markdown: capped }
}

/** Read one plan from a native `tool/call` event's untrusted logged arguments. */
function planFromNativeCall(data) {
  if (!isRecord(data) || data.name !== PLAN_TOOL || typeof data.arguments !== 'string') return undefined
  let args
  try { args = JSON.parse(data.arguments) } catch (_error) { return undefined }
  if (!isRecord(args) || typeof args.plan !== 'string' || args.plan === '') return undefined
  return planDocument(String(data.callId), args.plan, data.turn)
}

/** Read one plan from a PTC `run_code` sub-dispatch start event. */
function planFromPtcDispatchStart(data) {
  if (!isRecord(data) || data.name !== PLAN_TOOL || !isRecord(data.arguments)
    || typeof data.arguments.plan !== 'string' || data.arguments.plan === ''
    || !isNonEmptyString(data.subCallId)) {
    return undefined
  }
  return planDocument(data.subCallId, data.arguments.plan, undefined)
}

/**
 * Pure synchronous fold (projection contract): return the same reference when
 * the event is not this unit's, and never mutate the incoming state.
 */
export function foldDocs(state, event) {
  // A successful compaction end (manual or automatic) switches guarding on.
  if (event.type === 'compaction/end' && event.data?.error === undefined) {
    return state.sawCompaction === true ? state : { ...state, sawCompaction: true }
  }
  const plan = event.type === 'tool/call'
    ? planFromNativeCall(event.data)
    : event.type === 'tool/ptc-dispatch-start' ? planFromPtcDispatchStart(event.data) : undefined
  if (plan === undefined) return state
  if (state.docs.some(doc => doc.callId === plan.callId)) return state
  return { ...state, docs: [...state.docs, plan] }
}

// #endregion

// #region storage — per-session guarded-context record v2

/** Title cleanup for stored items: one trimmed line, bounded length. */
function normalizeTitle(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().replace(/\s+/g, ' ').slice(0, 200)
  return normalized === '' ? undefined : normalized
}

/** Title derived from a note body when the author omitted one. */
function titleFromText(text) {
  const first = text.split(/\r?\n/).map(line => line.trim()).find(line => line !== '')
  return (first === undefined ? undefined : normalizeTitle(first)) ?? 'Note'
}

/** Readable message for a typed filesystem/plugin failure. */
function describeError(error) {
  if (isRecord(error) && typeof error.code === 'string') {
    const message = typeof error.message === 'string' ? error.message : ''
    return `${error.code}${message === '' ? '' : `: ${message}`}`
  }
  return error instanceof Error ? error.message : String(error)
}

/** Strictly normalize one stored item; throws so the domain backs the record up. */
function normalizeItemStrict(id, raw) {
  if (!isRecord(raw)) throw new Error(`guarded item ${JSON.stringify(id)} is not an object`)
  const kind = raw.kind
  if (kind !== 'file' && kind !== 'note') throw new Error(`guarded item ${id} has an unknown kind`)
  const prefix = kind === 'file' ? 'file:' : 'note:'
  if (!id.startsWith(prefix)) throw new Error(`guarded item ${id} does not match its kind`)
  if (!isNonEmptyString(raw.title)) throw new Error(`guarded item ${id} has no title`)
  if (typeof raw.mounted !== 'boolean' || typeof raw.locked !== 'boolean') {
    throw new Error(`guarded item ${id} has invalid flags`)
  }
  if (raw.createdBy !== 'human' && raw.createdBy !== 'model') {
    throw new Error(`guarded item ${id} has an invalid creator`)
  }
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) {
    throw new Error(`guarded item ${id} has an invalid creation time`)
  }
  if (typeof raw.size !== 'number' || !Number.isFinite(raw.size) || raw.size < 0) {
    throw new Error(`guarded item ${id} has an invalid size`)
  }
  if (kind === 'note') {
    if (typeof raw.text !== 'string' || raw.text === '') throw new Error(`guarded note ${id} has no text`)
    return {
      id,
      kind,
      title: raw.title,
      text: raw.text,
      size: raw.size,
      mounted: raw.mounted,
      locked: raw.locked,
      createdBy: raw.createdBy,
      createdAt: raw.createdAt,
    }
  }
  for (const field of ['path', 'displayPath', 'workspaceRoot']) {
    if (!isNonEmptyString(raw[field])) throw new Error(`guarded file ${id} has no ${field}`)
  }
  return {
    id,
    kind,
    title: raw.title,
    path: raw.path,
    displayPath: raw.displayPath,
    workspaceRoot: raw.workspaceRoot,
    size: raw.size,
    mounted: raw.mounted,
    locked: raw.locked,
    createdBy: raw.createdBy,
    createdAt: raw.createdAt,
  }
}

/** Lenient journal normalization: malformed entries are dropped, never fatal. */
function normalizePending(raw) {
  const pending = emptyPending()
  if (!isRecord(raw)) return pending
  for (const bucket of ['added', 'removed']) {
    const source = raw[bucket]
    if (!isRecord(source)) continue
    for (const [key, entry] of Object.entries(source)) {
      if (key === '' || !isRecord(entry)) continue
      if (!PENDING_KINDS.has(entry.kind)) continue
      if (!isNonEmptyString(entry.id) || !isNonEmptyString(entry.label)) continue
      pending[bucket][key] = { kind: entry.kind, id: entry.id, label: entry.label.slice(0, 200) }
    }
  }
  return pending
}

/**
 * Strict record normalization used by the storage domain's load schema and by
 * reads. Legacy `{ guarded: { id: true } }` records are accepted as explicit
 * mounted plan choices; a missing policy falls back to the configured default.
 */
export function normalizeRecord(raw) {
  if (!isRecord(raw)) throw new Error('plan-guard guard record is not an object')
  if (raw.version !== undefined && raw.version !== 2) {
    throw new Error('plan-guard guard record has an unsupported version')
  }
  const plans = {}
  if (raw.plans !== undefined) {
    if (!isRecord(raw.plans)) throw new Error('plan-guard plan choices are not an object')
    for (const [callId, choice] of Object.entries(raw.plans)) {
      if (choice !== 'mounted' && choice !== 'unmounted') {
        throw new Error(`plan-guard plan choice for ${callId} is invalid`)
      }
      plans[callId] = choice
    }
  } else if (raw.guarded !== undefined) {
    if (!isRecord(raw.guarded)) throw new Error('plan-guard legacy guarded flags are not an object')
    for (const [callId, flag] of Object.entries(raw.guarded)) {
      if (flag !== true) throw new Error('plan-guard legacy guarded flags accept only true')
      plans[callId] = 'mounted'
    }
  }
  let policy
  if (raw.policy !== undefined) {
    if (typeof raw.policy !== 'string' || !POLICIES.includes(raw.policy)) {
      throw new Error('plan-guard permission policy is invalid')
    }
    policy = raw.policy
  }
  const items = {}
  if (raw.items !== undefined) {
    if (!isRecord(raw.items)) throw new Error('plan-guard items are not an object')
    for (const [id, item] of Object.entries(raw.items)) items[id] = normalizeItemStrict(id, item)
  }
  return { version: 2, policy, plans, items, pending: normalizePending(raw.pending) }
}

const guardRecordSchema = { parse(value) { return normalizeRecord(value) } }

/** Domain declaration handed to `ctx.storageDomain.open` (structural spec shape). */
const guardDomainSpec = {
  name: GUARD_DOMAIN_NAME,
  version: 1,
  invalidRecords: 'backup-and-skip',
  tables: { sessions: { valueSchema: guardRecordSchema } },
}

/** Effective record for a Session; missing records inherit the configured policy. */
function readRecord(domain, config, sessionId) {
  const raw = domain.table('sessions').get(String(sessionId))
  if (raw === undefined) {
    return { version: 2, policy: config.defaultPolicy, plans: {}, items: {}, pending: emptyPending() }
  }
  return {
    version: 2,
    policy: raw.policy ?? config.defaultPolicy,
    plans: raw.plans ?? {},
    items: raw.items ?? {},
    pending: clonePending(raw.pending),
  }
}

// #endregion

// #region plan state

/**
 * Effective mount state for one plan document.
 * An explicit human choice wins; otherwise the newest plan auto-mounts only
 * after the first successful compaction (when `autoMountLatestPlan` is on).
 */
export function effectivePlanState(doc, index, docs, record, config, sawCompaction) {
  const explicit = record.plans[doc.callId]
  const isLatest = index === docs.length - 1
  const autoEligible = isLatest && config.autoMountLatestPlan === true
  if (explicit === 'mounted' || explicit === 'unmounted') {
    return {
      mounted: explicit === 'mounted',
      explicit,
      auto: false,
      autoEligible,
      awaitingCompaction: false,
    }
  }
  const mounted = autoEligible && sawCompaction === true
  return {
    mounted,
    explicit: undefined,
    auto: mounted,
    autoEligible,
    awaitingCompaction: autoEligible && sawCompaction !== true,
  }
}

// #endregion

// #region permission

/**
 * Decide a model action against the Session policy and the item lock.
 * `action` is `add` (new item, implies mount), `mount`, or `unmount`.
 * @returns `{ decision: 'allow'|'ask'|'deny', reason }`.
 */
export function authorizeModelAction(record, action, item, config) {
  const policy = record.policy ?? config.defaultPolicy
  if (item !== undefined && item.locked === true) {
    return { decision: 'deny', reason: 'This item is locked by the user; the model cannot mount or unmount it.' }
  }
  if (policy === 'deny-all') {
    return { decision: 'deny', reason: 'The Session permission mode denies all model changes to guarded context.' }
  }
  if (policy === 'allow-all') return { decision: 'allow', reason: '' }
  const needsMount = action === 'add' || action === 'mount'
  if (policy === 'ask') {
    return { decision: 'ask', reason: 'The Session permission mode asks the user before model mount or unmount changes.' }
  }
  if (policy === 'allow-mount') {
    return needsMount
      ? { decision: 'allow', reason: '' }
      : { decision: 'ask', reason: 'The Session permission mode allows model mounts but asks before an unmount.' }
  }
  if (policy === 'allow-unmount') {
    return needsMount
      ? { decision: 'ask', reason: 'The Session permission mode allows model unmounts but asks before a mount.' }
      : { decision: 'allow', reason: '' }
  }
  return { decision: 'deny', reason: 'The Session permission mode is unknown; model changes are denied.' }
}

// #endregion

// #region tool arguments

function requireStringArg(args, field, min, max) {
  const value = args[field]
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new Error(`${field} must be a string from ${min} through ${max} characters`)
  }
  if (min > 0 && value.trim() === '') throw new Error(`${field} must not be blank`)
  return value
}

function optionalStringArg(args, field, max) {
  const value = args[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > max) {
    throw new Error(`${field} must be a string of at most ${max} characters`)
  }
  return value
}

/**
 * Validate and normalize one `context_guard` call. The tool runtime does not
 * validate raw tool arguments, so every action enforces its own fields here.
 */
export function validateToolArgs(args, config) {
  if (!isRecord(args)) throw new Error('context_guard arguments must be an object')
  const action = args.action
  if (typeof action !== 'string' || !TOOL_ACTIONS.includes(action)) {
    throw new Error(`action must be one of ${TOOL_ACTIONS.join(', ')}`)
  }
  const allowed = {
    list: ['action'],
    add_file: ['action', 'path', 'title'],
    add_note: ['action', 'text', 'title'],
    mount: ['action', 'itemId'],
    unmount: ['action', 'itemId'],
  }[action]
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`argument ${JSON.stringify(key)} is not valid for action ${action}`)
  }
  if (action === 'list') return { action }
  if (action === 'add_file') {
    return {
      action,
      path: requireStringArg(args, 'path', 1, 4096),
      title: optionalStringArg(args, 'title', 200),
    }
  }
  if (action === 'add_note') {
    const text = requireStringArg(args, 'text', 1, config.maxCharsPerNote)
    return { action, text, title: optionalStringArg(args, 'title', 200) }
  }
  return { action, itemId: requireStringArg(args, 'itemId', 1, 200) }
}

// #endregion

// #region text composition

/** Read a text file up to `cap` characters, stopping the backend stream. */
async function readTextCapped(fs, target, cap, signal) {
  let text = ''
  let truncated = false
  const stream = await fs.streamText(target, signal)
  for await (const chunk of stream) {
    if (typeof chunk !== 'string' || chunk === '') continue
    if (text.length + chunk.length > cap) {
      text += chunk.slice(0, Math.max(0, cap - text.length))
      truncated = true
      break
    }
    text += chunk
    if (signal?.aborted === true) throw signal.reason ?? new Error('aborted')
  }
  return { text, truncated }
}

/** One plan document as an injected section. */
function planSectionText(doc, config) {
  const body = doc.markdown.length > config.maxCharsPerPlan
    ? `${doc.markdown.slice(0, config.maxCharsPerPlan)}\n[plan-guard: plan truncated at ${config.maxCharsPerPlan} characters]`
    : doc.markdown
  return `## Plan: ${doc.title}\nplan: ${doc.callId}\n\n${body}`
}

/** One note or file as an injected section, with its unreadable/truncated markers. */
function itemSectionText(item, config, contents) {
  if (item.kind === 'note') {
    const body = item.text.length > config.maxCharsPerNote
      ? `${item.text.slice(0, config.maxCharsPerNote)}\n[plan-guard: note truncated at ${config.maxCharsPerNote} characters]`
      : item.text
    return `## Note: ${item.title}\nitem: ${item.id}\n\n${body}`
  }
  const content = contents?.[item.id]
  let body
  if (content === undefined) {
    body = '[plan-guard: file content unavailable]'
  } else if (content.error !== undefined) {
    body = `[plan-guard: file unreadable: ${content.error}]`
  } else {
    body = content.text ?? ''
    if (content.truncated === true) body += `\n[plan-guard: file truncated at ${config.maxCharsPerFile} characters]`
  }
  return `## File: ${item.displayPath}\nitem: ${item.id}\n\n${body}`
}

/**
 * Compose the full guarded-context snapshot (sent after a compaction, or the
 * first time anything is guarded). Pure apart from the file contents the caller
 * already read; returns undefined when nothing is mounted.
 */
export function composeGuardText({ docs, record, config, sawCompaction, contents }) {
  const mountedPlans = docs
    .map((doc, index) => ({ doc, state: effectivePlanState(doc, index, docs, record, config, sawCompaction) }))
    .filter(entry => entry.state.mounted)
    .reverse()
  const items = Object.values(record.items).filter(item => item.mounted === true)
  const humanItems = items.filter(item => item.createdBy === 'human').sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const modelItems = items.filter(item => item.createdBy !== 'human').sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const sections = []
  const omitted = []
  const included = []
  const header = `${config.header}\n`
    + 'This block is background context, not a new request; it is sent again after each successful compaction and whenever the guarded set changes.\n\n'
  const footer = config.toolEnabled === false
    ? '\n\nPlans and pinned items are managed by the user in the Guarded context drawer.\n'
    : '\n\nUse the `context_guard` tool to list, mount, unmount, or add notes/files. Plans are user-controlled.\n'
  let used = header.length + footer.length
  if (used >= config.maxTotalChars) return undefined
  const push = (id, section) => {
    if (used + section.length + 2 > config.maxTotalChars) {
      omitted.push(id)
      return
    }
    used += section.length + 2
    sections.push(section)
    included.push(id)
  }
  for (const { doc } of mountedPlans) push(doc.callId, planSectionText(doc, config))
  for (const item of [...humanItems, ...modelItems]) push(item.id, itemSectionText(item, config, contents))
  if (sections.length === 0) return undefined
  const omittedLine = omitted.length === 0
    ? ''
    : `\n[plan-guard: omitted over the total cap: ${omitted.join(', ')}]`
  return {
    text: header + sections.join('\n\n') + omittedLine + footer,
    included,
    omitted,
  }
}

/** How a removal notice names one journal entry. */
function removalNoun(entry) {
  if (entry.kind === 'plan') return `Plan "${entry.label}"`
  if (entry.kind === 'note') return `Note "${entry.label}"`
  return `File ${entry.label}`
}

/**
 * Compose the incremental message for changes since the last delivery: one
 * sentence per removal, then the added content in the same section format the
 * snapshot uses. Append-only by design, so the request prefix stays cached.
 * @returns `{ text, added, removed }`, or undefined when nothing is worth sending.
 */
export function composeUpdate({ pending, record, docs, config, sawCompaction, contents }) {
  const planIndex = new Map(docs.map((doc, index) => [doc.callId, { doc, index }]))
  const isGuarded = (entry) => {
    if (entry.kind === 'plan') {
      const found = planIndex.get(entry.id)
      if (found === undefined) return false
      return effectivePlanState(found.doc, found.index, docs, record, config, sawCompaction).mounted
    }
    const item = ownItem(record, entry.id)
    return item !== undefined && item.mounted === true
  }
  const removedLines = Object.values(pending?.removed ?? {})
    .filter(entry => !isGuarded(entry))
    .map(entry => `${removalNoun(entry)} is no longer guarded.`)
  const addedPlanIds = new Set()
  const addedItemIds = new Set()
  for (const entry of Object.values(pending?.added ?? {})) {
    if (!isGuarded(entry)) continue
    if (entry.kind === 'plan') addedPlanIds.add(entry.id)
    else addedItemIds.add(entry.id)
  }
  const addedItems = Object.values(record.items)
    .filter(item => addedItemIds.has(item.id) && item.mounted === true)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const addedPlans = docs.filter(doc => addedPlanIds.has(doc.callId)).reverse()
  if (removedLines.length === 0 && addedPlans.length === 0 && addedItems.length === 0) return undefined

  const removedText = removedLines.length === 0 ? '' : `${removedLines.join(' ')}\n\n`
  const prefix = `${config.header} — update\nBackground context, not a new request.\n\n${removedText}`
  let used = prefix.length
  const sections = []
  const omitted = []
  const included = []
  const push = (id, section) => {
    if (used + section.length + 2 > config.maxTotalChars) {
      omitted.push(id)
      return
    }
    used += section.length + 2
    sections.push(section)
    included.push(id)
  }
  for (const doc of addedPlans) push(doc.callId, planSectionText(doc, config))
  for (const item of addedItems) push(item.id, itemSectionText(item, config, contents))
  const omittedLine = omitted.length === 0
    ? ''
    : `\n[plan-guard: omitted over the total cap: ${omitted.join(', ')}]`
  return {
    text: prefix + sections.join('\n\n') + omittedLine,
    added: included,
    removed: removedLines,
  }
}

// #endregion

// #region operations

/**
 * Build the shared Host operations used by the Remote service, the tool, and
 * the injector. Writes are serialized per Session so the drawer and the tool
 * cannot lose each other's read-modify-write.
 */
function createOperations(ctx, domain, projections, sessions, config) {
  const queues = new Map()
  const serialize = (sessionId, task) => {
    const key = String(sessionId)
    const previous = queues.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    const settled = run.then(() => undefined, () => undefined)
    queues.set(key, settled)
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key)
    })
    return run
  }

  const read = (sessionId) => readRecord(domain, config, sessionId)
  const liveSession = (sessionId) => sessions?.get(String(sessionId))
  const requireLive = (sessionId) => {
    const session = liveSession(sessionId)
    if (session === undefined) throw new Error('The Session is not live in the Host. Resume it first.')
    return session
  }
  const mutate = (sessionId, fn) => serialize(sessionId, async () => {
    const current = read(sessionId)
    const next = await fn(current)
    if (next === undefined) return { record: current, changed: false }
    await domain.table('sessions').put(String(sessionId), next)
    return { record: next, changed: true }
  })
  /** Journal one guarded-set change on the record being written. */
  const journal = (next, action, key, kind, id, label) => {
    next.pending = applyPending(next.pending ?? emptyPending(), { action, key, kind, id, label })
    return next
  }
  /** Display label a removal notice can still use after the entry is gone. */
  const itemLabel = (item) => (item.kind === 'file' ? item.displayPath : item.title)

  const findFileItem = (record, absolutePath) => Object.values(record.items)
    .find(item => item.kind === 'file' && item.path === absolutePath)

  const state = (sessionId) => {
    const session = liveSession(sessionId)
    const limits = {
      maxItems: config.maxItems,
      maxCharsPerPlan: config.maxCharsPerPlan,
      maxCharsPerFile: config.maxCharsPerFile,
      maxCharsPerNote: config.maxCharsPerNote,
      maxTotalChars: config.maxTotalChars,
      previewChars: config.previewChars,
    }
    if (session === undefined) {
      return {
        live: false,
        policy: null,
        defaultPolicy: config.defaultPolicy,
        sawCompaction: false,
        plans: [],
        items: [],
        limits,
      }
    }
    const projected = projections.stateOf(session, PLAN_DOCS_PROJECTION_KEY)
    const docs = projected?.docs ?? []
    const sawCompaction = projected?.sawCompaction === true
    const record = read(sessionId)
    const plans = docs.map((doc, index) => {
      const effective = effectivePlanState(doc, index, docs, record, config, sawCompaction)
      return {
        callId: doc.callId,
        title: doc.title,
        size: doc.markdown.length,
        turn: doc.turn ?? null,
        mounted: effective.mounted,
        explicit: effective.explicit ?? null,
        auto: effective.auto,
        autoEligible: effective.autoEligible,
        awaitingCompaction: effective.awaitingCompaction,
      }
    })
    const items = Object.values(record.items)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(item => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        path: item.kind === 'file' ? item.displayPath : null,
        size: item.size,
        mounted: item.mounted,
        locked: item.locked,
        createdBy: item.createdBy,
        createdAt: item.createdAt,
      }))
    return {
      live: true,
      policy: record.policy,
      defaultPolicy: config.defaultPolicy,
      sawCompaction,
      plans,
      items,
      limits,
    }
  }

  const setPolicy = (sessionId, policy) => {
    requireLive(sessionId)
    if (typeof policy !== 'string' || !POLICIES.includes(policy)) {
      throw new Error(`policy must be one of ${POLICIES.join(', ')}`)
    }
    return mutate(sessionId, (current) => ({ ...cloneRecord(current), policy }))
  }

  const setPlan = (sessionId, callId, choice) => {
    const session = requireLive(sessionId)
    if (typeof choice !== 'string' || !PLAN_CHOICES.includes(choice)) {
      throw new Error(`plan choice must be one of ${PLAN_CHOICES.join(', ')}`)
    }
    const projected = projections.stateOf(session, PLAN_DOCS_PROJECTION_KEY)
    const docs = projected?.docs ?? []
    const sawCompaction = projected?.sawCompaction === true
    const index = docs.findIndex(doc => doc.callId === callId)
    if (index < 0) {
      throw new Error(`No plan document with call id ${JSON.stringify(callId)} in this Session.`)
    }
    const doc = docs[index]
    return mutate(sessionId, (current) => {
      const before = effectivePlanState(doc, index, docs, current, config, sawCompaction)
      const next = cloneRecord(current)
      if (choice === 'auto') delete next.plans[callId]
      else next.plans[callId] = choice
      const after = effectivePlanState(doc, index, docs, next, config, sawCompaction)
      if (before.mounted === after.mounted) {
        // `auto` clears an explicit choice without flipping the effective state;
        // that is a real write but needs no journal entry, and the same choice
        // written twice is not a change at all.
        const sameChoice = choice === 'auto'
          ? current.plans[callId] === undefined
          : current.plans[callId] === choice
        return sameChoice ? undefined : next
      }
      return journal(next, after.mounted ? 'added' : 'removed', `plan:${callId}`, 'plan', callId, doc.title)
    })
  }

  const prepareFile = async (agent, rawPath, title, signal) => {
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('The filesystem service is unavailable; file items cannot be added.')
    const wd = ctx.get('workingDirectory')
    if (wd === undefined) throw new Error('The working-directory service is unavailable; file items cannot be added.')
    const cwd = await wd.ensure(agent, signal)
    signal?.throwIfAborted?.()
    const root = await fs.resolve(cwd, { cwd, signal })
    const target = await fs.resolve(rawPath, { cwd, signal })
    const info = await fs.stat(target, signal)
    if (info === undefined) throw new Error(`File not found: ${rawPath}`)
    if (info.type !== 'file') throw new Error(`Not a regular file: ${rawPath}`)
    if (config.allowOutsideWorkspace !== true && !fs.contains(root, target)) {
      throw new Error(`Outside the Session workspace: ${rawPath}. Add it inside the workspace, or enable allowOutsideWorkspace in the plugin config.`)
    }
    const absolute = fs.processPath(target)
    const rootPath = fs.processPath(root)
    const rel = relative(rootPath, absolute)
    const displayPath = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : absolute
    const preview = await readTextCapped(fs, target, config.previewChars, signal)
    return {
      kind: 'file',
      path: absolute,
      displayPath,
      workspaceRoot: rootPath,
      size: info.size ?? 0,
      title: normalizeTitle(title) ?? normalizeTitle(basename(absolute)) ?? 'File',
      preview: preview.text,
      previewTruncated: preview.truncated,
    }
  }

  const readStoredFile = async (item, signal) => {
    const fs = ctx.get('fs')
    if (fs === undefined) return { error: 'filesystem service unavailable' }
    try {
      const target = await fs.resolve(item.path, { signal })
      const info = await fs.stat(target, signal)
      if (info === undefined) return { error: 'file not found' }
      if (info.type !== 'file') return { error: 'not a regular file' }
      if (config.allowOutsideWorkspace !== true) {
        if (!isNonEmptyString(item.workspaceRoot)) return { error: 'the recorded workspace root is missing' }
        const root = await fs.resolve(item.workspaceRoot, { signal })
        if (!fs.contains(root, target)) return { error: 'file is outside the recorded Session workspace' }
      }
      const content = await readTextCapped(fs, target, config.maxCharsPerFile, signal)
      return { text: content.text, truncated: content.truncated }
    } catch (error) {
      if (signal?.aborted === true) throw error
      return { error: describeError(error) }
    }
  }

  const readFileContents = async (items, signal) => {
    const contents = {}
    for (const item of items) {
      if (item.kind !== 'file' || item.mounted !== true) continue
      signal?.throwIfAborted?.()
      contents[item.id] = await readStoredFile(item, signal)
    }
    return contents
  }

  const addFile = async (sessionId, prepared, actor, approved) => {
    requireLive(sessionId)
    const id = `file:${randomUUID()}`
    return mutate(sessionId, (current) => {
      const existing = findFileItem(current, prepared.path)
      if (existing !== undefined) {
        if (existing.mounted === true) return undefined
        const auth = actor === 'model' ? authorizeModelAction(current, 'mount', existing, config) : { decision: 'allow' }
        if (auth.decision === 'deny') throw new Error(auth.reason)
        if (auth.decision === 'ask' && approved !== true) throw new Error(auth.reason)
        const next = cloneRecord(current)
        next.items[existing.id] = { ...existing, mounted: true }
        return journal(next, 'added', existing.id, 'file', existing.id, itemLabel(existing))
      }
      if (Object.keys(current.items).length >= config.maxItems) {
        throw new Error(`This Session already has the maximum of ${config.maxItems} pinned items; remove one before adding another.`)
      }
      const auth = actor === 'model' ? authorizeModelAction(current, 'add', undefined, config) : { decision: 'allow' }
      if (auth.decision === 'deny') throw new Error(auth.reason)
      if (auth.decision === 'ask' && approved !== true) throw new Error(auth.reason)
      const item = {
        id,
        kind: 'file',
        title: prepared.title,
        path: prepared.path,
        displayPath: prepared.displayPath,
        workspaceRoot: prepared.workspaceRoot,
        size: prepared.size,
        mounted: true,
        locked: false,
        createdBy: actor,
        createdAt: Date.now(),
      }
      const next = cloneRecord(current)
      next.items[id] = item
      return journal(next, 'added', id, 'file', id, prepared.displayPath)
    }).then(({ record, changed }) => {
      const item = findFileItem(record, prepared.path)
      return { status: changed === false ? 'unchanged' : item?.id === id ? 'added' : 'mounted', item }
    })
  }

  const addNote = async (sessionId, note, actor, approved) => {
    requireLive(sessionId)
    const id = `note:${randomUUID()}`
    const text = note.text
    if (!isNonEmptyString(text) || text.trim() === '') throw new Error('The note body must not be blank.')
    const title = normalizeTitle(note.title) ?? titleFromText(text)
    if (text.length > config.maxCharsPerNote) {
      throw new Error(`The note exceeds the ${config.maxCharsPerNote}-character limit.`)
    }
    return mutate(sessionId, (current) => {
      if (Object.keys(current.items).length >= config.maxItems) {
        throw new Error(`This Session already has the maximum of ${config.maxItems} pinned items; remove one before adding another.`)
      }
      const auth = actor === 'model' ? authorizeModelAction(current, 'add', undefined, config) : { decision: 'allow' }
      if (auth.decision === 'deny') throw new Error(auth.reason)
      if (auth.decision === 'ask' && approved !== true) throw new Error(auth.reason)
      const item = {
        id,
        kind: 'note',
        title,
        text,
        size: text.length,
        mounted: true,
        locked: false,
        createdBy: actor,
        createdAt: Date.now(),
      }
      const next = cloneRecord(current)
      next.items[id] = item
      return journal(next, 'added', id, 'note', id, title)
    }).then(({ record }) => ({ status: 'added', item: record.items[id] }))
  }

  const setMounted = async (sessionId, itemId, mounted, actor, approved) => {
    requireLive(sessionId)
    return mutate(sessionId, (current) => {
      const item = ownItem(current, itemId)
      if (item === undefined) {
        throw new Error(`No guarded item with id ${JSON.stringify(itemId)}. Use list to read the current ids; plan call ids are user-controlled and are not items.`)
      }
      if (item.mounted === mounted) return undefined
      const auth = actor === 'model'
        ? authorizeModelAction(current, mounted ? 'mount' : 'unmount', item, config)
        : { decision: 'allow' }
      if (auth.decision === 'deny') throw new Error(auth.reason)
      if (auth.decision === 'ask' && approved !== true) throw new Error(auth.reason)
      const next = cloneRecord(current)
      next.items[itemId] = { ...item, mounted }
      return journal(next, mounted ? 'added' : 'removed', itemId, item.kind, itemId, itemLabel(item))
    }).then(({ record, changed }) => ({
      status: changed === false ? 'unchanged' : (mounted ? 'mounted' : 'unmounted'),
      item: record.items[itemId],
    }))
  }

  const setLock = (sessionId, itemId, locked) => {
    requireLive(sessionId)
    if (typeof locked !== 'boolean') throw new Error('locked must be a boolean')
    return mutate(sessionId, (current) => {
      const item = ownItem(current, itemId)
      if (item === undefined) throw new Error(`No guarded item with id ${JSON.stringify(itemId)}.`)
      if (item.locked === locked) return undefined
      const next = cloneRecord(current)
      next.items[itemId] = { ...item, locked }
      return next
    })
  }

  const removeItem = (sessionId, itemId) => {
    requireLive(sessionId)
    return mutate(sessionId, (current) => {
      const item = ownItem(current, itemId)
      if (item === undefined) throw new Error(`No guarded item with id ${JSON.stringify(itemId)}.`)
      const next = cloneRecord(current)
      delete next.items[itemId]
      // Only mounted content leaves the guarded set; deleting an item that was
      // already unmounted changes the drawer, not what the model sees.
      return item.mounted === true
        ? journal(next, 'removed', itemId, item.kind, itemId, itemLabel(item))
        : next
    })
  }

  const content = async (sessionId, id) => {
    const record = read(sessionId)
    const item = ownItem(record, id)
    if (item !== undefined) {
      if (item.kind === 'note') {
        return { kind: 'note', title: item.title, text: item.text, truncated: false, error: null }
      }
      const readFile = await readStoredFile(item, undefined)
      return {
        kind: 'file',
        title: item.title,
        text: readFile.text ?? null,
        truncated: readFile.truncated === true,
        error: readFile.error ?? null,
      }
    }
    const session = liveSession(sessionId)
    if (session !== undefined) {
      const doc = projections.stateOf(session, PLAN_DOCS_PROJECTION_KEY)?.docs
        ?.find(candidate => candidate.callId === id)
      if (doc !== undefined) {
        return { kind: 'plan', title: doc.title, text: doc.markdown, truncated: false, error: null }
      }
    }
    throw new Error(`No guarded item or plan with id ${JSON.stringify(id)}.`)
  }

  /**
   * Drop journal entries the injector just delivered. Keys are removed
   * individually, so a change arriving between the read and this write survives
   * to the next step.
   * @param sessionId - target Session.
   * @param keys - journal keys the injected message accounted for.
   */
  const markInjected = (sessionId, keys) => {
    const unique = [...new Set(keys)]
    if (unique.length === 0) return Promise.resolve({ record: undefined, changed: false })
    return mutate(sessionId, (current) => {
      const pending = clonePending(current.pending)
      let touched = false
      for (const key of unique) {
        if (Object.hasOwn(pending.added, key)) {
          delete pending.added[key]
          touched = true
        }
        if (Object.hasOwn(pending.removed, key)) {
          delete pending.removed[key]
          touched = true
        }
      }
      if (!touched) return undefined
      const next = cloneRecord(current)
      next.pending = pending
      return next
    })
  }

  return {
    config,
    read,
    state,
    markInjected,
    setPolicy,
    setPlan,
    prepareFile,
    readFileContents,
    addFile,
    addNote,
    setMounted,
    setLock,
    removeItem,
    content,
  }
}

// #endregion

// #region tool text and permission question

function permissionQuestion(action, target) {
  const verbEn = action === 'unmount' ? 'unmount' : action === 'add' ? 'add and mount' : 'mount'
  const verbZh = action === 'unmount' ? '卸载' : action === 'add' ? '添加并挂载' : '挂载'
  const kindEn = target.kind === 'file' ? 'file' : 'note'
  const kindZh = target.kind === 'file' ? '文件' : '备注'
  const name = target.kind === 'file' ? target.displayPath : target.title
  const detail = [
    `Action / 动作: ${verbEn} / ${verbZh}`,
    `Target / 对象: ${name}`,
    'Session permission / 会话权限: ask',
    'The change is applied only if you allow it. / 只有允许才会生效。',
  ]
  const excerpt = typeof target.text === 'string'
    ? target.text
    : typeof target.preview === 'string' ? target.preview : undefined
  if (excerpt !== undefined && excerpt !== '') {
    detail.push(`Content / 内容:\n${excerpt.slice(0, 500)}${excerpt.length > 500 ? '\n[… truncated / 已截断]' : ''}`)
  }
  return {
    id: 'permission',
    header: 'Plan Guard / 计划守护',
    question: `Allow the model to ${verbEn} this ${kindEn}? / 允许模型${verbZh}这个${kindZh}吗？`,
    detail: detail.join('\n'),
    options: [
      { label: '允许 / Allow', description: 'Apply the change. / 应用修改。' },
      { label: '拒绝 / Deny', description: 'Leave the guarded context unchanged. / 保持守护上下文不变。' },
    ],
  }
}

/** Ask the live Session's human for one model action; any non-answer is a denial. */
async function askPermission(ctx, exec, config, action, target) {
  const userQuestions = ctx.get('userQuestions')
  if (userQuestions === undefined) {
    throw new Error('Permission is required, but this Host has no human question channel. Ask the user to set the Session permission mode to allow this action.')
  }
  let result
  try {
    result = await userQuestions.askTimed(
      { agent: exec.agent, questions: [permissionQuestion(action, target)], signal: exec.signal },
      exec.callId,
      config.askTimeoutMs,
    )
  } catch (error) {
    if (exec.signal?.aborted === true) throw new Error('The permission request was cancelled.')
    throw new Error(`Permission could not be requested: ${describeError(error)}`)
  }
  if (result?.pending === true) {
    throw new Error(`No permission answer arrived within ${Math.round(config.askTimeoutMs / 1000)} seconds; nothing was changed. The user can set the Session permission mode in the drawer or retry.`)
  }
  const answer = result?.answers?.find(candidate => candidate.id === 'permission')
  return answer?.selected?.includes('允许 / Allow') === true
}

function renderItemLine(item) {
  const flags = [item.mounted ? 'mounted' : 'unmounted']
  if (item.locked) flags.push('locked')
  flags.push(`added by ${item.createdBy}`)
  const path = item.kind === 'file' && item.path !== null ? ` | ${item.path}` : ''
  return `- ${item.id} | ${item.kind} | ${item.title}${path} | ${flags.join(', ')}`
}

function renderListText(state) {
  const lines = [
    `Session permission mode: ${state.policy ?? 'unavailable'}`,
    `Compaction seen: ${state.sawCompaction ? 'yes' : 'no'}`,
    '',
    'Plans (user-controlled; this tool cannot mount or unmount them):',
  ]
  if (state.plans.length === 0) lines.push('- (none)')
  for (const plan of state.plans) {
    const flags = [plan.mounted ? 'mounted' : 'unmounted']
    if (plan.auto) flags.push('auto')
    if (plan.awaitingCompaction) flags.push('will auto-mount after the first compaction')
    if (plan.explicit !== null) flags.push(`explicit ${plan.explicit}`)
    lines.push(`- ${plan.callId} | ${plan.title} | ${flags.join(', ')}`)
  }
  lines.push('', 'Pinned items:')
  if (state.items.length === 0) lines.push('- (none)')
  for (const item of state.items) lines.push(renderItemLine(item))
  return lines.join('\n')
}

function toolPreviewText(item, prepared) {
  if (prepared === undefined) return ''
  if (item.kind !== 'file') return ''
  const status = prepared.previewTruncated === true ? ' (truncated)' : ''
  return `\n\nPreview${status}:\n${prepared.preview ?? ''}`
}

// #endregion

// #region model tool

function createTool(ctx, operations, config) {
  return {
    name: TOOL_NAME,
    description: 'Manage this Session\'s guarded context: the plans, notes, and files the user pins so they are re-injected after every successful context compaction. Plans are user-controlled; this tool cannot mount or unmount them. `list` shows plans and pinned items. `add_file` and `add_note` add an item and mount it; `mount` and `unmount` change an existing item. Adding or mounting may require the user\'s permission; a denied request changes nothing. Mounted content reaches you from the next step and the whole set is re-sent after each successful compaction; an unmount adds one short notice instead of removing earlier text; `add_file` returns a bounded preview. Items cannot be deleted with this tool; only the user can delete them.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...TOOL_ACTIONS],
          description: 'Operation to perform.',
        },
        path: {
          type: 'string',
          description: 'For `add_file`: a workspace-relative or absolute path to a UTF-8 text file. It must stay inside the Session workspace unless the user enabled outside-workspace files.',
        },
        title: {
          type: 'string',
          description: 'For `add_file` or `add_note`: optional display title. Defaults to the file name or the note\'s first line.',
        },
        text: {
          type: 'string',
          description: 'For `add_note`: the note body.',
        },
        itemId: {
          type: 'string',
          description: 'For `mount` or `unmount`: an item id from `list` (`file:…` or `note:…`). Plan call ids are not items.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          action: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['action', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    timeoutMs: config.askTimeoutMs + 30000,
    isConcurrencySafe: args => isRecord(args) && args.action === 'list',
    async execute(args, exec) {
      const call = validateToolArgs(args, config)
      const agent = exec.agent
      if (agent === undefined || agent.id === undefined) {
        throw new Error('context_guard requires a live Session.')
      }
      const isRoot = ctx.agents.roots().some(root => root.id === agent.id)
      if (!isRoot) throw new Error('context_guard is only available in the main Session; delegated agents cannot change guarded context.')
      const sessionId = agent.id

      if (call.action === 'list') {
        const state = operations.state(sessionId)
        if (state.live !== true) throw new Error('The Session is not live in the Host.')
        return { action: 'list', text: renderListText(state) }
      }

      if (call.action === 'add_file') {
        const prepared = await operations.prepareFile(agent, call.path, call.title, exec.signal)
        const record = operations.read(sessionId)
        const existing = Object.values(record.items)
          .find(item => item.kind === 'file' && item.path === prepared.path)
        if (existing !== undefined && existing.mounted === true) {
          return {
            action: 'add_file',
            text: `File ${prepared.displayPath} is already mounted as ${existing.id}; nothing changed.`,
          }
        }
        const action = existing === undefined ? 'add' : 'mount'
        const auth = authorizeModelAction(record, action, existing, config)
        if (auth.decision === 'deny') throw new Error(auth.reason)
        let approved = false
        if (auth.decision === 'ask') {
          approved = await askPermission(ctx, exec, config, action, existing ?? {
            kind: 'file',
            displayPath: prepared.displayPath,
            title: prepared.title,
            preview: prepared.preview,
          })
          if (!approved) throw new Error('The user denied the file mount request; nothing was added or changed.')
        }
        const outcome = await operations.addFile(sessionId, prepared, 'model', approved)
        if (outcome.item === undefined) throw new Error('The file item could not be found after the change.')
        const verb = outcome.status === 'added' ? 'Added and mounted' : outcome.status === 'mounted' ? 'Mounted' : 'Already mounted'
        const text = `${verb} file ${prepared.displayPath} as ${outcome.item.id}. It is available to you from the next step.`
          + toolPreviewText(outcome.item, prepared)
        return { action: 'add_file', text }
      }

      if (call.action === 'add_note') {
        const title = normalizeTitle(call.title) ?? titleFromText(call.text)
        const record = operations.read(sessionId)
        if (Object.keys(record.items).length >= config.maxItems) {
          throw new Error(`This Session already has the maximum of ${config.maxItems} pinned items; remove one before adding another.`)
        }
        const auth = authorizeModelAction(record, 'add', undefined, config)
        if (auth.decision === 'deny') throw new Error(auth.reason)
        let approved = false
        if (auth.decision === 'ask') {
          approved = await askPermission(ctx, exec, config, 'add', { kind: 'note', title, text: call.text })
          if (!approved) throw new Error('The user denied the note mount request; nothing was added.')
        }
        const outcome = await operations.addNote(sessionId, { title, text: call.text }, 'model', approved)
        if (outcome.item === undefined) throw new Error('The note item could not be found after the change.')
        return {
          action: 'add_note',
          text: `Added and mounted note "${outcome.item.title}" as ${outcome.item.id}. It is available to you from the next step.`,
        }
      }

      const record = operations.read(sessionId)
      const item = ownItem(record, call.itemId)
      if (item === undefined) {
        throw new Error(`No guarded item with id ${JSON.stringify(call.itemId)}. Use list to read the current ids; plan call ids are user-controlled and are not items.`)
      }
      const mounted = call.action === 'mount'
      if (item.mounted === mounted) {
        return {
          action: call.action,
          text: `${item.kind === 'file' ? 'File' : 'Note'} ${item.title} is already ${mounted ? 'mounted' : 'unmounted'}; nothing changed.`,
        }
      }
      const auth = authorizeModelAction(record, call.action, item, config)
      if (auth.decision === 'deny') throw new Error(auth.reason)
      let approved = false
      if (auth.decision === 'ask') {
        approved = await askPermission(ctx, exec, config, call.action, item)
        if (!approved) throw new Error(`The user denied the ${call.action} request; nothing was changed.`)
      }
      const outcome = await operations.setMounted(sessionId, item.id, mounted, 'model', approved)
      return {
        action: call.action,
        text: `${outcome.status === 'unchanged' ? 'Already' : mounted ? 'Mounted' : 'Unmounted'} ${item.kind === 'file' ? 'file' : 'note'} ${item.title} (${item.id}).${mounted ? ' It is available to you from the next step.' : ' The item remains stored; a one-line notice tells you it is no longer guarded.'}`,
      }
    },
  }
}

// #endregion

// #region injection

/** One immutable injected message; the loop logs it as a durable user/message event. */
function guardMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: Object.freeze({ kind: SOURCE_KIND, schemaVersion: 2 }),
  })
}

/**
 * Whether a plan-guard injection is already visible: in the entering batch,
 * in the next-step inbox, or anywhere on the current surface.
 */
function injectionVisible(agent, decision) {
  for (const message of decision.messages) {
    if (message?.source?.kind === SOURCE_KIND) return true
  }
  for (const message of agent.inbox?.nextStep ?? []) {
    if (message?.source?.kind === SOURCE_KIND) return true
  }
  const nodes = agent.session?.surface?.nodes ?? []
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const event = agent.session.eventAt(nodes[i])
    if (event?.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND) return true
  }
  return false
}

/** Journal keys a pending record carries. */
function pendingKeys(pending) {
  return [...Object.keys(pending?.added ?? {}), ...Object.keys(pending?.removed ?? {})]
}

/**
 * Splice one message right after the claimed batch — the tail of the request,
 * before the per-step runtime-context block. Append-only: nothing earlier is
 * touched, so the cached request prefix stays valid.
 */
function injectMessage(decision, messages, message) {
  const lastClaimedIndex = decision.messages.findLastIndex(entry => messages.includes(entry))
  const at = lastClaimedIndex < 0 ? decision.messages.length : lastClaimedIndex + 1
  return { ...decision, messages: decision.messages.toSpliced(at, 0, message) }
}

/**
 * Build the pre-step listener. Two triggers, both append-only:
 * - the guarded set is not on the surface (after a compaction, or the first time
 *   anything gets guarded) → the full snapshot;
 * - the journal holds changes → one incremental message: a sentence per removal
 *   and the content of what was added.
 * Failures self-heal on the next step; the step itself never fails because of
 * this plugin.
 */
function createInjector(ctx, projections, config, operations) {
  const clear = async (sessionId, keys) => {
    if (keys.length === 0) return
    try {
      await operations.markInjected(sessionId, keys)
    } catch (error) {
      ctx.logger?.warn?.(`plan-guard: clearing delivered changes failed for session ${sessionId}: ${String(error)}`)
    }
  }
  return async ({ agent, messages, turn, step, signal }, next) => {
    const decision = await next()
    if (config.disabled === true) return decision
    // An empty first entry owns a no-step turn; never turn one into a request.
    if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
    try {
      const sessionId = agent.session?.id
      if (sessionId === undefined) return decision
      const record = operations.read(sessionId)
      const pending = record.pending ?? emptyPending()
      const keys = pendingKeys(pending)
      const visible = injectionVisible(agent, decision)
      if (visible && keys.length === 0) return decision

      const projected = projections.stateOf(agent.session, PLAN_DOCS_PROJECTION_KEY)
      const docs = projected?.docs ?? []
      const sawCompaction = projected?.sawCompaction === true

      if (!visible) {
        const mountedItems = Object.values(record.items).filter(item => item.mounted === true)
        let composed
        if (docs.length > 0 || mountedItems.length > 0) {
          signal?.throwIfAborted?.()
          const contents = await operations.readFileContents(Object.values(record.items), signal)
          signal?.throwIfAborted?.()
          composed = composeGuardText({ docs, record, config, sawCompaction, contents })
        }
        if (composed === undefined) {
          await clear(sessionId, keys)
          return decision
        }
        const entered = injectMessage(decision, messages, guardMessage(composed.text))
        await clear(sessionId, keys)
        ctx.logger?.debug?.('plan-guard: injected the guarded snapshot (turn %d step %d, %d plan(s), %d item(s))', turn, step, composed.included.length, mountedItems.length)
        return entered
      }

      signal?.throwIfAborted?.()
      const contents = await operations.readFileContents(Object.values(record.items), signal)
      signal?.throwIfAborted?.()
      const update = composeUpdate({ pending, record, docs, config, sawCompaction, contents })
      if (update === undefined) {
        await clear(sessionId, keys)
        return decision
      }
      const entered = injectMessage(decision, messages, guardMessage(update.text))
      await clear(sessionId, keys)
      ctx.logger?.debug?.('plan-guard: injected guarded changes (turn %d step %d, %d added, %d removed)', turn, step, update.added.length, update.removed.length)
      return entered
    } catch (error) {
      ctx.logger?.warn?.(`plan-guard: injection failed for session ${agent.session?.id}: ${String(error)}`)
      return decision
    }
  }
}

// #endregion

// #region Remote service

/**
 * Host Remote service exposing the drawer's reads and writes. Plain-JS form of
 * a Typert remote service: a frozen `typertRemote` binding plus the
 * `@deepseek-ai/dsh-typert-protocol/remote-methods` v1 descriptor on the
 * prototype (what the `Remote` decorator records for a compiled class). SRC
 * parameter names must stay simple identifiers (`sessionId`, `callId`, …).
 */
class PlanGuardHostService {
  /** @param access - operations plus config shared with the tool and injector. */
  constructor(access) {
    this.access = access
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: SERVICE_KEY,
      namespace: SERVICE_KEY,
    })
  }

  /**
   * List plans and pinned items for one Session.
   * @param sessionId - Session the drawer is open for.
   * @returns the drawer state; `live` is false for a Session with no live object.
   */
  async list(sessionId) {
    if (!isNonEmptyString(sessionId)) throw new Error('plan-guard.list requires a sessionId')
    return this.access.operations.state(sessionId)
  }

  /**
   * Set the Session permission mode for model actions.
   * @param sessionId - target Session.
   * @param policy - one of the closed policy strings.
   * @returns the refreshed drawer state.
   */
  async setPolicy(sessionId, policy) {
    if (!isNonEmptyString(sessionId)) throw new Error('plan-guard.setPolicy requires a sessionId')
    await this.access.operations.setPolicy(sessionId, policy)
    return this.access.operations.state(sessionId)
  }

  /**
   * Change one plan's explicit mount choice, or clear it back to auto.
   * @param sessionId - target Session.
   * @param callId - plan document to change.
   * @param choice - `mounted`, `unmounted`, or `auto`.
   * @returns the refreshed drawer state.
   */
  async setPlan(sessionId, callId, choice) {
    if (!isNonEmptyString(sessionId) || !isNonEmptyString(callId)) {
      throw new Error('plan-guard.setPlan requires a sessionId and a callId')
    }
    await this.access.operations.setPlan(sessionId, callId, choice)
    return this.access.operations.state(sessionId)
  }

  /**
   * Add and mount a note.
   * @param sessionId - target Session.
   * @param title - optional display title; the first line is used when blank.
   * @param text - note body.
   * @returns the refreshed drawer state.
   */
  async addNote(sessionId, title, text) {
    if (!isNonEmptyString(sessionId)) throw new Error('plan-guard.addNote requires a sessionId')
    await this.access.operations.addNote(sessionId, { title, text }, 'human', false)
    return this.access.operations.state(sessionId)
  }

  /**
   * Resolve, validate, add, and mount a file.
   * @param sessionId - target Session.
   * @param path - workspace-relative or absolute text-file path.
   * @returns the refreshed drawer state.
   */
  async addFile(sessionId, path) {
    if (!isNonEmptyString(sessionId) || !isNonEmptyString(path)) {
      throw new Error('plan-guard.addFile requires a sessionId and a path')
    }
    const ctx = this.access.ctx
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('The Session is not live in the Host. Resume it first.')
    const prepared = await this.access.operations.prepareFile(agent, path, undefined, undefined)
    await this.access.operations.addFile(sessionId, prepared, 'human', false)
    return this.access.operations.state(sessionId)
  }

  /**
   * Mount or unmount one item as the human.
   * @param sessionId - target Session.
   * @param itemId - stored item id.
   * @param mounted - requested state.
   * @returns the refreshed drawer state.
   */
  async setMounted(sessionId, itemId, mounted) {
    if (!isNonEmptyString(sessionId) || !isNonEmptyString(itemId) || typeof mounted !== 'boolean') {
      throw new Error('plan-guard.setMounted requires a sessionId, an itemId, and a boolean mounted flag')
    }
    await this.access.operations.setMounted(sessionId, itemId, mounted, 'human', false)
    return this.access.operations.state(sessionId)
  }

  /**
   * Lock or unlock one item for model changes (human only).
   * @param sessionId - target Session.
   * @param itemId - stored item id.
   * @param locked - requested lock state.
   * @returns the refreshed drawer state.
   */
  async setLock(sessionId, itemId, locked) {
    if (!isNonEmptyString(sessionId) || !isNonEmptyString(itemId) || typeof locked !== 'boolean') {
      throw new Error('plan-guard.setLock requires a sessionId, an itemId, and a boolean locked flag')
    }
    await this.access.operations.setLock(sessionId, itemId, locked)
    return this.access.operations.state(sessionId)
  }

  /**
   * Delete one item (human only).
   * @param sessionId - target Session.
   * @param itemId - stored item id.
   * @returns the refreshed drawer state.
   */
  async removeItem(sessionId, itemId) {
    if (!isNonEmptyString(sessionId) || !isNonEmptyString(itemId)) {
      throw new Error('plan-guard.removeItem requires a sessionId and an itemId')
    }
    await this.access.operations.removeItem(sessionId, itemId)
    return this.access.operations.state(sessionId)
  }

  /**
   * Read one plan document, note, or file preview.
   * @param sessionId - target Session.
   * @param id - plan call id or item id.
   * @returns `{ kind, title, text, truncated, error }`.
   */
  async content(sessionId, id) {
    if (!isNonEmptyString(sessionId) || !isNonEmptyString(id)) {
      throw new Error('plan-guard.content requires a sessionId and an id')
    }
    return this.access.operations.content(sessionId, id)
  }
}

Object.defineProperty(PlanGuardHostService.prototype, REMOTE_MARKER_KEY, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      'list',
      'setPolicy',
      'setPlan',
      'addNote',
      'addFile',
      'setMounted',
      'setLock',
      'removeItem',
      'content',
    ].map(method => Object.freeze({
      method,
      invocation: Object.freeze({ kind: 'direct' }),
    }))),
  }),
})

// #endregion

/**
 * Host apply: fix the storage API, register the projection and domain, provide
 * the Remote service, install the tool and its delegated-agent restriction, and
 * install the post-compaction injection listener.
 * @param ctx - Cordis context owning this plugin's registrations.
 * @param config - raw row config (the Loader normalizes it through `Config`).
 */
export async function apply(ctx, config) {
  const check = validateConfig(config)
  if (check.issues !== undefined) {
    throw new Error(`plan-guard config rejected: ${check.issues.map(issue => issue.message).join('; ')}`)
  }
  const options = check.value
  const projections = ctx.sessionProjections
  const sessions = ctx.get('sessions')

  const domain = await ctx.storageDomain.open(guardDomainSpec)
  ctx.effect(() => async () => {
    try { await domain.close() } catch (error) {
      ctx.logger?.warn?.(`plan-guard: closing the guard domain failed: ${String(error)}`)
    }
  }, 'plan-guard: guard storage domain')

  ctx.effect(
    () => projections.register({
      key: PLAN_DOCS_PROJECTION_KEY,
      stateSchema,
      init: stateInit,
      apply: foldDocs,
      stateVersion: 1,
    }),
    'plan-guard: plan-docs projection',
  )

  const operations = createOperations(ctx, domain, projections, sessions, options)
  ctx.provide(SERVICE_KEY, new PlanGuardHostService({ ctx, operations }))

  if (options.toolEnabled === true) {
    ctx.effect(() => ctx.tools.register(createTool(ctx, operations, options)), 'plan-guard: context_guard tool')
    ctx.on('agent/created', ({ agent }) => {
      const isRoot = ctx.agents.roots().some(root => root.id === agent.id)
      if (isRoot) return
      agent.ctx.effect(
        () => agent.ctx.tools.restrict({ deny: [TOOL_NAME] }),
        'plan-guard: hide context_guard from delegated agents',
      )
    })
  }

  ctx.on('agent/pre-step', createInjector(ctx, projections, options, operations))
}

/** Pure helpers exported for `node --test`; not part of the plugin contract. */
export const __testables = {
  DEFAULT_CONFIG,
  POLICIES,
  PLAN_CHOICES,
  TOOL_ACTIONS,
  GUARD_DOMAIN_NAME,
  guardDomainSpec,
  validateConfig,
  normalizeRecord,
  effectivePlanState,
  authorizeModelAction,
  validateToolArgs,
  composeGuardText,
  composeUpdate,
  applyPending,
  planDocument,
  foldDocs,
  stateInit,
  stateSchema,
  normalizeTitle,
  titleFromText,
}
