import { SCHEMA_VERSION } from './schema'

export const LIBRARY_DB_ERROR_CODES = [
  'DB_SCHEMA_TOO_NEW',
  'DB_BACKUP_FAILED',
  'DB_MIGRATION_FAILED',
  'DB_INVALID',
  'DB_BUSY'
] as const

export type LibraryDbErrorCode = (typeof LIBRARY_DB_ERROR_CODES)[number]

export interface LibraryDbErrorInit {
  code: LibraryDbErrorCode
  message: string
  dbPath: string
  discoveredVersion?: number
  backupPath?: string
  backupDir?: string
  cause?: unknown
}

/** D2 native dialog가 버전·경로를 표시할 수 있게 필드만 담는다. */
export class LibraryDbError extends Error {
  readonly code: LibraryDbErrorCode
  readonly dbPath: string
  readonly supportedVersion: number
  readonly discoveredVersion?: number
  readonly backupPath?: string
  readonly backupDir?: string

  constructor(init: LibraryDbErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined)
    this.name = 'LibraryDbError'
    this.code = init.code
    this.dbPath = init.dbPath
    this.supportedVersion = SCHEMA_VERSION
    this.discoveredVersion = init.discoveredVersion
    this.backupPath = init.backupPath
    this.backupDir = init.backupDir
  }
}

export function isLibraryDbError(error: unknown): error is LibraryDbError {
  return error instanceof LibraryDbError
}

export function sqliteErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code: unknown }).code
  return typeof code === 'string' ? code : undefined
}

export function isSqliteBusyError(error: unknown): boolean {
  const code = sqliteErrorCode(error)
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'SQLITE_BUSY_SNAPSHOT'
    ? true
    : code !== undefined && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
}

export function wrapSqliteOpenError(error: unknown, dbPath: string): LibraryDbError {
  if (isLibraryDbError(error)) return error
  const detail = error instanceof Error ? error.message : String(error)
  if (isSqliteBusyError(error)) {
    return new LibraryDbError({
      code: 'DB_BUSY',
      dbPath,
      message: `라이브러리 DB가 다른 프로세스에서 사용 중입니다. 모든 앱을 종료한 뒤 다시 시도하세요. (${detail})`,
      cause: error
    })
  }
  return new LibraryDbError({
    code: 'DB_INVALID',
    dbPath,
    message: `라이브러리 DB를 열 수 없습니다. 원본은 그대로 보존했습니다. (${detail})`,
    cause: error
  })
}

export function closeQuietly(db: { open: boolean; close: () => unknown } | undefined): void {
  if (!db?.open) return
  try {
    db.close()
  } catch {
    // 실패 경로에서 핸들이 남지 않게만 한다
  }
}
