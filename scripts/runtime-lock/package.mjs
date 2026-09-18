import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, posix, relative } from 'node:path'
import {
  ERROR_CODES,
  LockError,
  digestCanonical,
  getDistributionPolicy,
  isRuntimeDistribution,
  lockDigest,
  validateDistributionPolicy,
  validateLockShape
} from './schema.mjs'
import { LOCK_FILES, readLock } from './verify.mjs'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
const asar = builderRequire('@electron/asar')
const MANIFEST_KEYS = [
  'schemaVersion',
  'platform',
  'distribution',
  'capabilities',
  'toolDelivery',
  'runtimeId',
  'lockDigests',
  'interpreter',
  'sidecarSourceDigest',
  'wheelListDigest',
  'uvToolDigest',
  'modelsDigest'
]
const SIDECAR_ROOTS = ['.python-version', 'pyproject.toml', 'uv.lock', 'src']
const SIDECAR_EXCLUDES = new Set(['.venv', '__pycache__', '.git', '.mypy_cache', '.ruff_cache'])

/**
 * electron-builder가 만든 실제 앱 디렉터리를 manifest/lock/final bytes까지 검사한다.
 * @param {{ target: 'nsis' | 'zip' | 'appx', input: string, locksDir: string }} opts
 */
export function verifyPackage(opts) {
  const { target, input, locksDir } = opts
  if (!isRuntimeDistribution(target)) {
    throw new LockError(ERROR_CODES.SCHEMA_ERROR, `unknown package target: ${String(target)}`)
  }
  /** @type {LockError[]} */
  const errors = []
  const fail = (code, message, details = {}) => errors.push(new LockError(code, message, details))
  const policy = getDistributionPolicy(target)
  const sourceLocks = readLockSet(locksDir, errors, 'source')
  const packagedLocksDir = join(input, 'resources', 'locks')
  const packagedLocks = readLockSet(packagedLocksDir, errors, 'packaged')
  const tools = packagedLocks?.tools ?? sourceLocks?.tools

  if (!existsSync(input) || !statSync(input).isDirectory()) {
    fail(ERROR_CODES.SCHEMA_ERROR, 'package input must be an app directory', { path: input })
    return { ok: false, errors, target, present: [], files: [] }
  }

  let files = []
  try {
    files = inventoryPackage(input, errors)
  } catch (error) {
    fail(ERROR_CODES.SCHEMA_ERROR, `cannot inventory package: ${error.message}`, { path: input })
  }

  if (sourceLocks && packagedLocks) {
    for (const kind of Object.keys(LOCK_FILES)) {
      const expected = lockDigest(sourceLocks[kind])
      const actual = lockDigest(packagedLocks[kind])
      if (actual !== expected) {
        fail(ERROR_CODES.HASH_MISMATCH, `${kind} packaged lock differs from build lock`, {
          id: kind,
          path: `resources/locks/${LOCK_FILES[kind]}`
        })
      }
    }
  }

  const manifest = readJson(join(input, 'resources', 'runtime-manifest.json'), errors, 'manifest')
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail(ERROR_CODES.SCHEMA_ERROR, 'runtime manifest must be an object', { id: 'manifest' })
  } else if (packagedLocks) {
    verifyManifest(manifest, target, packagedLocks, join(input, 'resources', 'sidecar'), errors)
  }

  if (tools) verifyToolPayload(target, input, tools, policy, files, errors)

  for (const name of ['.python-version', 'pyproject.toml', 'uv.lock']) {
    const path = join(input, 'resources', 'sidecar', name)
    if (!existsSync(path) || !statSync(path).isFile()) {
      fail(ERROR_CODES.SCHEMA_ERROR, `missing staged sidecar file: ${name}`, {
        path: `resources/sidecar/${name}`
      })
    }
  }
  const sidecarSrc = join(input, 'resources', 'sidecar', 'src')
  if (!existsSync(sidecarSrc) || !statSync(sidecarSrc).isDirectory()) {
    fail(ERROR_CODES.SCHEMA_ERROR, 'missing staged sidecar src directory', {
      path: 'resources/sidecar/src'
    })
  }
  for (const name of [
    'tools.provenance.json',
    'python.lock.json',
    'wheels.lock.json',
    'models.lock.json'
  ]) {
    if (!existsSync(join(packagedLocksDir, name))) {
      fail(ERROR_CODES.SCHEMA_ERROR, `missing packaged runtime metadata: ${name}`, {
        path: `resources/locks/${name}`
      })
    }
  }
  for (const name of ['LICENSE', 'LICENSE_SCOPE.md', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']) {
    if (!existsSync(join(input, name))) {
      fail(ERROR_CODES.SCHEMA_ERROR, `missing packaged license notice: ${name}`, { path: name })
    }
  }

  const binDir = join(input, 'resources', 'bin')
  const present = existsSync(binDir)
    ? readdirSync(binDir).filter((name) => statSync(join(binDir, name)).isFile())
    : []
  return { ok: errors.length === 0, errors, target, present, files }
}

