/**
 * Durable settings for dsh-expose.
 *
 * One small JSON document next to the harness home, written atomically. The
 * file, not the profile patch, is the source of truth after first run: the
 * toggle in the Plugins page has to survive a restart without anyone editing
 * YAML, and an exposure switch that silently forgets it was on is worse than
 * no switch at all.
 * @module dsh-expose/state
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyIPv4 } from './network.js'

/** Shipped defaults: every interface, the documented 3080, exposure off. */
export const DEFAULT_SETTINGS = Object.freeze({ enabled: false, host: '0.0.0.0', port: 3080 })

/** Harness home, matching the launcher's own resolution order. */
export function harnessHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/** Absolute path of the settings document. */
export function settingsPath() {
  return path.join(harnessHome(), 'dsh-expose.json')
}

/**
 * Validate one settings candidate, filling every missing field from the
 * defaults so a corrupt file degrades to "shipped defaults" rather than a
 * half-applied listener.
 * @param {unknown} value - raw document or partial patch.
 * @param {{ enabled?: boolean, host?: string, port?: number }} [fallback] - values used for absent fields.
 * @returns {{ enabled: boolean, host: string, port: number, issues: string[] }}
 */
export function normalizeSettings(value, fallback = DEFAULT_SETTINGS) {
  const issues = []
  const raw = typeof value === 'object' && value !== null ? value : {}
  let enabled = fallback.enabled
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') enabled = raw.enabled
    else issues.push('enabled must be a boolean')
  }
  let host = fallback.host
  if (raw.host !== undefined) {
    const candidate = typeof raw.host === 'string' ? raw.host.trim() : ''
    if (candidate === '0.0.0.0' || candidate === '' || classifyIPv4(candidate) !== 'invalid') host = candidate === '' ? '0.0.0.0' : candidate
    else issues.push(`host ${JSON.stringify(raw.host)} is not 0.0.0.0 or an IPv4 literal`)
  }
  let port = fallback.port
  if (raw.port !== undefined) {
    const candidate = typeof raw.port === 'string' ? (/^\d+$/.test(raw.port.trim()) ? Number(raw.port.trim()) : Number.NaN) : raw.port
    if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) port = candidate
    else issues.push('port must be an integer between 1 and 65535')
  }
  return { enabled, host, port, issues }
}

/**
 * Read the stored settings, falling back to the given config for anything the
 * document does not decide.
 * @param {{ enabled?: boolean, host?: string, port?: number }} [config] - profile-provided defaults.
 * @returns {{ enabled: boolean, host: string, port: number, path: string, exists: boolean, issues: string[] }}
 */
export function loadSettings(config = {}) {
  const seeded = normalizeSettings(config, DEFAULT_SETTINGS)
  const file = settingsPath()
  let parsed
  let exists = false
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    exists = true
  } catch {
    parsed = undefined
  }
  const resolved = normalizeSettings(parsed ?? {}, { enabled: seeded.enabled, host: seeded.host, port: seeded.port })
  return { ...resolved, path: file, exists, issues: [...seeded.issues, ...resolved.issues] }
}

/**
 * Persist settings atomically (write + rename), creating the home directory
 * when a fresh install has none yet.
 * @param {{ enabled: boolean, host: string, port: number }} settings - normalized settings.
 * @returns {string} the file that was written.
 */
export function saveSettings(settings) {
  const file = settingsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = `${JSON.stringify({ version: 1, enabled: settings.enabled, host: settings.host, port: settings.port }, null, 2)}\n`
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, body, 'utf8')
  fs.renameSync(temporary, file)
  return file
}
