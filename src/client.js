/**
 * dsh-expose — browser half (source).
 *
 * Registers the configuration surface twice, through the two slot surfaces the
 * shipped client declares for it:
 *
 *   - `plugins.bundle.config` (keyed by this package's name) — the canonical
 *     home: the Plugins page renders it on this bundle's own detail page; and
 *   - `settings.plugins.tab` — a tab in Settings → Built-in plugins, so the
 *     same panel is reachable from the settings dialog.
 *
 * This file is plain ESM with no imports: `scripts/build.mjs` wraps it into
 * the `window.__ModuleLoader__.load({...})` factory the DSH client serves, and
 * that wrapper binds `React` for us. Every network call goes to the same-origin
 * control API under `/api/dsh-expose`, which the host half registered on the
 * instance's own authenticated `/api` channel.
 */

export const inject = ['slots']

const API = '/api/dsh-expose'
const POLL_MS = 10_000
const h = React.createElement

const CSS = `
.dx-root{display:flex;flex-direction:column;gap:14px;width:100%;max-width:860px;color:var(--dsw-alias-label-primary,#e8eaf0);font-size:13px;line-height:20px}
.dx-hero{position:relative;overflow:hidden;border-radius:16px;padding:16px 18px;border:.5px solid var(--dsw-alias-border-l3,#2b3040);background:
  radial-gradient(120% 160% at 0% 0%,color-mix(in srgb,var(--dsw-alias-state-business-primary,#4f7cff) 18%,transparent),transparent 60%),
  linear-gradient(180deg,var(--dsw-alias-bg-layer-2,#15171e),var(--dsw-alias-bg-layer-1,#101218))}
.dx-hero[data-live="true"]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2ecc71) 45%,transparent)}
.dx-hero-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dx-title{font-size:15px;font-weight:650;letter-spacing:.01em;margin:0}
.dx-sub{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#98a0b3)}
.dx-pill{margin-left:auto;display:inline-flex;align-items:center;gap:7px;padding:4px 11px;border-radius:999px;font-size:12px;font-weight:600;
  border:.5px solid var(--dsw-alias-border-l3,#2b3040);background:var(--dsw-alias-bg-layer-1,#101218);color:var(--dsw-alias-label-secondary,#b6bdcd)}
.dx-pill[data-live="true"]{color:#34d399;border-color:color-mix(in srgb,#34d399 45%,transparent);background:color-mix(in srgb,#34d399 12%,transparent)}
.dx-dot{width:8px;height:8px;border-radius:50%;background:#6b7280;flex:none}
.dx-pill[data-live="true"] .dx-dot{background:#34d399;box-shadow:0 0 0 0 color-mix(in srgb,#34d399 70%,transparent);animation:dx-pulse 1.9s ease-out infinite}
@keyframes dx-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,#34d399 60%,transparent)}70%{box-shadow:0 0 0 9px transparent}100%{box-shadow:0 0 0 0 transparent}}
.dx-card{border:.5px solid var(--dsw-alias-border-l3,#2b3040);border-radius:14px;background:var(--dsw-alias-bg-layer-2,#15171e);padding:14px 16px}
.dx-card-head{display:flex;align-items:center;gap:8px;margin:0 0 10px}
.dx-card-head h4{margin:0;font-size:13px;font-weight:620}
.dx-card-head span{color:var(--dsw-alias-label-tertiary,#98a0b3);font-size:12px}
.dx-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:9px 0;border-top:.5px solid var(--dsw-alias-border-l4,#232838)}
.dx-row:first-of-type{border-top:0}
.dx-row-label{min-width:76px;color:var(--dsw-alias-label-secondary,#b6bdcd)}
.dx-input,.dx-select{appearance:none;border:.5px solid var(--dsw-alias-border-l4,#232838);background:var(--dsw-alias-bg-layer-1,#101218);color:inherit;font:inherit;
  border-radius:9px;height:32px;padding:0 10px;outline:none;min-width:0}
.dx-input:focus-visible,.dx-select:focus-visible{border-color:var(--dsw-alias-state-business-primary,#4f7cff);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4f7cff) 20%,transparent)}
.dx-input[data-mono="true"]{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.02em}
.dx-port{width:104px}
.dx-grow{flex:1 1 220px}
.dx-btn{appearance:none;font:inherit;cursor:pointer;border-radius:9px;height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l3,#2b3040);
  background:var(--dsw-alias-bg-layer-1,#101218);color:inherit;transition:background .15s ease,border-color .15s ease,transform .08s ease}
.dx-btn:hover:not(:disabled):not([data-variant="primary"]):not([data-variant="danger"]){border-color:var(--dsw-alias-border-l2,#3a4152);background:var(--dsw-alias-bg-layer-3,#1b1e28)}
.dx-btn:active:not(:disabled){transform:translateY(1px)}
.dx-btn:disabled{opacity:.5;cursor:not-allowed}
.dx-btn[data-variant="primary"]{border-color:transparent;background:linear-gradient(180deg,#5b86ff,#3f66e0);color:#fff;font-weight:600;
  box-shadow:0 6px 18px color-mix(in srgb,#4f7cff 30%,transparent)}
.dx-btn[data-variant="primary"]:hover:not(:disabled){background:linear-gradient(180deg,#6d94ff,#4a72ee);box-shadow:0 8px 22px color-mix(in srgb,#4f7cff 38%,transparent)}
.dx-btn[data-variant="primary"]:disabled{color:#eef1ff}
.dx-btn[data-variant="danger"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f87171) 45%,transparent);color:#f87171}
.dx-btn[data-variant="danger"]:hover:not(:disabled){background:color-mix(in srgb,#f87171 12%,transparent);border-color:color-mix(in srgb,#f87171 60%,transparent)}
.dx-btn[data-variant="ghost"]{background:transparent}
.dx-btn[data-variant="ghost"]:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3,#1b1e28)}
.dx-switch{position:relative;display:inline-flex;align-items:center;gap:10px;cursor:pointer;user-select:none}
.dx-switch input{position:absolute;opacity:0;width:0;height:0}
.dx-track{width:46px;height:26px;border-radius:999px;background:var(--dsw-alias-bg-layer-4,#252a36);border:.5px solid var(--dsw-alias-border-l3,#2b3040);
  transition:background .2s ease,border-color .2s ease;flex:none;position:relative}
.dx-thumb{position:absolute;top:2.5px;left:3px;width:20px;height:20px;border-radius:50%;background:#9aa3b8;transition:transform .2s cubic-bezier(.3,1.4,.5,1),background .2s ease}
.dx-switch input:checked + .dx-track{background:linear-gradient(180deg,#2ecc71,#1f9d57);border-color:transparent}
.dx-switch input:checked + .dx-track .dx-thumb{transform:translateX(19px);background:#fff}
.dx-switch input:focus-visible + .dx-track{box-shadow:0 0 0 3px color-mix(in srgb,#2ecc71 25%,transparent)}
.dx-urls{display:flex;flex-direction:column;gap:8px}
.dx-url{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 11px;border-radius:11px;background:var(--dsw-alias-bg-layer-1,#101218);
  border:.5px solid var(--dsw-alias-border-l4,#232838)}
.dx-url[data-primary="true"]{border-color:color-mix(in srgb,#4f7cff 40%,transparent);background:linear-gradient(180deg,color-mix(in srgb,#4f7cff 9%,transparent),transparent)}
.dx-url-actions{display:flex;align-items:center;gap:8px;margin-left:auto;flex:none}
.dx-badge{font-size:11px;padding:2px 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3,#2b3040);color:var(--dsw-alias-label-tertiary,#98a0b3);flex:none}
.dx-badge[data-kind="private"]{color:#7dd3fc;border-color:color-mix(in srgb,#7dd3fc 35%,transparent)}
.dx-badge[data-kind="public"]{color:#34d399;border-color:color-mix(in srgb,#34d399 35%,transparent)}
.dx-badge[data-kind="nat"]{color:#fbbf24;border-color:color-mix(in srgb,#fbbf24 35%,transparent)}
.dx-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;color:var(--dsw-alias-label-primary,#e8eaf0);
  overflow-wrap:anywhere;flex:1 1 240px}
.dx-dim{color:var(--dsw-alias-label-tertiary,#98a0b3)}
.dx-steps{display:flex;flex-direction:column;gap:6px;margin-top:4px}
.dx-step{display:flex;align-items:center;gap:9px;font-size:12px}
.dx-step b{font-weight:600;min-width:120px}
.dx-ok{color:#34d399}.dx-bad{color:#f87171}
.dx-note{margin:6px 0 0;color:var(--dsw-alias-label-tertiary,#98a0b3);font-size:12px}
.dx-err{margin:0;color:#f87171;font-size:12px}
.dx-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dx-meta{display:flex;gap:14px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#98a0b3);font-size:12px}
.dx-pre{margin:8px 0 0;padding:9px 11px;border-radius:9px;background:var(--dsw-alias-bg-layer-1,#101218);border:.5px solid var(--dsw-alias-border-l4,#232838);
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.dx-empty{padding:14px;border-radius:11px;border:.5px dashed var(--dsw-alias-border-l3,#2b3040);color:var(--dsw-alias-label-tertiary,#98a0b3);text-align:center}
`