function readLockSet(locksDir, errors, label) {
  const locks = {}
  for (const [kind, filename] of Object.entries(LOCK_FILES)) {
    try {
      const lock = readLock(locksDir, filename).json
      errors.push(...validateLockShape(lock))
      locks[kind] = lock
    } catch (error) {
      errors.push(
        new LockError(
          ERROR_CODES.SCHEMA_ERROR,
          `cannot read ${label} ${filename}: ${error.message}`,
          {
            id: kind,
            path: join(locksDir, filename)
          }
        )
      )
      return null
    }
  }
  return locks
}

function readJson(path, errors, id) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    errors.push(
      new LockError(ERROR_CODES.SCHEMA_ERROR, `cannot read ${id}: ${error.message}`, { id, path })
    )
    return null
  }
}

function verifyManifest(manifest, target, locks, sidecarDir, errors) {
  const keys = Object.keys(manifest).sort()
  if (keys.length !== MANIFEST_KEYS.length || !MANIFEST_KEYS.every((key) => keys.includes(key))) {
    errors.push(
      new LockError(ERROR_CODES.SCHEMA_ERROR, 'runtime manifest fields do not match schema v2')
    )
  }
  if (manifest.schemaVersion !== 2) {
    errors.push(
      new LockError(
        ERROR_CODES.SCHEMA_ERROR,
        `unsupported runtime manifest schemaVersion: ${String(manifest.schemaVersion)}`,
        { id: 'schemaVersion' }
      )
    )
  }
  if (manifest.platform !== 'win32-x64') {
    errors.push(
      new LockError(ERROR_CODES.BAD_PLATFORM, `manifest platform is ${String(manifest.platform)}`, {
        id: 'platform'
      })
    )
  }
  if (manifest.distribution !== target) {
    errors.push(
      new LockError(
        ERROR_CODES.SCHEMA_ERROR,
        `manifest distribution ${String(manifest.distribution)} does not match ${target}`,
        { id: 'distribution' }
      )
    )
  }
  errors.push(
    ...validateDistributionPolicy(
      manifest.distribution,
      manifest.capabilities,
      manifest.toolDelivery
    )
  )

  if (!hasExactKeys(manifest.lockDigests, ['tools', 'python', 'wheels', 'models'])) {
    errors.push(
      new LockError(ERROR_CODES.SCHEMA_ERROR, 'manifest lockDigests fields do not match schema', {
        id: 'lockDigests'
      })
    )
  }
  if (!hasExactKeys(manifest.interpreter, ['patch', 'distributionBuild'])) {
    errors.push(
      new LockError(ERROR_CODES.SCHEMA_ERROR, 'manifest interpreter fields do not match schema', {
        id: 'interpreter'
      })
    )
  }

  const digests = {
    tools: lockDigest(locks.tools),
    python: lockDigest(locks.python),
    wheels: lockDigest(locks.wheels),
    models: lockDigest(locks.models)
  }
  for (const [kind, digest] of Object.entries(digests)) {
    if (manifest.lockDigests?.[kind] !== digest) {
      errors.push(
        new LockError(ERROR_CODES.HASH_MISMATCH, `${kind} manifest lock digest mismatch`, {
          id: `lockDigests.${kind}`
        })
      )
    }
  }
  const sidecarSourceDigest = computeSidecarDigest(sidecarDir)
  const wheelList = wheelListDigest(locks.wheels)
  const uv = locks.tools.artifacts.find((artifact) => artifact.id === 'uv')
  const interpreter = locks.python.python ?? {}
  const runtimeId = digestCanonical({
    platform: 'win32-x64',
    interpreter: {
      patch: interpreter.patch,
      distributionBuild: interpreter.distributionBuild
    },
    wheelListDigest: wheelList,
    uvToolDigest: uv?.sha256,
    sidecarSourceDigest
  })
  const checks = [
    ['sidecarSourceDigest', sidecarSourceDigest],
    ['wheelListDigest', wheelList],
    ['uvToolDigest', uv?.sha256],
    ['modelsDigest', digests.models],
    ['runtimeId', runtimeId]
  ]
  for (const [name, expected] of checks) {
    if (manifest[name] !== expected) {
      errors.push(new LockError(ERROR_CODES.HASH_MISMATCH, `${name} mismatch`, { id: name }))
    }
  }
  for (const name of ['patch', 'distributionBuild']) {
    if (manifest.interpreter?.[name] !== interpreter[name]) {
      errors.push(
        new LockError(ERROR_CODES.HASH_MISMATCH, `interpreter.${name} mismatch`, {
          id: `interpreter.${name}`
        })
      )
    }
  }
}

