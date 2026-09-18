import { existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import { join, posix } from 'path'
import { randomUUID } from 'crypto'
import {
  TOOL_IDS,
  type ToolId,
  type ToolReadinessSnapshot,
  type ToolReadinessState
} from '../../shared/runtimeTools'
import {
  ERROR_CODES,
  LockError,
  lockDigest,
  validateLockShape,
  type Artifact,
  type LockFile
} from './schema'
import { validateRuntimeManifestShape, type RuntimeManifest } from './manifest'
import {
  artifactDestMatches,
  downloadVerified,
  ensureArtifact,
  runtimeCacheRoot,
  verifyExistingFile
} from './download'
import { resolveInside } from './paths'
import { withProcessLock } from './lockfile'
import { abortError, checkAbort, waitWithSignal } from './cancellation'

export interface ToolReadinessControllerOptions {
  /** Caller must first verify the complete manifest, lock set and sidecar inputs. */
  manifest: RuntimeManifest
  toolsLock: LockFile
  userDataDir: string
  /** Electron resourcesPath (the directory containing bin/). */
  resourcesDir: string
  windowsStore?: boolean
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

interface ToolFlight {
  controller: AbortController
  promise: Promise<string>
  waiters: Set<symbol>
}

const TOOL_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com'
]

/** Tool paths never come from PATH, a previous digest, or an unverified existence check. */
export class ToolReadinessController {
  private readonly options: ToolReadinessControllerOptions
  private readonly listeners = new Set<(state: ToolReadinessState) => void>()
  private readonly flights = new Map<ToolId, ToolFlight>()
  private readonly states: Record<ToolId, ToolReadinessState>
  private disposed = false

  constructor(options: ToolReadinessControllerOptions) {
    const errors = [
      ...validateRuntimeManifestShape(options.manifest),
      ...validateLockShape(options.toolsLock)
    ]
    if (errors.length) throw errors[0]
    if (options.toolsLock.kind !== 'tools')
      throw new LockError(ERROR_CODES.SCHEMA_ERROR, 'tools lock required')
    if (lockDigest(options.toolsLock) !== options.manifest.lockDigests.tools) {
      throw new LockError(ERROR_CODES.HASH_MISMATCH, 'tools lock digest does not match manifest')
    }
    if (options.windowsStore && options.manifest.distribution !== 'appx') {
      throw new LockError(ERROR_CODES.SCHEMA_ERROR, 'Windows Store runtime requires APPX policy')
    }
    for (const id of TOOL_IDS) {
      if (!options.toolsLock.artifacts.some((a) => a.id === id)) {
        throw new LockError(ERROR_CODES.SCHEMA_ERROR, `missing tool (${id})`, { id })
      }
    }
    this.options = {
      ...options,
      manifest: structuredClone(options.manifest),
      toolsLock: structuredClone(options.toolsLock)
    }
    this.states = Object.fromEntries(
      TOOL_IDS.map((toolId) => [
        toolId,
        {
          toolId,
          status: options.manifest.toolDelivery[toolId] === 'disabled' ? 'disabled' : 'pending',
          downloadedBytes: null,
          totalBytes: null,
          error: null,
          retryable: false
        }
      ])
    ) as Record<ToolId, ToolReadinessState>
  }

  getSnapshot(): ToolReadinessSnapshot {
    return structuredClone({ tools: this.states })
  }

  onChange(listener: (state: ToolReadinessState) => void): () => void {
    if (!this.disposed) this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): Promise<PromiseSettledResult<string>[]> {
    return Promise.allSettled(TOOL_IDS.map((id) => this.ensure(id)))
  }

  retry(toolId: ToolId, options: { signal?: AbortSignal } = {}): Promise<string> {
    return this.ensure(toolId, options)
  }

  async ensure(toolId: ToolId, options: { signal?: AbortSignal } = {}): Promise<string> {
    if (this.disposed) throw abortError(toolId)
    checkAbort(options.signal)
    if (!TOOL_IDS.includes(toolId)) throw new LockError(ERROR_CODES.SCHEMA_ERROR, 'unknown tool')
    if (this.options.manifest.toolDelivery[toolId] === 'disabled') {
      throw new LockError(ERROR_CODES.SCHEMA_ERROR, `tool disabled (${toolId})`, { id: toolId })
    }
    let flight = this.flights.get(toolId)
    if (flight?.controller.signal.aborted) flight = undefined
    if (!flight) {
      const controller = new AbortController()
      const own: ToolFlight = { controller, waiters: new Set(), promise: Promise.resolve('') }
      this.flights.set(toolId, own)
      const update = (patch: Partial<ToolReadinessState>): void => {
        if (!this.disposed && this.flights.get(toolId) === own && !controller.signal.aborted)
          this.update(toolId, patch)
      }
      own.promise = Promise.resolve()
        .then(() => this.resolveTool(toolId, controller.signal, update))
        .then((path) => {
          checkAbort(controller.signal)
          update({ status: 'ready', error: null, retryable: false })
          return path
        })
        .catch((error: unknown) => {
          update({ status: 'error', error: toolError(toolId, error), retryable: true })
          throw new Error(toolError(toolId, error), { cause: error })
        })
        .finally(() => {
          if (this.flights.get(toolId) === own) this.flights.delete(toolId)
        })
      void own.promise.catch(() => {})
      flight = own
    }
    const waiter = Symbol()
    flight.waiters.add(waiter)
    const remove = (): void => {
      flight!.waiters.delete(waiter)
      if (!flight!.waiters.size) {
        flight!.controller.abort()
        if (!this.disposed && this.flights.get(toolId) === flight) {
          this.update(toolId, {
            status: 'pending',
            downloadedBytes: null,
            totalBytes: null,
            error: null,
            retryable: false
          })
        }
      }
    }
    options.signal?.addEventListener('abort', remove, { once: true })
    try {
      return await waitWithSignal(flight.promise, options.signal)
    } finally {
      options.signal?.removeEventListener('abort', remove)
      flight.waiters.delete(waiter)
    }
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    for (const flight of this.flights.values()) flight.controller.abort()
    this.flights.clear()
  }

  private update(id: ToolId, patch: Partial<ToolReadinessState>): void {
    this.states[id] = { ...this.states[id], ...patch }
    for (const listener of this.listeners) {
      try {
        listener({ ...this.states[id] })
      } catch {
        /* observer isolation */
      }
    }
  }

  private async resolveTool(
    id: ToolId,
    signal: AbortSignal,
    update: (patch: Partial<ToolReadinessState>) => void
  ): Promise<string> {
    const artifact = this.options.toolsLock.artifacts.find((a) => a.id === id)!
    update({
      status: 'verifying',
      downloadedBytes: null,
      totalBytes: artifact.size,
      error: null,
      retryable: false
    })
    if (this.options.manifest.toolDelivery[id] === 'bundled') {
      const path = resolveInside(this.options.resourcesDir, stripResources(artifact.dest))
      const expected =
        artifact.kind === 'archive'
          ? artifact.archive?.files.find(
              (f) => (f.dest ?? posix.join(posix.dirname(artifact.dest), f.path)) === artifact.dest
            )
          : artifact
      if (!expected) throw new LockError(ERROR_CODES.SCHEMA_ERROR, `missing primary member (${id})`)
      verifyExistingFile(path, expected)
      checkAbort(signal)
      return path
    }
    const root = resolveInside(this.options.userDataDir, `runtime-tools/${id}`)
    const finalDir = resolveInside(root, artifact.sha256)
    const cacheRoot = runtimeCacheRoot(this.options.userDataDir)
    const mapped = mapToolArtifact(artifact)
    return withProcessLock(
      join(root, `${artifact.sha256}.lock`),
      async () => {
        checkAbort(signal)
        // Even a valid active directory must not bypass cache verification on restart.
        await downloadVerified({
          artifact,
          cacheRoot,
          signal,
          fetchImpl: this.options.fetchImpl ?? globalThis.fetch,
          timeoutMs: this.options.timeoutMs,
          allowedHosts: TOOL_HOSTS,
          onProgress: (downloadedBytes, totalBytes) =>
            update({ status: 'downloading', downloadedBytes, totalBytes })
        })
        update({ status: 'verifying' })
        checkAbort(signal)
        if (artifactDestMatches(mapped, finalDir)) return resolveInside(finalDir, mapped.dest)
        const staging = resolveInside(root, `.staging-${artifact.sha256}-${randomUUID()}`)
        mkdirSync(staging, { recursive: true })
        try {
          await ensureArtifact({
            artifact: mapped,
            destRoot: staging,
            cacheRoot,
            signal,
            fetchImpl: this.options.fetchImpl,
            timeoutMs: this.options.timeoutMs
          })
          if (!artifactDestMatches(mapped, staging))
            throw new LockError(ERROR_CODES.HASH_MISMATCH, `tool validation failed (${id})`)
          checkAbort(signal)
          // Keep damaged/current and older versions intact; never delete an active directory.
          const quarantine = resolveInside(root, `.invalid-${artifact.sha256}-${randomUUID()}`)
          const hadPrevious = existsSync(finalDir)
          if (hadPrevious) renameSync(finalDir, quarantine)
          try {
            renameSync(staging, finalDir)
          } catch (error) {
            if (hadPrevious && !existsSync(finalDir)) renameSync(quarantine, finalDir)
            throw error
          }
          return resolveInside(finalDir, mapped.dest)
        } finally {
          rmSync(staging, { recursive: true, force: true })
        }
      },
      { signal, timeoutMs: this.options.timeoutMs }
    )
  }
}

function stripResources(dest: string): string {
  if (!dest.startsWith('resources/'))
    throw new LockError(ERROR_CODES.PATH_ESCAPE, 'tool must have a resources destination')
  return dest.slice('resources/'.length)
}

function mapToolArtifact(artifact: Artifact): Artifact {
  const map = (dest: string): string => {
    if (!dest.startsWith('resources/bin/'))
      throw new LockError(ERROR_CODES.PATH_ESCAPE, 'tool must have a bin destination')
    return dest.slice('resources/bin/'.length)
  }
  return {
    ...artifact,
    dest: map(artifact.dest),
    archive: artifact.archive
      ? {
          ...artifact.archive,
          files: artifact.archive.files.map((file) => ({
            ...file,
            dest: map(file.dest ?? posix.join(posix.dirname(artifact.dest), file.path))
          }))
        }
      : undefined
  }
}

function toolError(id: ToolId, error: unknown): string {
  const code = (error as { code?: string } | null)?.code
  // Do not expose fetch URLs, signed query strings, OS paths or arbitrary error text to IPC/logs.
  return `도구 준비 실패 (${id}): ${code && /^[A-Z_0-9]+$/.test(code) ? code : 'DOWNLOAD_FAILED'}`
}
