/**
 * The exposure listener: a small reverse proxy that re-publishes this
 * instance's own loopback web carrier on a second address.
 *
 * Why a proxy at all? The shipped web carrier deliberately refuses to bind
 * anything but loopback (`--host 0.0.0.0` is a usage error: it would expose
 * remote code execution), and its `/api` fence plus the authority-bound
 * browser cookie both key off the request authority. Re-publishing loopback
 * behind a listener we own keeps every one of those invariants intact:
 *
 *   - the inbound `Host` is rewritten to the upstream loopback authority, so
 *     `isTrustedApiRequest` sees an authority it already trusts and the
 *     authority-bound cookie the browser stores for the remote host still
 *     names the upstream authority the server signed;
 *   - `Origin` / `Referer` are rewritten to the same authority, so the fence's
 *     same-origin check keeps passing for browser-issued writes;
 *   - absolute `Location` headers pointing back at upstream are rewritten to
 *     the authority the client actually used, so redirects never leak
 *     `127.0.0.1` to a remote browser;
 *   - `Upgrade` (WebSocket / raw duplex) is tunnelled byte-for-byte.
 *
 * Nothing here is harness-aware: it is a plain TCP/HTTP forwarder with header
 * rewriting and counters.
 * @module dsh-expose/proxy
 */
import http from 'node:http'
import net from 'node:net'

/** Headers that must not be forwarded across a proxy hop. */
const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
])

/** The few response headers a hop must not echo back verbatim. */
const DROP_FROM_RESPONSE = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade'])

/** Normalize a raw `Host` header into a comparable authority, or undefined. */
function authorityOf(rawHost) {
  if (typeof rawHost !== 'string' || rawHost === '') return undefined
  try {
    return new URL(`http://${rawHost}`).host
  } catch {
    return undefined
  }
}

/**
 * Rewrite one same-authority absolute URL onto another authority, preserving
 * the path and query byte-for-byte (a hand-built `URL.href` would add a
 * trailing slash to a bare origin, and `Origin` must keep its exact shape).
 */
function retarget(value, fromAuthority, toAuthority) {
  if (typeof value !== 'string') return value
  const match = /^(https?:\/\/)([^/?#]*)([\s\S]*)$/i.exec(value)
  if (match === null) return value
  if (authorityOf(match[2]) !== fromAuthority) return value
  return `${match[1]}${toAuthority}${match[3]}`
}

/**
 * Build the header set sent upstream: authority-bearing headers move to the
 * upstream authority, hop-by-hop headers are dropped, and the original
 * authority is preserved for upstream logging. `upgrade` keeps the two
 * handshake headers the tunnel itself needs — a proxied WebSocket that lost
 * `Connection`/`Upgrade` would be answered as an ordinary GET.
 */
function rewriteRequestHeaders(headers, { upstreamAuthority, clientAuthority, clientAddress, upgrade = false }) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (lower === 'host') continue
    if (HOP_BY_HOP.has(lower) && !(upgrade && (lower === 'connection' || lower === 'upgrade'))) continue
    out[lower] = value
  }
  if (upgrade) {
    out.connection = 'Upgrade'
    out.upgrade = headers.upgrade ?? 'websocket'
  }
  out.host = upstreamAuthority
  if (headers.origin !== undefined) out.origin = retarget(headers.origin, clientAuthority, upstreamAuthority)
  if (headers.referer !== undefined) out.referer = retarget(headers.referer, clientAuthority, upstreamAuthority)
  out['x-forwarded-host'] = clientAuthority
  out['x-forwarded-proto'] = 'http'
  out['x-forwarded-for'] = clientAddress ?? ''
  return out
}

/** Rewrite response headers on the way back: absolute same-authority locations follow the client. */
function rewriteResponseHeaders(headers, { upstreamAuthority, clientAuthority }) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (DROP_FROM_RESPONSE.has(lower)) continue
    if (lower === 'location' && typeof value === 'string' && /^https?:\/\//i.test(value)) {
      out[name] = retarget(value, upstreamAuthority, clientAuthority)
      continue
    }
    out[name] = value
  }
  return out
}

