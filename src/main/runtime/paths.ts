import { lstatSync } from 'fs'
import { dirname, isAbsolute, resolve, sep } from 'path'
import { ERROR_CODES, LockError } from './schema'

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

export function toPosix(relPath: string): string {
  return relPath.replaceAll('\\', '/')
}

export const posixDest = toPosix

/** ZIP/tar 멤버 경로. 절대·..·드라이브·UNC를 거부한다. */
export function assertSafeArchivePath(raw: string, details: { id?: string } = {}): string {
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

export function resolveInside(
  targetDir: string,
  relPath: string,
  details: { id?: string } = {}
): string {
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
  assertNoSymlinkAlong(root, resolved, { ...details, path: relPath })
  return resolved
}

function assertNoSymlinkAlong(
  root: string,
  resolved: string,
  details: { id?: string; path?: string }
): void {
  let current = resolved
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new LockError(
          ERROR_CODES.SYMLINK_REJECTED,
          `symlink/reparse in path: ${details.path ?? current}`,
          details
        )
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (err instanceof LockError) throw err
      }
    }
    if (current === root) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

export function isWindowsExecutableName(name: string): boolean {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return EXECUTABLE_EXT.has(lower.slice(dot))
}

export function assertNoCaseCollisions(
  names: Iterable<string>,
  details: { id?: string } = {}
): void {
  const seen = new Map<string, string>()
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

export function unixFileKind(unixMode: number | null | undefined): {
  symlink: boolean
  executable: boolean
} {
  if (unixMode == null) return { symlink: false, executable: false }
  const type = unixMode & 0o170000
  return {
    symlink: type === 0o120000,
    executable: (unixMode & 0o111) !== 0 && type !== 0o040000
  }
}
