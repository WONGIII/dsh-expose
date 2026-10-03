/**
 * The browser half only ever loads through the page's module loader, so the
 * artifact is asserted in that exact shape: a `window.__ModuleLoader__.load`
 * registration whose factory resolves `react` from the host and returns the
 * `inject` / `apply` face the client fiber expects.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACT = path.join(ROOT, 'lib', 'client.js')

/** Load the artifact the way the page does and return the registration. */
function loadRegistration() {
  const code = fs.readFileSync(ARTIFACT, 'utf8')
  let captured
  const window = { __ModuleLoader__: { load: (registration) => { captured = registration } } }
  // eslint-disable-next-line no-new-func -- the artifact is the unit under test
  new Function('window', code)(window)
  assert.ok(captured !== undefined, 'lib/client.js must register with window.__ModuleLoader__')
  return captured
}

/** Minimal React surface: the module only builds elements at call time. */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

test('lib/client.js is a loader registration for this package', () => {
  const code = fs.readFileSync(ARTIFACT, 'utf8')
  assert.match(code, /window\.__ModuleLoader__\.load\(/)
  assert.doesNotMatch(code, /^\s*(import|export)\s/m, 'the served artifact must not keep ESM syntax')
  const registration = loadRegistration()
  assert.equal(registration.id, 'dsh-expose')
  assert.equal(typeof registration.factory, 'function')
})

test('the factory resolves react from the host and exports the client face', () => {
  const registration = loadRegistration()
  const requested = []
  const exports = registration.factory((specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return fakeReact
    throw new Error(`unexpected external ${specifier}`)
  })
  assert.deepEqual(requested, ['react'])
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
  assert.equal(Object.prototype.toString.call(exports), '[object Module]')
})

test('apply contributes the canonical bundle configuration page and the settings tab, then cleans both up', () => {
  const registration = loadRegistration()
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return fakeReact
    throw new Error(`unexpected external ${specifier}`)
  })

  const registered = []
  const disposed = []
  const cleanups = []
  const slotsInjected = []
  const ctx = {
    effect: (factory) => {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    slots: {
      inject: (slot, factory) => {
        slotsInjected.push(slot)
        return factory()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => disposed.push(options.id ?? options.key)
      },
    },
  }

  const style = { dataset: {}, remove: () => disposed.push('style'), textContent: '' }
  const head = { appendChild: (node) => disposed.push(`appended:${node.dataset.plugin}`) }
  const previous = globalThis.document
  globalThis.document = { createElement: () => style, head }
  try {
    exports.apply(ctx)
    // The Plugins page's bundle configuration is keyed by the package name; the
    // Settings tab is a list entry with its own label.
    assert.deepEqual(slotsInjected, ['plugins.bundle.config', 'settings.plugins.tab'])
    assert.equal(registered.length, 2)
    assert.deepEqual(Object.keys(registered[0].options).sort(), ['key', 'name'])
    assert.equal(registered[0].options.name, 'plugins.bundle.config')
    assert.equal(registered[0].options.key, 'dsh-expose')
    assert.equal(registered[1].options.name, 'settings.plugins.tab')
    assert.equal(registered[1].options.id, 'dsh-expose')
    assert.equal(registered[1].options.order, 20)
    assert.equal(typeof registered[1].options.label, 'function')
    assert.equal(registered[1].options.label(), '远程访问')
    for (const entry of registered) assert.equal(typeof entry.component, 'function')
    assert.ok(disposed.includes('appended:dsh-expose'))
    assert.equal(cleanups.length, 1)
    cleanups[0]()
    assert.ok(disposed.includes('dsh-expose'))
    assert.ok(disposed.includes('style'))
  } finally {
    globalThis.document = previous
  }
})

test('the registered view renders the panel for `page` and a one-liner for `summary`', () => {
  const registration = loadRegistration()
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return fakeReact
    throw new Error(`unexpected external ${specifier}`)
  })
  // Reach the components the same way the slot renderer does.
  const views = []
  const ctx = {
    effect: (factory) => factory(),
    slots: {
      inject: (_slot, factory) => factory(),
      register: (_options, component) => {
        views.push(component)
        return () => {}
      },
    },
  }
  const style = { dataset: {}, remove: () => {}, textContent: '' }
  const previous = globalThis.document
  globalThis.document = { createElement: () => style, head: { appendChild: () => {} } }
  try {
    exports.apply(ctx)
  } finally {
    globalThis.document = previous
  }
  assert.equal(views.length, 2)
  assert.equal(views[0], views[1], 'both surfaces render the same entry')

  // The fake createElement keeps function components as element types, so the
  // tree is unwrapped by hand the way React would render it.
  const render = (node) => {
    let current = node
    for (let depth = 0; depth < 5 && current !== null && typeof current === 'object' && typeof current.type === 'function'; depth += 1) {
      current = current.type(current.props ?? {})
    }
    return JSON.stringify(current)
  }

  const page = render(views[0]({ view: 'page' }))
  for (const marker of ['DSH Expose', '监听地址', '监听端口', '远程连接地址', '连通性自检']) {
    assert.match(page, new RegExp(marker))
  }

  const summary = render(views[0]({ view: 'summary' }))
  assert.match(summary, /未开放/)
  assert.doesNotMatch(summary, /监听端口/)

  // The Settings tab renders the same entry without a `view`, which must be the form.
  const noView = render(views[1]({}))
  assert.match(noView, /监听端口/)
})
