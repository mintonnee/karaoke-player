import { runFileJob } from './fileWorkerClient'
export { hashFile, verifyExistingFile, artifactDestMatches } from './fileOperations'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { createHash, randomBytes } from 'crypto'
import { join, resolve } from 'path'
import { ERROR_CODES, LockError, type Artifact } from './schema'
import { assertAllowedUrl, redactUrl } from './hosts'
import { withProcessLock } from './lockfile'
import { resolveInside } from './paths'
import { checkAbort, waitWithSignal, withDownloadSlot } from './cancellation'

interface Waiter {
  signal?: AbortSignal
  onProgress?: (received: number, total: number) => void
}

interface Flight {
  controller: AbortController
  waiters: Set<Waiter>
  promise: Promise<string>
}

const inflight = new Map<string, Flight>()

export function runtimeCacheRoot(userDataDir: string): string {
  return resolveInside(userDataDir, 'runtime-cache')
}

export function defaultCacheRoot(): string {
  return join(process.env.TEMP || process.env.TMPDIR || '.', 'karaoke-player-runtime-cache')
}

function cachePaths(
  cacheRoot: string,
  digest: string
): {
  dir: string
  blob: string
  complete: string
  lock: string
  tmpDir: string
} {
  const dir = resolveInside(cacheRoot, `sha256/${digest}`)
  return {
    dir,
    blob: resolveInside(cacheRoot, `sha256/${digest}/blob`),
    complete: resolveInside(cacheRoot, `sha256/${digest}/complete`),
    lock: resolveInside(cacheRoot, `locks/${digest}.lock`),
    tmpDir: resolveInside(cacheRoot, 'tmp')
  }
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

export interface EnsureArtifactOptions {
  artifact: Artifact
  destRoot: string
  cacheRoot?: string
  force?: boolean
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  maxRedownload?: number
  skipHostCheck?: boolean
  onProgress?: (received: number, total: number) => void
  timeoutMs?: number
  allowedHosts?: readonly string[]
}

export async function ensureArtifact(opts: EnsureArtifactOptions): Promise<{
  reused: boolean
  destPath: string
  downloaded: boolean
}> {
  const artifact = opts.artifact
  checkAbort(opts.signal)
  const cacheRoot = opts.cacheRoot ?? defaultCacheRoot()
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const maxRedownload = opts.maxRedownload ?? 1
  if (artifact.url && !opts.skipHostCheck) {
    assertAllowedUrl(artifact.url, { id: artifact.id })
  }
  if (!artifact.sha256) {
    throw new LockError(ERROR_CODES.MISSING_HASH, 'cannot download without sha256', {
      id: artifact.id
    })
  }

  const destPath = resolveInside(opts.destRoot, artifact.dest, { id: artifact.id })
  if (
    !opts.force &&
    (await runFileJob({ kind: 'matches', artifact, destRoot: opts.destRoot }, opts.signal))
  ) {
    return { reused: true, destPath, downloaded: false }
  }

  const blob = await downloadVerified({
    artifact,
    cacheRoot,
    fetchImpl,
    force: opts.force,
    signal: opts.signal,
    maxRedownload,
    skipHostCheck: opts.skipHostCheck,
    onProgress: opts.onProgress,
    timeoutMs: opts.timeoutMs,
    allowedHosts: opts.allowedHosts
  })
  checkAbort(opts.signal)

  await runFileJob(
    { kind: 'publish', artifact, blob, destRoot: opts.destRoot, cacheRoot },
    opts.signal
  )
  return { reused: false, destPath, downloaded: true }
}

export interface DownloadVerifiedOptions {
  artifact: Artifact
  cacheRoot: string
  fetchImpl: typeof fetch
  signal?: AbortSignal
  force?: boolean
  maxRedownload?: number
  skipHostCheck?: boolean
  onProgress?: (received: number, total: number) => void
  timeoutMs?: number
  allowedHosts?: readonly string[]
}

/** digest 단위 in-process single-flight + 프로세스 간 lock. 취소는 waiter 단위. */
export async function downloadVerified(opts: DownloadVerifiedOptions): Promise<string> {
  const { artifact, cacheRoot, signal } = opts
  checkAbort(signal)
  if (artifact.url && !opts.skipHostCheck) assertAllowedUrl(artifact.url, { id: artifact.id })
  const key = resolve(cacheRoot) + ':' + artifact.sha256
  let flight = inflight.get(key)
  if (flight?.controller.signal.aborted) flight = undefined
  if (!flight) {
    flight = createFlight(opts)
    inflight.set(key, flight)
    const ownFlight = flight
    void flight.promise
      .finally(() => {
        if (inflight.get(key) === ownFlight) inflight.delete(key)
      })
      .catch(() => {})
  }
  const waiter: Waiter = { signal, onProgress: opts.onProgress }
  flight.waiters.add(waiter)
  const onAbort = (): void => {
    flight!.waiters.delete(waiter)
    if (flight!.waiters.size === 0) flight!.controller.abort()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const blob = await waitWithSignal(flight.promise, signal)
    checkAbort(signal)
    await runFileJob({ kind: 'verify', path: blob, expected: artifact }, signal)
    return blob
  } finally {
    signal?.removeEventListener('abort', onAbort)
    flight.waiters.delete(waiter)
    if (flight.waiters.size === 0) flight.controller.abort()
  }
}

function createFlight(opts: DownloadVerifiedOptions): Flight {
  const { artifact, cacheRoot, fetchImpl } = opts
  const controller = new AbortController()
  const waiters = new Set<Waiter>()
  const onProgress = (received: number, total: number): void => {
    for (const waiter of waiters) {
      try {
        waiter.onProgress?.(received, total)
      } catch {
        /* observers cannot fail a transfer */
      }
    }
  }
  const promise = withProcessLock(
    cachePaths(cacheRoot, artifact.sha256).lock,
    async () => {
      const paths = cachePaths(cacheRoot, artifact.sha256)
      if (
        existsSync(paths.complete) &&
        existsSync(paths.blob) &&
        (await runFileJob({ kind: 'hash', path: paths.blob }, controller.signal)) ===
          artifact.sha256 &&
        statSync(paths.blob).size === artifact.size
      ) {
        return paths.blob
      }
      // Removal is safe only while holding the digest's process lock.
      rmSync(paths.dir, { recursive: true, force: true })
      return withDownloadSlot(controller.signal, async () => {
        const timed = new AbortController()
        const abort = (): void => timed.abort()
        controller.signal.addEventListener('abort', abort, { once: true })
        const timer = setTimeout(abort, opts.timeoutMs ?? 120_000)
        try {
          checkAbort(controller.signal)
          for (let attempt = 0; ; attempt++) {
            try {
              return await downloadOnce(
                artifact,
                cacheRoot,
                fetchImpl,
                timed.signal,
                opts.skipHostCheck,
                onProgress,
                opts.allowedHosts
              )
            } catch (err) {
              if (timed.signal.aborted && !controller.signal.aborted) {
                throw Object.assign(new Error('download timed out (' + artifact.id + ')'), {
                  code: 'ETIMEDOUT'
                })
              }
              checkAbort(controller.signal)
              const code = (err as { code?: string }).code
              if (
                attempt >= (opts.maxRedownload ?? 1) ||
                (code !== ERROR_CODES.HASH_MISMATCH && code !== ERROR_CODES.SIZE_MISMATCH)
              )
                throw err
            }
          }
        } finally {
          clearTimeout(timer)
          controller.signal.removeEventListener('abort', abort)
        }
      })
    },
    { signal: controller.signal, timeoutMs: opts.timeoutMs }
  )
  void promise.catch(() => {})
  return { controller, waiters, promise }
}

function writeChunk(stream: NodeJS.WritableStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error?: Error | null) => (error ? reject(error) : resolve()))
  })
}

