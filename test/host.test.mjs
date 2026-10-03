/**
 * Host-half integration: mount the plugin on a fake Cordis context, drive the
 * real control routes, and assert that flipping the switch actually opens and
 * closes a working listener in front of the fake web carrier.
 *
 * The suite binds real sockets and probes them over the real network stack, so
 * `npm test` pins `--test-concurrency=1`: parallel files would race for
 * ephemeral ports and make the probe legs flaky.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-expose-host-'))
process.env.DSH_HOME = HOME

const { apply } = await import('../lib/index.js')

/** Ask the OS for a free port, then release it for the plugin to claim. */
async function freePort() {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** A fake web carrier: whatever the plugin forwards to. */
function fakeCarrier() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ carrier: true, host: request.headers.host, url: request.url }))
  })
  return server
}

/** A fake Cordis context with the two services the plugin reads. */
function fakeContext(carrierPort) {
  const routes = []
  const effects = []
  const services = new Map([
    ['webServer', { host: '127.0.0.1', port: carrierPort }],
    [
      'connection',
      {
        authenticatedUrl: (base) => `${base}${base.includes('?') ? '&' : '?'}token=TEST-TOKEN`,
        fetch: {
          register: (route) => {
            routes.push(route)
            return async () => {}
          },
        },
      },
    ],
  ])
  const ctx = {
    get: (name) => services.get(name),
    effect: (factory, label) => {
      const dispose = factory()
      effects.push({ label, dispose })
      return dispose
    },
    inject: (deps, callback) => {
      for (const dep of deps) assert.ok(services.has(dep), `fake context is missing service ${dep}`)
      callback(ctx)
    },
  }
  // Cordis exposes every injected service as a context property as well as
  // through `get`; the fake mirrors both so the plugin cannot tell them apart.
  for (const name of services.keys()) {
    Object.defineProperty(ctx, name, { get: () => services.get(name), configurable: true })
  }
  return { ctx, routes, effects }
}

