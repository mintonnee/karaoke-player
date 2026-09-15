import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { ERROR_CODES, LockError, sha256Hex } from './schema.mjs'
import {
  assertNoCaseCollisions,
  assertSafeArchivePath,
  isWindowsExecutableName,
  resolveInside,
  unixFileKind
} from './paths.mjs'

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const ZIP64_EOCD_LOCATOR = 0x07064b50

/**
 * @typedef {object} ZipEntry
 * @property {string} name
 * @property {Buffer} data
 * @property {number} [unixMode]
 * @property {boolean} [symlink]
 * @property {'store' | 'deflate'} [method]
 */

function readU16(buf, offset) {
  return buf.readUInt16LE(offset)
}

function readU32(buf, offset) {
  return buf.readUInt32LE(offset)
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= min; i--) {
    if (readU32(buf, i) === EOCD_SIG) return i
  }
  throw new LockError(ERROR_CODES.SCHEMA_ERROR, 'zip: EOCD not found')
}

/**
 * @param {Buffer} buf
 */
export function listZipEntries(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf)
  const eocd = findEocd(buf)
  if (readU32(buf, eocd - 20) === ZIP64_EOCD_LOCATOR) {
    throw new LockError(ERROR_CODES.SCHEMA_ERROR, 'zip64 is not supported in this slice')
  }
  const cdOffset = readU32(buf, eocd + 16)
  const cdSize = readU32(buf, eocd + 12)
  const cdEnd = cdOffset + cdSize
  /** @type {Array<{ name: string, method: number, compSize: number, uncompSize: number, localOffset: number, unixMode: number | null, symlink: boolean, executable: boolean, versionMadeBy: number }>} */
  const entries = []
  let offset = cdOffset
  while (offset < cdEnd) {
    if (readU32(buf, offset) !== CENTRAL_SIG) {
      throw new LockError(ERROR_CODES.SCHEMA_ERROR, 'zip: broken central directory')
    }
    const versionMadeBy = readU16(buf, offset + 4)
    const flags = readU16(buf, offset + 8)
    const method = readU16(buf, offset + 10)
    const compSize = readU32(buf, offset + 20)
    const uncompSize = readU32(buf, offset + 24)
    const nameLen = readU16(buf, offset + 28)
    const extraLen = readU16(buf, offset + 30)
    const commentLen = readU16(buf, offset + 32)
    const external = readU32(buf, offset + 38)
    const localOffset = readU32(buf, offset + 42)
    const nameBuf = buf.subarray(offset + 46, offset + 46 + nameLen)
    const utf8 = (flags & 0x800) !== 0 || versionMadeBy >> 8 === 3
    const name = utf8 ? nameBuf.toString('utf8') : nameBuf.toString('binary')
    const host = versionMadeBy >> 8
    let unixMode = null
    if (host === 3) unixMode = (external >>> 16) & 0xffff
    const kind = unixFileKind(unixMode)
    const attrSymlink = (external & 0x400) !== 0 && host === 0
    entries.push({
      name,
      method,
      compSize,
      uncompSize,
      localOffset,
      unixMode,
      symlink: kind.symlink || attrSymlink,
      executable: kind.executable || isWindowsExecutableName(name),
      versionMadeBy
    })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return { entries, buf }
}

/**
 * @param {Buffer} buf
 * @param {{ name: string, method: number, compSize: number, uncompSize: number, localOffset: number }} entry
 */
export function readZipFileData(buf, entry) {
  const off = entry.localOffset
  if (readU32(buf, off) !== LOCAL_SIG) {
    throw new LockError(ERROR_CODES.SCHEMA_ERROR, `zip: bad local header for ${entry.name}`)
  }
  const flags = readU16(buf, off + 6)
  const method = readU16(buf, off + 8)
  const nameLen = readU16(buf, off + 26)
  const extraLen = readU16(buf, off + 28)
  let dataStart = off + 30 + nameLen + extraLen
  let compSize = entry.compSize
  let uncompSize = entry.uncompSize
  if (flags & 0x8) {
    compSize = entry.compSize
    uncompSize = entry.uncompSize
  }
  const compressed = buf.subarray(dataStart, dataStart + compSize)
  if (method === 0) {
    if (compressed.length !== uncompSize) {
      throw new LockError(ERROR_CODES.HASH_MISMATCH, `zip stored size mismatch: ${entry.name}`)
    }
    return Buffer.from(compressed)
  }
  if (method === 8) {
    const inflated = inflateRawSync(compressed)
    if (inflated.length !== uncompSize) {
      throw new LockError(ERROR_CODES.HASH_MISMATCH, `zip deflate size mismatch: ${entry.name}`)
    }
    return inflated
  }
  throw new LockError(
    ERROR_CODES.SCHEMA_ERROR,
    `zip unsupported method ${method} for ${entry.name}`
  )
}

