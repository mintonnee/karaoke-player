/**
 * 배포 타깃별 runtime staging/manifest 생성과 최종 app-directory 검증.
 * runtimeId 입력은 schema v1 때와 동일하고, 배포 정책만 manifest schema v2에 추가한다.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  digestCanonical,
  getDistributionPolicy,
  isRuntimeDistribution,
  lockDigest
} from './scripts/runtime-lock/schema.mjs'
import { verifyPackage } from './scripts/runtime-lock/package.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SIDECAR_DIGEST_ROOTS = ['.python-version', 'pyproject.toml', 'uv.lock', 'src']
const EXCLUDED_DIRS = new Set(['.venv', '__pycache__', '.git', '.mypy_cache', '.ruff_cache'])

function posixDest(relPath) {
  return relPath.replaceAll('\\', '/')
}

function shouldHashSidecarPath(relPath) {
  if (relPath === '' || relPath === '.') return true
  const segments = relPath.split(/[\\/]/)
  if (segments.some((segment) => EXCLUDED_DIRS.has(segment) || segment.endsWith('.egg-info'))) {
    return false
  }
  const name = segments.at(-1)
  return !name.endsWith('.pyc') && name !== '.ready'
}

function hashFileHex(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function computeSidecarSourceDigest(projectDir) {
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
      for (const name of readdirSync(path).sort()) {
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

function wheelListDigest(wheels) {
  return digestCanonical(
    (wheels.artifacts ?? [])
      .filter((artifact) => ['wheel', 'file', 'sdist-build'].includes(artifact.kind))
      .map((artifact) => ({
        id: artifact.id,
        sha256: artifact.sha256,
        dest: posixDest(artifact.dest)
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  )
}

function readLock(locksDir, name) {
  return JSON.parse(readFileSync(join(locksDir, name), 'utf8'))
}

export function runtimeStagingDir(target, root = ROOT) {
  if (!isRuntimeDistribution(target)) throw new Error(`unknown runtime target: ${String(target)}`)
  return join(root, 'dist', 'runtime-staging', target)
}

export function extraResourcesFor(target) {
  const staging = posixDest(join('dist', 'runtime-staging', target))
  const policy = getDistributionPolicy(target)
  const resources = []
  for (const [id, delivery] of Object.entries(policy.toolDelivery)) {
    if (delivery !== 'bundled') continue
    resources.push({ from: `${staging}/resources/bin/${id}.exe`, to: `bin/${id}.exe` })
  }
  resources.push(
    { from: `${staging}/sidecar`, to: 'sidecar' },
    { from: `${staging}/locks`, to: 'locks' },
    { from: `${staging}/runtime-manifest.json`, to: 'runtime-manifest.json' }
  )
  return resources
}

export async function writeRuntimeManifest(opts = {}) {
  const root = opts.root ?? ROOT
  const target = opts.target ?? 'zip'
  if (!isRuntimeDistribution(target)) throw new Error(`unknown runtime target: ${String(target)}`)
  const staging = opts.stagingDir ?? runtimeStagingDir(target, root)
  const locksDir = opts.locksDir ?? join(staging, 'locks')
  const sidecarDir = opts.sidecarDir ?? join(staging, 'sidecar')
  const outPath = opts.outPath ?? join(staging, 'runtime-manifest.json')

  const tools = readLock(locksDir, 'tools.lock.json')
  const python = readLock(locksDir, 'python.lock.json')
  const wheels = readLock(locksDir, 'wheels.lock.json')
  const models = readLock(locksDir, 'models.lock.json')
  const uv = tools.artifacts.find((artifact) => artifact.id === 'uv')
  if (!uv?.sha256) throw new Error('tools.lock missing uv artifact')
  const patch = python.python?.patch
  const distributionBuild = python.python?.distributionBuild
  if (!patch || !distributionBuild) throw new Error('python.lock missing patch/distributionBuild')

  const sidecarSourceDigest = computeSidecarSourceDigest(sidecarDir)
  const wheelsDigest = wheelListDigest(wheels)
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
  const policy = getDistributionPolicy(target)
  const manifest = {
    schemaVersion: 2,
    platform: 'win32-x64',
    distribution: target,
    capabilities: { ...policy.capabilities },
    toolDelivery: { ...policy.toolDelivery },
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

export async function verifyPackagedApp(target, context) {
  const result = await verifyPackage({
    target,
    input: context.appOutDir,
    locksDir: join(ROOT, 'build', 'locks')
  })
  if (!result.ok) {
    throw new Error(result.errors.map((error) => `${error.code} ${error.message}`).join('\n'))
  }
  return context.appOutDir
}
