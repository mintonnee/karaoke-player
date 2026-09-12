/** YouTube 동영상 호스트. 파싱한 hostname만 비교한다 (부분 문자열 금지) */
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com'])
const YOUTU_BE_HOST = 'youtu.be'

export interface YoutubeUrlOk {
  ok: true
  /** trim한 원문. yt-dlp에 이 값을 넘긴다 */
  href: string
}

export interface YoutubeUrlErr {
  ok: false
  reason: string
}

export type YoutubeUrlParseResult = YoutubeUrlOk | YoutubeUrlErr

/**
 * HTTP(S) YouTube 동영상 URL만 허용한다 (스펙 004 §4.1).
 * watch/shorts/live 와 youtu.be 단축 URL. 재생목록 전용은 거부.
 * 동영상에 붙은 list= 는 허용 (yt-dlp --no-playlist가 무시).
 */
export function parseYoutubeVideoUrl(raw: string): YoutubeUrlParseResult {
  const href = raw.trim()
  if (href === '') {
    return { ok: false, reason: 'URL이 비어 있습니다' }
  }

  let url: URL
  try {
    url = new URL(href)
  } catch {
    return { ok: false, reason: '올바른 URL이 아닙니다' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'http(s) YouTube 동영상 URL만 가져올 수 있습니다' }
  }

  const host = url.hostname.toLowerCase()
  if (host === YOUTU_BE_HOST) {
    return parseShortUrl(url, href)
  }
  if (!YOUTUBE_HOSTS.has(host)) {
    return { ok: false, reason: 'YouTube 동영상 URL만 가져올 수 있습니다' }
  }
  return parseYoutubePath(url, href)
}

export function isYoutubeVideoUrl(raw: string): boolean {
  return parseYoutubeVideoUrl(raw).ok
}

function parseShortUrl(url: URL, href: string): YoutubeUrlParseResult {
  const parts = pathParts(url.pathname)
  if (parts.length !== 1 || parts[0] === '') {
    return { ok: false, reason: 'YouTube 동영상 URL만 가져올 수 있습니다' }
  }
  return { ok: true, href }
}

function parseYoutubePath(url: URL, href: string): YoutubeUrlParseResult {
  const parts = pathParts(url.pathname)
  const head = parts[0] ?? ''

  if (head === 'playlist') {
    return { ok: false, reason: '재생목록 URL은 가져올 수 없습니다' }
  }

  if (head === 'watch') {
    const videoId = url.searchParams.get('v')?.trim() ?? ''
    if (videoId === '') {
      return { ok: false, reason: 'YouTube 동영상 URL만 가져올 수 있습니다' }
    }
    return { ok: true, href }
  }

  if ((head === 'shorts' || head === 'live') && parts.length === 2 && parts[1] !== '') {
    return { ok: true, href }
  }

  return { ok: false, reason: 'YouTube 동영상 URL만 가져올 수 있습니다' }
}

function pathParts(pathname: string): string[] {
  return pathname.split('/').filter((part) => part !== '')
}
