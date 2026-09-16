/** YouTube 동영상 호스트. 파싱한 hostname만 비교한다 (부분 문자열 금지) */
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com'])
const YOUTU_BE_HOST = 'youtu.be'
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

export interface YoutubeUrlOk {
  ok: true
  /** trim한 입력 원문. 입력창 표시용. 조회/다운로드에는 쓰지 않는다 */
  href: string
  videoId: string
  /** 조회·다운로드 공통 URL. 항상 https://www.youtube.com/watch?v=<id> */
  canonicalUrl: string
}

export interface YoutubeUrlErr {
  ok: false
  reason: string
}

export type YoutubeUrlParseResult = YoutubeUrlOk | YoutubeUrlErr

/**
 * HTTP(S) YouTube 동영상 URL만 허용한다 (스펙 004 §4.1, 009 §4.2).
 * watch/shorts/live 와 youtu.be 단축 URL. 재생목록 전용은 거부.
 * 동영상에 붙은 list= 는 허용하되 canonical에서는 제거한다.
 * 비문자열은 예외 없이 거부한다.
 */
export function parseYoutubeVideoUrl(raw: unknown): YoutubeUrlParseResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: '올바른 URL이 아닙니다' }
  }

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

  if (url.username !== '' || url.password !== '') {
    return genericReject()
  }

  // URL.port는 기본 포트(http 80 / https 443)면 빈 문자열이다
  if (url.port !== '') {
    return genericReject()
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

export function isYoutubeVideoUrl(raw: unknown): boolean {
  return parseYoutubeVideoUrl(raw).ok
}

function parseShortUrl(url: URL, href: string): YoutubeUrlParseResult {
  if (hasDuplicateV(url)) return genericReject()
  const parts = pathParts(url.pathname)
  if (parts.length !== 1) {
    return genericReject()
  }
  const videoId = parts[0] ?? ''
  if (!isVideoId(videoId)) {
    return genericReject()
  }
  return okResult(href, videoId)
}

function parseYoutubePath(url: URL, href: string): YoutubeUrlParseResult {
  const parts = pathParts(url.pathname)
  const head = parts[0] ?? ''

  if (head === 'playlist') {
    return { ok: false, reason: '재생목록 URL은 가져올 수 없습니다' }
  }

  if (hasDuplicateV(url)) return genericReject()

  if (head === 'watch') {
    if (parts.length !== 1) {
      return genericReject()
    }
    const videoId = url.searchParams.get('v') ?? ''
    if (!isVideoId(videoId)) {
      return genericReject()
    }
    return okResult(href, videoId)
  }

  if ((head === 'shorts' || head === 'live') && parts.length === 2) {
    const videoId = parts[1] ?? ''
    if (!isVideoId(videoId)) {
      return genericReject()
    }
    return okResult(href, videoId)
  }

  return genericReject()
}

function okResult(href: string, videoId: string): YoutubeUrlOk {
  return {
    ok: true,
    href,
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`
  }
}

function genericReject(): YoutubeUrlErr {
  return { ok: false, reason: 'YouTube 동영상 URL만 가져올 수 있습니다' }
}

function isVideoId(value: string): boolean {
  return VIDEO_ID_RE.test(value)
}

function hasDuplicateV(url: URL): boolean {
  return url.searchParams.getAll('v').length > 1
}

function pathParts(pathname: string): string[] {
  return pathname.split('/').filter((part) => part !== '')
}
