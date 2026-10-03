/**
 * Address classification is what keeps the UI from printing a "public" URL
 * that only works inside the campus network, so every non-routable block the
 * plugin claims to know is asserted here.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyIPv4, describeAddressKind, discoverPublicIp, isVirtualAdapter, listLocalAddresses, parseIPv4 } from '../lib/network.js'

test('parses only well-formed dotted quads', () => {
  assert.deepEqual(parseIPv4('192.168.1.20'), [192, 168, 1, 20])
  assert.equal(parseIPv4('192.168.0.256'), undefined)
  assert.equal(parseIPv4('192.168.0'), undefined)
  assert.equal(parseIPv4('::1'), undefined)
  assert.equal(parseIPv4(undefined), undefined)
})

test('classifies the blocks that decide whether a URL is honest', () => {
  const cases = {
    '127.0.0.1': 'loopback',
    '10.1.2.3': 'private',
    '172.16.0.1': 'private',
    '172.31.255.254': 'private',
    '192.168.1.20': 'private',
    '169.254.11.4': 'link-local',
    '100.64.0.7': 'cgnat',
    '100.127.255.255': 'cgnat',
    '0.0.0.0': 'reserved',
    '192.0.2.1': 'reserved',
    '203.0.113.9': 'reserved',
    '224.0.0.1': 'reserved',
    '8.8.8.8': 'public',
    '8.8.8.8': 'public',
    '172.32.0.1': 'public',
    '100.128.0.1': 'public',
  }
  for (const [address, expected] of Object.entries(cases)) {
    assert.equal(classifyIPv4(address), expected, `${address} should classify as ${expected}`)
  }
  assert.equal(classifyIPv4('nope'), 'invalid')
})

test('labels every kind the UI can render', () => {
  for (const kind of ['public', 'private', 'cgnat', 'link-local', 'reserved']) {
    assert.equal(typeof describeAddressKind(kind), 'string')
    assert.ok(describeAddressKind(kind).length > 0)
  }
})

test('recognizes the adapters that must never be the recommended address', () => {
  const virtual = ['Radmin VPN', 'vEthernet (WSL)', 'Hyper-V Virtual Ethernet Adapter', 'VMware Network Adapter VMnet8', 'Tailscale', 'OpenVPN Data Channel Offload for Surfshark', 'ZeroTier One [1c5f]', 'Docker Bridge']
  for (const name of virtual) assert.equal(isVirtualAdapter(name), true, `${name} should be virtual`)
  for (const name of ['WLAN', 'Ethernet', '以太网', 'Wi-Fi', 'Realtek Gaming 2.5GbE Family Controller']) {
    assert.equal(isVirtualAdapter(name), false, `${name} should be physical`)
  }
})

test('lists only reachable, deduplicated IPv4 addresses, physical and routable first', () => {
  const addresses = listLocalAddresses()
  const rank = { public: 0, private: 1, cgnat: 2, reserved: 4 }
  assert.ok(Array.isArray(addresses))
  for (const entry of addresses) {
    const kind = classifyIPv4(entry.address)
    assert.equal(kind === 'loopback' || kind === 'invalid' || kind === 'link-local', false, `${entry.address} must not be listed`)
    assert.equal(typeof entry.virtual, 'boolean')
  }
  for (let index = 1; index < addresses.length; index += 1) {
    const previous = addresses[index - 1]
    const current = addresses[index]
    const key = (entry) => [Number(entry.virtual), rank[entry.kind] ?? 9]
    const [previousVirtual, previousRank] = key(previous)
    const [currentVirtual, currentRank] = key(current)
    assert.ok(
      previousVirtual < currentVirtual || (previousVirtual === currentVirtual && previousRank <= currentRank),
      `${previous.address} (${previous.kind}${previous.virtual ? ', virtual' : ''}) must not sort after ${current.address} (${current.kind}${current.virtual ? ', virtual' : ''})`,
    )
  }
  assert.equal(new Set(addresses.map((entry) => entry.address)).size, addresses.length)
})

test('reports a failed public-IP lookup instead of throwing', async () => {
  const result = await discoverPublicIp({
    timeoutMs: 50,
    fetchImpl: () => Promise.reject(new Error('offline')),
  })
  assert.equal(result.ip, undefined)
  assert.equal(result.direct, false)
  assert.match(result.error, /offline/)
  assert.equal(typeof result.checkedAt, 'string')
})

test('accepts a public echo reply and marks it direct only for a physical interface', async () => {
  const remote = await discoverPublicIp({
    fetchImpl: async () => ({ ok: true, text: async () => '8.8.8.8\n' }),
  })
  assert.equal(remote.ip, '8.8.8.8')
  assert.equal(remote.direct, false)

  const physical = listLocalAddresses().find((entry) => entry.kind === 'public' && !entry.virtual)
  if (physical !== undefined) {
    const direct = await discoverPublicIp({ fetchImpl: async () => ({ ok: true, text: async () => physical.address }) })
    assert.equal(direct.direct, true)
    return
  }
  // No physical public address here: a tunnel that hands out a public-looking
  // address must still not be advertised as a directly reachable listener.
  const tunnel = listLocalAddresses().find((entry) => entry.kind === 'public' && entry.virtual)
  if (tunnel !== undefined) {
    const viaTunnel = await discoverPublicIp({ fetchImpl: async () => ({ ok: true, text: async () => tunnel.address }) })
    assert.equal(viaTunnel.ip, tunnel.address)
    assert.equal(viaTunnel.direct, false)
  }
})

test('rejects a provider that answers with a private address and falls through', async () => {
  let calls = 0
  const result = await discoverPublicIp({
    fetchImpl: async () => {
      calls += 1
      return calls === 1 ? { ok: true, text: async () => '192.168.1.1' } : { ok: true, text: async () => '203.0.113.5' }
    },
  })
  // 203.0.113.0/24 is TEST-NET-3: not a public address either, so the whole lookup fails honestly.
  assert.equal(result.ip, undefined)
  assert.ok(calls >= 2)
})
