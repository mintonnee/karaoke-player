import { parseYoutubeVideoUrl } from '../../shared/youtubeUrl'
import type { ImportFilesResponse } from '../../shared/types'

export const URL_IMPORT_DISABLED_REASON = '이 배포판에서는 URL 가져오기를 쓸 수 없습니다'

export type ImportUrlPrecheck =
  { action: 'reject'; response: ImportFilesResponse } | { action: 'proceed'; url: string }

/**
 * urlImport=false 이거나 YouTube 동영상 URL이 아니면 spawn 전에 거부한다.
 * Electron 없이 테스트하기 위해 IPC 핸들러에서 이 함수만 거친다.
 */
export function precheckImportUrl(url: string, urlImport: boolean): ImportUrlPrecheck {
  if (!urlImport) {
    return {
      action: 'reject',
      response: {
        imported: [],
        rejected: [{ filePath: url, reason: URL_IMPORT_DISABLED_REASON }]
      }
    }
  }
  const parsed = parseYoutubeVideoUrl(url)
  if (!parsed.ok) {
    return {
      action: 'reject',
      response: { imported: [], rejected: [{ filePath: url, reason: parsed.reason }] }
    }
  }
  return { action: 'proceed', url: parsed.href }
}
