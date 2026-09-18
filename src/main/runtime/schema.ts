import { createHash } from 'crypto'
import { posix as posixPath } from 'path'
import { TOOL_IDS, isToolId, type ToolId } from '../../shared/runtimeTools'

export const SCHEMA_VERSION = 1
export const SUPPORTED_PLATFORM = 'win32-x64' as const
export const LOCK_KINDS = Object.freeze(['tools', 'python', 'models', 'wheels'] as const)
export const ARTIFACT_KINDS = Object.freeze(['file', 'archive', 'wheel', 'sdist-build'] as const)
export const ARCHIVE_FORMATS = Object.freeze(['zip', 'tar.gz'] as const)
export const CAPABILITIES = Object.freeze(['always', 'zip-url-import'] as const)
export const RUNTIME_DISTRIBUTIONS = Object.freeze(['nsis', 'zip', 'appx'] as const)
export const TOOL_DELIVERIES = Object.freeze(['bundled', 'download', 'disabled'] as const)

export { TOOL_IDS, isToolId, type ToolId }

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

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]
export type LockKind = (typeof LOCK_KINDS)[number]
export type Capability = (typeof CAPABILITIES)[number]
export type ArchiveFormat = (typeof ARCHIVE_FORMATS)[number]
export type SupportedPlatform = typeof SUPPORTED_PLATFORM
export type RuntimeDistribution = (typeof RUNTIME_DISTRIBUTIONS)[number]
export type ToolDelivery = (typeof TOOL_DELIVERIES)[number]

export interface DistributionPolicy {
  readonly capabilities: {
    readonly urlImport: boolean
  }
  readonly toolDelivery: Readonly<Record<ToolId, ToolDelivery>>
}

const DISTRIBUTION_POLICIES: Readonly<Record<RuntimeDistribution, DistributionPolicy>> =
  Object.freeze({
    nsis: Object.freeze({
      capabilities: Object.freeze({ urlImport: true }),
      toolDelivery: Object.freeze({ uv: 'download', deno: 'download', 'yt-dlp': 'download' })
    }),
    zip: Object.freeze({
      capabilities: Object.freeze({ urlImport: true }),
      toolDelivery: Object.freeze({ uv: 'bundled', deno: 'bundled', 'yt-dlp': 'bundled' })
    }),
    appx: Object.freeze({
      capabilities: Object.freeze({ urlImport: false }),
      toolDelivery: Object.freeze({ uv: 'bundled', deno: 'bundled', 'yt-dlp': 'disabled' })
    })
  })

export interface ArchiveMember {
  path: string
  size: number
  sha256: string
  executable?: boolean
  dest?: string
}

export interface Artifact {
  id: string
  kind: ArtifactKind
  version: string
  revision?: string | null
  platform: string
  url: string | null
  size: number
  sha256: string
  dest: string
  source: string
  license: string
  capability?: Capability
  archive?: { format: ArchiveFormat; files: ArchiveMember[] }
  wheelTag?: string
  userPcBuild?: boolean
  buildEnvironment?: string
  hashStatus?: string
}

export interface LoaderBinding {
  package: string
  symbol: string
  argument?: string
}

export interface ModelBinding {
  id: string
  loader: string
  loaderBinding: LoaderBinding
  revision: string
  repo?: string
  license: string
  artifactIds: string[]
  dependsOn: string[]
}

export interface LocalBuild {
  id: string
  kind: 'sdist-build'
  version: string
  sourcePath: string
  backend: string
  buildEnvironment: 'controlled'
  userPcBuild: false
}

export interface LockFile {
  schemaVersion: number
  kind: LockKind
  platform: string
  artifacts: Artifact[]
  uvLockDigest?: string
  python?: {
    requiresMajorMinor: string
    implementation: string
    patch?: string
    distributionBuild?: string
    distribution?: string
    flavor?: string
  }
  buildSystem?: unknown
  models?: ModelBinding[]
  localBuilds?: LocalBuild[]
}

export class LockError extends Error {
  readonly code: string
  readonly id: string | null
  readonly path: string | null

  constructor(code: string, message: string, details: { id?: string; path?: string } = {}) {
    super(message)
    this.name = 'LockError'
    this.code = code
    this.id = details.id ?? null
    this.path = details.path ?? null
  }

  toJSON(): { code: string; id: string | null; path: string | null; message: string } {
    return {
      code: this.code,
      id: this.id,
      path: this.path,
      message: this.message
    }
  }
}

export function isRuntimeDistribution(value: unknown): value is RuntimeDistribution {
  return typeof value === 'string' && (RUNTIME_DISTRIBUTIONS as readonly string[]).includes(value)
}

export function getDistributionPolicy(distribution: unknown): DistributionPolicy {
  if (!isRuntimeDistribution(distribution)) {
    throw new LockError(
      ERROR_CODES.SCHEMA_ERROR,
      `unsupported runtime distribution: ${String(distribution)}`,
      { id: 'distribution' }
    )
  }
  return DISTRIBUTION_POLICIES[distribution]
}

