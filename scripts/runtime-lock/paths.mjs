import { isAbsolute, resolve, sep } from 'node:path'
import { ERROR_CODES, LockError } from './schema.mjs'

const DRIVE_RE = /^[a-zA-Z]:/
const EXECUTABLE_EXT = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.msi',
  '.ps1',
  '.scr',
  '.msix',
  '.appx'
])

/**
 * @param {string} relPath
 * @returns {string}
 */
export function toPosix(relPath) {
  return relPath.replaceAll('\\', '/')
}

export const posixDest = toPosix

/**
 * ZIP/tar 멤버 경로. 절대·..·드라이브·UNC를 거부한다.
 * @param {string} raw
 * @param {{ id?: string }} [details]
 * @returns {string}
 */
export function assertSafeArchivePath(raw, details = {}) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new LockError(ERROR_CODES.PATH_ESCAPE, 'empty archive path', details)
  }
  if (raw.includes('\0')) {
    throw new LockError(ERROR_CODES.PATH_ESCAPE, 'nul in archive path', details)
  }
  const posix = toPosix(raw)
  if (posix.startsWith('/') || posix.startsWith('//')) {
    throw new LockError(ERROR_CODES.PATH_ESCAPE, `absolute archive path: ${posix}`, {
      ...details,
      path: posix
    })
  }
  if (DRIVE_RE.test(posix) || posix.startsWith('\\\\') || posix.includes('://')) {
    throw new LockError(ERROR_CODES.PATH_ESCAPE, `drive/UNC archive path: ${posix}`, {
      ...details,
      path: posix
    })
  }
  const parts = posix.split('/')
  if (parts.some((part) => part === '..')) {
    throw new LockError(ERROR_CODES.PATH_ESCAPE, `path escape: ${posix}`, {
      ...details,
      path: posix
    })
  }
  return posix.replace(/^\.\//, '')
}

/**
 * @param {string} targetDir
 * @param {string} relPath
 * @param {{ id?: string }} [details]
 */
export function resolveInside(targetDir, relPath, details = {}) {
  const safeRel = assertSafeArchivePath(relPath, details)
  const root = resolve(targetDir)
  const resolved = resolve(root, safeRel.split('/').join(sep))
  const prefix = root.endsWith(sep) ? root : root + sep
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new LockError(ERROR_CODES.PATH_ESCAPE, `resolved path escaped target: ${relPath}`, {
      ...details,
      path: relPath
    })
  }
  if (isAbsolute(relPath) || DRIVE_RE.test(relPath)) {
    throw new LockError(ERROR_CODES.PATH_ESCAPE, `absolute dest: ${relPath}`, details)
  }
  return resolved
}

/**
 * @param {string} name
 */
export function isWindowsExecutableName(name) {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return EXECUTABLE_EXT.has(lower.slice(dot))
}

/**
 * @param {Iterable<string>} names
 * @param {{ id?: string }} [details]
 */
export function assertNoCaseCollisions(names, details = {}) {
  const seen = new Map()
  for (const name of names) {
    const key = toPosix(name).toLowerCase()
    const prev = seen.get(key)
    if (prev && prev !== name) {
      throw new LockError(
        ERROR_CODES.CASE_COLLISION,
        `windows case collision: ${prev} vs ${name}`,
        { ...details, path: name }
      )
    }
    seen.set(key, name)
  }
}

/**
 * Unix mode의 심볼릭 링크 / 실행 비트.
 * @param {number | null | undefined} unixMode
 */
export function unixFileKind(unixMode) {
  if (unixMode == null) return { symlink: false, executable: false }
  const type = unixMode & 0o170000
  return {
    symlink: type === 0o120000,
    executable: (unixMode & 0o111) !== 0 && type !== 0o040000
  }
}
