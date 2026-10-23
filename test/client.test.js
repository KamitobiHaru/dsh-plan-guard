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
  vm.runInContext(source, vm.createContext({ window, console }), { filename: 'client.js' })
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
  return { module, required }
}

/** Minimal Client context: enough of the registration surface for apply(). */
function fakeContext(captured) {
  const t = key => key
  const remote = new Proxy({}, { get: () => async () => ({ ok: true }) })
  const effect = (callback) => {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  }
  const slots = {
    inject: (_name, callback) => callback(),
    register: definition => { captured.slots.push(definition); return () => {} },
  }
  return {
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
  const { module, required } = await loadClientModule()
  assert.deepEqual(required, ['react'])
  assert.deepEqual([...module.inject], ['slots', 'locale', 'resources', 'remote', 'sidebarRight', 'sidebarRightTabs'])

  const captured = { slots: [], resources: [], tabs: [] }
  await module.apply(fakeContext(captured))

  const { contribution } = captured
  assert.equal(contribution.package, 'dsh-plan-guard')
  assert.equal(captured.locale.namespace, 'plan-guard')
  assert.equal(captured.tabs.length, 1)
  assert.equal(captured.tabs[0].kind, 'plan-guard-drawer')
  assert.equal(captured.resources.length, 1)
  assert.equal(captured.resources[0].protocol, 'plan-guard-drawer')
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
})
