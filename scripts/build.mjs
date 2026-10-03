#!/usr/bin/env node
/**
 * Build the browser half (`lib/client.js`) from `src/client.js`.
 *
 * The DSH client serves a plugin's `./client` entry as a module-loader
 * registration, not as a bare ESM file: the page hands the factory a `require`
 * that resolves the externals the shell already owns. This wrapper performs
 * exactly that transformation and nothing else — no bundler, no dependency is
 * inlined, and the emitted file stays readable.
 *
 * Usage:
 *   node scripts/build.mjs           write lib/client.js
 *   node scripts/build.mjs --check   fail when lib/client.js is stale
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = process.argv.includes('--check')
const PACKAGE_NAME = 'dsh-expose'
const SOURCE = join(ROOT, 'src', 'client.js')
const TARGET = join(ROOT, 'lib', 'client.js')

/** Modules the host page provides to the factory, and the binding name the source expects. */
const EXTERNALS = [{ specifier: 'react', binding: 'React' }]

const read = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')

/**
 * Wrap the source in the `window.__ModuleLoader__.load` registration.
 * @param {string} source - raw ESM source of the browser half.
 * @returns {string} the served artifact.
 */
export function wrapClientModule(source) {
  const lines = source.replace(/\n+$/, '').split('\n')
  const unexpected = lines.find((line) => /^import\b/.test(line))
  if (unexpected !== undefined) {
    throw new Error(`src/client.js must not import runtime modules (external bindings arrive through require): ${unexpected}`)
  }
  if (!lines.some((line) => /^export const inject = /.test(line))) throw new Error('src/client.js must export `const inject`')
  if (!lines.some((line) => /^export function apply\(/.test(line))) throw new Error('src/client.js must export `function apply`')

  const body = lines.map((line) => (line === '' ? '' : `\t\t${line.replace(/^export /, '')}`))
  const externals = EXTERNALS.map(({ specifier, binding }) => `\t\tvar ${binding} = require(${JSON.stringify(specifier)});`)
  return [
    '/**',
    ` * ${PACKAGE_NAME} — browser half (generated from src/client.js by scripts/build.mjs).`,
    ' *',
    ' * Do not edit: run `node scripts/build.mjs`.',
    ' */',
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(PACKAGE_NAME)},`,
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    ...externals,
    ...body,
    '\t\texports.apply = apply;',
    '\t\texports.inject = inject;',
    '\t\treturn module.exports;',
    '\t},',
    '});',
    '',
  ].join('\n')
}

const artifact = wrapClientModule(read(SOURCE))

if (CHECK) {
  const current = existsSync(TARGET) ? read(TARGET) : undefined
  if (current !== artifact) {
    console.error('build --check: lib/client.js is out of date — run `node scripts/build.mjs`')
    process.exit(1)
  }
  console.log('build --check: lib/client.js is up to date')
} else {
  mkdirSync(dirname(TARGET), { recursive: true })
  writeFileSync(TARGET, artifact, 'utf8')
  console.log(`wrote lib/client.js (${Buffer.byteLength(artifact)} bytes)`)
}
