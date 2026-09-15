import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ERROR_CODES,
  GIT_SHA_RE,
  LockError,
  SCHEMA_VERSION,
  SUPPORTED_PLATFORM,
  isMutableRevision,
  validateLockShape
} from './schema.mjs'
import { assertAllowedUrl, isHuggingFaceUrl } from './hosts.mjs'
import { diffWheelSelection, uvLockDigestFromFile } from './wheels.mjs'

export const LOCK_FILES = Object.freeze({
  tools: 'tools.lock.json',
  python: 'python.lock.json',
  models: 'models.lock.json',
  wheels: 'wheels.lock.json'
})

/**
 * @param {string} root
 */
export function defaultPaths(root) {
  return {
    root,
    locksDir: join(root, 'build', 'locks'),
    uvLock: join(root, 'sidecar', 'uv.lock'),
    pythonVersion: join(root, 'sidecar', '.python-version'),
    pyproject: join(root, 'sidecar', 'pyproject.toml')
  }
}

/**
 * @param {string} locksDir
 * @param {string} name
 */
export function readLock(locksDir, name) {
  const path = join(locksDir, name)
  const raw = readFileSync(path, 'utf8')
  return { path, raw, json: JSON.parse(raw) }
}

/**
 * @param {{ root: string, locksDir?: string }} opts
 * @returns {{ ok: boolean, errors: LockError[], snapshots: { path: string, mtimeMs: number, bytes: Buffer }[] }}
 */
export function verifyLocks(opts) {
  const paths = defaultPaths(opts.root)
  const locksDir = opts.locksDir ?? paths.locksDir
  /** @type {LockError[]} */
  const errors = []
  const snapshots = []

  const files = Object.values(LOCK_FILES).map((name) => {
    const { path, raw, json } = readLock(locksDir, name)
    snapshots.push({ path, mtimeMs: statSync(path).mtimeMs, bytes: Buffer.from(raw) })
    return { name, json, path }
  })

  const uvLockDigest = uvLockDigestFromFile(paths.uvLock)
  const pythonVersion = readFileSync(paths.pythonVersion, 'utf8').trim()
  const pyproject = readFileSync(paths.pyproject, 'utf8')

  for (const file of files) {
    const shape = validateLockShape(file.json)
    errors.push(...shape)
    if (file.json.schemaVersion !== SCHEMA_VERSION) {
      errors.push(new LockError(ERROR_CODES.SCHEMA_ERROR, `schemaVersion mismatch in ${file.name}`))
    }
    if (file.json.platform !== SUPPORTED_PLATFORM) {
      errors.push(
        new LockError(ERROR_CODES.BAD_PLATFORM, `platform mismatch in ${file.name}`, {
          path: file.path
        })
      )
    }
    for (const artifact of file.json.artifacts ?? []) {
      errors.push(...validateArtifactRuntime(artifact, file.json.kind))
    }
    if (file.json.kind === 'models') {
      for (const model of file.json.models ?? []) {
        if (isMutableRevision(model.revision, { requireGitSha: Boolean(model.repo) })) {
          errors.push(
            new LockError(
              ERROR_CODES.MUTABLE_REVISION,
              `mutable revision for model ${model.id}: ${model.revision}`,
              { id: model.id }
            )
          )
        }
        if (model.repo && model.revision && !GIT_SHA_RE.test(model.revision)) {
          errors.push(
            new LockError(
              ERROR_CODES.MUTABLE_REVISION,
              `HF revision must be full git SHA: ${model.id}`,
              { id: model.id }
            )
          )
        }
      }
    }
    if (file.json.kind === 'wheels') {
      const uvText = readFileSync(paths.uvLock, 'utf8')
      const diff = diffWheelSelection(file.json, uvText, uvLockDigest)
      for (const msg of diff.errors) {
        errors.push(new LockError(ERROR_CODES.UV_LOCK_MISMATCH, msg, { id: 'wheels' }))
      }
    }
    if (file.json.kind === 'python') {
      const majorMinor = file.json.python?.requiresMajorMinor
      if (majorMinor !== pythonVersion) {
        errors.push(
          new LockError(
            ERROR_CODES.PYTHON_VERSION_MISMATCH,
            `python.lock ${majorMinor} != sidecar/.python-version ${pythonVersion}`,
            { id: 'cpython' }
          )
        )
      }
      const patch = file.json.python?.patch
      if (typeof patch === 'string' && !patch.startsWith(`${pythonVersion}.`)) {
        errors.push(
          new LockError(
            ERROR_CODES.PYTHON_VERSION_MISMATCH,
            `python patch ${patch} is not in family ${pythonVersion}`,
            { id: 'cpython' }
          )
        )
      }
    }
  }

  if (!pyproject.includes('hatchling')) {
    errors.push(
      new LockError(ERROR_CODES.SCHEMA_ERROR, 'pyproject.toml build-system hatchling not found')
    )
  }

  return { ok: errors.length === 0, errors, snapshots, uvLockDigest, pythonVersion }
}

/**
 * @param {import('./schema.mjs').Artifact} artifact
 * @param {string} lockKind
 */
export function validateArtifactRuntime(artifact, lockKind) {
  /** @type {LockError[]} */
  const errors = []
  if (artifact.url) {
    try {
      assertAllowedUrl(artifact.url, { id: artifact.id })
    } catch (err) {
      if (err instanceof LockError) errors.push(err)
      else throw err
    }
    if (isHuggingFaceUrl(artifact.url)) {
      if (isMutableRevision(artifact.revision, { requireGitSha: true })) {
        errors.push(
          new LockError(
            ERROR_CODES.MUTABLE_REVISION,
            `HF artifact requires immutable git SHA: ${artifact.id}`,
            { id: artifact.id }
          )
        )
      }
    }
  }
  if (
    lockKind === 'models' &&
    artifact.revision &&
    isMutableRevision(artifact.revision, { requireGitSha: true })
  ) {
    errors.push(
      new LockError(ERROR_CODES.MUTABLE_REVISION, `mutable revision: ${artifact.revision}`, {
        id: artifact.id
      })
    )
  }
  return errors
}

/**
 * verify가 lock 파일을 쓰지 않았는지 확인.
 * @param {{ path: string, mtimeMs: number, bytes: Buffer }[]} snapshots
 */
export function assertLocksUnchanged(snapshots) {
  /** @type {LockError[]} */
  const errors = []
  for (const snap of snapshots) {
    const now = statSync(snap.path)
    const bytes = readFileSync(snap.path)
    if (now.mtimeMs !== snap.mtimeMs || Buffer.compare(bytes, snap.bytes) !== 0) {
      errors.push(new LockError(ERROR_CODES.SCHEMA_ERROR, `verify mutated lock file: ${snap.path}`))
    }
  }
  return errors
}