function verifyToolPayload(target, input, tools, policy, files, errors) {
  for (const id of Object.keys(policy.toolDelivery)) {
    if (!tools.artifacts.some((artifact) => artifact.id === id)) {
      errors.push(new LockError(ERROR_CODES.SCHEMA_ERROR, `missing tool lock entry: ${id}`, { id }))
    }
  }
  const expectedBinNames = new Set()
  const forbiddenDigests = new Map()
  const forbiddenNames = new Set()
  const archiveNames = new Set()

  for (const artifact of tools.artifacts) {
    const delivery = policy.toolDelivery[artifact.id]
    const primary = primaryPayload(artifact)
    if (!primary) {
      errors.push(
        new LockError(ERROR_CODES.SCHEMA_ERROR, `tool has no package payload: ${artifact.id}`, {
          id: artifact.id
        })
      )
      continue
    }
    const expectedPath = join(input, artifact.dest)
    const expectedName = basename(artifact.dest).toLowerCase()
    if (delivery === 'bundled') {
      expectedBinNames.add(expectedName)
      if (!existsSync(expectedPath)) {
        errors.push(
          new LockError(
            ERROR_CODES.SCHEMA_ERROR,
            `missing required ${expectedName} for ${target}`,
            {
              id: artifact.id,
              path: artifact.dest
            }
          )
        )
      } else if (
        statSync(expectedPath).size !== primary.size ||
        hashBytes(readFileSync(expectedPath)) !== primary.sha256
      ) {
        errors.push(
          new LockError(
            ERROR_CODES.HASH_MISMATCH,
            `${expectedName} final bytes do not match lock`,
            {
              id: artifact.id,
              path: artifact.dest
            }
          )
        )
      }
    } else {
      forbiddenNames.add(expectedName)
      forbiddenDigests.set(primary.sha256, artifact.id)
    }

    if (artifact.kind === 'archive') {
      forbiddenDigests.set(artifact.sha256, `${artifact.id}-archive`)
      try {
        archiveNames.add(basename(new URL(artifact.url).pathname).toLowerCase())
      } catch {
        // validateLockShape reports malformed URLs elsewhere.
      }
      for (const member of artifact.archive?.files ?? []) {
        const memberName = basename(member.dest ?? member.path).toLowerCase()
        if (delivery !== 'bundled' || member.sha256 !== primary.sha256) {
          forbiddenNames.add(memberName)
          forbiddenDigests.set(member.sha256, `${artifact.id}:${member.path}`)
        }
      }
    }
  }

  const binPrefix = 'resources/bin/'
  for (const file of files) {
    const logical = file.path.replaceAll('\\', '/')
    const lower = logical.toLowerCase()
    const name = posix.basename(lower)
    if (lower.startsWith(binPrefix) && !expectedBinNames.has(name)) {
      errors.push(
        new LockError(
          ERROR_CODES.UNEXPECTED_EXECUTABLE,
          `unexpected file in packaged resources/bin: ${logical}`,
          { path: logical }
        )
      )
    }
    const forbiddenId = forbiddenDigests.get(file.sha256)
    if (forbiddenId) {
      errors.push(
        new LockError(ERROR_CODES.HASH_MISMATCH, `forbidden tool bytes found: ${logical}`, {
          id: forbiddenId,
          path: logical
        })
      )
    }
    if (forbiddenNames.has(name) || archiveNames.has(name)) {
      errors.push(
        new LockError(
          ERROR_CODES.UNEXPECTED_EXECUTABLE,
          `forbidden tool payload found: ${logical}`,
          {
            path: logical
          }
        )
      )
    }
    if (
      target === 'nsis' &&
      (/(^|\/)(runtime-cache|tool-cache|downloads)(\/|$)/i.test(lower) || lower.endsWith('.part'))
    ) {
      errors.push(
        new LockError(
          ERROR_CODES.SCHEMA_ERROR,
          `build/download cache found in NSIS payload: ${logical}`,
          {
            path: logical
          }
        )
      )
    }
  }
}

