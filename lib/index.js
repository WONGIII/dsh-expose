/**
 * dsh-expose — host half.
 *
 * Publishes this DSH instance's own loopback web carrier on a second,
 * configurable address so a phone, a laptop, or a colleague can open the same
 * session at `http://<this-machine>:<port>/`.
 *
 * The plugin owns three things and nothing else:
 *
 *   1. a durable on/off switch plus a bind address and port ({@link module:dsh-expose/state});
 *   2. the listener that re-publishes loopback ({@link module:dsh-expose/proxy}); and
 *   3. an authenticated control API on the instance's own `/api` channel,
 *      which is where the browser half reads state and flips the switch.
 *
 * The control routes are registered through `ctx.connection.fetch`, so they
 * inherit the carrier's Host/Origin fence and browser-cookie authentication:
 * a remote stranger cannot toggle exposure even though the port they reached
 * is the very port this plugin opened.
 * @module dsh-expose
 */
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { startProxy } from './proxy.js'
import { discoverPublicIp, describeAddressKind, listLocalAddresses } from './network.js'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './state.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-expose'

/** Services this plugin reads; exposure needs a web carrier to forward to. */
export const inject = ['webServer']

/** Every control route this plugin owns, below the shared `/api` channel. */
const API_BASE = '/api/dsh-expose'

/** Public-IP cache lifetime; long enough to keep the tab cheap, short enough to follow a reconnect. */
const PUBLIC_IP_TTL_MS = 90_000

/** Timeout for one probe leg. */
const PROBE_TIMEOUT_MS = 4_000

/** Windows firewall rule prefix, so the rule a user adds is findable again. */
const FIREWALL_RULE_PREFIX = 'DSH Expose'

const require = createRequire(import.meta.url)
const VERSION = (() => {
  try {
    return require('../package.json').version
  } catch {
    return '0.0.0'
  }
})()

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {{ enabled?: boolean, host?: string, port?: number }} [config] - profile-provided defaults.
 */
