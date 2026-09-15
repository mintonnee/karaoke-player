import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { closeQuietly, LibraryDbError } from './errors'
import type { LibraryBackupFault } from './options'
import { SCHEMA_VERSION, listTracksColumns, readUserVersion, structureMismatch } from './schema'

export interface LibraryBackupMeta {
  id: string
  startVersion: number
  targetVersion: number
  appVersion: string
  createdAt: string
  sourceDbPath: string
}

export interface CreatedLibraryBackup {
  backupPath: string
  metaPath: string
  meta: LibraryBackupMeta
}

function backupStamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function safeToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return token.slice(0, 64) || 'app'
}

function unlinkIfExists(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // 임시 파일 정리 실패는 완료 백업을 지우지 않는 한 무시
  }
}

function quickCheckOk(db: Database.Database): boolean {
  const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>
  if (rows.length === 0) return false
  return rows.every((row) => Object.values(row)[0] === 'ok')
}

function verifyBackupFile(tmpPath: string, startVersion: number, dbPath: string): void {
  let check: Database.Database | undefined
  try {
    // 임시 파일을 닫은 뒤 별도 연결로 검증한다
    check = new Database(tmpPath, { readonly: true, fileMustExist: true, timeout: 1000 })
    if (!quickCheckOk(check)) {
      throw new LibraryDbError({
        code: 'DB_BACKUP_FAILED',
        dbPath,
        discoveredVersion: startVersion,
        message:
          '마이그레이션 전 백업 무결성 검사(quick_check)에 실패했습니다. 원본은 변경하지 않았습니다.',
        backupPath: tmpPath
      })
    }
    const version = readUserVersion(check)
    if (version !== startVersion) {
      throw new LibraryDbError({
        code: 'DB_BACKUP_FAILED',
        dbPath,
        discoveredVersion: startVersion,
        message: `백업의 user_version(${version})이 시작 버전(${startVersion})과 다릅니다. 원본은 변경하지 않았습니다.`,
        backupPath: tmpPath
      })
    }
    const mismatch = structureMismatch(listTracksColumns(check), startVersion)
    if (mismatch) {
      throw new LibraryDbError({
        code: 'DB_BACKUP_FAILED',
        dbPath,
        discoveredVersion: startVersion,
        message: `백업 구조 검증 실패: ${mismatch}. 원본은 변경하지 않았습니다.`,
        backupPath: tmpPath
      })
    }
  } finally {
    closeQuietly(check)
  }
}

/**
 * 열린 live DB를 copyFile하지 않는다. serialize()는 WAL에만 있는 커밋을 포함한 스냅샷이다.
 */
export function createPreMigrationBackup(
  db: Database.Database,
  dbPath: string,
  backupDir: string,
  startVersion: number,
  appVersion: string,
  backupFault?: LibraryBackupFault
): CreatedLibraryBackup {
  const createdAt = new Date().toISOString()
  const id = randomUUID()
  const baseName = `library-v${startVersion}-to-v${SCHEMA_VERSION}-${backupStamp(createdAt)}-${safeToken(id)}`
  const backupPath = join(backupDir, `${baseName}.sqlite`)
  const metaPath = join(backupDir, `${baseName}.json`)
  const tmpPath = `${backupPath}.tmp`
  const metaTmpPath = `${metaPath}.tmp`

  const meta: LibraryBackupMeta = {
    id,
    startVersion,
    targetVersion: SCHEMA_VERSION,
    appVersion,
    createdAt,
    sourceDbPath: dbPath
  }

  try {
    mkdirSync(backupDir, { recursive: true })
    unlinkIfExists(tmpPath)
    unlinkIfExists(metaTmpPath)
    if (backupFault === 'write') {
      throw new Error('injected backup write fault')
    }
    const snapshot = db.serialize()
    writeFileSync(tmpPath, snapshot)
    if (backupFault === 'verify') {
      throw new LibraryDbError({
        code: 'DB_BACKUP_FAILED',
        dbPath,
        discoveredVersion: startVersion,
        backupDir,
        backupPath: tmpPath,
        message: '마이그레이션 전 백업 검증에 실패했습니다. 원본은 변경하지 않았습니다.'
      })
    }
    verifyBackupFile(tmpPath, startVersion, dbPath)
    writeFileSync(metaTmpPath, `${JSON.stringify(meta, null, 2)}\n`)
    renameSync(tmpPath, backupPath)
    try {
      renameSync(metaTmpPath, metaPath)
    } catch {
      // 파일명에 시작/목표 버전·시각·id가 있으므로 sidecar 실패만으로 백업을 폐기하지 않는다
    }
    return { backupPath, metaPath, meta }
  } catch (error) {
    unlinkIfExists(tmpPath)
    unlinkIfExists(metaTmpPath)
    if (error instanceof LibraryDbError) {
      throw new LibraryDbError({
        code: error.code,
        message: error.message,
        dbPath: error.dbPath,
        discoveredVersion: error.discoveredVersion,
        backupPath: error.backupPath,
        backupDir,
        cause: error.cause
      })
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new LibraryDbError({
      code: 'DB_BACKUP_FAILED',
      dbPath,
      discoveredVersion: startVersion,
      backupDir,
      message: `마이그레이션 전 백업에 실패해 원본 DB를 변경하지 않았습니다. (${detail})`,
      cause: error
    })
  }
}
