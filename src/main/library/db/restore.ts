import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import { LibraryDbError } from './errors'

function unlinkIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path)
}

/**
 * 검증된 백업 파일을 별도 경로로 복사한다. 원본 live WAL/SHM을 붙이지 않는다.
 * dest에 남아 있던 -wal/-shm은 제거한다.
 */
export function restoreLibraryBackup(backupPath: string, destPath: string): void {
  if (!existsSync(backupPath)) {
    throw new LibraryDbError({
      code: 'DB_INVALID',
      dbPath: destPath,
      backupPath,
      message: `복원할 백업 파일이 없습니다: ${backupPath}`
    })
  }
  mkdirSync(dirname(destPath), { recursive: true })
  copyFileSync(backupPath, destPath)
  unlinkIfExists(`${destPath}-wal`)
  unlinkIfExists(`${destPath}-shm`)
}
