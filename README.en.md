# dsh-expose

**Publish a running DeepSeek Harness (DSH) instance to the LAN or the public internet with one switch.**

[中文](README.md) | English

Pick a bind address (default `0.0.0.0`) and a port (default `3080`), flip the switch, and the plugin re-publishes the DSH instance running on this machine: a phone, a tablet, or a colleague's laptop opens `http://192.168.1.20:3080/` and lands in the same session. The page then lists ready-to-copy addresses — the LAN address, a directly reachable public address, or (behind NAT) the public egress address plus a port-forwarding reminder.

It shows up in the **Plugins** page (installed list: enable / disable / uninstall), and its configuration panel is on its own page there; **Settings → Built-in plugins → Remote access** is the same panel, one click away.

![Remote access in the Plugins page's installed list](docs/plugins-page.png)

![The configuration panel on the plugin's own page (plugins.bundle.config)](docs/plugin-page-config.png)

![Remote addresses, public egress, and the connectivity self-test](docs/remote-addresses.png)

> The addresses in the screenshots (`192.168.1.20`, `203.0.113.10`, `198.51.100.7`) are documentation placeholders, and so is `token=TOKEN`.

```
┌──────────────────────────────────────────────────────────────┐
│ DSH Expose · Remote access                     ● live        │
│ Publish this DSH instance to the LAN or the internet.        │
│                                                              │
│  [ ●——]  Exposure on   forwarding to 127.0.0.1:19387 since…  │
│                                                              │
│  Bind address  [ 0.0.0.0 · every interface      ▾ ]          │
│  Port          [ 3080 ]        [ Save & expose ] [ Stop ]    │
│                                                              │
│  Remote addresses                    copy/open carries [●]   │
│  ┌ LAN        http://192.168.1.20:3080/    [copy] [open] ┐   │
│  ┌ Public WAN http://203.0.113.10:3080/    [copy] [open] ┐   │
│                                                              │
│  [Self-test] [Allow through firewall] [Copy best link]       │
│  ✓ listener 401 · 7ms   ✓ NIC 192.168.1.20 401 · 3ms         │
│  ✓ anonymous refused 401 ✓ token login 303 · 14ms            │
└──────────────────────────────────────────────────────────────┘
```

## Why a proxy instead of `--host 0.0.0.0`

The shipped web carrier deliberately binds loopback only: `--host 0.0.0.0` is a hard usage error, because it would expose remote code execution to the network. `dsh-expose` does not fight that decision — it puts a listener you control in front of it and keeps every existing defence intact:

| Shipped defence | What this plugin does |
| --- | --- |
| Loopback-only bind | The forwarding listener exists only when you turn it on, on the address and port you chose |
| `/api` Host/Origin fence | Inbound `Host`, `Origin`, and `Referer` are rewritten to the upstream loopback authority, so the fence always sees its own authority |
| Authority-bound browser cookie | Cookies are never rewritten: the token exchange still mints a session for the authority the remote browser used |
| No token → 401 | Passed through verbatim; anonymous access is still refused (the self-test shows the 401) |
| Remote code execution | A remote browser gets an ordinary DSH session under the same permission model |

**You open the port; DSH still does the login.**

## Install

**From the GUI** — open **Plugins → Add plugin** and paste either line, then press Enter:

```
https://github.com/WONGIII/dsh-expose
github:WONGIII/dsh-expose
```

![The add-plugin dialog with the repository URL](docs/install-dialog.png)

Once installed and enabled it appears under **Installed**; its title, description, and icon all come from the package's display metadata (top screenshot).

**From the command line**:

```bash
# Web
dsh plugin --profile web add github:WONGIII/dsh-expose

# Desktop app (Electron): the profile is named desktop
dsh plugin --profile desktop add github:WONGIII/dsh-expose

# Pin a release (recommended): a tag or a commit
dsh plugin --profile web add github:WONGIII/dsh-expose#v0.1.0

# Or a local checkout while developing
dsh plugin --profile web add link:/path/to/dsh-expose
```

Restart DSH, then:

1. open **Plugins** → **Remote access** is listed under installed, running;
2. open its card — the panel is on that page, between the description and the rows; **Settings → Built-in plugins → Remote access** shows the same panel.

**No build-script approval is needed.** `lib/` is committed, and the package has no `prepare`/`postinstall` script, so pnpm never asks for an `allowBuilds` entry; it also declares no `dependencies`, so nothing else is downloaded. Upgrading is uninstall + install:

```bash
dsh plugin --profile web remove dsh-expose
dsh plugin --profile web add github:WONGIII/dsh-expose
```

> Settings live in `$DSH_HOME/dsh-expose.json`, so the switch and the port survive a restart; if it was on, the plugin re-opens the port on boot.

## How it follows the DSH plugin conventions

| Convention | What this repository does |
| --- | --- |
| Bundle manifest | `package.json` declares `dsh.bundle.patch` → `cordis.patch.yml` mounts `dsh-expose` with one `insert` row |
| Browser half | `dsh.client.platform: "web"` plus an exported `./client`, emitted as a `window.__ModuleLoader__.load(...)` registration |
| Configuration page | Registered into the documented `plugins.bundle.config` slot (keyed by the package name `dsh-expose`), so it renders on the plugin's own page in the Plugins page; the same panel is also offered as a `settings.plugins.tab` entry |
| Display metadata | `locale/en.json` and `locale/zh.json` carry `meta.title` / `meta.description`, and top-level `"icon": "./assets/icon.svg"` supplies the card artwork |
| Exports and publication | `exports` exposes `.`, `./client`, `./cordis.patch.yml`, `./locale/*.json`, `./package.json`; `files` covers every artifact above |
| Built artifacts are committed | `lib/` ships in the repository, which sidesteps the pnpm ≥10 build-approval gate described in the official *Package and install a plugin* tutorial |
| No runtime dependencies | The host half uses Node built-ins only and the browser half only the page's own React, so nothing is declared under `peerDependencies` and no peer check runs at install time |

## Using it

1. **Bind address** — defaults to `0.0.0.0` (every interface). Bind a single NIC to restrict access to one network; virtual adapters (Radmin, Tailscale, OpenVPN…) are labelled and never recommended.
2. **Port** — 3080 by default, any 1–65535.
3. **Switch** — `Save & expose` / `Stop`. Stopping releases the port immediately, back to the shipped loopback-only posture.
4. **Remote addresses** — the "token" toggle (on by default) copies and opens the link carrying this process's one-time login token, so a fresh device logs straight in. Turn it off for plain addresses on devices that already have a session cookie. Each row is labelled LAN, direct public, or NAT-behind-forwarding.
5. **Self-test** — walks the real chain from this machine: listener → real NIC address → anonymous refusal → token login. All green means it genuinely works.
6. **Allow through firewall** — adds a Windows `netsh advfirewall` inbound rule for the chosen port (needs elevation; when denied, the exact command is shown for you to run).

## Public access

The plugin asks an external echo service for the machine's egress address and tells the two cases apart:

- **direct public** — a public address sits on a physical NIC → "directly reachable";
- **behind NAT** — the egress address is not a local physical address (almost every home connection) → the address is shown with a "needs port forwarding on the router" note.

Exposing to the internet is reachability, not authentication: keep the DSH session credentials strong, forward only this port, and turn the switch off when you are done.

## Control API

The browser half uses same-origin routes registered on the instance's own `/api` channel through `ctx.connection.fetch`, so they inherit the Host/Origin fence and browser-cookie authentication — an anonymous remote client cannot toggle exposure:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/dsh-expose/state` | settings, listener state, addresses, public egress, counters, last self-test |
| POST | `/api/dsh-expose/config` | `{ enabled?, host?, port? }` — persist and apply |
| POST | `/api/dsh-expose/refresh` | re-probe the public egress address |
| POST | `/api/dsh-expose/probe` | run the connectivity self-test |
| POST | `/api/dsh-expose/firewall` | `{ action: "add" \| "remove" \| "status" }` |

## Development

```bash
npm run build            # build lib/client.js (module-loader registration) from src/client.js
npm run check            # fail when the built artifact is stale
npm run verify:package   # check the bundle/client/locale/icon/files/manifest conventions (46 checks)
npm test                 # 31 cases: forwarding/rewriting/tunnelling, address classes, persistence, browser half, host integration
npm run verify           # check + verify:package + test
```

End-to-end check against a live `dsh` instance:

```powershell
./scripts/verify-live.ps1 -Base http://127.0.0.1:19399 -Token <the token dsh printed> -LanIp 192.168.1.20
```

## Layout

```
lib/index.js     host half: settings, lifecycle, control API
lib/proxy.js     forwarding listener: HTTP + Upgrade, header rewriting, counters
lib/network.js   address discovery/classification, public egress probe
lib/state.js     atomic read/write of $DSH_HOME/dsh-expose.json
lib/client.js    browser half (built from src/client.js): plugin-page config + settings tab
src/client.js    browser-half source (React, no external runtime deps)
scripts/         build, package conformance checks, live verification
test/            node:test suites
```

## License

MIT
