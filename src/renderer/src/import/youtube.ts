import { parseYoutubeVideoUrl, type YoutubeUrlParseResult } from '../../../shared/youtubeUrl'

/** 팝업 URL 검증. 파싱은 shared 구현을 그대로 쓴다 (재구현 금지). */
export function parseImportYoutubeUrl(raw: string): YoutubeUrlParseResult {
  return parseYoutubeVideoUrl(raw)
}
