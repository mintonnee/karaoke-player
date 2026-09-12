import { describe, expect, it } from 'vitest'
import { parseYoutubeVideoUrl } from '../../../shared/youtubeUrl'
import { parseImportYoutubeUrl } from './youtube'

describe('parseImportYoutubeUrl', () => {
  it('parseYoutubeVideoUrl 결과를 그대로 반환한다', () => {
    const samples = [
      '',
      'not a url',
      'https://youtu.be/dQw4w9WgXcQ',
      '  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ',
      'https://www.youtube.com/playlist?list=PLxxx',
      'https://example.com/watch?v=abc',
      'https://www.youtube.com/shorts/shortId11'
    ]
    for (const raw of samples) {
      expect(parseImportYoutubeUrl(raw)).toEqual(parseYoutubeVideoUrl(raw))
    }
  })
})
