/**
 * Address discovery and address classification for dsh-expose.
 *
 * Two questions the UI must answer honestly:
 *   - which addresses can a peer reach this machine on right now
 *     ({@link listLocalAddresses}); and
 *   - is one of them already a public address, or does the machine sit behind
 *     NAT ({@link discoverPublicIp})?
 *
 * Nothing here mutates state, and nothing here imports the host runtime.
 * @module dsh-expose/network
 */
import os from 'node:os'

/** IPv4 dotted-quad with each octet in range. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * Parse a dotted-quad IPv4 literal.
 * @param {string} value - candidate literal.
 * @returns {number[] | undefined} four octets, or undefined when malformed.
 */
export function parseIPv4(value) {
  if (typeof value !== 'string') return undefined
  const match = IPV4.exec(value.trim())
  if (match === null) return undefined
  const octets = match.slice(1).map((part) => Number(part))
  return octets.every((octet) => octet <= 255) ? octets : undefined
}

/**
 * RFC 1918 / RFC 6598 blocks that are not globally routable. Kept explicit so
 * the UI never promises a "public" URL that only works inside a campus.
 */
const NON_PUBLIC = [
  [0, 0, 0, 0, 8], // "this network"
  [10, 0, 0, 0, 8], // RFC 1918
  [100, 64, 0, 0, 10], // RFC 6598 carrier-grade NAT
  [127, 0, 0, 0, 8], // loopback
  [169, 254, 0, 0, 16], // link-local
  [172, 16, 0, 0, 12], // RFC 1918
  [192, 0, 0, 0, 24], // IETF protocol assignments
  [192, 0, 2, 0, 24], // TEST-NET-1
  [192, 168, 0, 0, 16], // RFC 1918
  [198, 18, 0, 0, 15], // benchmarking
  [198, 51, 100, 0, 24], // TEST-NET-2
  [203, 0, 113, 0, 24], // TEST-NET-3
  [224, 0, 0, 0, 3], // multicast
  [240, 0, 0, 0, 4], // reserved
]

/** Compare one IPv4 literal against a `[a, b, c, d, prefix]` block. */
function inBlock(octets, [a, b, c, d, prefix]) {
  const address = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  const base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (address & mask) === (base & mask)
}

/**
 * Classify one IPv4 literal into the labels the UI renders.
 * @param {string} value - IPv4 literal.
 * @returns {'loopback' | 'private' | 'cgnat' | 'link-local' | 'reserved' | 'public' | 'invalid'} address kind.
 */
export function classifyIPv4(value) {
  const octets = parseIPv4(value)
  if (octets === undefined) return 'invalid'
  if (octets[1] === 254 && octets[0] === 169) return 'link-local'
  if (octets[0] === 127) return 'loopback'
  for (const block of NON_PUBLIC) {
    if (!inBlock(octets, block)) continue
    if (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168)) return 'private'
    if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return 'cgnat'
    return 'reserved'
  }
  return 'public'
}

/**
 * Adapter names that are almost always tunnels, virtual switches, or
 * containers. A VPN address is printed as reachable but never *recommended*:
 * a phone on the same Wi-Fi cannot route to a Radmin or Tailscale address.
 */
const VIRTUAL_ADAPTER = /(radmin|vethernet|hyper-?v|vmware|virtualbox|vbox|tailscale|zerotier|hamachi|wintun|wireguard|openvpn|surfshark|nordvpn|expressvpn|proton|tap0|tun0|utun|docker|veth|wsl|bluetooth|蓝牙|npcap|sangfor|easyconnect|clash|mihomo|sing-?box|virtual)/i

/**
 * Whether one adapter name looks like a virtual/tunnel device.
 * @param {string} name - adapter name as the OS reports it.
 * @returns {boolean}
 */
export function isVirtualAdapter(name) {
  return typeof name === 'string' && VIRTUAL_ADAPTER.test(name)
}

/**
 * Every usable local IPv4 address, ordered so the most useful candidate leads:
 * a physical interface before a tunnel, and within each, a globally routable
 * address before RFC 1918, carrier-grade NAT, and the reserved leftovers.
 * Link-local addresses are dropped — binding 169.254/16 is never the answer.
 * @returns {Array<{ name: string, address: string, kind: string, cidr: string | undefined, virtual: boolean }>}
 */
export function listLocalAddresses() {
  const found = []
  const interfaces = os.networkInterfaces()
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4' && entry.family !== 4) continue
      const kind = classifyIPv4(entry.address)
      if (kind === 'invalid' || kind === 'loopback' || kind === 'link-local') continue
      found.push({ name, address: entry.address, kind, cidr: entry.cidr, virtual: isVirtualAdapter(name) })
    }
  }
  const rank = { public: 0, private: 1, cgnat: 2, 'link-local': 3, reserved: 4 }
  found.sort(
    (left, right) =>
      Number(left.virtual) - Number(right.virtual) ||
      (rank[left.kind] ?? 9) - (rank[right.kind] ?? 9) ||
      left.address.localeCompare(right.address),
  )
  const seen = new Set()
  return found.filter((entry) => (seen.has(entry.address) ? false : (seen.add(entry.address), true)))
}

/** Human label for one address kind, in the UI's language. */
export function describeAddressKind(kind) {
  switch (kind) {
    case 'public':
      return '公网地址'
    case 'private':
      return '局域网地址'
    case 'cgnat':
      return '运营商大内网'
    case 'link-local':
      return '链路本地'
    default:
      return '其它'
  }
}

/** Public-IP echo services, tried in order; each returns the bare address. */
const ECHO_SERVICES = [
  { url: 'https://api.ipify.org?format=json', pick: (body) => JSON.parse(body).ip },
  { url: 'https://ipv4.icanhazip.com/', pick: (body) => body.trim() },
  { url: 'https://ifconfig.co/ip', pick: (body) => body.trim() },
  { url: 'https://api.ip.sb/ip', pick: (body) => body.trim() },
]

/**
 * Ask an external echo service for this machine's egress address.
 *
 * A reply that equals a local address means the machine holds a public address
 * directly; any other reply means the traffic is translated on the way out
 * (NAT / carrier-grade NAT), so the address is real but needs forwarding.
 * Tunnel and virtual adapters never count as "direct": a VPN handing out a
 * public-looking address is not a public listener.
 * A failure is not an error the caller must handle — it is reported as
 * `{ ip: undefined, error }` so the UI degrades to LAN-only URLs.
 *
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options] - timeout per provider and injectable fetch (tests).
 * @returns {Promise<{ ip: string | undefined, direct: boolean, source: string | undefined, error: string | undefined, checkedAt: string }>}
 */
export async function discoverPublicIp(options = {}) {
  const timeoutMs = options.timeoutMs ?? 2500
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const local = new Set(listLocalAddresses().filter((entry) => !entry.virtual).map((entry) => entry.address))
  const errors = []
  for (const service of ECHO_SERVICES) {
    if (typeof fetchImpl !== 'function') break
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(service.url, {
        signal: controller.signal,
        headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.1' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const ip = String(service.pick(await response.text()) ?? '').trim()
      if (classifyIPv4(ip) !== 'public') throw new Error(`provider returned ${JSON.stringify(ip)}`)
      return { ip, direct: local.has(ip), source: new URL(service.url).host, error: undefined, checkedAt: new Date().toISOString() }
    } catch (error) {
      errors.push(`${new URL(service.url).host}: ${error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error)}`)
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    ip: undefined,
    direct: false,
    source: undefined,
    error: errors.length > 0 ? errors.join('; ') : 'no public-IP provider reachable',
    checkedAt: new Date().toISOString(),
  }
}
