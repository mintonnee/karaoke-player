import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import {
  ERROR_CODES,
  LockError,
  SUPPORTED_PLATFORM,
  digestCanonical,
  lockDigest,
  posixDest,
  sha256Hex,
  validateLockShape,
  type Artifact,
  type LockFile
} from './schema'
import { validateArtifactRuntime } from './verify'

export const MANIFEST_SCHEMA_VERSION = 1

export const SIDECAR_DIGEST_ROOTS = Object.freeze([
  '.python-version',
  'pyproject.toml',
  'uv.lock',
  'src'
] as const)

export interface RuntimeLockSet {
  tools: LockFile
  python: LockFile
  wheels: LockFile
  models: LockFile
}

export interface RuntimeManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION
  platform: typeof SUPPORTED_PLATFORM
  runtimeId: string
  lockDigests: {
    tools: string
    python: string
    wheels: string
    models: string
  }
  interpreter: {
    patch: string
    distributionBuild: string
  }
  sidecarSourceDigest: string
  wheelListDigest: string
  uvToolDigest: string
  modelsDigest: string
}

export interface RuntimeIdInput {
  platform: string
  interpreter: { patch: string; distributionBuild: string }
  wheelListDigest: string
  uvToolDigest: string
  sidecarSourceDigest: string
}

export interface RuntimeInputDigests {
  platform: string
  interpreter: string
  wheels: string
  uv: string
  sidecar: string
}

const EXCLUDED_DIRS = new Set(['.venv', '__pycache__', '.git', '.mypy_cache', '.ruff_cache'])