export function validateDistributionPolicy(
  distribution: unknown,
  capabilities: unknown,
  toolDelivery: unknown
): LockError[] {
  const errors: LockError[] = []
  let expected: DistributionPolicy
  try {
    expected = getDistributionPolicy(distribution)
  } catch (error) {
    return [
      error instanceof LockError
        ? error
        : new LockError(ERROR_CODES.SCHEMA_ERROR, 'invalid runtime distribution', {
            id: 'distribution'
          })
    ]
  }

  if (!hasExactKeys(capabilities, ['urlImport'])) {
    errors.push(
      new LockError(ERROR_CODES.SCHEMA_ERROR, 'capabilities must contain only urlImport', {
        id: 'capabilities'
      })
    )
  } else if (capabilities.urlImport !== expected.capabilities.urlImport) {
    errors.push(
      new LockError(
        ERROR_CODES.SCHEMA_ERROR,
        `urlImport does not match ${String(distribution)} distribution policy`,
        { id: 'capabilities.urlImport' }
      )
    )
  }

  if (!hasExactKeys(toolDelivery, TOOL_IDS)) {
    errors.push(
      new LockError(
        ERROR_CODES.SCHEMA_ERROR,
        'toolDelivery must contain exactly uv, deno, yt-dlp',
        {
          id: 'toolDelivery'
        }
      )
    )
  } else {
    for (const toolId of TOOL_IDS) {
      if (toolDelivery[toolId] !== expected.toolDelivery[toolId]) {
        errors.push(
          new LockError(
            ERROR_CODES.SCHEMA_ERROR,
            `${toolId} delivery does not match ${String(distribution)} distribution policy`,
            { id: `toolDelivery.${toolId}` }
          )
        )
      }
    }
  }

  return errors
}

function hasExactKeys<T extends string>(
  value: unknown,
  keys: readonly T[]
): value is Record<T, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

export function sha256Hex(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key]
    if (item === undefined) continue
    out[key] = canonicalize(item)
  }
  return out
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function digestCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

function canonicalizeMember(member: ArchiveMember): ArchiveMember {
  return { ...member, path: posixPath.normalize(member.path).replaceAll('\\', '/') }
}

export function canonicalizeLock(lock: LockFile): LockFile {
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
  return canonicalize(copy) as LockFile
}

export function lockDigest(lock: LockFile): string {
  return digestCanonical(canonicalizeLock(lock))
}

export function isMutableRevision(
  revision: string | null | undefined,
  opts: { requireGitSha?: boolean } = {}
): boolean {
  if (revision == null || revision === '') {
    return Boolean(opts.requireGitSha)
  }
  const value = String(revision)
  if (MUTABLE_REVISIONS.has(value.toLowerCase())) return true
  if (opts.requireGitSha) return !GIT_SHA_RE.test(value)
  return false
}

export function posixDest(relPath: string): string {
  return relPath.replaceAll('\\', '/')
}

export function normalizeDigest(value: string): string {
  return value.replace(/^sha256:/i, '').toLowerCase()
}

export function validateArtifactShape(artifact: unknown): LockError[] {
  const errors: LockError[] = []
  if (artifact == null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    errors.push(new LockError(ERROR_CODES.SCHEMA_ERROR, 'artifact must be an object'))
    return errors
  }
  const a = artifact as Record<string, unknown>
  const id = typeof a.id === 'string' ? a.id : '<unknown>'
  const fail = (code: string, message: string): void => {
    errors.push(new LockError(code, message, { id }))
  }

  if (typeof a.id !== 'string' || a.id.length === 0) {
    fail(ERROR_CODES.SCHEMA_ERROR, 'missing logical id')
  }
  if (!(ARTIFACT_KINDS as readonly string[]).includes(String(a.kind))) {
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
  if (a.capability != null && !(CAPABILITIES as readonly string[]).includes(String(a.capability))) {
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
      const ar = archive as Record<string, unknown>
      if (!(ARCHIVE_FORMATS as readonly string[]).includes(String(ar.format))) {
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

export function validateArchiveMember(file: unknown, artifactId: string): LockError[] {
  const errors: LockError[] = []
  if (file == null || typeof file !== 'object') {
    errors.push(
      new LockError(ERROR_CODES.SCHEMA_ERROR, 'archive member must be an object', {
        id: artifactId
      })
    )
    return errors
  }
  const f = file as Record<string, unknown>
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

export function validateLockShape(lock: unknown): LockError[] {
  const errors: LockError[] = []
  if (lock == null || typeof lock !== 'object' || Array.isArray(lock)) {
    return [new LockError(ERROR_CODES.SCHEMA_ERROR, 'lock must be an object')]
  }
  const l = lock as Record<string, unknown>
  if (l.schemaVersion !== SCHEMA_VERSION) {
    errors.push(
      new LockError(
        ERROR_CODES.SCHEMA_ERROR,
        `unsupported schemaVersion: ${String(l.schemaVersion)}`
      )
    )
  }
  if (!(LOCK_KINDS as readonly string[]).includes(String(l.kind))) {
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

  const dests = new Map<string, string>()
  const ids = new Set<string>()
  for (const artifact of l.artifacts) {
    const shapeErrors = validateArtifactShape(artifact)
    errors.push(...shapeErrors)
    if (artifact == null || typeof artifact !== 'object') continue
    const a = artifact as Artifact
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

export function formatErrors(errors: LockError[]): string {
  return errors
    .map((err) => {
      const id = err.id ? `${err.id}: ` : ''
      return `${err.code} ${id}${err.message}`
    })
    .join('\n')
}