/**
 * @param {Buffer} zipBytes
 * @param {{
 *   targetDir: string
 *   allowlist: Map<string, { sha256: string, size: number, executable?: boolean }>
 *   id?: string
 *   writeFile: (absPath: string, data: Buffer) => void
 * }} opts
 */
export function extractZipVerified(zipBytes, opts) {
  const { entries, buf } = listZipEntries(zipBytes)
  const names = entries.map((e) => e.name).filter((n) => !n.endsWith('/'))
  assertNoCaseCollisions(names, { id: opts.id })

  const extracted = []
  const allowlistKeys = new Set([...opts.allowlist.keys()].map((k) => k.replaceAll('\\', '/')))

  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue
    const rel = assertSafeArchivePath(entry.name, { id: opts.id })
    if (entry.symlink) {
      throw new LockError(ERROR_CODES.SYMLINK_REJECTED, `symlink/reparse in archive: ${rel}`, {
        id: opts.id,
        path: rel
      })
    }
    const spec = opts.allowlist.get(rel) ?? opts.allowlist.get(rel.toLowerCase())
    const executable = entry.executable || spec?.executable
    if (!spec && executable) {
      throw new LockError(
        ERROR_CODES.UNEXPECTED_EXECUTABLE,
        `unexpected executable in archive: ${rel}`,
        { id: opts.id, path: rel }
      )
    }
    if (!spec) continue
    const data = readZipFileData(buf, entry)
    if (data.length !== spec.size) {
      throw new LockError(
        ERROR_CODES.SIZE_MISMATCH,
        `extracted size mismatch for ${rel}: ${data.length} != ${spec.size}`,
        { id: opts.id, path: rel }
      )
    }
    const digest = sha256Hex(data)
    if (digest !== spec.sha256) {
      throw new LockError(ERROR_CODES.HASH_MISMATCH, `extracted hash mismatch for ${rel}`, {
        id: opts.id,
        path: rel
      })
    }
    const abs = resolveInside(opts.targetDir, spec.dest ?? rel, { id: opts.id })
    opts.writeFile(abs, data)
    extracted.push({ path: rel, dest: spec.dest ?? rel, sha256: digest, size: data.length })
    allowlistKeys.delete(rel)
    allowlistKeys.delete(rel.toLowerCase())
  }

  if (allowlistKeys.size > 0) {
    throw new LockError(
      ERROR_CODES.SCHEMA_ERROR,
      `archive missing allowlisted files: ${[...allowlistKeys].join(', ')}`,
      { id: opts.id }
    )
  }
  return extracted
}

function crc32(buf) {
  let crc = ~0
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      const bit = crc & 1
      crc >>>= 1
      if (bit) crc ^= 0xedb88320
    }
  }
  return ~crc >>> 0
}

/**
 * 테스트용 최소 ZIP 생성기 (store 또는 deflateRaw).
 * @param {ZipEntry[]} files
 * @returns {Buffer}
 */
export function createZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data)
    const methodName = file.method ?? 'store'
    const compressed = methodName === 'deflate' ? deflateRawSync(data) : data
    const method = methodName === 'deflate' ? 8 : 0
    const crc = crc32(data)
    const unixMode = file.unixMode ?? (file.symlink ? 0o120777 : 0o100644)
    const versionMadeBy = (3 << 8) | 20
    const flags = 0x800
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const localFull = Buffer.concat([local, name, compressed])
    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(versionMadeBy, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((unixMode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    const centralFull = Buffer.concat([central, name])
    locals.push(localFull)
    centrals.push(centralFull)
    offset += localFull.length
  }
  const centralDir = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralDir, eocd])
}
