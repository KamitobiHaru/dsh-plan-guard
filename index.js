/**
 * dsh-plan-guard Host half: guarded-context projection, storage, the
 * `context_guard` tool, Remote methods, and post-compaction re-injection.
 *
 * A plan document is one `exit_plan_mode` submission keyed by its tool call
 * id, derived from logged session events; each document also records whether
 * its submission was accepted or dismissed. Only a document with a confirmed
 * accepted verdict auto-mounts, so an unapproved plan never reaches the model
 * as a constraint (a human can still mount one explicitly).
 * Notes and files are items stored in the plugin's storage domain. Mounted
 * files carry a sighting of the exact bytes the model last saw, so an
 * on-disk edit is noticed on the next step and re-injected in full. The full
 * guarded set enters the model surface through one `agent/pre-step` message
 * splice, which the agent loop logs as a durable `user/message` event, only
 * when no guarded message is visible; afterwards only changes arrive.
 *
 * The Web drawer and the model tool share one set of operations. The tool is
 * the only model-facing entry point; the drawer is human-only and ignores the
 * session permission mode.
 * @module dsh-plan-guard
 */

import { createHash, randomUUID } from 'node:crypto'
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
  /** Maximum number of stored notes/files; 0 disables the count limit (plans are derived, not counted). */
  maxItems: 0,
  /** Permission mode for Sessions without a stored choice. */
  defaultPolicy: 'ask',
  /** Auto-mount the newest plan once the Session has compacted. */
  autoMountLatestPlan: true,
  /** Probe mounted files each step and re-inject one whose content changed on disk. */
  refreshChangedFiles: true,
  /** Foreground permission-question timeout in milliseconds. */
  askTimeoutMs: 120000,
  /** Allow file items whose absolute path is outside the Session workspace. */
  allowOutsideWorkspace: false,
  /** Character cap for the file preview returned by `add_file`. */
  previewChars: 4000,
}

const CONFIG_FIELD_LIMITS = {
  maxItems: [0, 10000],
  askTimeoutMs: [5000, 600000],
  previewChars: [500, 20000],
}

/**
 * Config fields that sized the old truncation and omission mechanism. Removing
 * mounted content silently was the bug this plugin set out to fix, so the caps
 * are gone rather than reinterpreted: guarded content is delivered in full.
 * They stay accepted-and-ignored on purpose — `apply` rejects unknown fields,
 * and a profile row that still sets one of these must not fail to activate.
 */
export const DEPRECATED_CONFIG_FIELDS = Object.freeze([
  'maxCharsPerPlan', 'maxCharsPerFile', 'maxCharsPerNote', 'maxTotalChars',
])

const CONFIG_BOOLEAN_FIELDS = ['disabled', 'toolEnabled', 'autoMountLatestPlan', 'allowOutsideWorkspace', 'refreshChangedFiles']

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0
/** Own-record item lookup; never walks Object.prototype for a hostile id. */
const ownItem = (record, id) => (Object.hasOwn(record.items, id) ? record.items[id] : undefined)
/** Empty change journal for the guarded set. */
const emptyPending = () => ({ added: {}, changed: {}, removed: {} })
/** Shallow copy of the journal's buckets. */
const clonePending = (pending) => ({
  added: { ...(pending?.added ?? {}) },
  changed: { ...(pending?.changed ?? {}) },
  removed: { ...(pending?.removed ?? {}) },
})
/** Kinds a pending change can name; anything else is dropped on read. */
const PENDING_KINDS = new Set(['plan', 'file', 'note'])
/** Journal buckets, in the order they are trimmed. */
const PENDING_BUCKETS = ['added', 'changed', 'removed']
/** Events that end any claim that a later `plan/mode` off was caused by one plan. */
const VERDICT_VOIDING_EVENTS = new Set(['tool/call', 'tool/ptc-dispatch-start', 'user/message', 'command/run'])
/** Bound on the journal so a long offline gap cannot grow the record. */
const PENDING_LIMIT = 200

const cloneRecord = (record) => ({
  version: 2,
  policy: record.policy,
  plans: { ...record.plans },
  items: { ...record.items },
  pending: clonePending(record.pending),
  autoPlan: isNonEmptyString(record.autoPlan) ? record.autoPlan : null,
})

/**
 * Record one change in the pending journal, coalescing by key: the newest
 * action wins, so add-then-remove leaves nothing to report and a removal that
 * is immediately undone never reaches the model. `changed` reports an on-disk
 * rewrite of a mounted file; while an item's addition is still undelivered the
 * addition already carries current bytes, so the change needs no second entry.
 * @param pending - current journal, possibly missing on a legacy record.
 * @param change - `{ action: 'added'|'changed'|'removed', key, kind, id, label }`.
 * @returns a new journal, capped at `PENDING_LIMIT` entries.
 */
export function applyPending(pending, change) {
  const next = clonePending(pending)
  const entry = { kind: change.kind, id: change.id, label: String(change.label).slice(0, 200) }
  if (change.action === 'added') {
    delete next.changed[change.key]
    delete next.removed[change.key]
    next.added[change.key] = entry
  } else if (change.action === 'changed') {
    if (next.added[change.key] !== undefined) return next
    delete next.removed[change.key]
    next.changed[change.key] = entry
  } else {
    delete next.added[change.key]
    delete next.changed[change.key]
    next.removed[change.key] = entry
  }
  return trimPending(next)
}