/** Same-origin control-API call with a JSON body and a normalized failure. */
async function callApi(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
  if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`)
  return payload
}

/** Clipboard write that also works on a plain-HTTP origin, where the async clipboard API is unavailable. */
async function copyText(text) {
  try {
    if (navigator.clipboard !== undefined && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the selection-based copy */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const done = document.execCommand('copy')
    area.remove()
    return done
  } catch {
    return false
  }
}

/** `HH:MM:SS` for the "since" line. */
function clockTime(iso) {
  if (typeof iso !== 'string') return undefined
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleTimeString()
}

/** One copyable remote address row. */
function UrlRow(props) {
  const { entry, tokenFirst, onCopy } = props
  const target = tokenFirst && entry.tokenUrl !== undefined ? entry.tokenUrl : entry.url
  const [copied, setCopied] = React.useState(false)
  const copy = async () => {
    const ok = await copyText(target)
    setCopied(ok)
    onCopy(ok ? `已复制 ${entry.kindLabel}：${target}` : '复制失败，请手动选中链接', ok)
    window.setTimeout(() => setCopied(false), 1600)
  }
  return h(
    'div',
    { className: 'dx-url', 'data-primary': entry.kind === 'private' || entry.kind === 'public' ? 'true' : undefined },
    h('span', { className: 'dx-badge', 'data-kind': entry.kind }, entry.kindLabel),
    h('code', { className: 'dx-code' }, entry.url),
    entry.bound === false ? h('span', { className: 'dx-dim' }, '未绑定该网卡') : null,
    entry.virtual === true ? h('span', { className: 'dx-dim' }, '虚拟网卡') : null,
    entry.requiresForwarding === true ? h('span', { className: 'dx-dim' }, '需在路由器/光猫做端口映射') : null,
    h(
      'div',
      { className: 'dx-url-actions' },
      h(
        'button',
        { type: 'button', className: 'dx-btn', onClick: copy },
        copied ? '已复制 ✓' : tokenFirst && entry.tokenUrl !== undefined ? '复制登录链接' : '复制地址',
      ),
      h('a', { className: 'dx-btn', href: entry.tokenUrl ?? entry.url, target: '_blank', rel: 'noreferrer', style: { lineHeight: '30px', textDecoration: 'none' } }, '打开'),
    ),
  )
}

/** The Plugins settings tab. */
function ExposePanel() {
  const [state, setState] = React.useState(undefined)
  const [host, setHost] = React.useState('')
  const [port, setPort] = React.useState('')
  const [manualHost, setManualHost] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState(undefined)
  const [error, setError] = React.useState(undefined)
  const [tokenFirst, setTokenFirst] = React.useState(true)
  const [firewall, setFirewall] = React.useState(undefined)

  const adopt = React.useCallback((next) => {
    setState(next)
    if (next?.settings !== undefined) {
      setHost((current) => (current === '' ? next.settings.host : current))
      setPort((current) => (current === '' ? String(next.settings.port) : current))
    }
  }, [])

  const report = React.useCallback((message, ok = true) => {
    setNotice(ok ? message : undefined)
    setError(ok ? undefined : message)
    if (ok) window.setTimeout(() => setNotice(undefined), 2600)
  }, [])

  const run = React.useCallback(
    async (path, body, label) => {
      setBusy(true)
      setError(undefined)
      try {
        const payload = await callApi(path, body === undefined ? { method: 'POST' } : { method: 'POST', body: JSON.stringify(body) })
        const next = payload.state ?? payload
        if (next?.settings !== undefined) adopt(next)
        if (label !== undefined) report(label)
        return next
      } catch (failure) {
        report(String(failure?.message ?? failure), false)
        return undefined
      } finally {
        setBusy(false)
      }
    },
    [adopt, report],
  )

  React.useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const payload = await callApi('/state', { method: 'GET' })
        if (alive) adopt(payload)
      } catch (failure) {
        if (alive) report(String(failure?.message ?? failure), false)
      }
    }
    void load()
    void run('/refresh')
    const timer = window.setInterval(() => {
      void callApi('/state', { method: 'GET' }).then((payload) => {
        if (alive) adopt(payload)
      }).catch(() => {})
    }, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [adopt, report, run])

  const settings = state?.settings
  const listener = state?.listener
  const live = listener?.listening === true
  const addresses = state?.addresses ?? []
  // Recommend a physical LAN address: a tunnel address is reachable on this
  // machine but a phone on the same Wi-Fi usually cannot route to it.
  const primary =
    addresses.find((entry) => entry.bound !== false && entry.virtual !== true && entry.kind === 'private') ??
    addresses.find((entry) => entry.bound !== false && entry.kind === 'private') ??
    addresses[0]
  const dirty = settings !== undefined && (host !== settings.host || port !== String(settings.port))
  // The picker lists what the machine actually has; anything else (a hand-typed
  // address, or one stored earlier that has since disappeared) keeps the text
  // field open so the value stays visible and editable.
  const knownHost = host === '0.0.0.0' || (state?.interfaces ?? []).some((entry) => entry.address === host)
  const pickerValue = knownHost ? host : '__custom__'
  const showManual = manualHost || !knownHost

  const apply = async (enabled) => {
    const nextPort = Number(port)
    if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
      report('端口必须是 1-65535 之间的整数', false)
      return
    }
    await run('/config', { enabled, host: host === '' ? '0.0.0.0' : host, port: nextPort }, enabled ? `已开放：${host || '0.0.0.0'}:${nextPort}` : '已关闭对外访问')
  }

  const copyPrimary = async () => {
    const target = (tokenFirst ? primary?.tokenUrl : primary?.url) ?? primary?.url
    if (target === undefined) {
      report('还没有可复制的地址', false)
      return
    }
    const ok = await copyText(target)
    report(ok ? `已复制登录链接：${target}` : '复制失败，请手动选中链接', ok)
  }

  return h(
    'section',
    { className: 'dx-root', 'data-dsh-expose': '' },
    h(
      'header',
      { className: 'dx-hero', 'data-live': live ? 'true' : 'false' },
      h(
        'div',
        { className: 'dx-hero-top' },
        h('div', null, h('h3', { className: 'dx-title' }, 'DSH Expose · 远程访问'), h('p', { className: 'dx-sub' }, '把这个 DSH 实例开放到局域网或公网，然后用手机 / 另一台电脑打开同一个会话。')),
        h('span', { className: 'dx-pill', 'data-live': live ? 'true' : 'false' }, h('i', { className: 'dx-dot' }), live ? `已开放 · ${listener.bindHost}:${listener.port}` : '未开放'),
      ),
      h(
        'div',
        { className: 'dx-row', style: { marginTop: '12px' } },
        h('label', { className: 'dx-switch' }, h('input', { type: 'checkbox', checked: live, disabled: busy, onChange: (event) => void apply(event.target.checked) }), h('span', { className: 'dx-track' }, h('span', { className: 'dx-thumb' }))),
        h('b', null, live ? '对外访问已开启' : '对外访问已关闭'),
        h('span', { className: 'dx-dim' }, live ? `自 ${clockTime(listener.since) ?? '刚刚'} 起转发到 ${state?.upstream?.authority ?? '本机 DSH 服务'}` : '关闭时只在 127.0.0.1 上服务，与官方默认一致'),
      ),
    ),

    h(
      'div',
      { className: 'dx-card' },
      h('div', { className: 'dx-card-head' }, h('h4', null, '监听配置'), h('span', null, '默认 0.0.0.0:3080')),
      h(
        'div',
        { className: 'dx-row' },
        h('span', { className: 'dx-row-label' }, '监听地址'),
        h(
          'select',
          {
            className: 'dx-select dx-grow',
            value: pickerValue,
            disabled: busy,
            onChange: (event) => {
              if (event.target.value === '__custom__') {
                setManualHost(true)
                setHost('')
                return
              }
              setManualHost(false)
              setHost(event.target.value)
            },
          },
          h('option', { value: '0.0.0.0' }, '0.0.0.0 · 全部网卡（推荐）'),
          (state?.interfaces ?? []).map((entry) =>
            h('option', { key: entry.address, value: entry.address }, `${entry.address} · ${entry.name} · ${entry.kindLabel}${entry.virtual === true ? '（虚拟网卡）' : ''}`),
          ),
          h('option', { value: '__custom__' }, '自定义 IPv4…'),
        ),
        showManual
          ? h('input', {
              className: 'dx-input dx-grow',
              value: host,
              disabled: busy,
              spellCheck: false,
              autoFocus: true,
              placeholder: '例如 192.168.1.20',
              onChange: (event) => setHost(event.target.value.trim()),
            })
          : null,
      ),
      h(
        'div',
        { className: 'dx-row' },
        h('span', { className: 'dx-row-label' }, '监听端口'),
        h('input', { className: 'dx-input dx-port', value: port, disabled: busy, inputMode: 'numeric', onChange: (event) => setPort(event.target.value.replace(/[^\d]/g, '')) }),
        h(
          'div',
          { className: 'dx-actions' },
          h('button', { type: 'button', className: 'dx-btn', 'data-variant': 'primary', disabled: busy, onClick: () => void apply(true) }, dirty ? '保存并开放' : live ? '重新应用' : '保存并开放'),
          live ? h('button', { type: 'button', className: 'dx-btn', 'data-variant': 'danger', disabled: busy, onClick: () => void apply(false) }, '关闭开放') : null,
        ),
      ),
      listener?.error !== undefined ? h('p', { className: 'dx-err' }, `监听失败：${listener.error}`) : null,
      error !== undefined ? h('p', { className: 'dx-err' }, error) : null,
      notice !== undefined ? h('p', { className: 'dx-note' }, `✓ ${notice}`) : null,
    ),

    h(
      'div',
      { className: 'dx-card' },
      h(
        'div',
        { className: 'dx-card-head' },
        h('h4', null, '远程连接地址'),
        h('span', null, tokenFirst ? '复制/打开默认带一次性登录令牌，新设备可直接进入' : '复制/打开使用纯地址，需要该浏览器已有登录 Cookie'),
        h(
          'label',
          { className: 'dx-switch', style: { marginLeft: 'auto' } },
          h('input', { type: 'checkbox', checked: tokenFirst, onChange: (event) => setTokenFirst(event.target.checked) }),
          h('span', { className: 'dx-track' }, h('span', { className: 'dx-thumb' })),
          h('span', { className: 'dx-dim' }, '令牌'),
        ),
      ),
      live === false
        ? h('div', { className: 'dx-empty' }, '打开上方的开关后，这里会列出可以直接发给别人的连接地址。')
        : addresses.length === 0
          ? h('div', { className: 'dx-empty' }, '没有检测到可用的网卡地址。')
          : h('div', { className: 'dx-urls' }, addresses.map((entry) => h(UrlRow, { key: `${entry.kind}-${entry.address}`, entry, tokenFirst, onCopy: report }))),
      h(
        'div',
        { className: 'dx-row' },
        h('span', { className: 'dx-row-label' }, '公网出口'),
        h(
          'span',
          { className: 'dx-code' },
          state?.public?.refreshing === true ? '检测中…' : state?.public?.ip !== undefined ? state.public.ip : '未检测到（可能无法访问公网）',
        ),
        state?.public?.ip !== undefined
          ? h('span', { className: 'dx-badge', 'data-kind': state.public.direct ? 'public' : 'nat' }, state.public.direct ? '直连公网，可直接访问' : '在 NAT 后，需要端口映射')
          : null,
        h('button', { type: 'button', className: 'dx-btn', disabled: busy, onClick: () => void run('/refresh', undefined, '已重新检测公网出口') }, '重新检测'),
      ),
      h('p', { className: 'dx-note' }, primary !== undefined ? `推荐链接：${(tokenFirst ? primary.tokenUrl : primary.url) ?? primary.url}` : '公网地址来自外部回显服务，仅用于展示，不会上传其它信息。'),
    ),

    h(
      'div',
      { className: 'dx-card' },
      h('div', { className: 'dx-card-head' }, h('h4', null, '连通性与放行'), h('span', null, '在本机自测一遍真实链路')),
      h(
        'div',
        { className: 'dx-actions' },
        h('button', { type: 'button', className: 'dx-btn', disabled: busy || !live, onClick: () => void run('/probe', undefined, '自检完成') }, '连通性自检'),
        h('button', { type: 'button', className: 'dx-btn', disabled: busy, onClick: () => void run('/firewall', { action: 'add' }, '已尝试放行防火墙') }, '放行防火墙入站'),
        h('button', { type: 'button', className: 'dx-btn', 'data-variant': 'ghost', disabled: busy, onClick: copyPrimary }, '复制推荐链接'),
      ),
      state?.probe !== undefined && Array.isArray(state.probe.steps) && state.probe.steps.length > 0
        ? h(
            'div',
            { className: 'dx-steps' },
            state.probe.steps.map((step, index) =>
              h(
                'div',
                { className: 'dx-step', key: `${step.label}-${index}` },
                h('span', { className: step.ok ? 'dx-ok' : 'dx-bad' }, step.ok ? '✓' : '✗'),
                h('b', null, step.label),
                h('span', { className: 'dx-dim' }, `HTTP ${step.status || '—'} · ${step.ms}ms`),
                step.note !== undefined ? h('span', { className: 'dx-bad' }, step.note) : null,
              ),
            ),
          )
        : state?.probe?.reason !== undefined
          ? h('p', { className: 'dx-note' }, `上次自检：${state.probe.reason}`)
          : h('p', { className: 'dx-note' }, '自检会从本机依次请求监听端口、真实网卡地址、未授权访问与令牌登录链路。'),
      firewall?.message !== undefined
        ? h('div', null, h('p', { className: firewall.ok ? 'dx-note' : 'dx-err' }, firewall.message), firewall.elevationRequired === true ? h('pre', { className: 'dx-pre' }, firewall.command) : null)
        : null,
      firewall?.output !== undefined && firewall.output !== '' ? h('pre', { className: 'dx-pre' }, firewall.output) : null,
    ),

    h(
      'div',
      { className: 'dx-meta' },
      h('span', null, `上游实例：${state?.upstream?.authority ?? '—'}`),
      h('span', null, `已连接客户端：${state?.stats?.clients?.length ?? 0}`),
      h('span', null, `累计请求：${state?.stats?.requests ?? 0} · 升级：${state?.stats?.upgrades ?? 0}`),
      h('span', null, `设置文件：${state?.store?.path ?? '—'}`),
      h('span', null, `dsh-expose v${state?.version ?? '?'}`),
    ),
  )
}

/** One-line status, for a surface that asks for the `summary` view instead of the form. */
function ExposeSummary() {
  const [state, setState] = React.useState(undefined)
  React.useEffect(() => {
    let alive = true
    void callApi('/state', { method: 'GET' })
      .then((payload) => {
        if (alive) setState(payload)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  const live = state?.listener?.listening === true
  return h('span', null, live ? `已开放 · ${state.listener.bindHost}:${state.listener.port}` : '未开放 · 默认只在 127.0.0.1 服务')
}

/**
 * The shared slot entry: `page` (every configuration surface) renders the
 * panel, `summary` renders the one-liner. Both registrations below point here.
 */
function ExposeView(props) {
  return props?.view === 'summary' ? h(ExposeSummary) : h(ExposePanel)
}

/**
 * Mount the browser half: inject the stylesheet and contribute the panel to
 * the bundle's own page on the Plugins page (`plugins.bundle.config`, keyed by
 * the package name) and to Settings → Built-in plugins (`settings.plugins.tab`).
 * @param {object} ctx - browser plugin context (requires the `slots` service).
 */
export function apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = CSS
    style.dataset.plugin = 'dsh-expose'
    document.head.appendChild(style)

    // Canonical home: the bundle detail page in the Plugins page renders this
    // between the description and the bundle's rows, as `view: 'page'`.
    const disposeBundlePage = ctx.slots.inject('plugins.bundle.config', () =>
      ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-expose' }, ExposeView),
    )

    // Convenience: the same panel as a tab of Settings → Built-in plugins.
    const disposeSettingsTab = ctx.slots.inject('settings.plugins.tab', () =>
      ctx.slots.register({ name: 'settings.plugins.tab', id: 'dsh-expose', order: 20, label: () => '远程访问' }, ExposeView),
    )

    return () => {
      disposeBundlePage()
      disposeSettingsTab()
      style.remove()
    }
  }, 'dsh-expose: plugin configuration')
}
