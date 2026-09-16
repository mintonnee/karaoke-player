import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  youtubePreviewMessage,
  type YoutubePreviewMetadata,
  type YoutubePreviewRequest,
  type YoutubePreviewResult
} from '../../../shared/types'
import {
  applyYoutubePreviewToForm,
  canSubmit,
  emptyImportForm,
  setImportUrl,
  setSongArtist,
  setSongTitle,
  songMetaFromForm,
  type ImportFormState
} from './form'
import {
  YOUTUBE_PREVIEW_DEBOUNCE_MS,
  createYoutubePreviewController,
  shouldApplyYoutubePreviewResult,
  type YoutubePreviewController,
  type YoutubePreviewLookupApi
} from './youtubePreview'

const URL_A = 'https://youtu.be/dQw4w9WgXcQ'
const URL_B = 'https://youtu.be/jNQXAC9IVRw'
const SESSION = 'preview-session'

function readyResult(
  requestId: string,
  metadata?: Partial<YoutubePreviewMetadata>,
  thumbnailWarning: string | null = null
): YoutubePreviewResult {
  return {
    requestId,
    status: 'ready',
    code: 'READY',
    canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    message: youtubePreviewMessage('READY'),
    checkedAt: 1_700_000_000_000,
    metadata: {
      title: metadata?.title === undefined ? 'YT 제목' : metadata.title,
      artist: metadata?.artist === undefined ? 'YT 가수' : metadata.artist,
      thumbnailDataUrl:
        metadata?.thumbnailDataUrl === undefined
          ? 'data:image/jpeg;base64,abc'
          : metadata.thumbnailDataUrl
    },
    thumbnailWarning
  }
}

function blockedResult(requestId: string): YoutubePreviewResult {
  return {
    requestId,
    status: 'blocked',
    code: 'DRM_PROTECTED',
    canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    message: youtubePreviewMessage('DRM_PROTECTED'),
    checkedAt: 1_700_000_000_001,
    metadata: { title: '보호됨', artist: null, thumbnailDataUrl: null },
    thumbnailWarning: null
  }
}

function errorResult(requestId: string): YoutubePreviewResult {
  return {
    requestId,
    status: 'error',
    code: 'NETWORK',
    canonicalUrl: null,
    message: youtubePreviewMessage('NETWORK'),
    checkedAt: null,
    metadata: null,
    thumbnailWarning: null
  }
}

function cancelledResult(requestId: string): YoutubePreviewResult {
  return {
    requestId,
    status: 'cancelled',
    code: 'CANCELLED',
    canonicalUrl: null,
    message: youtubePreviewMessage('CANCELLED'),
    checkedAt: null,
    metadata: null,
    thumbnailWarning: null
  }
}

interface Harness {
  controller: YoutubePreviewController
  preview: ReturnType<typeof vi.fn<(req: YoutubePreviewRequest) => Promise<YoutubePreviewResult>>>
  cancel: ReturnType<typeof vi.fn<(req: { requestId: string }) => Promise<void>>>
  pending: Map<
    string,
    {
      resolve: (result: YoutubePreviewResult) => void
      reject: (error: unknown) => void
    }
  >
}