/** Drop the oldest journal entries once the cap is exceeded. */
function trimPending(pending) {
  let total = PENDING_BUCKETS.reduce((sum, bucket) => sum + Object.keys(pending[bucket]).length, 0)
  while (total > PENDING_LIMIT) {
    const bucket = PENDING_BUCKETS.map(name => pending[name]).find(entries => Object.keys(entries).length > 0)
    const oldest = bucket === undefined ? undefined : Object.keys(bucket)[0]
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
    if (key in DEFAULT_CONFIG) continue
    if (!DEPRECATED_CONFIG_FIELDS.includes(key)) pushIssue(`unknown config field ${JSON.stringify(key)}`)
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
 * least one successful compaction, the point where guarding starts to matter;
 * `awaitingVerdict` holds the call id of one plan whose logged outcome carried no
 * readable verdict, so a following `plan/mode` off can still settle it.
 */
const stateInit = () => ({ docs: [], sawCompaction: false, awaitingVerdict: null })

/** Validates prior state before it seeds a fold from a persisted cache row. */
const stateSchema = {
  parse(value) {
    if (!isRecord(value) || !Array.isArray(value.docs) || typeof value.sawCompaction !== 'boolean') {
      throw new Error('plan-guard projection state does not match its shape')
    }
    for (const doc of value.docs) {
      if (!isRecord(doc) || !isNonEmptyString(doc.callId) || !isNonEmptyString(doc.title)
        || typeof doc.markdown !== 'string'
        || (doc.accepted !== undefined && typeof doc.accepted !== 'boolean')) {
        throw new Error('plan-guard projection document does not match its shape')
      }
    }
    if (value.awaitingVerdict !== undefined && value.awaitingVerdict !== null
      && typeof value.awaitingVerdict !== 'string') {
      throw new Error('plan-guard pending verdict id does not match its shape')
    }
    return { ...value, awaitingVerdict: isNonEmptyString(value.awaitingVerdict) ? value.awaitingVerdict : null }
  },
}

/**
 * One plan document reduced from an accepted submission. The full markdown is
 * kept: the injected guard block is the only place a plan can be read from once
 * a compaction has replaced the `exit_plan_mode` call arguments on the surface,
 * and the model has no tool that fetches the rest. The session log already
 * stores the whole plan, so keeping the copy bounded by nothing is not a new
 * cost — it is what makes the guard faithful.
 */
export function planDocument(callId, markdown, turn) {
  const heading = /^#\s+(\S[^\r\n]*)/.exec(markdown.trim())?.[1]
  const firstLine = /^[^\r\n]*/.exec(markdown.trim())[0]
  const title = (heading ?? firstLine).trim() || 'Untitled plan'
  return { callId, turn, title, markdown }
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
 * The call id one logged outcome belongs to. `tool/result` carries it inside
 * `data.message` in the v4 session log (flat on `data` in older logs); a PTC
 * sub-dispatch outcome carries it as `data.subCallId`, which is exactly the key
 * `planFromPtcDispatchStart` recorded the document under.
 */
function outcomeCallId(eventType, data) {
  if (!isRecord(data)) return undefined
  if (eventType === 'tool/ptc-dispatch') {
    return isNonEmptyString(data.subCallId) ? data.subCallId : undefined
  }
  const message = isRecord(data.message) ? data.message : undefined
  if (message !== undefined && isNonEmptyString(message.toolCallId)) return message.toolCallId
  return isNonEmptyString(data.toolCallId) ? data.toolCallId : undefined
}

/** Concatenated model-facing text of one logged outcome, or ''. */
function outcomeText(source) {
  const content = isRecord(source) ? source.content : undefined
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * Verdict on one plan submission, read from its logged outcome.
 *
 * `exit_plan_mode` answers in both directions as a plain success — the approval
 * and the dismissal differ only in the rendered text (`dsh-plan-mode` renders
 * `{ approved }` into one text block) — so `isError` alone is never enough, and
 * a dismissed plan used to fold as if it had been approved. Keyword matching on
 * the text is primary, `isError` covers a hard failure and the pre-rc logs that
 * recorded a dismissal as an error. When neither signal is readable the verdict
 * stays unknown, which the auto-mount rule treats as not approved.
 *
 * @param data - the `tool/result` or `tool/ptc-dispatch` event data.
 * @returns `true` (approved), `false` (dismissed), or `undefined` (unknown).
 */
export function planVerdict(data) {
  if (!isRecord(data)) return undefined
  const message = isRecord(data.message) ? data.message : data
  if (message.isError === true || data.isError === true) return false
  const text = outcomeText(message) === '' ? outcomeText(data) : outcomeText(message)
  if (text === '') return undefined
  if (/dismissed/i.test(text)) return false
  if (/plan approved/i.test(text)) return true
  return undefined
}

/**
 * Settle one document's verdict and stop awaiting it, returning the same state
 * reference when neither moves. `accepted === undefined` leaves the stored
 * verdict untouched so an unreadable outcome never rewrites a known answer.
 */
function settleVerdict(state, callId, accepted) {
  const index = state.docs.findIndex(doc => doc.callId === callId)
  if (index < 0) return state
  const doc = state.docs[index]
  const awaiting = state.awaitingVerdict === callId ? null : state.awaitingVerdict
  if (accepted === undefined || accepted === doc.accepted) {
    return awaiting === state.awaitingVerdict ? state : { ...state, awaitingVerdict: awaiting }
  }
  const docs = state.docs.slice()
  docs[index] = { ...doc, accepted }
  return { ...state, docs, awaitingVerdict: awaiting }
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
  // Once anything else happens in the Session, a later `plan/mode` off can no
  // longer be attributed to the plan awaiting its verdict.
  let base = state
  if (base.awaitingVerdict !== null && VERDICT_VOIDING_EVENTS.has(event.type)) {
    base = { ...base, awaitingVerdict: null }
  }
  // Leaving plan mode is the structural mark of an approval. It is appended from
  // the next accepted pre-step, so it always lands after the approving result.
  if (event.type === 'plan/mode') {
    if (event.data?.active !== false || base.awaitingVerdict === null) return base
    return settleVerdict(base, base.awaitingVerdict, true)
  }
  // The verdict on one plan submission, from a native `tool/result` or a PTC
  // `tool/ptc-dispatch`. A result naming an unknown call id (or none at all) is
  // not this unit's; a readable-free outcome starts awaiting structural proof.
  if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
    const callId = outcomeCallId(event.type, event.data)
    if (callId === undefined) return base
    const index = base.docs.findIndex(doc => doc.callId === callId)
    if (index < 0) return base
    const accepted = planVerdict(event.data)
    if (accepted !== undefined) return settleVerdict(base, callId, accepted)
    if (base.docs[index].accepted !== undefined || base.awaitingVerdict !== null) return base
    return { ...base, awaitingVerdict: callId }
  }
  const plan = event.type === 'tool/call'
    ? planFromNativeCall(event.data)
    : event.type === 'tool/ptc-dispatch-start' ? planFromPtcDispatchStart(event.data) : undefined
  if (plan === undefined) return base
  if (base.docs.some(doc => doc.callId === plan.callId)) return base
  return { ...base, docs: [...base.docs, plan] }
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
  // Sighting of the exact bytes the model last saw, written by the injector.
  // Optional and lenient: an unstamped item is simply probed once more. These
  // fields must be re-emitted here or the storage schema drops them on read.
  const sight = {}
  if (isNonEmptyString(raw.seenVersion)) sight.seenVersion = raw.seenVersion
  if (isNonEmptyString(raw.seenDigest)) sight.seenDigest = raw.seenDigest
  if (typeof raw.seenAt === 'number' && Number.isFinite(raw.seenAt)) sight.seenAt = raw.seenAt
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
    ...sight,
  }
}

/** Lenient journal normalization: malformed entries are dropped, never fatal. */
function normalizePending(raw) {
  const pending = emptyPending()
  if (!isRecord(raw)) return pending
  for (const bucket of PENDING_BUCKETS) {
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
  // Bookkeeping for auto-displacement: which auto-mounted plan the journal
  // already accounts for. Lenient on purpose — a corrupt value just resets to
  // "unknown", which re-journals at most one incremental message.
  const autoPlan = isNonEmptyString(raw.autoPlan) ? raw.autoPlan : null
  return { version: 2, policy, plans, items, pending: normalizePending(raw.pending), autoPlan }
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
    return { version: 2, policy: config.defaultPolicy, plans: {}, items: {}, pending: emptyPending(), autoPlan: null }
  }
  return {
    version: 2,
    policy: raw.policy ?? config.defaultPolicy,
    plans: raw.plans ?? {},
    items: raw.items ?? {},
    pending: clonePending(raw.pending),
    autoPlan: isNonEmptyString(raw.autoPlan) ? raw.autoPlan : null,
  }
}

// #endregion

// #region plan state

/**
 * Effective mount state for one plan document.
 * An explicit human choice wins; otherwise the newest plan auto-mounts only
 * after the first successful compaction (when `autoMountLatestPlan` is on)
 * and only when its approval is confirmed. The rule is deliberately
 * fail-closed: a dismissed plan and a plan whose verdict could not be read
 * from the log both stay unmounted, and a human can still mount either one.
 */
export function effectivePlanState(doc, index, docs, record, config, sawCompaction) {
  const explicit = record.plans[doc.callId]
  const isLatest = index === docs.length - 1
  const autoEligible = isLatest && config.autoMountLatestPlan === true && doc.accepted === true
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

/**
 * Reconcile the auto-mounted plan against what the journal already accounts
 * for. Pure: returns `{ autoPlan, addPlan, removePlan }`, or undefined when
 * the recorded `autoPlan` already matches the derived auto-mounted plan.
 *
 * The predicate is exactly `effectivePlanState(...).auto`, so this agrees
 * with every other reader about what "auto-mounted" means. Only
 * auto-following plans are ever displaced: a plan the human explicitly
 * mounted or unmounted is left untouched, and pinned notes/files are out of
 * scope (only `plan:` journal keys are written).
 */
export function planAutoTransition(docs, record, config, sawCompaction) {
  let autoNow = null
  for (let index = 0; index < docs.length; index += 1) {
    const doc = docs[index]
    if (effectivePlanState(doc, index, docs, record, config, sawCompaction).auto === true) {
      autoNow = doc
      break // at most one: auto requires isLatest
    }
  }
  const autoPrev = isNonEmptyString(record.autoPlan) ? record.autoPlan : null
  const nowId = autoNow === null ? null : autoNow.callId
  if (nowId === autoPrev) return undefined
  let removePlan = null
  if (autoPrev !== null) {
    const prevDoc = docs.find(doc => doc.callId === autoPrev)
    if (prevDoc !== undefined && record.plans[autoPrev] === undefined) {
      removePlan = { id: autoPrev, label: prevDoc.title }
    }
  }
  return {
    autoPlan: nowId,
    addPlan: autoNow === null ? null : { id: autoNow.callId, label: autoNow.title },
    removePlan,
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
 * Upper bound for tool text arguments. Effectively unlimited on purpose: a note
 * is pinned precisely because it must stay in context whole, so the plugin
 * neither cuts it at delivery nor refuses it at pin time. Storage size is the
 * human's decision, not something this plugin hides by delivering less.
 */
const UNLIMITED_TEXT = Number.MAX_SAFE_INTEGER

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
    const text = requireStringArg(args, 'text', 1, UNLIMITED_TEXT)
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

/** One plan document as an injected section, in full. */
function planSectionText(doc) {
  return `## Plan: ${doc.title}\nplan: ${doc.callId}\n\n${doc.markdown}`
}

/** One note or file as an injected section, with its unreadable markers. */
function itemSectionText(item, contents) {
  return item.kind === 'note' ? noteSectionText(item) : fileSectionText(item, contents, false)
}

/** One note as an injected section, in full. */
function noteSectionText(item) {
  return `## Note: ${item.title}\nitem: ${item.id}\n\n${item.text}`
}

/**
 * One file as an injected section. A refreshed file is labelled `(changed)` so
 * the model reads it as replacing the older copy still sitting in the surface.
 */
function fileSectionText(item, contents, changed) {
  const heading = changed === true ? `## File: ${item.displayPath} (changed)` : `## File: ${item.displayPath}`
  return `${heading}\nitem: ${item.id}\n\n${itemBodyText(item, contents)}`
}

/**
 * The whole body of one file item. A read failure is reported as a visible
 * marker and never degrades into a partial body: this plugin delivers guarded
 * content complete or clearly not at all.
 */
function itemBodyText(item, contents) {
  const content = contents?.[item.id]
  if (content === undefined) return '[plan-guard: file content unavailable]'
  if (content.error !== undefined) return `[plan-guard: file unreadable: ${content.error}]`
  return content.text ?? ''
}

/**
 * Compose the full guarded-context snapshot (sent after a compaction, or the
 * first time anything is guarded). Pure apart from the file contents the caller
 * already read; returns undefined when nothing is mounted.
 *
 * There is deliberately no size budget here: everything mounted is delivered in
 * full. The model cannot fetch what a cap would have dropped — `context_guard`
 * has no read action, and after a compaction this message is the only copy — so
 * a partial delivery would turn a pin into a silently different constraint.
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
  const included = []
  const header = `${config.header}\n`
    + 'This block is background context, not a new request. You see the full set only the first time anything is guarded, or again after a compaction wiped it from the surface; afterwards you only get short updates when the guarded set changes (new content in full, removals as one-line notices, and a mounted file that changed on disk re-sent under a "(changed)" heading, which replaces the older copy above it). Every mounted plan, note, and file is delivered complete: nothing here is truncated and nothing is left out.\n\n'
  const footer = config.toolEnabled === false
    ? '\n\nPlans and pinned items are managed by the user in the Guarded context drawer.\n'
    : '\n\nUse the `context_guard` tool to list, mount, unmount, or add notes/files. Plans are user-controlled.\n'
  const push = (id, section) => {
    sections.push(section)
    included.push(id)
  }
  for (const { doc } of mountedPlans) push(doc.callId, planSectionText(doc))
  for (const item of [...humanItems, ...modelItems]) push(item.id, itemSectionText(item, contents))
  if (sections.length === 0) return undefined
  return {
    text: header + sections.join('\n\n') + footer,
    included,
  }
}

/** How a removal notice names one journal entry: title plus unique id. */
function removalNoun(entry) {
  const id = typeof entry?.id === 'string' && entry.id !== '' ? ` (${entry.id})` : ''
  if (entry.kind === 'plan') return `Plan "${entry.label}"${id}`
  if (entry.kind === 'note') return `Note "${entry.label}"${id}`
  return `File ${entry.label}${id}`
}

/**
 * Compose the incremental message for changes since the last delivery: one
 * sentence per removal, one per refreshed file, then the content of what was
 * added or refreshed in the same section format the snapshot uses. Append-only
 * by design, so the request prefix stays cached.
 * @returns `{ text, added, changed, removed }`, or undefined when nothing is worth sending.
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
  // Refreshed files: still-mounted file items whose bytes moved since the model
  // last saw them. A removal or addition already in the journal covers them.
  const changedIds = new Set()
  for (const entry of Object.values(pending?.changed ?? {})) {
    if (entry.kind !== 'file') continue
    if (addedItemIds.has(entry.id)) continue
    const item = ownItem(record, entry.id)
    if (item === undefined || item.mounted !== true || item.kind !== 'file') continue
    changedIds.add(entry.id)
  }
  const byAge = (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  const addedItems = Object.values(record.items)
    .filter(item => addedItemIds.has(item.id) && item.mounted === true)
    .sort(byAge)
  const changedItems = Object.values(record.items)
    .filter(item => changedIds.has(item.id))
    .sort(byAge)
  const addedPlans = docs.filter(doc => addedPlanIds.has(doc.callId)).reverse()
  const changedLines = changedItems.map(item => `File ${item.displayPath} (${item.id}) changed on disk; the section below is its current content.`)
  if (removedLines.length === 0 && changedLines.length === 0 && addedPlans.length === 0 && addedItems.length === 0) return undefined

  const noticeLines = [...removedLines, ...changedLines]
  const prefix = `${config.header} — update\nBackground context, not a new request. Content below is complete; nothing here is truncated or left out.\n\n${noticeLines.length === 0 ? '' : `${noticeLines.join(' ')}\n\n`}`
  const sections = []
  const included = []
  const changedIncluded = []
  const push = (id, section, changed) => {
    sections.push(section)
    included.push(id)
    if (changed === true) changedIncluded.push(id)
  }
  for (const doc of addedPlans) push(doc.callId, planSectionText(doc), false)
  for (const item of addedItems) push(item.id, itemSectionText(item, contents), false)
  for (const item of changedItems) push(item.id, fileSectionText(item, contents, true), true)
  return {
    text: prefix + sections.join('\n\n'),
    added: included.filter(id => !changedIncluded.includes(id)),
    changed: changedIncluded,
    removed: removedLines,
  }
}

// #endregion

// #region operations

/**
 * Build the shared Host operations used by the Remote service, the tool, and
 * the injector. Writes are serialized per Session so the drawer and the tool
 * cannot lose each other's read-modify-write. `planProjection` is the awaited
 * `ProjectionHandle` for this plugin's unit; every read goes through it.
 */
function createOperations(ctx, domain, planProjection, sessions, config) {
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
    const projected = planProjection.stateOf(session)
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
        accepted: doc.accepted ?? null,
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
        // Read straight from the journal: a detected change awaiting its next
        // delivery, with no extra filesystem probe per drawer poll.
        changedPending: Object.hasOwn(record.pending?.changed ?? {}, item.id),
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
    const projected = planProjection.stateOf(session)
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
    // The `workingDirectory` service is gone from current runtimes; the live
    // Session always carries its header, whose `cwd` is the absolute working
    // directory the session was created in (dsh-session Session.header).
    const sessionId = agent?.session?.id ?? agent?.id
    const live = sessionId === undefined ? undefined : liveSession(sessionId)
    const headerCwd = live?.header?.cwd ?? agent?.session?.header?.cwd
    if (!isNonEmptyString(headerCwd)) {
      throw new Error('The Session has no working directory; file items cannot be added.')
    }
    const cwd = headerCwd
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
      const text = await fs.readText(target, signal)
      return { text }
    } catch (error) {
      if (signal?.aborted === true) throw error
      return { error: describeError(error) }
    }
  }

  const readFileContents = async (items, signal, cache) => {
    const contents = {}
    for (const item of items) {
      if (item.kind !== 'file' || item.mounted !== true) continue
      if (cache !== undefined && cache[item.id] !== undefined) {
        contents[item.id] = cache[item.id]
        continue
      }
      signal?.throwIfAborted?.()
      contents[item.id] = await readStoredFile(item, signal)
    }
    return contents
  }

  /** sha256 prefix of the exact body the model is shown; cheap and restart-stable. */
  const digestBody = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)
  /** Stand-in sighting for a file that was missing or unreadable when last seen. */
  const MISSING_SIGHT = 'missing'

  /**
   * Find out which mounted files moved on disk since the model last saw them.
   * Cheap by construction: one `stat` per item (version = `dev:ino:size:mtime:ctime`),
   * and a content read only once that version moved, so a `touch` or a rewrite
   * with identical bytes never reaches the model.
   *
   * An item with no sighting yet (recorded by an older version, or just added)
   * is compared against the byte size stored when it was added: a size match
   * silently records the sighting without injecting anything, because the model
   * has not been shown a stale copy this step could improve on.
   *
   * @returns `{ changed, contents, sights, versions }` — ids whose body must be
   *   re-sent, the bodies already read, sightings for items needing only a quiet
   *   restamp, and the metadata seen for every probed item.
   */
  const observeFileChanges = async (items, signal) => {
    const result = { changed: [], contents: {}, sights: {}, versions: {} }
    if (config.refreshChangedFiles !== true) return result
    const fs = ctx.get('fs')
    if (fs === undefined) return result
    const files = items.filter(item => item.kind === 'file' && item.mounted === true)
    if (files.length === 0) return result
    for (const item of files) {
      signal?.throwIfAborted?.()
      let info
      try {
        info = await fs.stat(await fs.resolve(item.path, { signal }), signal)
      } catch (error) {
        if (signal?.aborted === true) throw error
        info = undefined
      }
      const present = info !== undefined && info.type === 'file'
      const seen = present && isNonEmptyString(info.version) ? String(info.version) : MISSING_SIGHT
      const size = present && typeof info.size === 'number' ? info.size : item.size
      result.versions[item.id] = { seenVersion: seen, size }
      if (seen === item.seenVersion) continue
      if (!isNonEmptyString(item.seenVersion) && present && size === item.size) {
        result.sights[item.id] = { seenVersion: seen, seenDigest: item.seenDigest ?? '', size }
        continue
      }
      const read = await readStoredFile(item, signal)
      const digest = read.error === undefined ? digestBody(read.text ?? '') : ''
      if (present && digest !== '' && digest === item.seenDigest) {
        result.sights[item.id] = { seenVersion: seen, seenDigest: digest, size }
        continue
      }
      result.changed.push(item.id)
      result.contents[item.id] = read
      result.sights[item.id] = { seenVersion: seen, seenDigest: digest, size }
    }
    return result
  }

  /**
   * Build sightings for the file bodies one message actually carried. The digest
   * covers the complete body that was injected, so a later edit always compares
   * against what the model really saw — including a change in the tail.
   * @param items - items whose content the message carried.
   * @param contents - the bodies that were composed into the message.
   * @param versions - the metadata `observeFileChanges` probed this step.
   */
  const sightsFor = (items, contents, versions) => {
    const sights = {}
    for (const item of items) {
      if (item.kind !== 'file') continue
      const meta = versions?.[item.id]
      const content = contents?.[item.id]
      if (meta === undefined || content === undefined) continue
      sights[item.id] = {
        seenVersion: meta.seenVersion,
        seenDigest: content.error === undefined ? digestBody(content.text ?? '') : '',
        size: meta.size,
      }
    }
    return sights
  }

  /**
   * Account for one delivered injection: drop the journal keys it covered and
   * store the file sightings it carried, in a single write. Stamping only here
   * means a step that never sent a message leaves the change pending, so the
   * next step simply detects it again — nothing is ever marked seen without
   * having been shown.
   * @param sessionId - target Session.
   * @param keys - journal keys the injected message accounted for.
   * @param sights - `{ itemId: { seenVersion, seenDigest, size } }`.
   */
  const deliver = (sessionId, keys, sights) => mutate(sessionId, (current) => {
    const pending = clonePending(current.pending)
    let touched = false
    for (const key of new Set(keys ?? [])) {
      for (const bucket of PENDING_BUCKETS) {
        if (pending[bucket][key] !== undefined) {
          delete pending[bucket][key]
          touched = true
        }
      }
    }
    const items = { ...current.items }
    for (const [id, sight] of Object.entries(sights ?? {})) {
      const item = items[id]
      if (item === undefined || item.kind !== 'file') continue
      if (item.seenVersion === sight.seenVersion && item.seenDigest === sight.seenDigest && item.size === sight.size) continue
      items[id] = { ...item, ...sight }
      touched = true
    }
    if (!touched) return undefined
    const next = cloneRecord(current)
    next.pending = pending
    next.items = items
    return next
  })

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
      if (config.maxItems > 0 && Object.keys(current.items).length >= config.maxItems) {
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
    return mutate(sessionId, (current) => {
      if (config.maxItems > 0 && Object.keys(current.items).length >= config.maxItems) {
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
        // Always false now: nothing is cut any more. The field stays in the
        // wire shape so an older Client bundle cannot mis-read a preview.
        truncated: false,
        error: readFile.error ?? null,
      }
    }
    const session = liveSession(sessionId)
    if (session !== undefined) {
      const doc = planProjection.stateOf(session)?.docs
        ?.find(candidate => candidate.callId === id)
      if (doc !== undefined) {
        return { kind: 'plan', title: doc.title, text: doc.markdown, truncated: false, error: null }
      }
    }
    throw new Error(`No guarded item or plan with id ${JSON.stringify(id)}.`)
  }

  /**
   * Internal bookkeeping, deliberately permission-free (like `deliver`):
   * the auto-mount rule itself never asks, so accounting for its transitions
   * must not ask either. Journals the new auto plan's addition (full text next
   * step) and the displaced auto plan's removal (one line); explicit human
   * choices are never touched. Returns the post-write record so the caller
   * continues the step with fresh pending.
   */
  const syncAutoPlans = (sessionId, docs, sawCompaction) => mutate(sessionId, (current) => {
    const transition = planAutoTransition(docs, current, config, sawCompaction)
    if (transition === undefined) return undefined
    const next = cloneRecord(current)
    next.autoPlan = transition.autoPlan
    if (transition.addPlan !== null) {
      journal(next, 'added', `plan:${transition.addPlan.id}`, 'plan', transition.addPlan.id, transition.addPlan.label)
    }
    if (transition.removePlan !== null) {
      journal(next, 'removed', `plan:${transition.removePlan.id}`, 'plan', transition.removePlan.id, transition.removePlan.label)
    }
    return next
  })

  return {
    config,
    read,
    state,
    deliver,
    observeFileChanges,
    sightsFor,
    syncAutoPlans,
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

function permissionQuestion(action, target, config) {
  const verbEn = action === 'unmount' ? 'unmount' : action === 'add' ? 'add and mount' : 'mount'
  const verbZh = action === 'unmount' ? '卸载' : action === 'add' ? '添加并挂载' : '挂载'
  const kindEn = target.kind === 'file' ? 'file' : 'note'
  const kindZh = target.kind === 'file' ? '文件' : '备注'
  const name = target.kind === 'file' ? target.displayPath : target.title
  const detail = [
    `- Action / 动作: ${verbEn} / ${verbZh}`,
    `- Target / 对象: ${name}`,
    '- Session permission / 会话权限: ask',
    '- The change is applied only if you allow it. / 只有允许才会生效。',
  ]
  const content = typeof target.text === 'string'
    ? target.text
    : typeof target.preview === 'string' ? target.preview : undefined
  if (content !== undefined && content !== '') {
    const options = config ?? DEFAULT_CONFIG
    const isFile = target.kind === 'file'
    // The card is a human review surface, so it previews at `previewChars` for
    // both kinds. This bounds the card only: what gets stored and injected is
    // the complete body either way.
    const limit = Math.max(1, options.previewChars)
    const truncated = content.length > limit || target.previewTruncated === true
    const shown = content.length > limit ? content.slice(0, limit) : content
    const bytes = isFile && typeof target.size === 'number' ? target.size : undefined
    if (content.length > 1000) {
      detail.push('', truncated
        ? '内容较长；以下为预览，向下滚动查看；允许 / 拒绝按钮在内容之后。 / Long content: preview below; scroll down to read it; Allow / Deny follow below.'
        : '内容较长，向下滚动查看；允许 / 拒绝按钮在内容之后。 / Long content: scroll down to read it; Allow / Deny follow below.')
    }
    detail.push('', '---', '')
    if (isFile) {
      const byteWord = bytes === 1 ? 'byte' : 'bytes'
      const total = bytes === undefined ? '文件较大 / large file' : `文件共 ${bytes} 字节 / ${bytes} ${byteWord} total`
      detail.push(truncated
        ? `Preview / 预览（${total}；以下为前 ${shown.length} 字符，允许后可在抽屉或预览器打开完整文件 / first ${shown.length} characters shown; open the full file in the drawer or viewer after you allow it）:`
        : `Preview / 预览（${bytes === undefined ? '完整预览' : `共 ${bytes} 字节 / ${bytes} ${byteWord}`}，完整内容如下 / shown in full）:`)
    } else {
      detail.push(truncated
        ? `Content / 内容（全文共 ${content.length} 字符；卡片只显示前 ${shown.length} 字符，存储与注入的都是完整正文 / ${content.length} chars in total; the card previews the first ${shown.length}, while the stored and injected body is complete）:`
        : `Content / 内容（共 ${content.length} 字符，可在卡片内滚动查看 / ${content.length} chars; scroll inside the card to read it）:`)
    }
    detail.push('')
    detail.push(truncated ? `${shown}\n[… truncated / 已截断]` : shown)
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
      { agent: exec.agent, questions: [permissionQuestion(action, target, config)], signal: exec.signal },
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
  if (item.changedPending === true) flags.push('changed on disk; its current content is sent on the next step')
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
    if (plan.accepted === false) flags.push('rejected; never auto-mounts')
    else if (plan.accepted !== true) flags.push('verdict unconfirmed; never auto-mounts')
    else if (plan.awaitingCompaction) flags.push('will auto-mount after the first compaction')
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
    description: 'Manage this Session\'s guarded context: the plans, notes, and files the user pins so they stay in your context across steps and compactions. Plans are user-controlled; this tool cannot mount or unmount them. Only a plan the user explicitly approved can auto-mount, and only after the first compaction; a rejected or unconfirmed plan stays listed but never auto-mounts. `list` shows plans and pinned items. `add_file` and `add_note` add an item and mount it; `mount` and `unmount` change an existing item. Adding or mounting may require the user\'s permission; a denied request changes nothing. Mounted content reaches you from the next step, always in full — nothing is truncated or left out, and this tool has no action that would fetch a missing part, so what you see is the whole item. The full set is re-sent only when the surface holds no guarded message (first guarding, or after a compaction); otherwise only changes arrive: new content in full, a mounted file whose bytes changed on disk re-sent in full under a "(changed)" heading, and an unmount as one short notice instead of removing earlier text; `add_file` also returns a preview of the file for convenience. Items cannot be deleted with this tool; only the user can delete them. When you hold facts, decisions, or work-in-progress that must survive for the rest of this session, persist them with `add_note`/`add_file` so they stay in your context.',
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
      if (agent.session?.header?.origin === 'subagent') {
        throw new Error('context_guard is only available in the main Session; delegated agents cannot change guarded context.')
      }
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
            previewTruncated: prepared.previewTruncated,
            size: prepared.size,
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
        if (config.maxItems > 0 && Object.keys(record.items).length >= config.maxItems) {
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
  return PENDING_BUCKETS.flatMap(bucket => Object.keys(pending?.[bucket] ?? {}))
}

/**
 * Overlay this step's freshly detected file changes onto the journal used for
 * composition. They are never persisted on their own: the sighting that records
 * them is written together with the delivery, so a step that sent nothing simply
 * detects the same change again on the next step.
 */
function withChanged(pending, changedIds, items) {
  if (changedIds.length === 0) return pending
  let next = pending
  for (const id of changedIds) {
    const item = items.find(candidate => candidate.id === id)
    if (item === undefined) continue
    next = applyPending(next, { action: 'changed', key: id, kind: 'file', id, label: item.displayPath })
  }
  return next
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
 *   or refreshed file, and the content of what was added or refreshed.
 * Mounted files are probed with one `stat` each per step, so an on-disk edit
 * joins the second trigger without waiting for a compaction.
 * Failures self-heal on the next step; the step itself never fails because of
 * this plugin.
 * @param planProjection - awaited handle for the `plan-guard-docs` unit.
 */
function createInjector(ctx, planProjection, config, operations) {
  const clear = async (sessionId, keys, sights) => {
    if (keys.length === 0 && (sights === undefined || Object.keys(sights).length === 0)) return
    try {
      await operations.deliver(sessionId, keys, sights ?? {})
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
      const projected = planProjection.stateOf(agent.session)
      const docs = projected?.docs ?? []
      const sawCompaction = projected?.sawCompaction === true
      // Account for auto-mount transitions before anything else: a newly
      // auto-mounted plan journals its addition and displaces the previous
      // auto plan with a one-line notice. The pure pre-check keeps the common
      // no-change step free of a storage round-trip; on change the fresh
      // record continues this step so the displacement delivers immediately.
      let record = operations.read(sessionId)
      if (planAutoTransition(docs, record, config, sawCompaction) !== undefined) {
        record = (await operations.syncAutoPlans(sessionId, docs, sawCompaction)).record
      }
      const items = Object.values(record.items)
      // Detect mounted-file changes before deciding whether this step has
      // anything to say; a probe failure is logged by the catch below and costs
      // this step its update, not the step itself.
      const sighting = await operations.observeFileChanges(items, signal)
      const pending = withChanged(record.pending ?? emptyPending(), sighting.changed, items)
      const keys = pendingKeys(pending)
      const visible = injectionVisible(agent, decision)
      // A file whose version moved but whose bytes are identical needs only its
      // sighting stored. Persist it even on a step that sends nothing, or every
      // later step would stat, read, and hash that file again.
      if (visible && keys.length === 0) {
        await clear(sessionId, [], sighting.sights)
        return decision
      }

      if (!visible) {
        signal?.throwIfAborted?.()
        const mountedItems = items.filter(item => item.mounted === true)
        let composed
        let contents = {}
        if (docs.length > 0 || mountedItems.length > 0) {
          signal?.throwIfAborted?.()
          contents = await operations.readFileContents(mountedItems, signal, sighting.contents)
          signal?.throwIfAborted?.()
          composed = composeGuardText({ docs, record, config, sawCompaction, contents })
        }
        if (composed === undefined) {
          await clear(sessionId, keys, sighting.sights)
          return decision
        }
        const entered = injectMessage(decision, messages, guardMessage(composed.text))
        await clear(sessionId, keys, { ...sighting.sights, ...operations.sightsFor(mountedItems, contents, sighting.versions) })
        ctx.logger?.debug?.('plan-guard: injected the guarded snapshot (turn %d step %d, %d plan(s), %d item(s))', turn, step, composed.included.length, mountedItems.length)
        return entered
      }

      signal?.throwIfAborted?.()
      const wanted = new Set([...Object.keys(pending.added), ...Object.keys(pending.changed)])
      const targets = items.filter(item => item.mounted === true && item.kind === 'file' && wanted.has(item.id))
      const contents = await operations.readFileContents(targets, signal, sighting.contents)
      signal?.throwIfAborted?.()
      const update = composeUpdate({ pending, record, docs, config, sawCompaction, contents })
      if (update === undefined) {
        await clear(sessionId, keys, sighting.sights)
        return decision
      }
      const entered = injectMessage(decision, messages, guardMessage(update.text))
      await clear(sessionId, keys, { ...sighting.sights, ...operations.sightsFor(targets, contents, sighting.versions) })
      ctx.logger?.debug?.('plan-guard: injected guarded changes (turn %d step %d, %d added, %d refreshed, %d removed)', turn, step, update.added.length, update.changed.length, update.removed.length)
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
 * Host apply: open the guard domain, await the plan-docs projection
 * registration (DSH 0.2.2 made it asynchronous and expects the returned
 * handle to be held), provide the Remote service, install the tool and its
 * delegated-agent restriction, and install the post-compaction injection
 * listener.
 * @param ctx - Cordis context owning this plugin's registrations.
 * @param config - raw row config (the Loader normalizes it through `Config`).
 */
export async function apply(ctx, config) {
  const check = validateConfig(config)
  if (check.issues !== undefined) {
    throw new Error(`plan-guard config rejected: ${check.issues.map(issue => issue.message).join('; ')}`)
  }
  const options = check.value
  // A profile row may still carry the caps this plugin used to size its
  // injections. They are ignored, never reinterpreted: guarded content is
  // delivered whole. Warn once so the row can be cleaned up, then activate.
  if (isRecord(config)) {
    const stale = Object.keys(config).filter(key => DEPRECATED_CONFIG_FIELDS.includes(key))
    if (stale.length > 0) {
      ctx.logger?.warn?.(`plan-guard: ignored deprecated config field(s) ${stale.join(', ')} — nothing is truncated or omitted any more`)
    }
  }
  const projections = ctx.sessionProjections
  const sessions = ctx.get('sessions')

  const domain = await ctx.storageDomain.open(guardDomainSpec)
  ctx.effect(() => async () => {
    try { await domain.close() } catch (error) {
      ctx.logger?.warn?.(`plan-guard: closing the guard domain failed: ${String(error)}`)
    }
  }, 'plan-guard: guard storage domain')

  // DSH 0.2.2: registration is asynchronous and resolves to a
  // `ProjectionHandle`; the registration is still an effect on this fiber, so
  // unloading releases the unit while the retained handle keeps folding new
  // events on demand. Await it before publishing the service, tool, or
  // listeners so no consumer can read a half-installed projection.
  const planProjection = await projections.register({
    key: PLAN_DOCS_PROJECTION_KEY,
    stateSchema,
    init: stateInit,
    apply: foldDocs,
    // 5: plan markdown is stored whole. A cache row at an older version is
    // re-folded from the session log by the runtime, which recovers the tail
    // the 65536-character storage cap used to drop. (4 added the verdict
    // reading; both bumps are re-fold-only, no data migration.)
    stateVersion: 5,
  })
  // The pre-0.2.2 runtime returned a bare disposer; awaiting it yields the
  // disposer function itself, which has no `stateOf`. Fail loud instead of
  // silently reading `undefined` for every Session.
  if (typeof planProjection?.stateOf !== 'function') {
    throw new Error('dsh-plan-guard 0.10.0 requires DSH 0.2.2-rc.5 or newer: sessionProjections.register() must resolve to a ProjectionHandle with stateOf()')
  }

  const operations = createOperations(ctx, domain, planProjection, sessions, options)
  ctx.provide(SERVICE_KEY, new PlanGuardHostService({ ctx, operations }))

  if (options.toolEnabled === true) {
    ctx.effect(() => ctx.tools.register(createTool(ctx, operations, options)), 'plan-guard: context_guard tool')
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session?.header?.origin !== 'subagent') return
      agent.ctx.effect(
        () => agent.ctx.tools.restrict({ deny: [TOOL_NAME] }),
        'plan-guard: hide context_guard from delegated agents',
      )
    })
  }

  ctx.on('agent/pre-step', createInjector(ctx, planProjection, options, operations))
}

/** Pure helpers exported for `node --test`; not part of the plugin contract. */
export const __testables = {
  DEFAULT_CONFIG,
  DEPRECATED_CONFIG_FIELDS,
  POLICIES,
  PLAN_CHOICES,
  TOOL_ACTIONS,
  GUARD_DOMAIN_NAME,
  guardDomainSpec,
  validateConfig,
  normalizeRecord,
  effectivePlanState,
  planAutoTransition,
  authorizeModelAction,
  validateToolArgs,
  composeGuardText,
  composeUpdate,
  applyPending,
  planDocument,
  foldDocs,
  planVerdict,
  withChanged,
  stateInit,
  stateSchema,
  normalizeTitle,
  titleFromText,
  permissionQuestion,
}
