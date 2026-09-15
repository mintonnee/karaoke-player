import { dirname } from 'path'
import { describe, expect, it } from 'vitest'
import {
  LIBRARY_DB_ERROR_CODES,
  SCHEMA_VERSION,
  defaultLibraryBackupDir
} from '../../library/LibraryStore'
import {
  LIBRARY_DB_DIALOG_BUTTONS,
  LIBRARY_DB_DIALOG_OPEN_BACKUP_ID,
  LIBRARY_DB_DIALOG_OPEN_DATA_ID,
  LIBRARY_DB_DIALOG_QUIT_ID,
  OPEN_BACKUP_DIR_BUTTON,
  OPEN_DATA_DIR_BUTTON,
  QUIT_BUTTON,
  formatLibraryDbErrorDialog,
  presentLibraryDbErrorDialog,
  shouldClaimOriginalPreserved
} from '../../startup'
import { DB_PATH, makeDbError, mockApp, mockDialog, mockShell } from './helpers'

function fullText(errorCode: Parameters<typeof makeDbError>[0], message?: string): string {
  const content = formatLibraryDbErrorDialog(
    makeDbError(errorCode, {
      message,
      discoveredVersion: errorCode === 'DB_SCHEMA_TOO_NEW' ? 99 : undefined
    })
  )
  return `${content.title}\n${content.message}\n${content.detail}`
}