function createHarness(): Harness {
  const pending = new Map<
    string,
    {
      resolve: (result: YoutubePreviewResult) => void
      reject: (error: unknown) => void
    }
  >()
  const preview = vi.fn((req: YoutubePreviewRequest) => {
    return new Promise<YoutubePreviewResult>((resolve, reject) => {
      pending.set(req.requestId, { resolve, reject })
    })
  })
  const cancel = vi.fn(async () => undefined)
  const api: YoutubePreviewLookupApi = {
    previewYoutube: preview,
    cancelYoutubePreview: cancel
  }
  const controller = createYoutubePreviewController({ sessionId: SESSION, api })
  return { controller, preview, cancel, pending }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function resolveRequest(
  harness: Harness,
  requestId: string,
  result: YoutubePreviewResult
): Promise<void> {
  const pending = harness.pending.get(requestId)
  expect(pending).toBeDefined()
  pending?.resolve(result)
  await flush()
}

describe('shouldApplyYoutubePreviewResult', () => {
  it('세션·generation·URL·method가 모두 맞을 때만 적용한다', () => {
    const result = readyResult(`${SESSION}:1`)
    expect(
      shouldApplyYoutubePreviewResult({
        sessionId: SESSION,
        generation: 1,
        url: URL_A,
        method: 'url',
        requestId: `${SESSION}:1`,
        requestUrl: URL_A,
        result
      })
    ).toBe(true)
    expect(
      shouldApplyYoutubePreviewResult({
        sessionId: SESSION,
        generation: 1,
        url: URL_B,
        method: 'url',
        requestId: `${SESSION}:1`,
        requestUrl: URL_A,
        result
      })
    ).toBe(false)
    expect(
      shouldApplyYoutubePreviewResult({
        sessionId: SESSION,
        generation: 2,
        url: URL_A,
        method: 'url',
        requestId: `${SESSION}:1`,
        requestUrl: URL_A,
        result
      })
    ).toBe(false)
    expect(
      shouldApplyYoutubePreviewResult({
        sessionId: SESSION,
        generation: 1,
        url: URL_A,
        method: 'general',
        requestId: `${SESSION}:1`,
        requestUrl: URL_A,
        result
      })
    ).toBe(false)
    expect(
      shouldApplyYoutubePreviewResult({
        sessionId: SESSION,
        generation: 1,
        url: URL_A,
        method: 'url',
        requestId: `${SESSION}:1`,
        requestUrl: URL_A,
        result: cancelledResult(`${SESSION}:1`)
      })
    ).toBe(false)
  })
})

describe('YoutubePreviewController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('빈 입력은 idle이고 조회하지 않으며 제출할 수 없다', async () => {
    const harness = createHarness()
    harness.controller.setMethod('url')
    harness.controller.setUrl('')
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS)
    expect(harness.controller.snapshot().status).toBe('idle')
    expect(harness.controller.snapshot().description).toBe('YouTube 동영상 URL을 입력하세요')
    expect(harness.preview).not.toHaveBeenCalled()
    expect(canSubmit({ ...emptyImportForm(), method: 'url', url: '' })).toBe(false)
    harness.controller.dispose()
  })

  it('잘못된 URL은 invalid이고 원격 조회를 하지 않는다', async () => {
    const harness = createHarness()
    harness.controller.setMethod('url')
    harness.controller.setUrl('https://example.com/watch?v=abc')
    await vi.advanceTimersByTimeAsync(1000)
    expect(harness.preview).not.toHaveBeenCalled()
    expect(harness.controller.snapshot().status).toBe('invalid')
    expect(harness.controller.snapshot().description).toBe(
      'YouTube 동영상 URL만 가져올 수 있습니다'
    )
    harness.controller.dispose()
  })

  it('재생목록 URL은 파서 이유를 표시하고 조회하지 않는다', async () => {
    const harness = createHarness()
    harness.controller.setMethod('url')
    harness.controller.setUrl('https://www.youtube.com/playlist?list=PLxxx')
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS)
    expect(harness.preview).not.toHaveBeenCalled()
    expect(harness.controller.snapshot().status).toBe('invalid')
    expect(harness.controller.snapshot().description).toBe('재생목록 URL은 가져올 수 없습니다')
    harness.controller.dispose()
  })

  it('499ms에서는 조회하지 않고 500ms에서 1회 조회한다', async () => {
    const harness = createHarness()
    harness.controller.setMethod('url')
    harness.controller.setUrl(URL_A)
    expect(harness.controller.snapshot().status).toBe('debouncing')
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS - 1)
    expect(harness.preview).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.preview).toHaveBeenCalledTimes(1)
    expect(harness.preview.mock.calls[0]?.[0]).toEqual({
      requestId: `${SESSION}:1`,
      url: URL_A
    })
    expect(harness.controller.snapshot().status).toBe('checking')
    harness.controller.dispose()
  })

  it('붙여넣기도 같은 500ms debounce를 쓴다', async () => {
    const harness = createHarness()
    harness.controller.setMethod('url')
    harness.controller.setUrl(URL_A)
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS)
    expect(harness.preview).toHaveBeenCalledTimes(1)
    harness.controller.dispose()
  })

  it('A 다음 B는 B만 적용한다', async () => {
    const harness = createHarness()
    harness.controller.setMethod('url')
    harness.controller.setUrl(URL_A)
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS)
    harness.controller.setUrl(URL_B)
    expect(harness.cancel).toHaveBeenCalledWith({ requestId: `${SESSION}:1` })
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS)
    expect(harness.preview).toHaveBeenCalledTimes(2)
    expect(harness.preview.mock.calls[1]?.[0].url).toBe(URL_B)
    await resolveRequest(harness, `${SESSION}:1`, readyResult(`${SESSION}:1`))
    expect(harness.controller.snapshot().status).toBe('checking')
    await resolveRequest(harness, `${SESSION}:2`, readyResult(`${SESSION}:2`))
    expect(harness.controller.snapshot().status).toBe('ready')
    expect(harness.controller.snapshot().result?.requestId).toBe(`${SESSION}:2`)
    harness.controller.dispose()
  })

  it('A→B→A에서 첫 A의 늦은 응답은 적용하지 않는다', async () => {
    const harness = createHarness()
    harness.controller.setMethod('url')
    harness.controller.setUrl(URL_A)
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS)
    harness.controller.setUrl(URL_B)
    harness.controller.setUrl(URL_A)
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS)
    expect(harness.preview).toHaveBeenCalledTimes(2)
    expect(harness.preview.mock.calls[1]?.[0]).toEqual({
      requestId: `${SESSION}:2`,
      url: URL_A
    })
    await resolveRequest(harness, `${SESSION}:1`, readyResult(`${SESSION}:1`))
    expect(harness.controller.snapshot().status).toBe('checking')
    expect(harness.controller.snapshot().result).toBeNull()
    await resolveRequest(harness, `${SESSION}:2`, readyResult(`${SESSION}:2`))
    expect(harness.controller.snapshot().status).toBe('ready')
    expect(harness.controller.snapshot().generation).toBe(2)
    harness.controller.dispose()
  })

  it('다시 확인은 debounce 없이 새 요청을 시작한다', async () => {
    const harness = createHarness()
    harness.controller.setMethod('url')
    harness.controller.setUrl(URL_A)
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS)
    await resolveRequest(harness, `${SESSION}:1`, errorResult(`${SESSION}:1`))
    expect(harness.controller.snapshot().status).toBe('error')
    expect(harness.controller.snapshot().showRetry).toBe(true)
    expect(harness.controller.snapshot().description).toBe(youtubePreviewMessage('NETWORK'))
    harness.controller.retry()
    expect(harness.preview).toHaveBeenCalledTimes(2)
    expect(harness.preview.mock.calls[1]?.[0].requestId).toBe(`${SESSION}:2`)
    expect(harness.controller.snapshot().status).toBe('checking')
    harness.controller.dispose()
  })

  it('방식 전환과 dispose는 진행 중 요청을 취소한다', async () => {
    const harness = createHarness()
    harness.controller.setMethod('url')
    harness.controller.setUrl(URL_A)
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS)
    harness.controller.setMethod('general')
    expect(harness.cancel).toHaveBeenCalledWith({ requestId: `${SESSION}:1` })
    await resolveRequest(harness, `${SESSION}:1`, readyResult(`${SESSION}:1`))
    expect(harness.controller.snapshot().status).toBe('idle')
    expect(harness.controller.snapshot().result).toBeNull()

    harness.controller.setMethod('url')
    harness.controller.setUrl(URL_A)
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS)
    harness.controller.dispose()
    expect(harness.cancel).toHaveBeenCalledWith({ requestId: `${SESSION}:2` })
    await resolveRequest(harness, `${SESSION}:2`, readyResult(`${SESSION}:2`))
    expect(harness.controller.snapshot().result).toBeNull()
    expect(harness.controller.snapshot().status).not.toBe('ready')
  })

  it('IME 조합 중에는 조회하지 않고 compositionend 뒤에 예약한다', async () => {
    const harness = createHarness()
    harness.controller.setMethod('url')
    harness.controller.setComposing(true)
    harness.controller.setUrl(URL_A)
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS)
    expect(harness.preview).not.toHaveBeenCalled()
    expect(harness.controller.snapshot().status).toBe('debouncing')
    harness.controller.setComposing(false)
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS - 1)
    expect(harness.preview).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.preview).toHaveBeenCalledTimes(1)
    harness.controller.dispose()
  })

  it('blocked는 제출을 막고 안내 문구를 code에서 만든다', async () => {
    const harness = createHarness()
    harness.controller.setMethod('url')
    harness.controller.setUrl(URL_A)
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS)
    await resolveRequest(harness, `${SESSION}:1`, blockedResult(`${SESSION}:1`))
    expect(harness.controller.snapshot().status).toBe('blocked')
    expect(harness.controller.snapshot().description).toBe(youtubePreviewMessage('DRM_PROTECTED'))
    expect(harness.controller.snapshot().showRetry).toBe(false)
    harness.controller.dispose()
  })

  it('조회 예외는 error로 두고 재시도할 수 있다', async () => {
    const harness = createHarness()
    harness.preview.mockRejectedValueOnce(new Error('boom'))
    harness.controller.setMethod('url')
    harness.controller.setUrl(URL_A)
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS)
    await flush()
    expect(harness.controller.snapshot().status).toBe('error')
    expect(harness.controller.snapshot().description).toBe(youtubePreviewMessage('UNKNOWN'))
    harness.controller.retry()
    expect(harness.preview).toHaveBeenCalledTimes(2)
    harness.controller.dispose()
  })

  it('url 방식이 아니면 조회 IPC를 호출하지 않는다', async () => {
    const harness = createHarness()
    harness.controller.setMethod('general')
    harness.controller.setUrl(URL_A)
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS)
    expect(harness.preview).not.toHaveBeenCalled()
    harness.controller.dispose()
  })

  it('같은 URL로 돌아와도 이전 성공을 재사용하지 않는다', async () => {
    const harness = createHarness()
    harness.controller.setMethod('url')
    harness.controller.setUrl(URL_A)
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS)
    await resolveRequest(harness, `${SESSION}:1`, readyResult(`${SESSION}:1`))
    expect(harness.controller.snapshot().status).toBe('ready')
    harness.controller.setUrl(URL_B)
    harness.controller.setUrl(URL_A)
    expect(harness.controller.snapshot().status).toBe('debouncing')
    expect(harness.controller.snapshot().result).toBeNull()
    await vi.advanceTimersByTimeAsync(YOUTUBE_PREVIEW_DEBOUNCE_MS)
    expect(harness.preview).toHaveBeenCalledTimes(2)
    harness.controller.dispose()
  })
})

