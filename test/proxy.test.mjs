/**
 * The proxy is the one piece of this plugin that can silently break a live
 * session, so it is tested against a real socket pair: a fake upstream that
 * records what it received, and the real listener in front of it.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { after, before, test } from 'node:test'
import { startProxy } from '../lib/proxy.js'

/** A fake upstream: records the request it saw, answers 200, 303 or 500 on demand. */
function fakeUpstream() {
  const seen = []
  const tunnels = new Set()
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const record = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      seen.push(record)
      if (request.url.startsWith('/redirect')) {
        response.writeHead(303, { location: `http://127.0.0.1:${server.address().port}/after`, 'set-cookie': 'dsh-auth-demo=abc; Path=/; HttpOnly' })
        response.end()
        return
      }
      if (request.url.startsWith('/boom')) {
        response.writeHead(500, { 'content-type': 'text/plain' })
        response.end('upstream exploded')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, host: request.headers.host, origin: request.headers.origin ?? null, echo: record.body }))
    })
  })
  server.on('upgrade', (request, socket, head) => {
    seen.push({ method: 'UPGRADE', url: request.url, headers: request.headers, body: head.toString('utf8') })
    tunnels.add(socket)
    socket.on('close', () => tunnels.delete(socket))
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (chunk) => socket.write(`echo:${chunk.toString('utf8')}`))
  })
  return { server, seen, tunnels }
}

/** One HTTP request through the proxy, returning status, headers and body. */
function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const call = http.request({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () =>
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    call.on('error', reject)
    if (body !== undefined) call.write(body)
    call.end()
  })
}

let upstream
let proxy

before(async () => {
  upstream = fakeUpstream()
  await new Promise((resolve) => upstream.server.listen(0, '127.0.0.1', resolve))
  proxy = await startProxy({
    bindHost: '127.0.0.1',
    port: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: upstream.server.address().port,
  })
})

after(async () => {
  await proxy?.close()
  for (const socket of upstream?.tunnels ?? []) socket.destroy()
  upstream?.server.closeAllConnections?.()
  await new Promise((resolve) => upstream?.server.close(resolve))
})

test('forwards method, path and body and rewrites Host to the upstream authority', async () => {
  const port = proxy.port
  const response = await request(port, '/api/thing?x=1', {
    method: 'POST',
    headers: { host: '192.168.1.20:3080', 'content-type': 'application/json' },
    body: '{"hello":"world"}',
  })
  assert.equal(response.status, 200)
  const record = upstream.seen.at(-1)
  assert.equal(record.method, 'POST')
  assert.equal(record.url, '/api/thing?x=1')
  assert.equal(record.headers.host, `127.0.0.1:${upstream.server.address().port}`)
  assert.equal(record.headers['x-forwarded-host'], '192.168.1.20:3080')
  assert.equal(record.body, '{"hello":"world"}')
  assert.deepEqual(JSON.parse(response.body).host, `127.0.0.1:${upstream.server.address().port}`)
})

test('rewrites Origin and Referer so the upstream same-origin fence still passes', async () => {
  await request(proxy.port, '/api/write', {
    method: 'POST',
    headers: {
      host: '192.168.1.20:3080',
      origin: 'http://192.168.1.20:3080',
      referer: 'http://192.168.1.20:3080/settings',
    },
  })
  const record = upstream.seen.at(-1)
  assert.equal(record.headers.origin, `http://127.0.0.1:${upstream.server.address().port}`)
  assert.equal(record.headers.referer, `http://127.0.0.1:${upstream.server.address().port}/settings`)
})

test('passes the authority-bound session cookie through untouched', async () => {
  await request(proxy.port, '/api/state', {
    headers: { host: '192.168.1.20:3080', cookie: 'dsh-auth-xyz=token-value' },
  })
  assert.equal(upstream.seen.at(-1).headers.cookie, 'dsh-auth-xyz=token-value')
})

test('rewrites an absolute upstream Location back to the authority the client used', async () => {
  const response = await request(proxy.port, '/redirect', { headers: { host: '10.0.0.9:3080' } })
  assert.equal(response.status, 303)
  assert.equal(response.headers.location, `http://10.0.0.9:3080/after`)
  assert.match(response.headers['set-cookie'][0], /dsh-auth-demo=abc/)
})

test('surfaces an upstream failure as a readable 502', async () => {
  const dead = await startProxy({ bindHost: '127.0.0.1', port: 0, upstreamHost: '127.0.0.1', upstreamPort: 1 })
  const response = await request(dead.port, '/')
  assert.equal(response.status, 502)
  assert.match(response.body, /无法连接本机 DSH 服务/)
  await dead.close()
})

test('tunnels an Upgrade handshake and duplex bytes', async () => {
  const socket = net.connect({ host: '127.0.0.1', port: proxy.port })
  const received = []
  await new Promise((resolve, reject) => {
    socket.on('error', reject)
    socket.on('connect', () => {
      socket.write('GET /api/stream HTTP/1.1\r\nHost: 192.168.1.20:3080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    })
    socket.on('data', (chunk) => {
      received.push(chunk.toString('utf8'))
      if (received.join('').includes('echo:ping')) {
        socket.end()
        resolve()
      }
      if (received.join('').includes('101 Switching Protocols')) socket.write('ping')
    })
    setTimeout(() => reject(new Error('upgrade tunnel timed out')), 4000)
  })
  const transcript = received.join('')
  assert.match(transcript, /101 Switching Protocols/)
  assert.match(transcript, /echo:ping/)
  const upgradeRecord = upstream.seen.find((record) => record.method === 'UPGRADE')
  assert.equal(upgradeRecord.headers.host, `127.0.0.1:${upstream.server.address().port}`)
})

test('reports live counters and the connected client table', async () => {
  const snapshot = proxy.snapshot()
  assert.ok(snapshot.requests >= 4)
  assert.ok(snapshot.upgrades >= 1)
  assert.ok(Array.isArray(snapshot.clients))
  assert.ok(snapshot.clients.every((client) => typeof client.address === 'string'))
})
