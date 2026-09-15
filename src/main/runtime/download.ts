import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { createHash, randomBytes } from 'crypto'
import { dirname, join, posix as posixPath } from 'path'
import { ERROR_CODES, LockError, type Artifact } from './schema'
import { assertAllowedUrl, redactUrl } from './hosts'
import { extractZipVerified, type ArchiveAllowSpec } from './zip'
import { extractTarGzVerified } from './tar'
import { withProcessLock } from './lockfile'
import { posixDest, resolveInside } from './paths'

interface Waiter {
  signal?: AbortSignal
}

interface Flight {
  controller: AbortController
  waiters: Set<Waiter>
  promise: Promise<string>
}

const inflight = new Map<string, Flight>()

export function runtimeCacheRoot(userDataDir: string): string {
  return join(userDataDir, 'runtime-cache')
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
  const dir = join(cacheRoot, 'sha256', digest)
  return {
    dir,
    blob: join(dir, 'blob'),
    complete: join(dir, 'complete'),
    lock: join(cacheRoot, 'locks', `${digest}.lock`),
    tmpDir: join(cacheRoot, 'tmp')
  }
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

export function hashFile(path: string): string {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(1024 * 1024)
    let n = 0
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n))
    }
    return hash.digest('hex')
  } finally {
    closeSync(fd)
  }
}

