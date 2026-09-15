import { gunzipSync } from 'zlib'
import { ERROR_CODES, LockError, sha256Hex } from './schema'
import {
  assertNoCaseCollisions,
  assertSafeArchivePath,
  isWindowsExecutableName,
  resolveInside,
  unixFileKind
} from './paths'
import type { ArchiveAllowSpec } from './zip'

function parseOctal(buf: Buffer): number {
  const text = buf.toString('utf8').replace(/\0/g, '').trim()
  if (!text) return 0
  return Number.parseInt(text, 8)
}

export interface TarListEntry {
  name: string
  typeflag: string
  size: number
  mode: number
  symlink: boolean
  executable: boolean
  data: Buffer
}

export function listTarEntries(tarBytes: Buffer): TarListEntry[] {
  const entries: TarListEntry[] = []
  let offset = 0
  let pendingLongName: string | null = null
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const typeflag = String.fromCharCode(header[156] || 48)
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0/g, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0/g, '')
    const size = parseOctal(header.subarray(124, 136))
    const mode = parseOctal(header.subarray(100, 108))
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    const padded = Math.ceil(size / 512) * 512
    if (typeflag === 'L') {
      pendingLongName = tarBytes.subarray(dataStart, dataEnd).toString('utf8').replace(/\0/g, '')
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

export function decodeArchiveBytes(archiveBytes: Buffer, format: 'zip' | 'tar.gz'): Buffer {
  if (format === 'tar.gz') return gunzipSync(archiveBytes)
  return archiveBytes
}

export function extractTarGzVerified(
  tarGzBytes: Buffer | Uint8Array,
  opts: {
    targetDir: string
    allowlist: Map<string, ArchiveAllowSpec>
    id?: string
    writeFile: (absPath: string, data: Buffer) => void
  }
): Array<{ path: string; dest: string; sha256: string; size: number }> {
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
  const extracted: Array<{ path: string; dest: string; sha256: string; size: number }> = []
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