function primaryPayload(artifact) {
  if (artifact.kind !== 'archive') return artifact
  return (
    artifact.archive?.files?.find((member) => member.dest === artifact.dest) ??
    artifact.archive?.files?.[0]
  )
}

function inventoryPackage(root, errors) {
  const entries = []
  const visit = (absolute) => {
    const info = lstatSync(absolute)
    const rel = relative(root, absolute).replaceAll('\\', '/')
    if (info.isSymbolicLink()) {
      errors.push(
        new LockError(ERROR_CODES.SYMLINK_REJECTED, `package symlink is forbidden: ${rel}`, {
          path: rel
        })
      )
      return
    }
    if (info.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(join(absolute, name))
      return
    }
    if (!info.isFile()) return
    const bytes = readFileSync(absolute)
    entries.push({ path: rel, size: bytes.length, sha256: hashBytes(bytes), source: 'file' })
  }
  visit(root)

  const asarPath = join(root, 'resources', 'app.asar')
  if (!existsSync(asarPath)) {
    errors.push(
      new LockError(ERROR_CODES.SCHEMA_ERROR, 'missing resources/app.asar', {
        path: 'resources/app.asar'
      })
    )
    return entries
  }
  try {
    for (const listed of asar.listPackage(asarPath).sort()) {
      const name = listed.replace(/^[/\\]+/, '')
      const info = asar.statFile(asarPath, name, false)
      if ('files' in info) continue
      if ('link' in info) {
        errors.push(
          new LockError(ERROR_CODES.SYMLINK_REJECTED, `asar link is forbidden: ${name}`, {
            path: `resources/app.asar:${name}`
          })
        )
        continue
      }
      const bytes = asar.extractFile(asarPath, name, false)
      entries.push({
        path: `resources/app.asar:${name.replaceAll('\\', '/')}`,
        size: bytes.length,
        sha256: hashBytes(bytes),
        source: 'asar'
      })
    }
  } catch (error) {
    errors.push(
      new LockError(
        ERROR_CODES.SCHEMA_ERROR,
        `cannot inspect resources/app.asar: ${error.message}`,
        {
          path: 'resources/app.asar'
        }
      )
    )
  }
  return entries
}

function computeSidecarDigest(root) {
  const entries = []
  const visit = (rel) => {
    const segments = rel.split(/[\\/]/).filter(Boolean)
    if (
      segments.some((segment) => SIDECAR_EXCLUDES.has(segment) || segment.endsWith('.egg-info'))
    ) {
      return
    }
    const name = segments.at(-1) ?? ''
    if (name.endsWith('.pyc') || name === '.ready') return
    const absolute = join(root, rel)
    if (!existsSync(absolute)) return
    const info = statSync(absolute)
    if (info.isDirectory()) {
      for (const child of readdirSync(absolute).sort()) {
        visit(rel ? `${rel}/${child}` : child)
      }
    } else {
      entries.push({ path: rel.replaceAll('\\', '/'), sha256: hashBytes(readFileSync(absolute)) })
    }
  }
  for (const name of SIDECAR_ROOTS) visit(name)
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return digestCanonical(entries)
}

function wheelListDigest(wheels) {
  return digestCanonical(
    wheels.artifacts
      .filter((artifact) => ['wheel', 'file', 'sdist-build'].includes(artifact.kind))
      .map((artifact) => ({
        id: artifact.id,
        sha256: artifact.sha256,
        dest: artifact.dest.replaceAll('\\', '/')
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  )
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function hasExactKeys(value, keys) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