describe('youtube preview form fill', () => {
  function urlForm(url = URL_A): ImportFormState {
    return { ...emptyImportForm(), method: 'url' as const, url }
  }

  it('blocked도 메타데이터는 채우지만 제출은 막는다', () => {
    const next = applyYoutubePreviewToForm(urlForm(), blockedResult('s:1'), 1, URL_A)
    expect(next.title).toBe('보호됨')
    expect(next.titleOrigin).toBe('youtube')
    expect(next.urlPreviewReady).toBe(false)
    expect(canSubmit(next)).toBe(false)
  })

  it('제목·아티스트·썸네일을 채우되 coverPath는 건드리지 않는다', () => {
    const next = applyYoutubePreviewToForm(urlForm(), readyResult('s:1'), 1, URL_A)
    expect(next.title).toBe('YT 제목')
    expect(next.artist).toBe('YT 가수')
    expect(next.titleOrigin).toBe('youtube')
    expect(next.titleYoutubeGeneration).toBe(1)
    expect(next.youtubeThumbnailDataUrl).toBe('data:image/jpeg;base64,abc')
    expect(next.coverPath).toBeNull()
    expect(next.urlPreviewReady).toBe(true)
    expect(canSubmit(next)).toBe(true)
  })

  it('썸네일 경고는 ready를 막지 않는다', () => {
    const next = applyYoutubePreviewToForm(
      urlForm(),
      readyResult('s:1', { thumbnailDataUrl: null }, 'too large'),
      1,
      URL_A
    )
    expect(next.urlPreviewReady).toBe(true)
    expect(next.youtubeThumbnailWarning).toBe('too large')
    expect(canSubmit(next)).toBe(true)
  })

  it('사용자가 지운 칸은 늦은 응답이 다시 채우지 않는다', () => {
    const filled = applyYoutubePreviewToForm(urlForm(), readyResult('s:1'), 1, URL_A)
    const cleared = setSongTitle(filled, '')
    const late = applyYoutubePreviewToForm(cleared, readyResult('s:2'), 2, URL_A)
    expect(cleared.titleOrigin).toBe('user')
    expect(late.title).toBe('')
    expect(late.artist).toBe('YT 가수')
  })

  it('URL이 바뀌면 자동값만 지우고 수동값·로컬 커버는 남긴다', () => {
    const filled = applyYoutubePreviewToForm(
      { ...urlForm(), coverPath: 'C:\\art.png' },
      readyResult('s:1'),
      1,
      URL_A
    )
    const edited = setSongTitle(filled, '직접 제목')
    const changed = setImportUrl(edited, URL_B)
    expect(changed.title).toBe('직접 제목')
    expect(changed.artist).toBe('')
    expect(changed.artistOrigin).toBeNull()
    expect(changed.coverPath).toBe('C:\\art.png')
    expect(changed.youtubeThumbnailDataUrl).toBeNull()
    expect(changed.urlPreviewReady).toBe(false)
    expect(canSubmit(changed)).toBe(false)
  })

  it('같은 URL 재조회는 dirty가 아닌 필드만 갱신한다', () => {
    const filled = applyYoutubePreviewToForm(urlForm(), readyResult('s:1'), 1, URL_A)
    const dirtyArtist = setSongArtist(filled, '직접 가수')
    const again = applyYoutubePreviewToForm(
      dirtyArtist,
      readyResult('s:2', { title: '새 제목', artist: '새 가수' }),
      2,
      URL_A
    )
    expect(again.title).toBe('새 제목')
    expect(again.artist).toBe('직접 가수')
  })

  it('songMetaFromForm URL 경로는 자동값을 보내지 않는다', () => {
    const auto = applyYoutubePreviewToForm(
      { ...urlForm(), coverPath: 'C:\\art.png' },
      readyResult('s:1'),
      1,
      URL_A
    )
    expect(songMetaFromForm(auto)).toEqual({ coverPath: 'C:\\art.png' })
    const manual = setSongTitle(auto, '직접 제목')
    expect(songMetaFromForm(manual)).toEqual({
      title: '직접 제목',
      coverPath: 'C:\\art.png'
    })
  })
})
