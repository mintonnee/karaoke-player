import { parseYoutubeVideoUrl } from '../../shared/youtubeUrl'
import { URL_IMPORT_DISABLED_REASON } from '../../shared/types'
import type { ImportFilesResponse } from '../../shared/types'

export { URL_IMPORT_DISABLED_REASON }

export type ImportUrlPrecheck =
  { action: 'reject'; response: ImportFilesResponse } | { action: 'proceed'; url: string }

/**
 * urlImport=false 이거나 YouTube 동영상 URL이 아니면 spawn 전에 거부한다.
 * 비문자열도 예외 없이 거부한다. 진행 시 canonical URL만 넘긴다 (스펙 009 §4.2).
 */
export function precheckImportUrl(url: unknown, urlImport: boolean): ImportUrlPrecheck {
  const filePath = typeof url === 'string' ? url : ''
  if (!urlImport) {
    return {
      action: 'reject',
      response: {
        imported: [],
        rejected: [{ filePath, reason: URL_IMPORT_DISABLED_REASON }]
      }
    }
  }
  const parsed = parseYoutubeVideoUrl(url)
  if (!parsed.ok) {
    return {
      action: 'reject',
      response: { imported: [], rejected: [{ filePath, reason: parsed.reason }] }
    }
  }
  return { action: 'proceed', url: parsed.canonicalUrl }
}
