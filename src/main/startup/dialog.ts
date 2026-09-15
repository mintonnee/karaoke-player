import { dirname } from 'path'
import {
  defaultLibraryBackupDir,
  type LibraryDbError,
  type LibraryDbErrorCode
} from '../library/LibraryStore'
import { quitStartupApp } from './singleInstance'
import type { StartupApp, StartupDialog, StartupShell } from './types'

export const OPEN_DATA_DIR_BUTTON = '데이터 폴더 열기'
export const OPEN_BACKUP_DIR_BUTTON = '백업 폴더 열기'
export const QUIT_BUTTON = '종료'

export const LIBRARY_DB_DIALOG_BUTTONS = [
  OPEN_DATA_DIR_BUTTON,
  OPEN_BACKUP_DIR_BUTTON,
  QUIT_BUTTON
] as const

export const LIBRARY_DB_DIALOG_OPEN_DATA_ID = 0
export const LIBRARY_DB_DIALOG_OPEN_BACKUP_ID = 1
export const LIBRARY_DB_DIALOG_QUIT_ID = 2

export interface LibraryDbErrorDialogContent {
  type: 'error'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: true
  dataDir: string
  backupDir: string
}

const COPY: Record<
  LibraryDbErrorCode,
  (error: LibraryDbError) => { title: string; message: string }
> = {
  DB_SCHEMA_TOO_NEW: (error) => {
    const discovered =
      error.discoveredVersion === undefined ? '알 수 없음' : String(error.discoveredVersion)
    return {
      title: '더 최신 앱이 필요합니다',
      message:
        `이 라이브러리 DB 버전은 ${discovered}이고, 이 앱이 지원하는 버전은 ` +
        `${error.supportedVersion}입니다. 더 최신 버전의 Karaoke Player가 필요합니다.`
    }
  },
  DB_BACKUP_FAILED: () => ({
    title: '라이브러리 백업에 실패했습니다',
    message: '마이그레이션 전 백업에 실패했습니다. 원본 라이브러리는 변경하지 않았습니다.'
  }),
  DB_MIGRATION_FAILED: (error) => ({
    title: '라이브러리 업그레이드에 실패했습니다',
    message: error.message
  }),
  DB_INVALID: () => ({
    title: '라이브러리가 손상되었거나 스키마가 맞지 않습니다',
    message:
      '라이브러리 DB가 손상되었거나 스키마가 버전과 맞지 않습니다. 원본은 그대로 보존했습니다.'
  }),
  DB_BUSY: () => ({
    title: '라이브러리를 다른 앱이 사용 중입니다',
    message:
      '다른 프로세스가 라이브러리 DB를 사용 중입니다. 다른 Karaoke Player나 관련 앱을 종료한 뒤 다시 시도하세요.'
  })
}

/** D1 메시지가 롤백 성공을 명시한 경우에만 보존을 안내한다. */
export function shouldClaimOriginalPreserved(error: LibraryDbError): boolean {
  if (error.code === 'DB_BACKUP_FAILED' || error.code === 'DB_INVALID') return true
  if (error.code === 'DB_SCHEMA_TOO_NEW' || error.code === 'DB_BUSY') return false
  if (error.code === 'DB_MIGRATION_FAILED') {
    if (error.message.includes('롤백에 실패')) return false
    return error.message.includes('롤백되어 보존')
  }
  return false
}

export function formatLibraryDbErrorDialog(error: LibraryDbError): LibraryDbErrorDialogContent {
  const dataDir = dirname(error.dbPath)
  const backupDir = error.backupDir ?? defaultLibraryBackupDir(error.dbPath)
  const { title, message } = COPY[error.code](error)
  const detailParts = [error.message]
  if (error.code === 'DB_MIGRATION_FAILED' && shouldClaimOriginalPreserved(error)) {
    if (!error.message.includes('롤백되어 보존')) {
      detailParts.push('원본은 롤백되어 보존되었습니다.')
    }
  }
  if (error.code === 'DB_SCHEMA_TOO_NEW') {
    detailParts.push(
      `발견된 DB 버전: ${error.discoveredVersion === undefined ? '알 수 없음' : error.discoveredVersion}`,
      `이 앱이 지원하는 버전: ${error.supportedVersion}`
    )
  }
  detailParts.push(
    `라이브러리: ${error.dbPath}`,
    `데이터 폴더: ${dataDir}`,
    `백업 폴더: ${backupDir}`
  )
  return {
    type: 'error',
    title,
    message,
    detail: detailParts.filter((part, index, all) => all.indexOf(part) === index).join('\n'),
    buttons: [...LIBRARY_DB_DIALOG_BUTTONS],
    defaultId: LIBRARY_DB_DIALOG_QUIT_ID,
    cancelId: LIBRARY_DB_DIALOG_QUIT_ID,
    noLink: true,
    dataDir,
    backupDir
  }
}

export async function presentLibraryDbErrorDialog(
  error: LibraryDbError,
  deps: { dialog: StartupDialog; shell: StartupShell; app: Pick<StartupApp, 'quit' | 'exit'> }
): Promise<void> {
  const content = formatLibraryDbErrorDialog(error)
  for (;;) {
    const { response } = await deps.dialog.showMessageBox({
      type: content.type,
      title: content.title,
      message: content.message,
      detail: content.detail,
      buttons: content.buttons,
      defaultId: content.defaultId,
      cancelId: content.cancelId,
      noLink: content.noLink
    })
    if (response === LIBRARY_DB_DIALOG_OPEN_DATA_ID) {
      await openFolder(deps.shell, content.dataDir)
      continue
    }
    if (response === LIBRARY_DB_DIALOG_OPEN_BACKUP_ID) {
      await openFolder(deps.shell, content.backupDir)
      continue
    }
    break
  }
  quitStartupApp(deps.app)
}

async function openFolder(shell: StartupShell, folder: string): Promise<void> {
  try {
    await shell.openPath(folder)
  } catch {
    // 폴더가 없어도 안내 대화상자는 유지한다
  }
}
