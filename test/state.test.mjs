/**
 * Settings persistence: a switch that forgets it was on after a restart is
 * worse than no switch, and a corrupt document must degrade to defaults rather
 * than bind something surprising.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-expose-state-'))
process.env.DSH_HOME = HOME

const { DEFAULT_SETTINGS, harnessHome, loadSettings, normalizeSettings, saveSettings, settingsPath } = await import('../lib/state.js')

after(() => {
  fs.rmSync(HOME, { recursive: true, force: true })
})

before(() => {
  fs.rmSync(settingsPath(), { force: true })
})

test('resolves the harness home from DSH_HOME', () => {
  assert.equal(harnessHome(), path.resolve(HOME))
  assert.equal(settingsPath(), path.join(path.resolve(HOME), 'dsh-expose.json'))
})

test('defaults to 0.0.0.0:3080 with exposure off', () => {
  const settings = loadSettings()
  assert.deepEqual({ enabled: settings.enabled, host: settings.host, port: settings.port }, { ...DEFAULT_SETTINGS })
  assert.equal(settings.exists, false)
  assert.deepEqual(settings.issues, [])
})

test('a profile config seeds the first run without touching the file', () => {
  const settings = loadSettings({ enabled: true, host: '192.168.1.20', port: 8080 })
  assert.deepEqual({ enabled: settings.enabled, host: settings.host, port: settings.port }, { enabled: true, host: '192.168.1.20', port: 8080 })
  assert.equal(settings.exists, false)
})

test('normalizes hostile values and reports each rejection', () => {
  const bad = normalizeSettings({ enabled: 'yes', host: 'evil.example.com', port: '0x1f90' })
  assert.equal(bad.enabled, DEFAULT_SETTINGS.enabled)
  assert.equal(bad.host, DEFAULT_SETTINGS.host)
  assert.equal(bad.port, DEFAULT_SETTINGS.port)
  assert.equal(bad.issues.length, 3)

  const good = normalizeSettings({ enabled: true, host: ' 0.0.0.0 ', port: '3080' })
  assert.deepEqual({ enabled: good.enabled, host: good.host, port: good.port }, { enabled: true, host: '0.0.0.0', port: 3080 })
  assert.deepEqual(good.issues, [])

  assert.equal(normalizeSettings({ port: 65536 }).port, DEFAULT_SETTINGS.port)
  assert.equal(normalizeSettings({ port: 0 }).port, DEFAULT_SETTINGS.port)
  assert.equal(normalizeSettings({ host: '' }).host, '0.0.0.0')
})

test('round-trips through an atomic write and survives a corrupt document', () => {
  const file = saveSettings({ enabled: true, host: '10.0.0.5', port: 8443 })
  assert.equal(file, settingsPath())
  assert.equal(fs.existsSync(file), true)
  const stored = loadSettings()
  assert.deepEqual({ enabled: stored.enabled, host: stored.host, port: stored.port }, { enabled: true, host: '10.0.0.5', port: 8443 })
  assert.equal(stored.exists, true)

  fs.writeFileSync(file, '{ this is not json', 'utf8')
  const recovered = loadSettings()
  assert.deepEqual({ enabled: recovered.enabled, host: recovered.host, port: recovered.port }, { ...DEFAULT_SETTINGS })

  fs.rmSync(file, { force: true })
  assert.equal(loadSettings().exists, false)
})
