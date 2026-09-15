/**
 * L1 lock schema 계약. L2/L3는 이 모듈의 검증·digest 규칙을 그대로 따른다.
 */

import { createHash } from 'node:crypto'
import { posix as posixPath } from 'node:path'

export const SCHEMA_VERSION = 1
export const SUPPORTED_PLATFORM = 'win32-x64'
export const LOCK_KINDS = Object.freeze(['tools', 'python', 'models', 'wheels'])
export const ARTIFACT_KINDS = Object.freeze(['file', 'archive', 'wheel', 'sdist-build'])
export const ARCHIVE_FORMATS = Object.freeze(['zip', 'tar.gz'])
export const CAPABILITIES = Object.freeze(['always', 'zip-url-import'])

export const SHA256_RE = /^[0-9a-f]{64}$/
export const GIT_SHA_RE = /^[0-9a-f]{40}$/

export const MUTABLE_REVISIONS = Object.freeze(
  new Set(['main', 'master', 'latest', 'head', 'nightly', 'stable', 'dev', 'tip'])
)

export const ERROR_CODES = Object.freeze({
  SCHEMA_ERROR: 'SCHEMA_ERROR',
  MISSING_HASH: 'MISSING_HASH',
  DUPLICATE_DEST: 'DUPLICATE_DEST',
  BAD_SIZE: 'BAD_SIZE',
  BAD_PLATFORM: 'BAD_PLATFORM',
  MUTABLE_REVISION: 'MUTABLE_REVISION',
  DISALLOWED_HOST: 'DISALLOWED_HOST',
  UV_LOCK_MISMATCH: 'UV_LOCK_MISMATCH',
  PYTHON_VERSION_MISMATCH: 'PYTHON_VERSION_MISMATCH',
  UNEXPECTED_EXECUTABLE: 'UNEXPECTED_EXECUTABLE',
  PATH_ESCAPE: 'PATH_ESCAPE',
  SYMLINK_REJECTED: 'SYMLINK_REJECTED',
  CASE_COLLISION: 'CASE_COLLISION',
  HASH_MISMATCH: 'HASH_MISMATCH',
  SIZE_MISMATCH: 'SIZE_MISMATCH'
})

/**
 * @typedef {'file' | 'archive' | 'wheel' | 'sdist-build'} ArtifactKind
 * @typedef {'tools' | 'python' | 'models' | 'wheels'} LockKind
 * @typedef {'always' | 'zip-url-import'} Capability
 *
 * @typedef {object} ArchiveMember
 * @property {string} path
 * @property {number} size
 * @property {string} sha256
 * @property {boolean} [executable]
 * @property {string} [dest]
 *
 * @typedef {object} Artifact
 * @property {string} id
 * @property {ArtifactKind} kind
 * @property {string} version
 * @property {string | null} [revision]
 * @property {string} platform
 * @property {string | null} url
 * @property {number} size
 * @property {string} sha256
 * @property {string} dest
 * @property {string} source
 * @property {string} license
 * @property {Capability} [capability]
 * @property {{ format: 'zip' | 'tar.gz', files: ArchiveMember[] }} [archive]
 * @property {string} [wheelTag]
 * @property {boolean} [userPcBuild]
 * @property {string} [buildEnvironment]
 * @property {string} [hashStatus]
 *
 * @typedef {object} LoaderBinding
 * @property {string} package
 * @property {string} symbol
 * @property {string} [argument]
 *
 * @typedef {object} ModelBinding
 * @property {string} id
 * @property {string} loader
 * @property {LoaderBinding} loaderBinding
 * @property {string} revision
 * @property {string} [repo]
 * @property {string} license
 * @property {string[]} artifactIds
 * @property {string[]} dependsOn
 *
 * @typedef {object} LocalBuild
 * @property {string} id
 * @property {'sdist-build'} kind
 * @property {string} version
 * @property {string} sourcePath
 * @property {string} backend
 * @property {'controlled'} buildEnvironment
 * @property {false} userPcBuild
 *
 * @typedef {object} LockFile
 * @property {number} schemaVersion
 * @property {LockKind} kind
 * @property {string} platform
 * @property {Artifact[]} artifacts
 * @property {string} [uvLockDigest]
 * @property {{ requiresMajorMinor: string, implementation: string, patch: string, distributionBuild: string }} [python]
 * @property {object} [buildSystem]
 * @property {ModelBinding[]} [models]
 * @property {LocalBuild[]} [localBuilds]
 */