/** Call one registered Fetch route. */
async function call(route, { method = 'GET', body } = {}) {
  assert.ok(route !== undefined, 'route must be registered')
  const request = new Request(`http://127.0.0.1${route.path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const response = await route.fetch(request)
  return { status: response.status, payload: await response.json() }
}

/** One plain HTTP GET against the published port. */
function fetchThrough(port) {
  return new Promise((resolve, reject) => {
    const call_ = http.request({ host: '127.0.0.1', port, path: '/api/ping' }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    call_.on('error', reject)
    call_.end()
  })
}

const carrier = fakeCarrier()
let port
let harness

before(async () => {
  await new Promise((resolve) => carrier.listen(0, '127.0.0.1', resolve))
  port = await freePort()
  harness = fakeContext(carrier.address().port)
  apply(harness.ctx, {})
  await new Promise((resolve) => setImmediate(resolve))
})

after(async () => {
  harness?.effects.find((entry) => entry.label === 'dsh-expose: listener')?.dispose?.()
  await new Promise((resolve) => setImmediate(resolve))
  carrier.closeAllConnections?.()
  await new Promise((resolve) => carrier.close(resolve))
  fs.rmSync(HOME, { recursive: true, force: true })
})

test('registers the five control routes under the authenticated api channel', () => {
  assert.deepEqual(
    harness.routes.map((route) => route.path).sort(),
    [
      '/api/dsh-expose/config',
      '/api/dsh-expose/firewall',
      '/api/dsh-expose/probe',
      '/api/dsh-expose/refresh',
      '/api/dsh-expose/state',
    ],
  )
  for (const route of harness.routes) {
    assert.equal(route.requestBody, 'buffered')
    assert.ok(route.methods.length > 0)
  }
  assert.deepEqual(harness.effects.map((entry) => entry.label), ['dsh-expose: control API', 'dsh-expose: listener'])
})

test('starts closed, with 0.0.0.0:3080 as the shipped default', async () => {
  const route = harness.routes.find((entry) => entry.path.endsWith('/state'))
  const { status, payload } = await call(route)
  assert.equal(status, 200)
  assert.deepEqual(payload.settings, { enabled: false, host: '0.0.0.0', port: 3080 })
  assert.equal(payload.listener.listening, false)
  assert.deepEqual(payload.addresses, [])
  assert.equal(payload.upstream.authority, `127.0.0.1:${carrier.address().port}`)
  assert.ok(Array.isArray(payload.interfaces))
  assert.equal(payload.store.exists, false)
})

test('rejects an invalid port before anything binds', async () => {
  const route = harness.routes.find((entry) => entry.path.endsWith('/config'))
  const { status, payload } = await call(route, { method: 'POST', body: { enabled: true, port: 70_000 } })
  assert.equal(status, 400)
  assert.match(payload.error, /端口/)

  const bad = await call(route, { method: 'POST', body: { enabled: true, host: 'not-a-host' } })
  assert.equal(bad.status, 400)
  assert.match(bad.payload.error, /监听地址/)
})

test('opening the switch binds the port, forwards traffic and publishes tokenized URLs', async () => {
  const config = harness.routes.find((entry) => entry.path.endsWith('/config'))
  const { status, payload } = await call(config, { method: 'POST', body: { enabled: true, host: '0.0.0.0', port } })
  assert.equal(status, 200)
  assert.equal(payload.listener.listening, true)
  assert.equal(payload.listener.port, port)
  assert.equal(payload.listener.error, undefined)
  assert.equal(payload.store.exists, true)

  // The listener is a real socket in front of the fake carrier.
  const forwarded = await fetchThrough(port)
  assert.equal(forwarded.status, 200)
  const echoed = JSON.parse(forwarded.body)
  assert.equal(echoed.carrier, true)
  assert.equal(echoed.url, '/api/ping')
  assert.equal(echoed.host, `127.0.0.1:${carrier.address().port}`)

  // Every advertised address carries the process login token when one exists.
  assert.ok(payload.addresses.length > 0)
  for (const entry of payload.addresses) {
    assert.equal(entry.bound, true)
    assert.match(entry.tokenUrl, /token=TEST-TOKEN/)
  }

  // The settings document is the durable record of the switch.
  const stored = JSON.parse(fs.readFileSync(path.join(HOME, 'dsh-expose.json'), 'utf8'))
  assert.deepEqual({ enabled: stored.enabled, host: stored.host, port: stored.port }, { enabled: true, host: '0.0.0.0', port })
})

test('the self-test reports each leg of the chain', async () => {
  const probe = harness.routes.find((entry) => entry.path.endsWith('/probe'))
  const { status, payload } = await call(probe, { method: 'POST' })
  assert.equal(status, 200)
  assert.equal(payload.probe.steps.length >= 3, true)
  assert.equal(payload.probe.steps[0].ok, true, JSON.stringify(payload.probe.steps))
  assert.ok(payload.probe.steps.some((step) => step.label.includes('未授权访问被拒绝')))
})

test('closing the switch releases the port immediately', async () => {
  const config = harness.routes.find((entry) => entry.path.endsWith('/config'))
  const { payload } = await call(config, { method: 'POST', body: { enabled: false } })
  assert.equal(payload.listener.listening, false)
  assert.deepEqual(payload.addresses, [])
  const rebound = net.createServer()
  await new Promise((resolve, reject) => {
    rebound.once('error', reject)
    rebound.listen(port, '0.0.0.0', resolve)
  })
  await new Promise((resolve) => rebound.close(resolve))
  await assert.rejects(fetchThrough(port))
})

test('a busy port is reported instead of thrown', async () => {
  const squatter = net.createServer()
  const busy = await freePort()
  await new Promise((resolve) => squatter.listen(busy, '0.0.0.0', resolve))
  const config = harness.routes.find((entry) => entry.path.endsWith('/config'))
  const { payload } = await call(config, { method: 'POST', body: { enabled: true, port: busy } })
  assert.equal(payload.listener.listening, false)
  assert.match(payload.listener.error, /占用/)
  await new Promise((resolve) => squatter.close(resolve))
  await call(config, { method: 'POST', body: { enabled: false } })
})
