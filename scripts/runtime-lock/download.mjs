import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix as posixPath } from 'node:path'
import { randomBytes } from 'node:crypto'
import { ERROR_CODES, LockError, sha256Hex } from './schema.mjs'
import { assertAllowedUrl, redactUrl } from './hosts.mjs'
import { extractZipVerified } from './zip.mjs'
import { extractTarGzVerified } from './tar.mjs'
import { withProcessLock } from './lockfile.mjs'
import { posixDest, resolveInside } from './paths.mjs'

const inflight = new Map()

export function defaultCacheRoot() {
  return join(tmpdir(), 'karaoke-player-runtime-cache')
}

function cachePaths(cacheRoot, digest) {
  const dir = join(cacheRoot, 'sha256', digest)
  return {
    dir,
    blob: join(dir, 'blob'),
    complete: join(dir, 'complete'),
    lock: join(cacheRoot, 'locks', `${digest}.lock`),
    tmpDir: join(cacheRoot, 'tmp')
  }
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

/**
 * @param {import('node:fs').PathLike} path
 */
export function hashFile(path) {
  return sha256Hex(readFileSync(path))
}

function writeFileAtomic(dest, data) {
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

/**
 * @param {object} opts
 * @param {import('./schema.mjs').Artifact} opts.artifact
 * @param {string} opts.destRoot
 * @param {string} [opts.cacheRoot]
 * @param {boolean} [opts.force]
 * @param {AbortSignal} [opts.signal]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.maxRedownload]
 */
export async function ensureArtifact(opts) {
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
      publishArchive(artifact, blob, extractDir, opts.destRoot)
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

function destMatches(artifact, destPath) {
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

function publishArchive(artifact, blobPath, extractDir, destRoot) {
  const allowlist = new Map()
  for (const file of artifact.archive.files) {
    allowlist.set(file.path, {
      sha256: file.sha256,
      size: file.size,
      executable: file.executable,
      dest: file.dest ?? file.path
    })
  }
  const writeFile = (absPath, data) => {
    writeFileAtomic(absPath, data)
  }
  const bytes = readFileSync(blobPath)
  const extractOpts = { targetDir: destRoot, allowlist, id: artifact.id, writeFile }
  if (artifact.archive.format === 'zip') extractZipVerified(bytes, extractOpts)
  else extractTarGzVerified(bytes, extractOpts)
}

/**
 * digest 단위 in-process single-flight + 프로세스 간 lock.
 * 취소는 waiter 단위. 다운로드 abort는 waiter가 없을 때만.
 */
export async function downloadVerified(opts) {
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
  const waiter = { signal, abort: null }
  flight.waiters.add(waiter)
  const onAbort = () => {
    flight.waiters.delete(waiter)
    if (flight.waiters.size === 0) flight.controller.abort()
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

function abortError(id) {
  const err = new Error(`download cancelled (${id})`)
  err.name = 'AbortError'
  err.code = 'ABORT_ERR'
  return err
}

function createFlight(artifact, cacheRoot, fetchImpl, maxRedownload) {
  const controller = new AbortController()
  /** @type {Set<{ signal?: AbortSignal }>} */
  const waiters = new Set()
  const promise = withProcessLock(cachePaths(cacheRoot, artifact.sha256).lock, async () => {
    const paths = cachePaths(cacheRoot, artifact.sha256)
    if (existsSync(paths.complete) && existsSync(paths.blob)) {
      if (hashFile(paths.blob) === artifact.sha256 && statSync(paths.blob).size === artifact.size) {
        return paths.blob
      }
    }
    let attempt = 0
    let lastErr
    while (attempt <= maxRedownload) {
      try {
        return await downloadOnce(artifact, cacheRoot, fetchImpl, controller.signal)
      } catch (err) {
        lastErr = err
        if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') throw err
        if (err?.code !== ERROR_CODES.HASH_MISMATCH && err?.code !== ERROR_CODES.SIZE_MISMATCH) {
          throw err
        }
        attempt += 1
        if (attempt > maxRedownload) throw err
      }
    }
    throw lastErr
  })
  promise.catch(() => {})
  return { controller, waiters, promise }
}

async function downloadOnce(artifact, cacheRoot, fetchImpl, signal) {
  const paths = cachePaths(cacheRoot, artifact.sha256)
  ensureDir(paths.tmpDir)
  const tmp = join(paths.tmpDir, `${artifact.sha256}-${randomBytes(6).toString('hex')}.part`)
  try {
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
    const chunks = []
    let received = 0
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
        chunks.push(Buffer.from(value))
      }
    } else {
      const buf = Buffer.from(await response.arrayBuffer())
      received = buf.length
      chunks.push(buf)
    }
    if (received !== artifact.size) {
      throw new LockError(
        ERROR_CODES.SIZE_MISMATCH,
        `downloaded ${received} bytes, lock size ${artifact.size}`,
        { id: artifact.id }
      )
    }
    const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
    const digest = sha256Hex(buf)
    if (digest !== artifact.sha256) {
      throw new LockError(ERROR_CODES.HASH_MISMATCH, `sha256 mismatch for ${artifact.id}`, {
        id: artifact.id
      })
    }
    writeFileSync(tmp, buf)
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

/**
 * 테스트에서 inflight 상태를 비운다.
 */
export function resetInflightForTests() {
  inflight.clear()
}