/** Serialize one raw HTTP request head for the upgrade tunnel. */
function rawRequestHead(request, headers) {
  const lines = [`${request.method} ${request.url} HTTP/1.1`]
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

/** Dark, dependency-free error page for a proxy-level failure. */
function errorPage(title, detail) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>dsh-expose</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e6e8ef;
font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:36rem;padding:2.5rem;
border:1px solid #232838;border-radius:16px;background:linear-gradient(180deg,#12151d,#0e1117);box-shadow:0 24px 60px rgba(0,0,0,.45)}
h1{margin:0 0 .5rem;font-size:1.05rem;letter-spacing:.01em}p{margin:.35rem 0;color:#9aa3b8}code{color:#7dd3fc}</style>
<main><h1>${title}</h1><p>${detail}</p><p>本页由 <code>dsh-expose</code> 转发监听器生成。</p></main></html>`
}

/**
 * Start (or replace) the exposure listener.
 *
 * @param {object} options - listener configuration.
 * @param {string} options.bindHost - local address to bind (`0.0.0.0` publishes every interface).
 * @param {number} options.port - local TCP port.
 * @param {string} options.upstreamHost - this instance's web carrier host (always loopback).
 * @param {number} options.upstreamPort - this instance's web carrier port.
 * @returns {Promise<object>} the live listener handle.
 */
export async function startProxy({ bindHost, port, upstreamHost, upstreamPort }) {
  const upstreamAuthority = authorityOf(`${upstreamHost}:${upstreamPort}`) ?? `${upstreamHost}:${upstreamPort}`
  // No socket timeout: the carrier's long-lived SSE and websocket streams must
  // survive a quiet session, so the agent only reuses sockets.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 512, maxFreeSockets: 64 })
  const sockets = new Set()
  const clients = new Map()
  const stats = {
    startedAt: new Date().toISOString(),
    requests: 0,
    upgrades: 0,
    bytesUp: 0,
    bytesDown: 0,
    errors: 0,
    lastError: undefined,
    lastErrorAt: undefined,
    lastSeenAt: undefined,
  }

  const noteClient = (address) => {
    if (typeof address !== 'string') return
    const current = clients.get(address)
    clients.set(address, { address, requests: (current?.requests ?? 0) + 1, lastSeenAt: new Date().toISOString() })
  }

  const server = http.createServer()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
  })

  server.on('request', (request, response) => {
    stats.requests += 1
    stats.lastSeenAt = new Date().toISOString()
    noteClient(request.socket.remoteAddress)
    const clientAuthority = authorityOf(request.headers.host) ?? `${bindHost}:${port}`
    const upstream = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method: request.method,
      path: request.url,
      agent,
      headers: rewriteRequestHeaders(request.headers, {
        upstreamAuthority,
        clientAuthority,
        clientAddress: request.socket.remoteAddress,
      }),
    })
    upstream.on('response', (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        rewriteResponseHeaders(upstreamResponse.headers, { upstreamAuthority, clientAuthority }),
      )
      upstreamResponse.on('data', (chunk) => {
        stats.bytesDown += chunk.length
      })
      upstreamResponse.pipe(response)
    })
    upstream.on('error', (error) => {
      stats.errors += 1
      stats.lastError = `${error.code ?? 'ERROR'}: ${error.message}`
      stats.lastErrorAt = new Date().toISOString()
      if (response.headersSent) {
        response.destroy()
        return
      }
      const body = errorPage(
        '无法连接本机 DSH 服务',
        `转发目标 <code>${upstreamAuthority}</code> 拒绝或未能建立连接（${error.code ?? error.message}）。请确认 DSH 实例仍在运行。`,
      )
      response.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(body)
    })
    request.on('data', (chunk) => {
      stats.bytesUp += chunk.length
    })
    // The inbound message is short-lived: its 'close' fires once the body has
    // been read, which is long before the response exists. Only a client that
    // goes away mid-response may cancel the upstream call.
    response.on('close', () => {
      if (!response.writableEnded) upstream.destroy()
    })
    request.on('aborted', () => upstream.destroy())
    request.pipe(upstream)
  })

  server.on('upgrade', (request, socket, head) => {
    stats.upgrades += 1
    stats.lastSeenAt = new Date().toISOString()
    noteClient(request.socket.remoteAddress)
    const clientAuthority = authorityOf(request.headers.host) ?? `${bindHost}:${port}`
    const target = net.connect({ host: upstreamHost, port: upstreamPort })
    let settled = false
    const fail = (error) => {
      stats.errors += 1
      stats.lastError = `${error?.code ?? 'UPGRADE'}: ${error?.message ?? 'upgrade failed'}`
      stats.lastErrorAt = new Date().toISOString()
      if (!settled && socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      socket.destroy()
      target.destroy()
    }
    target.on('error', fail)
    socket.on('error', () => target.destroy())
    target.on('connect', () => {
      settled = true
      target.write(
        rawRequestHead(
          request,
          rewriteRequestHeaders(request.headers, {
            upstreamAuthority,
            clientAuthority,
            clientAddress: request.socket.remoteAddress,
            upgrade: true,
          }),
        ),
      )
      if (head?.length) target.write(head)
      socket.pipe(target)
      target.pipe(socket)
    })
  })

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, bindHost)
  })

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  const boundHost = typeof address === 'object' && address !== null ? address.address : bindHost

  return {
    bindHost,
    port: boundPort,
    upstreamAuthority,
    stats,
    /** Live counters plus the connected-client table, JSON-safe. */
    snapshot() {
      return {
        ...stats,
        clients: [...clients.values()].sort((left, right) => right.requests - left.requests).slice(0, 12),
      }
    },
    /** Stop listening and drop every open socket. Idempotent. */
    async close() {
      agent.destroy()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      // An upgraded tunnel is not tracked by the server's own connection list,
      // so both surfaces are torn down explicitly before the socket closes.
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
