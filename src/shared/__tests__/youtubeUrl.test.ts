import { describe, expect, it } from 'vitest'
import { isYoutubeVideoUrl, parseYoutubeVideoUrl } from '../youtubeUrl'

const VIDEO_ID = 'dQw4w9WgXcQ'
const VIDEO_ID_ALT = 'abc123_-XYZ'
const CANONICAL = `https://www.youtube.com/watch?v=${VIDEO_ID}`

describe('parseYoutubeVideoUrl', () => {
  it('지원 형태는 같은 canonical URL을 만든다', () => {
    const accepted = [
      `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      `http://youtube.com/watch?v=${VIDEO_ID}`,
      `https://m.youtube.com/watch?v=${VIDEO_ID}`,
      `https://youtu.be/${VIDEO_ID}`,
      `https://www.youtube.com/shorts/${VIDEO_ID}`,
      `https://www.youtube.com/live/${VIDEO_ID}`,
      `https://WWW.YouTube.com/watch?v=${VIDEO_ID}`
    ]
    for (const raw of accepted) {
      const result = parseYoutubeVideoUrl(raw)
      expect(result.ok, raw).toBe(true)
      if (result.ok) {
        expect(result.href).toBe(raw)
        expect(result.videoId).toBe(VIDEO_ID)
        expect(result.canonicalUrl).toBe(CANONICAL)
      }
      expect(isYoutubeVideoUrl(raw)).toBe(true)
    }
  })

  it('공백을 trim한 원문을 href로 보존하고 canonical은 따로 둔다', () => {
    const raw = `  https://youtu.be/${VIDEO_ID}?t=43  `
    const result = parseYoutubeVideoUrl(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.href).toBe(raw.trim())
      expect(result.canonicalUrl).toBe(CANONICAL)
      expect(result.href).not.toBe(result.canonicalUrl)
    }
  })

  it('list·시간·공유 추적 파라미터는 canonical에서 제거하고 href는 보존한다', () => {
    const raw =
      `https://www.youtube.com/watch?v=${VIDEO_ID}` +
      '&list=PLplaylist&t=43s&start=10&time_continue=5&si=abc&feature=share&pp=ygU'
    const result = parseYoutubeVideoUrl(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.href).toBe(raw)
      expect(result.videoId).toBe(VIDEO_ID)
      expect(result.canonicalUrl).toBe(CANONICAL)
    }

    const shortRaw = `https://youtu.be/${VIDEO_ID_ALT}?t=43&si=xyz&list=PLother`
    const shortResult = parseYoutubeVideoUrl(shortRaw)
    expect(shortResult.ok).toBe(true)
    if (shortResult.ok) {
      expect(shortResult.href).toBe(shortRaw)
      expect(shortResult.videoId).toBe(VIDEO_ID_ALT)
      expect(shortResult.canonicalUrl).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID_ALT}`)
    }
  })

  it('재생목록 전용·다른 호스트·비 http(s)·빈 값을 거부한다', () => {
    const rejected: Array<[string, string]> = [
      ['', '비어'],
      ['   ', '비어'],
      ['not a url', '올바른 URL'],
      ['ftp://www.youtube.com/watch?v=abc', 'http(s)'],
      ['https://example.com/watch?v=abc', 'YouTube'],
      [`https://music.youtube.com/watch?v=${VIDEO_ID}`, 'YouTube'],
      [`https://www.youtube.com.evil.com/watch?v=${VIDEO_ID}`, 'YouTube'],
      [`https://evil.com/youtube.com/watch?v=${VIDEO_ID}`, 'YouTube'],
      ['https://www.youtube.com/playlist?list=PLxxx', '재생목록'],
      ['https://www.youtube.com/watch', 'YouTube'],
      ['https://www.youtube.com/watch?v=', 'YouTube'],
      ['https://www.youtube.com/channel/UCxxx', 'YouTube'],
      ['https://youtu.be/', 'YouTube'],
      [`https://youtu.be/${VIDEO_ID}/extra`, 'YouTube']
    ]
    for (const [raw, hint] of rejected) {
      const result = parseYoutubeVideoUrl(raw)
      expect(result.ok, raw).toBe(false)
      if (!result.ok) expect(result.reason, raw).toContain(hint)
      expect(isYoutubeVideoUrl(raw)).toBe(false)
    }
  })

  it('위조 호스트·자격증명·비기본 포트·잘못된 ID·중복 v·watch 추가 경로를 거부한다', () => {
    const rejected: Array<[unknown, string]> = [
      [`https://youtube.com.evil.com/watch?v=${VIDEO_ID}`, 'YouTube'],
      [`https://user:pass@www.youtube.com/watch?v=${VIDEO_ID}`, 'YouTube'],
      [`https://user@www.youtube.com/watch?v=${VIDEO_ID}`, 'YouTube'],
      [`https://www.youtube.com:8080/watch?v=${VIDEO_ID}`, 'YouTube'],
      [`http://www.youtube.com:8080/watch?v=${VIDEO_ID}`, 'YouTube'],
      [`https://www.youtube.com:80/watch?v=${VIDEO_ID}`, 'YouTube'],
      ['https://www.youtube.com/shorts/shortId11', 'YouTube'],
      ['https://www.youtube.com/live/liveId_11a', 'YouTube'],
      [`https://www.youtube.com/watch?v=${VIDEO_ID}x`, 'YouTube'],
      ['https://www.youtube.com/watch?v=shortId11', 'YouTube'],
      [`https://www.youtube.com/watch?v=${VIDEO_ID}&v=${VIDEO_ID_ALT}`, 'YouTube'],
      [`https://www.youtube.com/watch/foo?v=${VIDEO_ID}`, 'YouTube'],
      [`https://www.youtube.com/playlist?list=PLxxx&v=${VIDEO_ID}`, '재생목록']
    ]
    for (const [raw, hint] of rejected) {
      const result = parseYoutubeVideoUrl(raw)
      expect(result.ok, String(raw)).toBe(false)
      if (!result.ok) expect(result.reason, String(raw)).toContain(hint)
      expect(isYoutubeVideoUrl(raw)).toBe(false)
    }
  })

  it('비문자열은 예외 없이 거부한다', () => {
    const rejected: unknown[] = [1, 0, true, { url: CANONICAL }, null, undefined, [CANONICAL]]
    for (const raw of rejected) {
      expect(() => parseYoutubeVideoUrl(raw)).not.toThrow()
      const result = parseYoutubeVideoUrl(raw)
      expect(result.ok, String(raw)).toBe(false)
      if (!result.ok) expect(result.reason).toContain('올바른 URL')
      expect(isYoutubeVideoUrl(raw)).toBe(false)
    }
  })

  it('invalid 입력은 순수 파서만 타며 예외를 던지지 않는다', () => {
    const junk = [
      '',
      'javascript:alert(1)',
      `https://user:pass@www.youtube.com/watch?v=${VIDEO_ID}`,
      42,
      null
    ]
    for (const raw of junk) {
      expect(() => parseYoutubeVideoUrl(raw)).not.toThrow()
      expect(parseYoutubeVideoUrl(raw).ok).toBe(false)
    }
  })

  it('기본 포트는 허용한다', () => {
    const httpsDefault = parseYoutubeVideoUrl(`https://www.youtube.com:443/watch?v=${VIDEO_ID}`)
    const httpDefault = parseYoutubeVideoUrl(`http://www.youtube.com:80/watch?v=${VIDEO_ID}`)
    expect(httpsDefault.ok).toBe(true)
    expect(httpDefault.ok).toBe(true)
    if (httpsDefault.ok) expect(httpsDefault.canonicalUrl).toBe(CANONICAL)
    if (httpDefault.ok) expect(httpDefault.canonicalUrl).toBe(CANONICAL)
  })
})