describe('library DB error dialog copy (criterion 6)', () => {
  it('오류 코드마다 제목·본문이 다르다', () => {
    const formatted = LIBRARY_DB_ERROR_CODES.map((code) =>
      formatLibraryDbErrorDialog(
        makeDbError(code, {
          discoveredVersion: code === 'DB_SCHEMA_TOO_NEW' ? 12 : 7,
          message: `${code} 고유 메시지`
        })
      )
    )
    const titles = new Set(formatted.map((item) => item.title))
    const messages = new Set(formatted.map((item) => item.message))
    expect(titles.size).toBe(LIBRARY_DB_ERROR_CODES.length)
    expect(messages.size).toBe(LIBRARY_DB_ERROR_CODES.length)
  })

  it('TOO_NEW는 발견/지원 버전과 최신 앱 필요를 알리고 백업을 만들었다고 하지 않는다', () => {
    const error = makeDbError('DB_SCHEMA_TOO_NEW', {
      discoveredVersion: 99,
      message: '라이브러리 DB 버전(99)이 이 앱이 지원하는 버전(8)보다 높습니다.'
    })
    const content = formatLibraryDbErrorDialog(error)
    const text = `${content.title}\n${content.message}\n${content.detail}`
    expect(content.message).toContain('99')
    expect(content.message).toContain(String(error.supportedVersion))
    expect(error.supportedVersion).toBe(SCHEMA_VERSION)
    expect(text).toMatch(/최신/)
    expect(content.detail).toContain('발견된 DB 버전: 99')
    expect(content.detail).toContain(`이 앱이 지원하는 버전: ${SCHEMA_VERSION}`)
    expect(text).not.toMatch(/백업을 만들|백업했습니다|백업에 성공/)
    expect(shouldClaimOriginalPreserved(error)).toBe(false)
  })

  it('BACKUP_FAILED는 원본을 변경하지 않았다고 안내한다', () => {
    const text = fullText(
      'DB_BACKUP_FAILED',
      '마이그레이션 전 백업에 실패해 원본 DB를 변경하지 않았습니다.'
    )
    expect(text).toMatch(/백업/)
    expect(text).toMatch(/변경하지 않았/)
    expect(shouldClaimOriginalPreserved(makeDbError('DB_BACKUP_FAILED'))).toBe(true)
  })

  it('MIGRATION_FAILED는 error.message를 쓰고, 롤백 성공일 때만 보존을 안내한다', () => {
    const preserved = makeDbError('DB_MIGRATION_FAILED', {
      message: '라이브러리 DB 업그레이드에 실패했습니다. 원본은 롤백되어 보존되었습니다. (boom)'
    })
    const preservedText = `${formatLibraryDbErrorDialog(preserved).message}\n${formatLibraryDbErrorDialog(preserved).detail}`
    expect(formatLibraryDbErrorDialog(preserved).message).toBe(preserved.message)
    expect(preservedText).toMatch(/롤백되어 보존/)
    expect(shouldClaimOriginalPreserved(preserved)).toBe(true)

    const rollbackFailed = makeDbError('DB_MIGRATION_FAILED', {
      message: '마이그레이션 롤백에 실패했습니다. 원본 파일을 보존한 채 중단합니다. (disk)'
    })
    const failedContent = formatLibraryDbErrorDialog(rollbackFailed)
    expect(failedContent.message).toBe(rollbackFailed.message)
    expect(failedContent.title).not.toMatch(/보존/)
    expect(failedContent.detail).not.toMatch(/롤백되어 보존|원본은 그대로 보존/)
    expect(shouldClaimOriginalPreserved(rollbackFailed)).toBe(false)
  })

  it('DB_INVALID는 손상/불일치와 원본 보존을 안내한다', () => {
    const text = fullText('DB_INVALID')
    expect(text).toMatch(/손상/)
    expect(text).toMatch(/보존/)
  })

  it('DB_BUSY는 다른 프로세스 사용과 종료를 안내한다', () => {
    const text = fullText('DB_BUSY')
    expect(text).toMatch(/다른 프로세스|다른 앱/)
    expect(text).toMatch(/종료/)
  })

  it('버튼은 데이터/백업 폴더 열기와 종료뿐이며 복원·삭제·초기화가 없다', () => {
    const content = formatLibraryDbErrorDialog(makeDbError('DB_INVALID'))
    expect(content.buttons).toEqual([OPEN_DATA_DIR_BUTTON, OPEN_BACKUP_DIR_BUTTON, QUIT_BUTTON])
    expect(content.buttons).toEqual([...LIBRARY_DB_DIALOG_BUTTONS])
    expect(content.defaultId).toBe(LIBRARY_DB_DIALOG_QUIT_ID)
    expect(content.cancelId).toBe(LIBRARY_DB_DIALOG_QUIT_ID)
    expect(content.buttons.join('\n')).not.toMatch(/복원|삭제|초기화|restore|delete|reset|factory/i)
    expect(content.dataDir).toBe(dirname(DB_PATH))
    expect(content.backupDir).toBe(defaultLibraryBackupDir(DB_PATH))
  })

  it('backupDir가 없으면 D1 기본 백업 경로를 쓴다', () => {
    const content = formatLibraryDbErrorDialog(
      makeDbError('DB_SCHEMA_TOO_NEW', { discoveredVersion: 9 })
    )
    expect(content.backupDir).toBe(defaultLibraryBackupDir(DB_PATH))
  })
})

describe('presentLibraryDbErrorDialog', () => {
  it('데이터 폴더·백업 폴더를 연 뒤 종료한다', async () => {
    const app = mockApp()
    const dialog = mockDialog([
      LIBRARY_DB_DIALOG_OPEN_DATA_ID,
      LIBRARY_DB_DIALOG_OPEN_BACKUP_ID,
      LIBRARY_DB_DIALOG_QUIT_ID
    ])
    const shell = mockShell()
    const error = makeDbError('DB_BACKUP_FAILED', { backupDir: joinBackup() })
    await presentLibraryDbErrorDialog(error, { app, dialog, shell })
    const content = formatLibraryDbErrorDialog(error)
    expect(shell.openPath).toHaveBeenNthCalledWith(1, content.dataDir)
    expect(shell.openPath).toHaveBeenNthCalledWith(2, content.backupDir)
    expect(app.quit).toHaveBeenCalledTimes(1)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(3)
    const shown = dialog.options[0] as { buttons: string[] }
    expect(shown.buttons).toEqual([...LIBRARY_DB_DIALOG_BUTTONS])
  })
})

function joinBackup(): string {
  return defaultLibraryBackupDir(DB_PATH)
}