function writeFileAtomic(dest: string, data: Buffer): void {
  ensureDir(dirname(dest))
  const tmp = `${dest}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, data)
  try {
    renameSync(tmp, dest)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // ignore
    }
    if (existsSync(dest)) {
      throw new LockError(
        ERROR_CODES.SCHEMA_ERROR,
        `rename failed; kept existing complete file: ${dest}`
      )
    }
    throw err
  }
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
}

export async function ensureArtifact(opts: EnsureArtifactOptions): Promise<{
  reused: boolean
  destPath: string
  downloaded: boolean
}> {
  const artifact = opts.artifact
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
  if (!opts.force && existsSync(destPath) && destMatches(artifact, destPath)) {
    return { reused: true, destPath, downloaded: false }
  }

  const blob = await downloadVerified({
    artifact,
    cacheRoot,
    fetchImpl,
    force: opts.force,
    signal: opts.signal,
    maxRedownload
  })

  if (artifact.kind === 'archive') {
    const extractDir = join(
      cacheRoot,
      'tmp',
      `extract-${artifact.sha256}-${randomBytes(4).toString('hex')}`
    )
    ensureDir(extractDir)
    try {
      publishArchive(artifact, blob, opts.destRoot)
    } finally {
      rmSync(extractDir, { recursive: true, force: true })
    }
  } else {
    try {
      writeFileAtomic(destPath, readFileSync(blob))
    } catch (err) {
      if (existsSync(destPath) && destMatches(artifact, destPath)) {
        throw new LockError(
          ERROR_CODES.SCHEMA_ERROR,
          `windows lock/rename failed; kept existing complete file (${artifact.id})`,
          { id: artifact.id }
        )
      }
      throw err
    }
  }
  return { reused: false, destPath, downloaded: true }
}

function destMatches(artifact: Artifact, destPath: string): boolean {
  if (artifact.kind === 'archive') {
    const primary =
      artifact.archive?.files?.find(
        (f) =>
          (f.dest ?? posixDest(posixPath.join(posixPath.dirname(artifact.dest), f.path))) ===
          artifact.dest
      ) ?? artifact.archive?.files?.[0]
    if (!primary) return false
    if (statSync(destPath).size !== primary.size) return false
    return hashFile(destPath) === primary.sha256
  }
  if (statSync(destPath).size !== artifact.size) return false
  return hashFile(destPath) === artifact.sha256
}

function publishArchive(artifact: Artifact, blobPath: string, destRoot: string): void {
  if (!artifact.archive) {
    throw new LockError(ERROR_CODES.SCHEMA_ERROR, 'archive metadata required', { id: artifact.id })
  }
  const allowlist = new Map<string, ArchiveAllowSpec>()
  for (const file of artifact.archive.files) {
    allowlist.set(file.path, {
      sha256: file.sha256,
      size: file.size,
      executable: file.executable,
      dest: file.dest ?? file.path
    })
  }
  const writeFile = (absPath: string, data: Buffer): void => {
    writeFileAtomic(absPath, data)
  }
  const bytes = readFileSync(blobPath)
  const extractOpts = { targetDir: destRoot, allowlist, id: artifact.id, writeFile }
  if (artifact.archive.format === 'zip') extractZipVerified(bytes, extractOpts)
  else extractTarGzVerified(bytes, extractOpts)
}

export interface DownloadVerifiedOptions {
  artifact: Artifact
  cacheRoot: string
  fetchImpl: typeof fetch
  signal?: AbortSignal
  force?: boolean
  maxRedownload?: number
}

/** digest 단위 in-process single-flight + 프로세스 간 lock. 취소는 waiter 단위. */
export async function downloadVerified(opts: DownloadVerifiedOptions): Promise<string> {
  const { artifact, cacheRoot, fetchImpl, signal, force } = opts
  const digest = artifact.sha256
  const paths = cachePaths(cacheRoot, digest)

  if (!force && existsSync(paths.complete) && existsSync(paths.blob)) {
    const actual = hashFile(paths.blob)
    if (actual === digest && statSync(paths.blob).size === artifact.size) {
      return paths.blob
    }
    rmSync(paths.dir, { recursive: true, force: true })
  }

  let flight = inflight.get(digest)
  if (!flight) {
    flight = createFlight(artifact, cacheRoot, fetchImpl, opts.maxRedownload ?? 1)
    inflight.set(digest, flight)
  }
  const waiter: Waiter = { signal }
  flight.waiters.add(waiter)
  const onAbort = (): void => {
    flight!.waiters.delete(waiter)
    if (flight!.waiters.size === 0) flight!.controller.abort()
  }
  if (signal) {
    if (signal.aborted) {
      onAbort()
      throw abortError(artifact.id)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const blob = await flight.promise
    if (signal?.aborted) throw abortError(artifact.id)
    return blob
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
    flight.waiters.delete(waiter)
    if (flight.waiters.size === 0 && inflight.get(digest) === flight) inflight.delete(digest)
  }
}

function abortError(id: string): Error {
  const err = new Error(`download cancelled (${id})`) as Error & { code: string }
  err.name = 'AbortError'
  err.code = 'ABORT_ERR'
  return err
}

function createFlight(
  artifact: Artifact,
  cacheRoot: string,
  fetchImpl: typeof fetch,
  maxRedownload: number
): Flight {
  const controller = new AbortController()
  const waiters = new Set<Waiter>()
  const promise = withProcessLock(cachePaths(cacheRoot, artifact.sha256).lock, async () => {
    const paths = cachePaths(cacheRoot, artifact.sha256)
    if (existsSync(paths.complete) && existsSync(paths.blob)) {
      if (hashFile(paths.blob) === artifact.sha256 && statSync(paths.blob).size === artifact.size) {
        return paths.blob
      }
    }
    let attempt = 0
    let lastErr: unknown
    while (attempt <= maxRedownload) {
      try {
        return await downloadOnce(artifact, cacheRoot, fetchImpl, controller.signal)
      } catch (err) {
        lastErr = err
        const name = (err as Error).name
        const code = (err as { code?: string }).code
        if (name === 'AbortError' || code === 'ABORT_ERR') throw err
        if (code !== ERROR_CODES.HASH_MISMATCH && code !== ERROR_CODES.SIZE_MISMATCH) {
          throw err
        }
        attempt += 1
        if (attempt > maxRedownload) throw err
      }
    }
    throw lastErr
  })
  void promise.catch(() => {})
  return { controller, waiters, promise }
}

function writeChunk(stream: NodeJS.WritableStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      stream.off('drain', onDrain)
      reject(err)
    }
    const onDrain = (): void => {
      stream.off('error', onError)
      resolve()
    }
    stream.once('error', onError)
    const ok = stream.write(chunk)
    if (ok) {
      stream.off('error', onError)
      resolve()
    } else {
      stream.once('drain', onDrain)
    }
  })
}

async function downloadOnce(
  artifact: Artifact,
  cacheRoot: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal
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
    const response = await fetchImpl(artifact.url, { signal, redirect: 'follow' })
    if (!response.ok) {
      throw new LockError(
        ERROR_CODES.SCHEMA_ERROR,
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
    try {
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          if (received > artifact.size) {
            await reader.cancel()
            throw new LockError(ERROR_CODES.SIZE_MISMATCH, 'download exceeded lock size', {
              id: artifact.id
            })
          }
          hash.update(value)
          await writeChunk(fh, value)
        }
      } else {
        const buf = Buffer.from(await response.arrayBuffer())
        received = buf.length
        if (received > artifact.size) {
          throw new LockError(ERROR_CODES.SIZE_MISMATCH, 'download exceeded lock size', {
            id: artifact.id
          })
        }
        hash.update(buf)
        await writeChunk(fh, buf)
      }
      await new Promise<void>((resolve, reject) => {
        fh.end((err: Error | null | undefined) => (err ? reject(err) : resolve()))
      })
    } catch (err) {
      fh.destroy()
      throw err
    }
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
      if (existsSync(paths.blob) && hashFile(paths.blob) === artifact.sha256) {
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

/** 테스트에서 inflight 상태를 비운다. */
export function resetInflightForTests(): void {
  inflight.clear()
}

export function verifyExistingFile(
  path: string,
  expected: { sha256: string; size: number; id?: string }
): void {
  if (!existsSync(path)) {
    throw new LockError(ERROR_CODES.SCHEMA_ERROR, `missing verified file: ${path}`, {
      id: expected.id,
      path
    })
  }
  const size = statSync(path).size
  if (size !== expected.size) {
    throw new LockError(
      ERROR_CODES.SIZE_MISMATCH,
      `size mismatch for ${path}: ${size} != ${expected.size}`,
      { id: expected.id, path }
    )
  }
  const actual = hashFile(path)
  if (actual !== expected.sha256) {
    throw new LockError(ERROR_CODES.HASH_MISMATCH, `sha256 mismatch for ${path}`, {
      id: expected.id,
      path
    })
  }
}