export class LockError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ id?: string, path?: string }} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'LockError'
    this.code = code
    this.id = details.id ?? null
    this.path = details.path ?? null
  }

  toJSON() {
    return {
      code: this.code,
      id: this.id,
      path: this.path,
      message: this.message
    }
  }
}

/**
 * @param {string | Buffer | Uint8Array} data
 * @returns {string}
 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of Object.keys(value).sort()) {
    const item = /** @type {Record<string, unknown>} */ (value)[key]
    if (item === undefined) continue
    out[key] = canonicalize(item)
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function digestCanonical(value) {
  return sha256Hex(canonicalJson(value))
}

/**
 * @param {ArchiveMember} member
 * @returns {ArchiveMember}
 */
function canonicalizeMember(member) {
  const files = { ...member, path: posixPath.normalize(member.path).replaceAll('\\', '/') }
  return files
}

/**
 * lock digest 입력. 키 정렬 + artifact id/path 정렬.
 * @param {LockFile} lock
 * @returns {LockFile}
 */
export function canonicalizeLock(lock) {
  const copy = structuredClone(lock)
  if (Array.isArray(copy.artifacts)) {
    copy.artifacts = copy.artifacts
      .map((artifact) => {
        if (artifact.archive?.files) {
          artifact.archive.files = artifact.archive.files
            .map(canonicalizeMember)
            .sort((a, b) => a.path.localeCompare(b.path))
        }
        if (typeof artifact.dest === 'string') {
          artifact.dest = artifact.dest.replaceAll('\\', '/')
        }
        return artifact
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  }
  if (Array.isArray(copy.models)) {
    copy.models = [...copy.models].sort((a, b) => a.id.localeCompare(b.id))
    for (const model of copy.models) {
      model.artifactIds = [...(model.artifactIds ?? [])].sort()
      model.dependsOn = [...(model.dependsOn ?? [])].sort()
    }
  }
  if (Array.isArray(copy.localBuilds)) {
    copy.localBuilds = [...copy.localBuilds].sort((a, b) => a.id.localeCompare(b.id))
  }
  return /** @type {LockFile} */ (canonicalize(copy))
}

/**
 * @param {LockFile} lock
 * @returns {string}
 */
export function lockDigest(lock) {
  return digestCanonical(canonicalizeLock(lock))
}

/**
 * @param {string | null | undefined} revision
 * @param {{ requireGitSha?: boolean }} [opts]
 */
export function isMutableRevision(revision, opts = {}) {
  if (revision == null || revision === '') {
    return Boolean(opts.requireGitSha)
  }
  const value = String(revision)
  if (MUTABLE_REVISIONS.has(value.toLowerCase())) return true
  if (opts.requireGitSha) return !GIT_SHA_RE.test(value)
  return false
}

/**
 * @param {string} relPath
 * @returns {string}
 */
export function posixDest(relPath) {
  return relPath.replaceAll('\\', '/')
}

/**
 * @param {unknown} artifact
 * @returns {LockError[]}
 */
export function validateArtifactShape(artifact) {
  /** @type {LockError[]} */
  const errors = []
  if (artifact == null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    errors.push(new LockError(ERROR_CODES.SCHEMA_ERROR, 'artifact must be an object'))
    return errors
  }
  const a = /** @type {Record<string, unknown>} */ (artifact)
  const id = typeof a.id === 'string' ? a.id : '<unknown>'
  const fail = (code, message) => {
    errors.push(new LockError(code, message, { id }))
  }

  if (typeof a.id !== 'string' || a.id.length === 0) {
    fail(ERROR_CODES.SCHEMA_ERROR, 'missing logical id')
  }
  if (!ARTIFACT_KINDS.includes(/** @type {ArtifactKind} */ (a.kind))) {
    fail(ERROR_CODES.SCHEMA_ERROR, `invalid kind: ${String(a.kind)}`)
  }
  if (typeof a.version !== 'string' || a.version.length === 0) {
    fail(ERROR_CODES.SCHEMA_ERROR, 'missing version')
  }
  if (a.platform !== SUPPORTED_PLATFORM) {
    fail(ERROR_CODES.BAD_PLATFORM, `unsupported platform: ${String(a.platform)}`)
  }
  if (typeof a.dest !== 'string' || a.dest.length === 0) {
    fail(ERROR_CODES.SCHEMA_ERROR, 'missing dest')
  } else if (a.dest.includes('\\')) {
    fail(ERROR_CODES.SCHEMA_ERROR, `dest must use / separators: ${a.dest}`)
  }
  if (typeof a.source !== 'string' || a.source.length === 0) {
    fail(ERROR_CODES.SCHEMA_ERROR, 'missing source')
  }
  if (typeof a.license !== 'string' || a.license.length === 0) {
    fail(ERROR_CODES.SCHEMA_ERROR, 'missing license')
  }
  if (a.capability != null && !CAPABILITIES.includes(/** @type {Capability} */ (a.capability))) {
    fail(ERROR_CODES.SCHEMA_ERROR, `invalid capability: ${String(a.capability)}`)
  }

  const needsUrl = a.kind !== 'sdist-build' || a.url != null
  if (needsUrl && a.kind !== 'sdist-build') {
    if (typeof a.url !== 'string' || a.url.length === 0) {
      fail(ERROR_CODES.SCHEMA_ERROR, 'missing url')
    }
  }

  if (typeof a.size !== 'number' || !Number.isInteger(a.size) || a.size < 0) {
    fail(ERROR_CODES.BAD_SIZE, `invalid size: ${String(a.size)}`)
  }

  const hash = a.sha256
  if (hash == null || hash === '' || hash === 'missing') {
    fail(ERROR_CODES.MISSING_HASH, 'missing sha256')
  } else if (typeof hash !== 'string' || !SHA256_RE.test(hash)) {
    fail(ERROR_CODES.MISSING_HASH, 'sha256 must be lowercase 64-char hex')
  } else if (hash !== hash.toLowerCase()) {
    fail(ERROR_CODES.MISSING_HASH, 'sha256 must be lowercase')
  }

  if (a.kind === 'archive') {
    const archive = a.archive
    if (archive == null || typeof archive !== 'object' || Array.isArray(archive)) {
      fail(ERROR_CODES.SCHEMA_ERROR, 'archive metadata required')
    } else {
      const ar = /** @type {Record<string, unknown>} */ (archive)
      if (!ARCHIVE_FORMATS.includes(/** @type {string} */ (ar.format))) {
        fail(ERROR_CODES.SCHEMA_ERROR, `invalid archive format: ${String(ar.format)}`)
      }
      if (!Array.isArray(ar.files) || ar.files.length === 0) {
        fail(ERROR_CODES.SCHEMA_ERROR, 'archive files allowlist required')
      } else {
        for (const file of ar.files) {
          errors.push(...validateArchiveMember(file, id))
        }
      }
    }
  }

  if (a.kind === 'sdist-build' && a.userPcBuild === true) {
    fail(ERROR_CODES.SCHEMA_ERROR, 'user PC must not build sdists')
  }

  return errors
}

/**
 * @param {unknown} file
 * @param {string} artifactId
 * @returns {LockError[]}
 */
export function validateArchiveMember(file, artifactId) {
  /** @type {LockError[]} */
  const errors = []
  if (file == null || typeof file !== 'object') {
    errors.push(
      new LockError(ERROR_CODES.SCHEMA_ERROR, 'archive member must be an object', {
        id: artifactId
      })
    )
    return errors
  }
  const f = /** @type {Record<string, unknown>} */ (file)
  const path = typeof f.path === 'string' ? f.path : ''
  if (!path || path.includes('\\')) {
    errors.push(
      new LockError(ERROR_CODES.SCHEMA_ERROR, 'archive member path must use / separators', {
        id: artifactId,
        path
      })
    )
  }
  if (typeof f.size !== 'number' || !Number.isInteger(f.size) || f.size < 0) {
    errors.push(
      new LockError(ERROR_CODES.BAD_SIZE, `invalid member size for ${path}`, {
        id: artifactId,
        path
      })
    )
  }
  if (typeof f.sha256 !== 'string' || !SHA256_RE.test(f.sha256)) {
    errors.push(
      new LockError(ERROR_CODES.MISSING_HASH, `missing member sha256 for ${path}`, {
        id: artifactId,
        path
      })
    )
  }
  return errors
}

/**
 * @param {unknown} lock
 * @returns {LockError[]}
 */
export function validateLockShape(lock) {
  /** @type {LockError[]} */
  const errors = []
  if (lock == null || typeof lock !== 'object' || Array.isArray(lock)) {
    return [new LockError(ERROR_CODES.SCHEMA_ERROR, 'lock must be an object')]
  }
  const l = /** @type {Record<string, unknown>} */ (lock)
  if (l.schemaVersion !== SCHEMA_VERSION) {
    errors.push(
      new LockError(
        ERROR_CODES.SCHEMA_ERROR,
        `unsupported schemaVersion: ${String(l.schemaVersion)}`
      )
    )
  }
  if (!LOCK_KINDS.includes(/** @type {LockKind} */ (l.kind))) {
    errors.push(new LockError(ERROR_CODES.SCHEMA_ERROR, `invalid lock kind: ${String(l.kind)}`))
  }
  if (l.platform !== SUPPORTED_PLATFORM) {
    errors.push(
      new LockError(ERROR_CODES.BAD_PLATFORM, `unsupported lock platform: ${String(l.platform)}`)
    )
  }
  if (!Array.isArray(l.artifacts)) {
    errors.push(new LockError(ERROR_CODES.SCHEMA_ERROR, 'artifacts must be an array'))
    return errors
  }

  const dests = new Map()
  const ids = new Set()
  for (const artifact of l.artifacts) {
    const shapeErrors = validateArtifactShape(artifact)
    errors.push(...shapeErrors)
    if (artifact == null || typeof artifact !== 'object') continue
    const a = /** @type {Artifact} */ (artifact)
    if (ids.has(a.id)) {
      errors.push(
        new LockError(ERROR_CODES.SCHEMA_ERROR, `duplicate artifact id: ${a.id}`, { id: a.id })
      )
    }
    ids.add(a.id)
    const destsToCheck = [a.dest]
    if (a.archive?.files) {
      for (const file of a.archive.files) {
        if (file.dest) destsToCheck.push(file.dest)
      }
    }
    for (const dest of destsToCheck) {
      if (!dest) continue
      const key = dest.replaceAll('\\', '/').toLowerCase()
      const prev = dests.get(key)
      if (prev && prev !== a.id) {
        errors.push(
          new LockError(
            ERROR_CODES.DUPLICATE_DEST,
            `conflicting dest ${dest} (${prev} vs ${a.id})`,
            {
              id: a.id,
              path: dest
            }
          )
        )
      } else {
        dests.set(key, a.id)
      }
    }
  }

  if (
    l.kind === 'wheels' &&
    (typeof l.uvLockDigest !== 'string' || !l.uvLockDigest.startsWith('sha256:'))
  ) {
    errors.push(
      new LockError(ERROR_CODES.SCHEMA_ERROR, 'wheels.lock requires uvLockDigest sha256:...')
    )
  }
  if (l.kind === 'python' && (l.python == null || typeof l.python !== 'object')) {
    errors.push(new LockError(ERROR_CODES.SCHEMA_ERROR, 'python.lock requires python metadata'))
  }
  if (l.kind === 'models' && !Array.isArray(l.models)) {
    errors.push(new LockError(ERROR_CODES.SCHEMA_ERROR, 'models.lock requires models bindings'))
  }

  return errors
}

/**
 * @param {LockError[]} errors
 * @returns {string}
 */
export function formatErrors(errors) {
  return errors
    .map((err) => {
      const id = err.id ? `${err.id}: ` : ''
      return `${err.code} ${id}${err.message}`
    })
    .join('\n')
}