export function apply(ctx, config = {}) {
  const settings = loadSettings(config)
  const runtime = {
    settings: { enabled: settings.enabled, host: settings.host, port: settings.port },
    stored: { path: settings.path, exists: settings.exists, issues: settings.issues },
    proxy: undefined,
    error: undefined,
    refreshing: undefined,
    publicIp: undefined,
    publicCachedAt: 0,
    publicError: undefined,
    lastProbe: undefined,
    queue: Promise.resolve(),
  }

  /** The instance's own web carrier, resolved lazily so boot order never matters. */
  function upstream() {
    const server = ctx.get('webServer')
    if (server === undefined) return undefined
    const host = server.host === '0.0.0.0' ? '127.0.0.1' : server.host
    return { host, port: server.port, authority: `${host}:${server.port}` }
  }

  /** Serialize mutations: a human can click the switch faster than a socket binds. */
  function serialize(task) {
    const next = runtime.queue.then(task, task)
    runtime.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /** Stop the current listener, if any. */
  async function unpublish() {
    const current = runtime.proxy
    runtime.proxy = undefined
    if (current === undefined) return
    try {
      await current.close()
    } catch {
      /* a socket that already died needs no second close */
    }
  }

  /** Apply the current settings to the network. */
  async function publish() {
    await unpublish()
    runtime.error = undefined
    // A previous run's self-test describes a listener that no longer exists.
    runtime.lastProbe = undefined
    if (!runtime.settings.enabled) return
    const target = upstream()
    if (target === undefined) {
      runtime.error = '未找到 Web 载体服务（webServer），无法开放'
      return
    }
    try {
      runtime.proxy = await startProxy({
        bindHost: runtime.settings.host,
        port: runtime.settings.port,
        upstreamHost: target.host,
        upstreamPort: target.port,
      })
    } catch (error) {
      runtime.error =
        error?.code === 'EADDRINUSE'
          ? `端口 ${runtime.settings.port} 已被其它进程占用`
          : error?.code === 'EACCES'
            ? `端口 ${runtime.settings.port} 需要更高权限（1024 以下端口）`
            : error?.code === 'EADDRNOTAVAIL'
              ? `本机不存在地址 ${runtime.settings.host}`
              : `监听失败：${String(error?.message ?? error)}`
    }
  }

  /** Persist + apply in one serialized step. */
  function commit(next) {
    return serialize(async () => {
      runtime.settings = next
      try {
        saveSettings(next)
        runtime.stored = { ...runtime.stored, exists: true, issues: [] }
      } catch (error) {
        runtime.stored = { ...runtime.stored, issues: [`写入设置失败：${String(error?.message ?? error)}`] }
      }
      await publish()
      return runtime.settings
    })
  }

  /** Tokenized login URL for one authority, when the carrier exposes its token. */
  function authenticatedUrl(base) {
    const connection = ctx.get('connection')
    if (connection === undefined || typeof connection.authenticatedUrl !== 'function') return undefined
    try {
      return connection.authenticatedUrl(base)
    } catch {
      return undefined
    }
  }

  /** Local interfaces, always present so the bind-address picker works before exposure. */
  function interfaces() {
    return listLocalAddresses().map((entry) => ({
      name: entry.name,
      address: entry.address,
      kind: entry.kind,
      kindLabel: describeAddressKind(entry.kind),
      virtual: entry.virtual,
    }))
  }

  /** Every URL this instance currently answers on, with and without the login token. */
  function addresses() {
    const port = runtime.proxy?.port ?? runtime.settings.port
    const boundHost = runtime.settings.host
    const wildcard = boundHost === '0.0.0.0'
    const built = interfaces().map((entry) => {
      const base = `http://${entry.address}:${port}/`
      return {
        ...entry,
        bound: wildcard || boundHost === entry.address,
        requiresForwarding: false,
        url: base,
        tokenUrl: authenticatedUrl(base),
      }
    })
    const publicIp = runtime.publicIp
    if (publicIp?.ip !== undefined && publicIp.direct !== true) {
      const base = `http://${publicIp.ip}:${port}/`
      built.push({
        name: 'WAN',
        address: publicIp.ip,
        kind: 'nat',
        kindLabel: '公网出口（需端口映射）',
        bound: wildcard,
        requiresForwarding: true,
        url: base,
        tokenUrl: authenticatedUrl(base),
      })
    }
    return built.sort((left, right) => Number(right.bound) - Number(left.bound) || left.address.localeCompare(right.address))
  }

  /** Refresh the public-IP cache; concurrent callers share one attempt. */
  function refreshPublicIp(force = false) {
    const fresh = Date.now() - runtime.publicCachedAt < PUBLIC_IP_TTL_MS && runtime.publicIp !== undefined
    if (fresh && !force) return Promise.resolve(runtime.publicIp)
    if (runtime.refreshing !== undefined) return runtime.refreshing
    runtime.refreshing = discoverPublicIp()
      .then((result) => {
        runtime.publicIp = result
        runtime.publicError = result.error
        runtime.publicCachedAt = Date.now()
        return result
      })
      .catch((error) => {
        runtime.publicError = String(error?.message ?? error)
        return undefined
      })
      .finally(() => {
        runtime.refreshing = undefined
      })
    return runtime.refreshing
  }

  /** JSON-safe view of everything the browser half renders. */
  function snapshot() {
    const target = upstream()
    const proxy = runtime.proxy
    return {
      ok: true,
      version: VERSION,
      settings: { ...runtime.settings },
      store: { path: runtime.stored.path, exists: runtime.stored.exists, issues: runtime.stored.issues, defaults: { ...DEFAULT_SETTINGS } },
      upstream: target === undefined ? undefined : { host: target.host, port: target.port, authority: target.authority },
      listener: {
        listening: proxy !== undefined,
        bindHost: proxy?.bindHost ?? runtime.settings.host,
        port: proxy?.port ?? runtime.settings.port,
        since: proxy?.stats.startedAt,
        error: runtime.error,
      },
      interfaces: interfaces(),
      addresses: proxy === undefined ? [] : addresses(),
      public: {
        ip: runtime.publicIp?.ip,
        direct: runtime.publicIp?.direct ?? false,
        source: runtime.publicIp?.source,
        error: runtime.publicError,
        cachedAt: runtime.publicCachedAt === 0 ? undefined : new Date(runtime.publicCachedAt).toISOString(),
        refreshing: runtime.refreshing !== undefined,
      },
      stats: proxy?.snapshot(),
      probe: runtime.lastProbe,
      firewall: {
        platform: process.platform,
        supported: process.platform === 'win32' || process.platform === 'linux',
        ruleName: `${FIREWALL_RULE_PREFIX} ${runtime.settings.port}`,
      },
    }
  }

  /**
   * Reachability self-test: prove the listener answers on loopback, prove it
   * answers on a real network interface, prove an unauthenticated hit is
   * refused by the carrier's own authentication rather than by an open door,
   * and prove the tokenized login link completes its cookie exchange.
   */
  async function probe() {
    const proxy = runtime.proxy
    if (proxy === undefined) {
      runtime.lastProbe = { ok: false, at: new Date().toISOString(), reason: '尚未开放', steps: [] }
      return runtime.lastProbe
    }
    const steps = []
    const leg = async (label, url, expectation) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
      const started = Date.now()
      try {
        const response = await fetch(url, { signal: controller.signal, redirect: 'manual' })
        steps.push({ label, url, status: response.status, ms: Date.now() - started, ok: expectation(response.status) })
      } catch (error) {
        steps.push({
          label,
          url,
          status: 0,
          ms: Date.now() - started,
          ok: false,
          note:
            error?.name === 'AbortError'
              ? '超时'
              : [error?.cause?.code, error?.cause?.message, error?.message].filter((part) => typeof part === 'string' && part !== '').join(' · ') ||
                String(error),
        })
      } finally {
        clearTimeout(timer)
      }
    }

    const candidates = addresses()
    const lan = candidates.find((entry) => entry.bound && entry.address !== '127.0.0.1' && entry.kind !== 'nat')
    await leg('本机监听端口', `http://127.0.0.1:${proxy.port}/`, (status) => status > 0)
    if (lan !== undefined) await leg(`网卡 ${lan.address}`, lan.url, (status) => status > 0)
    await leg('未授权访问被拒绝', `http://127.0.0.1:${proxy.port}/`, (status) => status === 401 || status === 403)
    const tokenBase = lan?.url ?? `http://127.0.0.1:${proxy.port}/`
    const token = authenticatedUrl(tokenBase)
    if (token !== undefined) await leg('令牌登录链路', token, (status) => status === 303 || status === 302 || status === 200)

    runtime.lastProbe = {
      ok: steps.length > 0 && steps.every((step) => step.ok),
      at: new Date().toISOString(),
      upstream: upstream()?.authority,
      port: proxy.port,
      steps,
    }
    return runtime.lastProbe
  }

  /** Add / remove / inspect the inbound firewall rule for the published port. */
  async function firewall(action) {
    const port = runtime.settings.port
    const ruleName = `${FIREWALL_RULE_PREFIX} ${port}`
    const manual =
      process.platform === 'win32'
        ? `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=${port}`
        : `sudo ufw allow ${port}/tcp`
    const table = {
      win32: {
        add: ['netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${ruleName}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`]],
        remove: ['netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${ruleName}`]],
        status: ['netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${ruleName}`]],
      },
      linux: {
        add: ['ufw', ['allow', `${port}/tcp`]],
        remove: ['ufw', ['delete', 'allow', `${port}/tcp`]],
        status: ['ufw', ['status']],
      },
    }
    const perPlatform = table[process.platform]
    if (perPlatform === undefined || perPlatform[action] === undefined) {
      return { ok: false, supported: false, action, ruleName, port, command: manual, message: '当前平台不支持自动放行，请手动执行下面的命令。' }
    }
    const [binary, args] = perPlatform[action]
    const result = await new Promise((resolve) => {
      execFile(binary, args, { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => {
        resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    })
    const output = `${result.stdout}${result.stderr}`.trim()
    const denied = /elevat|管理员|permission|denied|权限/i.test(output)
    const failed = result.error !== undefined && !(action === 'status' && output !== '')
    return {
      ok: !failed,
      supported: true,
      action,
      ruleName,
      port,
      command: [binary, ...args].join(' '),
      output: output.split(/\r?\n/).slice(0, 12).join('\n'),
      elevationRequired: failed && denied,
      message: !failed
        ? action === 'add'
          ? `已添加入站放行规则「${ruleName}」`
          : action === 'remove'
            ? `已删除入站规则「${ruleName}」`
            : `已读取规则「${ruleName}」`
        : denied
          ? '需要管理员权限：请以管理员身份运行下面的命令，或在系统防火墙中手动放行。'
          : `执行失败：${output.split(/\r?\n/)[0] ?? String(result.error?.message ?? '')}`,
    }
  }

  /** Parse and validate a JSON control payload. */
  async function readJson(request) {
    try {
      const body = await request.json()
      return typeof body === 'object' && body !== null ? body : {}
    } catch {
      return {}
    }
  }

  // --- control API -------------------------------------------------------
  // Registered through the Connection carrier so every route inherits the
  // Host/Origin fence and cookie authentication of this instance.
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.get('connection')
    if (connection === undefined) return
    const disposers = []
    const route = (path, methods, handler) => {
      disposers.push(
        connection.fetch.register({
          path,
          methods,
          requestBody: 'buffered',
          fetch: async (request) => {
            try {
              return await handler(request)
            } catch (error) {
              return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 500 })
            }
          },
        }),
      )
    }

    route(`${API_BASE}/state`, ['GET'], async () => {
      if (runtime.publicIp === undefined) void refreshPublicIp()
      return Response.json(snapshot())
    })

    route(`${API_BASE}/config`, ['POST'], async (request) => {
      const body = await readJson(request)
      const next = {
        enabled: typeof body.enabled === 'boolean' ? body.enabled : runtime.settings.enabled,
        host: typeof body.host === 'string' && body.host.trim() !== '' ? body.host.trim() : runtime.settings.host,
        port: body.port === undefined ? runtime.settings.port : Number(body.port),
      }
      if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) {
        return Response.json({ ok: false, error: '端口必须是 1-65535 之间的整数' }, { status: 400 })
      }
      if (next.host !== '0.0.0.0' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(next.host)) {
        return Response.json({ ok: false, error: '监听地址必须是 0.0.0.0 或一个 IPv4 地址' }, { status: 400 })
      }
      await commit(next)
      // Show the freshly opened listener's own health instead of a stale row.
      if (runtime.settings.enabled && runtime.proxy !== undefined) await probe()
      return Response.json(snapshot())
    })

    route(`${API_BASE}/refresh`, ['POST'], async () => {
      await refreshPublicIp(true)
      return Response.json(snapshot())
    })

    route(`${API_BASE}/probe`, ['POST'], async () => {
      await probe()
      return Response.json(snapshot())
    })

    route(`${API_BASE}/firewall`, ['POST'], async (request) => {
      const body = await readJson(request)
      const action = body.action === 'remove' || body.action === 'status' ? body.action : 'add'
      const result = await firewall(action)
      return Response.json({ ok: result.ok, firewall: result, state: snapshot() })
    })

    connectionCtx.effect(
      () => () => {
        for (const dispose of disposers.splice(0)) {
          try {
            const pending = dispose()
            if (pending !== undefined && typeof pending.then === 'function') pending.catch(() => {})
          } catch {
            /* an already-disposed route is not an error */
          }
        }
      },
      'dsh-expose: control API',
    )
  })

  // --- lifecycle ---------------------------------------------------------
  ctx.inject(['webServer'], () => {
    void serialize(publish)
  })

  ctx.effect(
    () => () => {
      void serialize(unpublish)
    },
    'dsh-expose: listener',
  )
}

/** Default settings, re-exported so a profile patch or a test can read one source. */
export { DEFAULT_SETTINGS }
