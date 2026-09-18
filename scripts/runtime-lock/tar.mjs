import { gunzipSync } from 'node:zlib'
import { ERROR_CODES, LockError, sha256Hex } from './schema.mjs'
import {
  assertNoCaseCollisions,
  assertSafeArchivePath,
  isWindowsExecutableName,
  resolveInside,
  unixFileKind
} from './paths.mjs'

function parseOctal(buf) {
  const text = buf.toString('utf8').split('\0', 1)[0].trim()
  if (!text) return 0
  return Number.parseInt(text, 8)
}

/**
 * @param {Buffer} tarBytes
 */
export function listTarEntries(tarBytes) {
  const entries = []
  let offset = 0
  let pendingLongName = null
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const typeflag = String.fromCharCode(header[156] || 48)
    const rawName = header.subarray(0, 100).toString('utf8').split('\0', 1)[0]
    const prefix = header.subarray(345, 500).toString('utf8').split('\0', 1)[0]
    const size = parseOctal(header.subarray(124, 136))
    const mode = parseOctal(header.subarray(100, 108))
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    const padded = Math.ceil(size / 512) * 512
    if (typeflag === 'L') {
      pendingLongName = tarBytes.subarray(dataStart, dataEnd).toString('utf8').split('\0', 1)[0]
      offset = dataStart + padded
      continue
    }
    const name = pendingLongName || (prefix ? `${prefix}/${rawName}` : rawName)
    pendingLongName = null
    const kind = unixFileKind(mode)
    entries.push({
      name,
      typeflag,
      size,
      mode,
      symlink: typeflag === '2' || typeflag === '1' || kind.symlink,
      executable: kind.executable || isWindowsExecutableName(name),
      data: tarBytes.subarray(dataStart, dataEnd)
    })
    offset = dataStart + padded
  }
  return entries
}

/**
 * @param {Buffer} archiveBytes
 * @param {'zip' | 'tar.gz'} format
 */
export function decodeArchiveBytes(archiveBytes, format) {
  if (format === 'tar.gz') return gunzipSync(archiveBytes)
  return archiveBytes
}

/**
 * @param {Buffer} tarGzBytes
 * @param {{
 *   targetDir: string
 *   allowlist: Map<string, { sha256: string, size: number, executable?: boolean, dest?: string }>
 *   id?: string
 *   writeFile: (absPath: string, data: Buffer) => void
 * }} opts
 */
export function extractTarGzVerified(tarGzBytes, opts) {
  const tarBytes = gunzipSync(tarGzBytes)
  const entries = listTarEntries(tarBytes)
  const fileEntries = entries.filter(
    (e) => e.typeflag === '0' || e.typeflag === '\0' || e.typeflag === ''
  )
  assertNoCaseCollisions(
    fileEntries.map((e) => e.name),
    { id: opts.id }
  )

  const remaining = new Set([...opts.allowlist.keys()].map((k) => k.replaceAll('\\', '/')))

  const extracted = []
  for (const entry of entries) {
    if (entry.typeflag === '5') continue
    const rel = assertSafeArchivePath(entry.name, { id: opts.id })
    if (entry.symlink) {
      throw new LockError(ERROR_CODES.SYMLINK_REJECTED, `symlink/reparse in archive: ${rel}`, {
        id: opts.id,
        path: rel
      })
    }
    const spec = opts.allowlist.get(rel) ?? opts.allowlist.get(rel.toLowerCase())
    if (!spec && entry.executable) {
      throw new LockError(
        ERROR_CODES.UNEXPECTED_EXECUTABLE,
        `unexpected executable in archive: ${rel}`,
        { id: opts.id, path: rel }
      )
    }
    if (!spec) continue
    if (entry.data.length !== spec.size) {
      throw new LockError(
        ERROR_CODES.SIZE_MISMATCH,
        `extracted size mismatch for ${rel}: ${entry.data.length} != ${spec.size}`,
        { id: opts.id, path: rel }
      )
    }
    const digest = sha256Hex(entry.data)
    if (digest !== spec.sha256) {
      throw new LockError(ERROR_CODES.HASH_MISMATCH, `extracted hash mismatch for ${rel}`, {
        id: opts.id,
        path: rel
      })
    }
    const destRel = spec.dest ?? rel
    const abs = resolveInside(opts.targetDir, destRel, { id: opts.id })
    opts.writeFile(abs, entry.data)
    extracted.push({ path: rel, dest: destRel, sha256: digest, size: entry.data.length })
    remaining.delete(rel)
    remaining.delete(rel.toLowerCase())
  }

  if (remaining.size > 0) {
    throw new LockError(
      ERROR_CODES.SCHEMA_ERROR,
      `archive missing allowlisted files: ${[...remaining].join(', ')}`,
      { id: opts.id }
    )
  }
  return extracted
}