async function downloadOnce(
  artifact: Artifact,
  cacheRoot: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  skipHostCheck = false,
  onProgress?: (received: number, total: number) => void,
  allowedHosts?: readonly string[]
): Promise<string> {
  const paths = cachePaths(cacheRoot, artifact.sha256)
  ensureDir(paths.tmpDir)
  const tmp = join(paths.tmpDir, `${artifact.sha256}-${randomBytes(6).toString('hex')}.part`)
  const hash = createHash('sha256')
  let received = 0
  try {
    if (!artifact.url) {
      throw new LockError(ERROR_CODES.SCHEMA_ERROR, 'missing url', { id: artifact.id })
    }
    const response = await fetchRedirects(
      artifact.url,
      fetchImpl,
      signal,
      skipHostCheck,
      artifact.id,
      allowedHosts
    )
    checkAbort(signal)
    if (!response.ok) {
      throw new LockError(
        `HTTP_${response.status}`,
        `download failed ${response.status} for ${artifact.id} (${redactUrl(artifact.url)})`,
        { id: artifact.id }
      )
    }
    const declared = response.headers.get('content-length')
    if (declared != null && Number(declared) !== artifact.size) {
      throw new LockError(
        ERROR_CODES.SIZE_MISMATCH,
        `Content-Length ${declared} != lock size ${artifact.size}`,
        { id: artifact.id }
      )
    }
    const fh = createWriteStream(tmp)
    // Keep a listener installed even between writes and wait for close before deleting on Windows.
    let streamError: Error | null = null
    fh.on('error', (err) => {
      streamError = err
    })
    const closed = new Promise<void>((resolve) => fh.once('close', resolve))
    onProgress?.(0, artifact.size)
    try {
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader()
        try {
          for (;;) {
            const { done, value } = await waitWithSignal(reader.read(), signal)
            checkAbort(signal)
            if (done) break
            received += value.byteLength
            if (received > artifact.size) {
              await reader.cancel()
              throw new LockError(ERROR_CODES.SIZE_MISMATCH, 'download exceeded lock size', {
                id: artifact.id
              })
            }
            hash.update(value)
            await waitWithSignal(writeChunk(fh, value), signal)
            onProgress?.(received, artifact.size)
          }
        } finally {
          void reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      } else {
        const buf = Buffer.from(await waitWithSignal(response.arrayBuffer(), signal))
        checkAbort(signal)
        received = buf.length
        if (received > artifact.size) {
          throw new LockError(ERROR_CODES.SIZE_MISMATCH, 'download exceeded lock size', {
            id: artifact.id
          })
        }
        hash.update(buf)
        await waitWithSignal(writeChunk(fh, buf), signal)
        onProgress?.(received, artifact.size)
      }
      await new Promise<void>((resolve, reject) => {
        fh.once('error', reject)
        fh.end((err: Error | null | undefined) => (err ? reject(err) : resolve()))
      })
      if (streamError) throw streamError
      await closed
    } catch (err) {
      fh.destroy()
      await closed
      throw err
    }
    checkAbort(signal)
    if (received !== artifact.size) {
      throw new LockError(
        ERROR_CODES.SIZE_MISMATCH,
        `downloaded ${received} bytes, lock size ${artifact.size}`,
        { id: artifact.id }
      )
    }
    const digest = hash.digest('hex')
    if (digest !== artifact.sha256) {
      throw new LockError(ERROR_CODES.HASH_MISMATCH, `sha256 mismatch for ${artifact.id}`, {
        id: artifact.id
      })
    }
    ensureDir(paths.dir)
    try {
      renameSync(tmp, paths.blob)
    } catch (err) {
      if (
        existsSync(paths.blob) &&
        (await runFileJob({ kind: 'hash', path: paths.blob }, signal)) === artifact.sha256
      ) {
        rmSync(tmp, { force: true })
      } else {
        throw err
      }
    }
    writeFileSync(paths.complete, `${artifact.sha256}\n`)
    return paths.blob
  } catch (err) {
    rmSync(tmp, { force: true })
    if (!existsSync(paths.complete)) {
      rmSync(paths.blob, { force: true })
    }
    throw err
  }
}

async function fetchRedirects(
  initialUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  skipHostCheck: boolean,
  id: string,
  allowedHosts?: readonly string[]
): Promise<Response> {
  let url = initialUrl
  for (let hops = 0; hops <= 5; hops++) {
    checkAbort(signal)
    if (!skipHostCheck) {
      const host = assertAllowedUrl(url, { id })
      if (allowedHosts && !allowedHosts.includes(host)) {
        throw new LockError(ERROR_CODES.DISALLOWED_HOST, `disallowed tool host (${id})`, { id })
      }
    }
    const response = await waitWithSignal(fetchImpl(url, { signal, redirect: 'manual' }), signal)
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || hops === 5)
      throw new LockError(ERROR_CODES.DISALLOWED_HOST, `invalid redirect (${id})`, { id })
    try {
      url = new URL(location, url).href
    } catch {
      throw new LockError(ERROR_CODES.DISALLOWED_HOST, `invalid redirect (${id})`, { id })
    }
  }
  throw new Error('unreachable redirect')
}

/** 테스트에서 inflight 상태를 비운다. */
export function resetInflightForTests(): void {
  inflight.clear()
}
