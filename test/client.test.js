import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { test } from 'node:test'

/** Load the browser module the way the Client module table would. */
async function loadClientModule() {
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

  const React = {
    createElement: () => null,
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
    throw new Error(`client module required an unseeded module: ${specifier}`)
  })
  return { module, required, head }
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
  assert.deepEqual(required, ['react'])
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
