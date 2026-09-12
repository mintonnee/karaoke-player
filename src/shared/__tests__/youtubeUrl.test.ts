import { describe, expect, it } from 'vitest'
import { isYoutubeVideoUrl, parseYoutubeVideoUrl } from '../youtubeUrl'

describe('parseYoutubeVideoUrl', () => {
  it('공백을 제거하고 watch/shorts/live·youtu.be 동영상 URL을 허용한다', () => {
    const accepted = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'http://youtube.com/watch?v=dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=abc123_-XYZ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/shortId11',
      'https://www.youtube.com/live/liveId_11a',
      '  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLplaylist'
    ]
    for (const raw of accepted) {
      const result = parseYoutubeVideoUrl(raw)
      expect(result.ok, raw).toBe(true)
      if (result.ok) expect(result.href).toBe(raw.trim())
      expect(isYoutubeVideoUrl(raw)).toBe(true)
    }
  })

  it('재생목록 전용·다른 호스트·비 http(s)·빈 값을 거부한다', () => {
    const rejected: Array<[string, string]> = [
      ['', '비어'],
      ['   ', '비어'],
      ['not a url', '올바른 URL'],
      ['ftp://www.youtube.com/watch?v=abc', 'http(s)'],
      ['https://example.com/watch?v=abc', 'YouTube'],
      ['https://music.youtube.com/watch?v=abc', 'YouTube'],
      ['https://www.youtube.com.evil.com/watch?v=abc', 'YouTube'],
      ['https://evil.com/youtube.com/watch?v=abc', 'YouTube'],
      ['https://www.youtube.com/playlist?list=PLxxx', '재생목록'],
      ['https://www.youtube.com/watch', 'YouTube'],
      ['https://www.youtube.com/watch?v=', 'YouTube'],
      ['https://www.youtube.com/channel/UCxxx', 'YouTube'],
      ['https://youtu.be/', 'YouTube'],
      ['https://youtu.be/abc/extra', 'YouTube']
    ]
    for (const [raw, hint] of rejected) {
      const result = parseYoutubeVideoUrl(raw)
      expect(result.ok, raw).toBe(false)
      if (!result.ok) expect(result.reason, raw).toContain(hint)
      expect(isYoutubeVideoUrl(raw)).toBe(false)
    }
  })
})
