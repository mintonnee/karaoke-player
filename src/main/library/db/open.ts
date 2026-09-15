import Database from 'better-sqlite3'
import { existsSync } from 'fs'
import { createPreMigrationBackup } from './backup'
import { closeQuietly, isLibraryDbError, LibraryDbError, wrapSqliteOpenError } from './errors'
import { inspectLibraryDb } from './inspect'
import { applyUpgradeToCurrent, createCurrentSchema } from './migrate'
import {
  defaultLibraryBackupDir,
  resolveBusyTimeoutMs,
  resolveLibraryAppVersion,
  type LibraryStoreOptions
} from './options'
import { SCHEMA_VERSION } from './schema'

function tooNewError(dbPath: string, version: number): LibraryDbError {
  return new LibraryDbError({
    code: 'DB_SCHEMA_TOO_NEW',
    dbPath,
    discoveredVersion: version,
    message: `라이브러리 DB 버전(${version})이 이 앱이 지원하는 버전(${SCHEMA_VERSION})보다 높습니다. 더 최신 앱이 필요합니다.`
  })
}

function invalidError(dbPath: string, version: number, reason: string): LibraryDbError {
  return new LibraryDbError({
    code: 'DB_INVALID',
    dbPath,
    discoveredVersion: Number.isFinite(version) ? version : undefined,
    message: `라이브러리 DB가 손상되었거나 스키마가 버전과 맞지 않습니다. 원본은 그대로 보존했습니다. (${reason})`
  })
}

function migrationFailed(
  dbPath: string,
  version: number | undefined,
  error: unknown
): LibraryDbError {
  if (isLibraryDbError(error)) return error
  const detail = error instanceof Error ? error.message : String(error)
  return new LibraryDbError({
    code: 'DB_MIGRATION_FAILED',
    dbPath,
    discoveredVersion: version,
    message: `라이브러리 DB 업그레이드에 실패했습니다. 원본은 롤백되어 보존되었습니다. (${detail})`,
    cause: error
  })
}

function inspectExistingReadOnly(dbPath: string, timeout: number): void {
  let db: Database.Database | undefined
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout })
    const result = inspectLibraryDb(db)
    if (result.kind === 'too_new') throw tooNewError(dbPath, result.version)
    if (result.kind === 'invalid') throw invalidError(dbPath, result.version, result.reason)
  } catch (error) {
    throw wrapSqliteOpenError(error, dbPath)
  } finally {
    closeQuietly(db)
  }
}

function rollbackQuietly(db: Database.Database): void {
  if (!db.open || !db.inTransaction) return
  try {
    db.exec('ROLLBACK')
  } catch (error) {
    throw new LibraryDbError({
      code: 'DB_MIGRATION_FAILED',
      dbPath: db.name,
      message: `마이그레이션 롤백에 실패했습니다. 원본 파일을 보존한 채 중단합니다. (${error instanceof Error ? error.message : String(error)})`,
      cause: error
    })
  }
}

function prepareOpenDatabase(
  db: Database.Database,
  dbPath: string,
  options: LibraryStoreOptions | undefined
): void {
  const result = inspectLibraryDb(db)
  if (result.kind === 'too_new') throw tooNewError(dbPath, result.version)
  if (result.kind === 'invalid') throw invalidError(dbPath, result.version, result.reason)
  if (result.kind === 'current') return
  if (result.kind === 'empty') {
    createCurrentSchema(db)
    return
  }

  const backupDir = options?.backupDir ?? defaultLibraryBackupDir(dbPath)
  createPreMigrationBackup(
    db,
    dbPath,
    backupDir,
    result.version,
    resolveLibraryAppVersion(options),
    options?.debug?.backupFault
  )
  try {
    applyUpgradeToCurrent(db, dbPath, result.version, options?.debug?.migrateFault)
  } catch (error) {
    throw migrationFailed(dbPath, result.version, error)
  }
}

export function openLibraryDatabase(
  dbPath: string,
  options?: LibraryStoreOptions
): Database.Database {
  const timeout = resolveBusyTimeoutMs(options)
  const existed = existsSync(dbPath)
  if (existed) inspectExistingReadOnly(dbPath, timeout)

  let db: Database.Database | undefined
  try {
    db = new Database(dbPath, { timeout, fileMustExist: existed })
    // 연결 단위 설정. 트랜잭션 안에서는 바꿀 수 없다
    db.pragma('synchronous = FULL')
    try {
      db.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      throw wrapSqliteOpenError(error, dbPath)
    }
    try {
      prepareOpenDatabase(db, dbPath, options)
      db.exec('COMMIT')
    } catch (error) {
      rollbackQuietly(db)
      throw wrapSqliteOpenError(error, dbPath)
    }
    try {
      db.pragma('synchronous = NORMAL')
      db.pragma('journal_mode = WAL')
    } catch {
      // 스키마 커밋 이후 journal 전환 실패는 다음 개방에서 재시도한다
    }
    return db
  } catch (error) {
    closeQuietly(db)
    if (isLibraryDbError(error)) throw error
    throw wrapSqliteOpenError(error, dbPath)
  }
}
