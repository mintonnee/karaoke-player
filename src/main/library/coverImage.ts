import { copyFile, readFile, stat } from 'fs/promises'
import { extname, join } from 'path'
import { COVER_FILE_NAME, isAllowedCoverExt, MAX_COVER_BYTES } from '../../shared/trackEdit'

export type CoverImageInspection = { ok: true } | { ok: false; message: string }

/** 일반 파일·확장자·크기·매직 바이트/헤더 파싱. electron 없이 테스트한다 */
export async function inspectCoverImage(filePath: string): Promise<CoverImageInspection> {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return { ok: false, message: '커버 파일을 찾을 수 없습니다' }
  }
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(filePath)
  } catch {
    return { ok: false, message: '커버 파일을 찾을 수 없습니다' }
  }
  if (!info.isFile()) return { ok: false, message: '커버가 일반 파일이 아닙니다' }
  if (!isAllowedCoverExt(extname(filePath))) {
    return { ok: false, message: '커버는 JPG/PNG/WebP만 사용할 수 있습니다' }
  }
  if (info.size <= 0) return { ok: false, message: '커버 이미지를 읽을 수 없습니다' }
  if (info.size > MAX_COVER_BYTES) return { ok: false, message: '커버 파일이 너무 큽니다' }

  let bytes: Buffer
  try {
    bytes = await readFile(filePath)
  } catch {
    return { ok: false, message: '커버 파일을 찾을 수 없습니다' }
  }
  if (bytes.byteLength > MAX_COVER_BYTES) {
    return { ok: false, message: '커버 파일이 너무 큽니다' }
  }
  if (!isDecodableCoverBytes(bytes)) {
    return { ok: false, message: '커버 이미지를 읽을 수 없습니다' }
  }
  return { ok: true }
}

export async function installUserCover(trackDir: string, imagePath: string): Promise<void> {
  const inspected = await inspectCoverImage(imagePath)
  if (!inspected.ok) throw new Error(inspected.message)
  await copyFile(imagePath, join(trackDir, COVER_FILE_NAME))
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** JPEG/PNG/WebP 시그니처와 양수 크기의 이미지 헤더가 있는지 본다 */
export function isDecodableCoverBytes(bytes: Buffer): boolean {
  return isPng(bytes) || isJpeg(bytes) || isWebp(bytes)
}

function isPng(buf: Buffer): boolean {
  if (buf.length < 33) return false
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return false
  if (buf.readUInt32BE(8) !== 13) return false
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return false
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width === 0 || height === 0) return false
  let offset = 8
  let hasIdat = false
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    if (length > buf.length) return false
    const next = offset + 12 + length
    if (next > buf.length) return false
    if (type === 'IDAT') hasIdat = true
    if (type === 'IEND') return hasIdat
    offset = next
  }
  return hasIdat
}

function isJpeg(buf: Buffer): boolean {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return false
  let i = 2
  while (i < buf.length) {
    if (buf[i] !== 0xff) return false
    while (i < buf.length && buf[i] === 0xff) i += 1
    if (i >= buf.length) return false
    const marker = buf[i]
    i += 1
    if (marker === 0xd9) return false
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (i + 2 > buf.length) return false
    const length = buf.readUInt16BE(i)
    if (length < 2) return false
    const sof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (sof) {
      if (length < 7 || i + 7 > buf.length) return false
      const height = buf.readUInt16BE(i + 3)
      const width = buf.readUInt16BE(i + 5)
      return width > 0 && height > 0
    }
    i += length
  }
  return false
}

function isWebp(buf: Buffer): boolean {
  if (buf.length < 16) return false
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return false
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return false
  const fourcc = buf.toString('ascii', 12, 16)
  if (fourcc === 'VP8 ') {
    if (buf.length < 30) return false
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return false
    const width = buf.readUInt16LE(26) & 0x3fff
    const height = buf.readUInt16LE(28) & 0x3fff
    return width > 0 && height > 0
  }
  if (fourcc === 'VP8L') {
    if (buf.length < 25) return false
    if (buf[20] !== 0x2f) return false
    const bits = buf.readUInt32LE(21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >> 14) & 0x3fff) + 1
    return width > 0 && height > 0
  }
  if (fourcc === 'VP8X') {
    if (buf.length < 30) return false
    const width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1
    const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1
    return width > 0 && height > 0
  }
  return false
}