export function shouldHashSidecarPath(relPath: string): boolean {
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

async function hashFileHex(path: string): Promise<string> {
  const content = await readFile(path)
  return sha256Hex(content)
}

/** sidecar 소스 digest. `.python-version`을 포함한다. */
export async function computeSidecarSourceDigest(projectDir: string): Promise<string> {
  const entries: Array<{ path: string; sha256: string }> = []
  const visit = async (rel: string): Promise<void> => {
    if (!shouldHashSidecarPath(rel)) return
    const path = join(projectDir, rel)
    let info
    try {
      info = await stat(path)
    } catch {
      return
    }
    if (info.isDirectory()) {
      const names = (await readdir(path)).sort()
      for (const name of names) {
        await visit(rel === '' || rel === '.' ? name : `${rel}/${name}`)
      }
    } else {
      entries.push({ path: posixDest(rel), sha256: await hashFileHex(path) })
    }
  }
  for (const name of SIDECAR_DIGEST_ROOTS) await visit(name)
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return digestCanonical(entries)
}

export function wheelListDigest(wheels: LockFile): string {
  const list = (wheels.artifacts ?? [])
    .filter((a) => a.kind === 'wheel' || a.kind === 'file' || a.kind === 'sdist-build')
    .map((a) => ({ id: a.id, sha256: a.sha256, dest: posixDest(a.dest) }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return digestCanonical(list)
}

export function uvToolDigest(tools: LockFile): string {
  const uv = tools.artifacts.find((a) => a.id === 'uv')
  if (!uv?.sha256) {
    throw new LockError(ERROR_CODES.SCHEMA_ERROR, 'tools.lock missing uv artifact', { id: 'uv' })
  }
  return uv.sha256
}

export function interpreterDigest(python: LockFile): { patch: string; distributionBuild: string } {
  const patch = python.python?.patch
  const distributionBuild = python.python?.distributionBuild
  if (!patch || !distributionBuild) {
    throw new LockError(ERROR_CODES.SCHEMA_ERROR, 'python.lock missing patch/distributionBuild', {
      id: 'cpython'
    })
  }
  return { patch, distributionBuild }
}

/** 앱 표시 버전·모델 digest는 입력에 넣지 않는다. */
export function computeRuntimeId(input: RuntimeIdInput): string {
  return digestCanonical({
    platform: input.platform,
    interpreter: {
      patch: input.interpreter.patch,
      distributionBuild: input.interpreter.distributionBuild
    },
    wheelListDigest: input.wheelListDigest,
    uvToolDigest: input.uvToolDigest,
    sidecarSourceDigest: input.sidecarSourceDigest
  })
}

export function runtimeInputDigests(
  manifest: Pick<
    RuntimeManifest,
    'platform' | 'interpreter' | 'wheelListDigest' | 'uvToolDigest' | 'sidecarSourceDigest'
  >
): RuntimeInputDigests {
  return {
    platform: manifest.platform,
    interpreter: `${manifest.interpreter.patch}+${manifest.interpreter.distributionBuild}`,
    wheels: manifest.wheelListDigest,
    uv: manifest.uvToolDigest,
    sidecar: manifest.sidecarSourceDigest
  }
}

export async function computeManifestInputs(
  locks: RuntimeLockSet,
  sidecarDir: string
): Promise<RuntimeIdInput & { lockDigests: RuntimeManifest['lockDigests']; modelsDigest: string }> {
  const sidecarSourceDigest = await computeSidecarSourceDigest(sidecarDir)
  const interpreter = interpreterDigest(locks.python)
  const wheels = wheelListDigest(locks.wheels)
  const uv = uvToolDigest(locks.tools)
  const lockDigests = {
    tools: lockDigest(locks.tools),
    python: lockDigest(locks.python),
    wheels: lockDigest(locks.wheels),
    models: lockDigest(locks.models)
  }
  return {
    platform: SUPPORTED_PLATFORM,
    interpreter,
    wheelListDigest: wheels,
    uvToolDigest: uv,
    sidecarSourceDigest,
    lockDigests,
    modelsDigest: lockDigests.models
  }
}

export async function buildRuntimeManifest(
  locks: RuntimeLockSet,
  sidecarDir: string
): Promise<RuntimeManifest> {
  const inputs = await computeManifestInputs(locks, sidecarDir)
  const runtimeId = computeRuntimeId(inputs)
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    platform: SUPPORTED_PLATFORM,
    runtimeId,
    lockDigests: inputs.lockDigests,
    interpreter: inputs.interpreter,
    sidecarSourceDigest: inputs.sidecarSourceDigest,
    wheelListDigest: inputs.wheelListDigest,
    uvToolDigest: inputs.uvToolDigest,
    modelsDigest: inputs.modelsDigest
  }
}

export interface VerifyManifestResult {
  ok: boolean
  errors: LockError[]
  runtimeId: string
}

const REQUIRED_SIDECAR_FILES = ['.python-version', 'pyproject.toml', 'uv.lock'] as const

export async function verifyManifest(
  manifest: RuntimeManifest,
  locks: RuntimeLockSet,
  sidecarDir: string
): Promise<VerifyManifestResult> {
  const errors: LockError[] = []
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push(
      new LockError(
        ERROR_CODES.SCHEMA_ERROR,
        `unsupported manifest schemaVersion: ${String(manifest.schemaVersion)}`
      )
    )
  }
  if (manifest.platform !== SUPPORTED_PLATFORM) {
    errors.push(
      new LockError(ERROR_CODES.BAD_PLATFORM, `unsupported manifest platform: ${manifest.platform}`)
    )
  }

  for (const [kind, lock] of Object.entries(locks) as Array<[keyof RuntimeLockSet, LockFile]>) {
    errors.push(...validateLockShape(lock))
    if (lock.platform !== SUPPORTED_PLATFORM) {
      errors.push(
        new LockError(ERROR_CODES.BAD_PLATFORM, `unsupported lock platform: ${lock.platform}`, {
          id: kind
        })
      )
    }
    for (const artifact of lock.artifacts ?? []) {
      errors.push(...validateArtifactRuntime(artifact, lock.kind))
    }
  }

  for (const name of REQUIRED_SIDECAR_FILES) {
    try {
      await stat(join(sidecarDir, name))
    } catch {
      errors.push(
        new LockError(ERROR_CODES.SCHEMA_ERROR, `missing required sidecar file: ${name}`, {
          path: name
        })
      )
    }
  }
  try {
    const src = await stat(join(sidecarDir, 'src'))
    if (!src.isDirectory()) {
      errors.push(
        new LockError(ERROR_CODES.SCHEMA_ERROR, 'sidecar src must be a directory', { path: 'src' })
      )
    }
  } catch {
    errors.push(
      new LockError(ERROR_CODES.SCHEMA_ERROR, 'missing required sidecar file: src', { path: 'src' })
    )
  }

  const computed = await computeManifestInputs(locks, sidecarDir)
  const check = (label: string, expected: string, actual: string): void => {
    if (expected !== actual) {
      errors.push(
        new LockError(ERROR_CODES.HASH_MISMATCH, `${label} digest mismatch`, { id: label })
      )
    }
  }
  check('tools', manifest.lockDigests.tools, computed.lockDigests.tools)
  check('python', manifest.lockDigests.python, computed.lockDigests.python)
  check('wheels', manifest.lockDigests.wheels, computed.lockDigests.wheels)
  check('models', manifest.lockDigests.models, computed.lockDigests.models)
  check('sidecar', manifest.sidecarSourceDigest, computed.sidecarSourceDigest)
  check('wheelList', manifest.wheelListDigest, computed.wheelListDigest)
  check('uv', manifest.uvToolDigest, computed.uvToolDigest)

  const runtimeId = computeRuntimeId(computed)
  if (manifest.runtimeId !== runtimeId) {
    errors.push(
      new LockError(ERROR_CODES.HASH_MISMATCH, 'runtimeId does not match execution inputs', {
        id: 'runtimeId'
      })
    )
  }

  return { ok: errors.length === 0, errors, runtimeId }
}

export function findArtifact(lock: LockFile, id: string): Artifact {
  const found = lock.artifacts.find((a) => a.id === id)
  if (!found) {
    throw new LockError(ERROR_CODES.SCHEMA_ERROR, `artifact not found: ${id}`, { id })
  }
  return found
}
