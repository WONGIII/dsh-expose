#!/usr/bin/env node
/**
 * Verify this package against the published DSH plugin conventions.
 *
 * The checks mirror what the Plugin Manager, the Loader, and pnpm read from a
 * git install:
 *
 *   - the bundle manifest (`dsh.bundle.patch`) and its patch file exist;
 *   - the browser half (`dsh.client.platform` + `exports["./client"]`) exists;
 *   - display metadata resolves (`icon`, `locale/*.json` with `meta.title` /
 *     `meta.description`) and every image stays inside the package, under the
 *     256 KiB ceiling the Host enforces;
 *   - the published `files` list actually covers the artifacts above;
 *   - no install-time script or dependency can surprise the person installing,
 *     because a git install runs with the profile's own permissions.
 *
 * Usage: node scripts/verify-package.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const checks = []

/** Record one assertion. */
function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail })
  if (!condition) problems.push(detail === '' ? label : `${label}: ${detail}`)
}

/** Read one JSON file, or report why it could not be read. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    problems.push(`${relative(ROOT, path)} is not readable JSON: ${error.message}`)
    return undefined
  }
}

const manifest = readJson(join(ROOT, 'package.json'))
if (manifest === undefined) {
  console.error(problems.join('\n'))
  process.exit(1)
}

check('package name is a registry-legal name', /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(manifest.name), manifest.name)
check('version is semver', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? ''), manifest.version)
check('description is a non-empty string', typeof manifest.description === 'string' && manifest.description.trim() !== '')
check('type is module', manifest.type === 'module')
check('license is declared', typeof manifest.license === 'string' && manifest.license !== '')
check('main resolves to a file in the package', existsSync(join(ROOT, manifest.main ?? '')))

// --- bundle manifest -------------------------------------------------------
const patchRel = manifest.dsh?.bundle?.patch
check('declares dsh.bundle.patch', typeof patchRel === 'string', JSON.stringify(manifest.dsh?.bundle))
if (typeof patchRel === 'string') {
  const patchPath = join(ROOT, patchRel)
  check('the patch file exists', existsSync(patchPath), patchRel)
  if (existsSync(patchPath)) {
    const patch = readFileSync(patchPath, 'utf8')
    check('the patch mounts this package by name', patch.includes(`name: '${manifest.name}'`) || patch.includes(`name: "${manifest.name}"`))
    check('the patch is an insert list', /^-\s+insert:/m.test(patch))
  }
}

// --- browser half ----------------------------------------------------------
check('declares dsh.client for the web platform', manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh?.client))
const clientRel = manifest.exports?.['./client']
check('exports ./client', typeof clientRel === 'string', String(clientRel))
if (typeof clientRel === 'string') {
  const clientPath = join(ROOT, clientRel)
  check('the browser half exists', existsSync(clientPath), clientRel)
  if (existsSync(clientPath)) {
    const bundle = readFileSync(clientPath, 'utf8')
    const id = /id:\s*"([^"]+)"/.exec(bundle)?.[1]
    check('the browser half registers under the package name', id === manifest.name, `id=${String(id)}`)
    check('the browser half keeps no ESM syntax', !/^\s*(?:import|export)\s/m.test(bundle))
    check('the browser half exports inject and apply', bundle.includes('exports.apply = apply') && bundle.includes('exports.inject = inject'))
  }
}
check('exports ./package.json for manifest fallback', manifest.exports?.['./package.json'] === './package.json')
for (const [key, target] of Object.entries(manifest.exports ?? {})) {
  if (key.includes('*')) continue
  check(`export ${key} points at an existing file`, existsSync(join(ROOT, target)), target)
}

// --- display metadata ------------------------------------------------------
const localeExport = manifest.exports?.['./locale/*.json']
check('exports locale resources', typeof localeExport === 'string', String(localeExport))
const localeDir = join(ROOT, 'locale')
const localeFiles = existsSync(localeDir) ? readdirSync(localeDir).filter((name) => name.endsWith('.json')) : []
check('ships locale/en.json as the discovery entry', localeFiles.includes('en.json'), localeFiles.join(', '))
for (const name of localeFiles) {
  const dictionary = readJson(join(localeDir, name))
  if (dictionary === undefined) continue
  const title = dictionary.meta?.title
  const description = dictionary.meta?.description
  check(`locale/${name} meta.title is a non-empty string`, typeof title === 'string' && title.trim() !== '', String(title))
  check(`locale/${name} meta.description is a non-empty string`, typeof description === 'string' && description.trim() !== '', String(description))
  for (const key of Object.keys(dictionary)) {
    if (key !== 'meta') problems.push(`locale/${name} declares unknown top-level key ${JSON.stringify(key)}`)
  }
}

const iconRel = manifest.icon ?? manifest.exports?.['./icon']
check('declares an icon', typeof iconRel === 'string', String(iconRel))
if (typeof iconRel === 'string') {
  const iconPath = resolve(ROOT, iconRel)
  const inside = !isAbsolute(iconRel) && !relative(ROOT, iconPath).startsWith('..')
  check('the icon stays inside the package', inside, iconRel)
  check('the icon exists', existsSync(iconPath), iconRel)
  if (existsSync(iconPath)) {
    check('the icon is a supported format', ['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(extname(iconPath).toLowerCase()), extname(iconPath))
    check('the icon is under the 256 KiB ceiling', statSync(iconPath).size <= 256 * 1024, `${statSync(iconPath).size} bytes`)
    if (extname(iconPath).toLowerCase() === '.svg') {
      const svg = readFileSync(iconPath, 'utf8')
      check('the SVG is self-contained', !/<(?:script|image|use|foreignObject)\b/i.test(svg) && !/href\s*=/.test(svg))
    }
  }
}

// --- publication and install-time surprises --------------------------------
const files = manifest.files ?? []
// npm's `files` semantics: a bare directory includes everything below it, a
// `*` segment matches within one path segment boundary at most, and an exact
// path matches itself.
const covered = (rel) =>
  files.some((entry) => {
    const clean = entry.replace(/^\.\//, '').replace(/\/+$/, '')
    if (clean === rel) return true
    if (!clean.includes('*') && rel.startsWith(`${clean}/`)) return true
    if (!clean.includes('*')) return false
    const pattern = `^${clean.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`
    return new RegExp(pattern).test(rel)
  })
for (const rel of [manifest.main, clientRel, patchRel, iconRel, 'locale/en.json'].filter((value) => typeof value === 'string')) {
  const normalized = rel.replace(/^\.\//, '')
  check(`files covers ${normalized}`, covered(normalized), files.join(', '))
}
const scripts = manifest.scripts ?? {}
for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly']) {
  check(`no ${lifecycle} script (a git install must not need build approval)`, scripts[lifecycle] === undefined, String(scripts[lifecycle]))
}
check('no runtime dependencies', manifest.dependencies === undefined || Object.keys(manifest.dependencies).length === 0, JSON.stringify(manifest.dependencies ?? {}))
check('repository, homepage and bugs point at this project', /github\.com\/WONGIII\/dsh-expose/.test(manifest.repository?.url ?? '') && /github\.com\/WONGIII\/dsh-expose/.test(manifest.homepage ?? '') && /github\.com\/WONGIII\/dsh-expose/.test(manifest.bugs?.url ?? ''))

// --- report ----------------------------------------------------------------
for (const { label, ok, detail } of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : `  [${detail}]`}`)
}
if (problems.length > 0) {
  console.error(`\nverify-package: ${problems.length} problem(s)`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`\nverify-package: ${checks.length} checks passed`)
