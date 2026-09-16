import { describe, expect, it } from 'vitest'
import {
  buildYoutubePreviewResult,
  classifyYoutubePreviewJson
} from '../../src/main/library/YoutubePreviewService'
import {
  applyYoutubePreviewToForm,
  canSubmit,
  emptyImportForm,
  setSongTitle,
  songMetaFromForm
} from '../../src/renderer/src/import/form'
import { parseYoutubeVideoUrl } from '../../src/shared/youtubeUrl'

const URL = 'https://youtu.be/dQw4w9WgXcQ'
const CANONICAL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

function m4a(hasDrm?: boolean): Record<string, unknown> {
  const format: Record<string, unknown> = {
    format_id: '140',
    ext: 'm4a',
    acodec: 'mp4a.40.2',
    vcodec: 'none',
    audio_ext: 'm4a',
    video_ext: 'none'
  }
  if (hasDrm !== undefined) format.has_drm = hasDrm
  return format
}

describe('009 preview slices compose', () => {
  it('잘못된 URL·재생목록은 파서에서 막고 제출할 수 없다', () => {
    expect(parseYoutubeVideoUrl('https://example.com/watch?v=dQw4w9WgXcQ').ok).toBe(false)
    expect(parseYoutubeVideoUrl('https://www.youtube.com/playlist?list=PLxxx').ok).toBe(false)
    expect(canSubmit({ ...emptyImportForm(), method: 'url', url: URL })).toBe(false)
  })

  it('지원 URL은 같은 canonical로 모이고, 비보호 m4a가 확인돼야 제출한다', () => {
    const parsed = parseYoutubeVideoUrl(`  ${URL}?t=12&si=abc  `)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.canonicalUrl).toBe(CANONICAL)

    const classified = classifyYoutubePreviewJson(
      {
        title: '미리보기 제목',
        artist: '미리보기 가수 - Topic',
        has_drm: false,
        formats: [m4a(false)]
      },
      '',
      0
    )
    expect(classified.code).toBe('READY')
    expect(classified.artist).toBe('미리보기 가수')

    const result = buildYoutubePreviewResult({
      requestId: 'popup:1',
      code: 'READY',
      canonicalUrl: parsed.canonicalUrl,
      checkedAt: 1,
      metadata: {
        title: classified.title,
        artist: classified.artist,
        thumbnailDataUrl: 'data:image/jpeg;base64,abc'
      },
      thumbnailWarning: null
    })
    const form = applyYoutubePreviewToForm(
      { ...emptyImportForm(), method: 'url', url: URL },
      result,
      1,
      URL
    )
    expect(form.title).toBe('미리보기 제목')
    expect(form.artist).toBe('미리보기 가수')
    expect(form.coverPath).toBeNull()
    expect(form.youtubeThumbnailDataUrl).toBe('data:image/jpeg;base64,abc')
    expect(canSubmit(form)).toBe(true)
    expect(songMetaFromForm(form)).toBeUndefined()
  })

  it('DRM은 메타를 채울 수 있어도 제출을 막고, 수동 제목만 ImportUserMeta로 보낸다', () => {
    const classified = classifyYoutubePreviewJson(
      { title: '보호됨', has_drm: true, formats: [m4a(true)] },
      '',
      0
    )
    expect(classified.code).toBe('DRM_PROTECTED')
    const result = buildYoutubePreviewResult({
      requestId: 'popup:2',
      code: classified.code,
      canonicalUrl: CANONICAL,
      checkedAt: 1,
      metadata: { title: classified.title, artist: null, thumbnailDataUrl: null },
      thumbnailWarning: null
    })
    const filled = applyYoutubePreviewToForm(
      { ...emptyImportForm(), method: 'url', url: URL },
      result,
      2,
      URL
    )
    expect(filled.title).toBe('보호됨')
    expect(canSubmit(filled)).toBe(false)

    const typed = setSongTitle({ ...emptyImportForm(), method: 'url', url: URL }, '내가 적은 제목')
    const ready = buildYoutubePreviewResult({
      requestId: 'popup:3',
      code: 'READY',
      canonicalUrl: CANONICAL,
      checkedAt: 1,
      metadata: { title: '조회 제목', artist: '조회 가수', thumbnailDataUrl: null },
      thumbnailWarning: null
    })
    const mixed = applyYoutubePreviewToForm(typed, ready, 3, URL)
    expect(mixed.title).toBe('내가 적은 제목')
    expect(mixed.artist).toBe('조회 가수')
    expect(canSubmit(mixed)).toBe(true)
    expect(songMetaFromForm(mixed)).toEqual({ title: '내가 적은 제목' })
  })
})
