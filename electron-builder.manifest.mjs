/**
 * 패키징 시 runtime-manifest.json 생성 (스펙 008 L4).
 * lock digest는 L1 scripts/runtime-lock, sidecar digest는 L2 computeSidecarSourceDigest와 동일한 규칙.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)))
const SIDECAR_DIGEST_ROOTS = ['.python-version', 'pyproject.toml', 'uv.lock', 'src']
const EXCLUDED_DIRS = new Set(['.venv', '__pycache__', '.git', '.mypy_cache', '.ruff_cache'])

function posixDest(relPath) {
  return relPath.replaceAll('\\', '/')
}

function shouldHashSidecarPath(relPath) {
  if (relPath === '' || relPath === '.') return true
  const segments = relPath.split(/[\\/]/)
  for (const segment of segments) {
    if (EXCLUDED_DIRS.has(segment)) return false
    if (segment.endsWith('.egg-info')) return false
  }
  const name = segments[segments.length - 1]
  if (name.endsWith('.pyc') || name === '.ready') return false
  return true
}

function hashFileHex(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function computeSidecarSourceDigest(projectDir, digestCanonical) {
  const entries = []
  const visit = (rel) => {
    if (!shouldHashSidecarPath(rel)) return
    const path = join(projectDir, rel)
    let info
    try {
      info = statSync(path)
    } catch {
      return
    }
    if (info.isDirectory()) {
      const names = readdirSync(path).sort()
      for (const name of names) {
        visit(rel === '' || rel === '.' ? name : `${rel}/${name}`)
      }
    } else {
      entries.push({ path: posixDest(rel), sha256: hashFileHex(path) })
    }
  }
  for (const name of SIDECAR_DIGEST_ROOTS) visit(name)
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return digestCanonical(entries)
}

function wheelListDigest(wheels, digestCanonical) {
  const list = (wheels.artifacts ?? [])
    .filter((a) => a.kind === 'wheel' || a.kind === 'file' || a.kind === 'sdist-build')
    .map((a) => ({ id: a.id, sha256: a.sha256, dest: posixDest(a.dest) }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return digestCanonical(list)
}

function readLock(locksDir, name) {
  return JSON.parse(readFileSync(join(locksDir, name), 'utf8'))
}

export function extraResourcesFor(target) {
  const bin = [{ from: 'resources/bin/uv.exe', to: 'bin/uv.exe' }]
  if (target === 'zip') {
    bin.push({ from: 'resources/bin/yt-dlp.exe', to: 'bin/yt-dlp.exe' })
  }
  bin.push({ from: 'resources/bin/deno.exe', to: 'bin/deno.exe' })
  return [
    ...bin,
    { from: 'resources/sidecar', to: 'sidecar' },
    { from: 'build/locks', to: 'locks' },
    { from: 'build/runtime-manifest.json', to: 'runtime-manifest.json' }
  ]
}

export async function writeRuntimeManifest(opts = {}) {
  const root = opts.root ?? ROOT
  const locksDir = opts.locksDir ?? join(root, 'build', 'locks')
  const staged = join(root, 'resources', 'sidecar')
  const sidecarDir =
    opts.sidecarDir ?? (existsSync(join(staged, 'pyproject.toml')) ? staged : join(root, 'sidecar'))
  const outPath = opts.outPath ?? join(root, 'build', 'runtime-manifest.json')

  const { digestCanonical, lockDigest } = await import(
    pathToFileURL(join(root, 'scripts', 'runtime-lock', 'index.mjs')).href
  )

  const tools = readLock(locksDir, 'tools.lock.json')
  const python = readLock(locksDir, 'python.lock.json')
  const wheels = readLock(locksDir, 'wheels.lock.json')
  const models = readLock(locksDir, 'models.lock.json')

  const uv = tools.artifacts.find((a) => a.id === 'uv')
  if (!uv?.sha256) throw new Error('tools.lock missing uv artifact')
  const patch = python.python?.patch
  const distributionBuild = python.python?.distributionBuild
  if (!patch || !distributionBuild) {
    throw new Error('python.lock missing patch/distributionBuild')
  }

  const sidecarSourceDigest = computeSidecarSourceDigest(sidecarDir, digestCanonical)
  const wheelsDigest = wheelListDigest(wheels, digestCanonical)
  const lockDigests = {
    tools: lockDigest(tools),
    python: lockDigest(python),
    wheels: lockDigest(wheels),
    models: lockDigest(models)
  }
  const runtimeId = digestCanonical({
    platform: 'win32-x64',
    interpreter: { patch, distributionBuild },
    wheelListDigest: wheelsDigest,
    uvToolDigest: uv.sha256,
    sidecarSourceDigest
  })
  const manifest = {
    schemaVersion: 1,
    platform: 'win32-x64',
    runtimeId,
    lockDigests,
    interpreter: { patch, distributionBuild },
    sidecarSourceDigest,
    wheelListDigest: wheelsDigest,
    uvToolDigest: uv.sha256,
    modelsDigest: lockDigests.models
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { outPath, manifest }
}
