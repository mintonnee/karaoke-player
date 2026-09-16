import { describe, expect, it } from 'vitest'
import {
  IPC_CHANNELS,
  URL_IMPORT_DISABLED_REASON,
  YOUTUBE_PREVIEW_CODES,
  YOUTUBE_PREVIEW_MESSAGES,
  makeYoutubePreviewRequestId,
  parseYoutubePreviewResult,
  youtubePreviewMessage,
  youtubePreviewStatusForCode,
  type YoutubePreviewResult
} from '../types'

const READY: YoutubePreviewResult = {
  requestId: 'sess:1',
  canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  status: 'ready',
  code: 'READY',
  message: YOUTUBE_PREVIEW_MESSAGES.READY,
  checkedAt: 1_700_000_000_000,
  metadata: { title: '제목', artist: '가수', thumbnailDataUrl: 'data:image/jpeg;base64,abc' },
  thumbnailWarning: null
}

const BLOCKED: YoutubePreviewResult = {
  requestId: 'sess:2',
  canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  status: 'blocked',
  code: 'DRM_PROTECTED',
  message: YOUTUBE_PREVIEW_MESSAGES.DRM_PROTECTED,
  checkedAt: 1_700_000_000_001,
  metadata: { title: '보호됨', artist: null, thumbnailDataUrl: null },
  thumbnailWarning: null
}

const ERROR: YoutubePreviewResult = {
  requestId: 'sess:3',
  canonicalUrl: null,
  status: 'error',
  code: 'NETWORK',
  message: YOUTUBE_PREVIEW_MESSAGES.NETWORK,
  checkedAt: null,
  metadata: null,
  thumbnailWarning: null
}

const CANCELLED: YoutubePreviewResult = {
  requestId: 'sess:4',
  canonicalUrl: null,
  status: 'cancelled',
  code: 'CANCELLED',
  message: YOUTUBE_PREVIEW_MESSAGES.CANCELLED,
  checkedAt: null,
  metadata: null,
  thumbnailWarning: null
}

describe('YoutubePreviewResult 판별 유니온', () => {
  it('ready는 READY·canonicalUrl·checkedAt을 강제한다', () => {
    const result: YoutubePreviewResult = READY
    expect(result.status).toBe('ready')
    if (result.status === 'ready') {
      const code: 'READY' = result.code
      const canonicalUrl: string = result.canonicalUrl
      const checkedAt: number = result.checkedAt
      expect(code).toBe('READY')
      expect(canonicalUrl).toContain('watch?v=')
      expect(Number.isFinite(checkedAt)).toBe(true)
    }
  })

  it('blocked·error·cancelled는 각 status에 맞는 code만 가진다', () => {
    expect(BLOCKED.status).toBe('blocked')
    expect(BLOCKED.code).toBe('DRM_PROTECTED')
    expect(ERROR.status).toBe('error')
    expect(ERROR.code).toBe('NETWORK')
    expect(CANCELLED.status).toBe('cancelled')
    expect(CANCELLED.code).toBe('CANCELLED')
    expect(youtubePreviewStatusForCode('DRM_PROTECTED')).toBe('blocked')
    expect(youtubePreviewStatusForCode('INVALID_URL')).toBe('error')
    expect(youtubePreviewStatusForCode('DISABLED')).toBe('error')
    expect(youtubePreviewStatusForCode('CANCELLED')).toBe('cancelled')
    expect(youtubePreviewStatusForCode('READY')).toBe('ready')
  })
})

describe('parseYoutubePreviewResult', () => {
  it('유효한 ready/blocked/error/cancelled를 수락한다', () => {
    expect(parseYoutubePreviewResult(READY)).toEqual(READY)
    expect(parseYoutubePreviewResult(BLOCKED)).toEqual(BLOCKED)
    expect(parseYoutubePreviewResult(ERROR)).toEqual(ERROR)
    expect(parseYoutubePreviewResult(CANCELLED)).toEqual(CANCELLED)
  })

  it('ready에 canonicalUrl 또는 checkedAt이 없으면 거부한다', () => {
    expect(parseYoutubePreviewResult({ ...READY, canonicalUrl: null })).toBeNull()
    expect(parseYoutubePreviewResult({ ...READY, canonicalUrl: '' })).toBeNull()
    expect(parseYoutubePreviewResult({ ...READY, checkedAt: null })).toBeNull()
    expect(parseYoutubePreviewResult({ ...READY, checkedAt: Number.NaN })).toBeNull()
    expect(parseYoutubePreviewResult({ ...READY, checkedAt: Number.POSITIVE_INFINITY })).toBeNull()
    const { canonicalUrl: _canonicalUrl, ...noCanonical } = READY
    const { checkedAt: _checkedAt, ...noCheckedAt } = READY
    expect(parseYoutubePreviewResult(noCanonical)).toBeNull()
    expect(parseYoutubePreviewResult(noCheckedAt)).toBeNull()
  })

  it('status/code 불일치를 거부한다', () => {
    expect(parseYoutubePreviewResult({ ...READY, code: 'DRM_PROTECTED' })).toBeNull()
    expect(parseYoutubePreviewResult({ ...BLOCKED, code: 'READY' })).toBeNull()
    expect(parseYoutubePreviewResult({ ...BLOCKED, status: 'error' })).toBeNull()
    expect(parseYoutubePreviewResult({ ...ERROR, code: 'CANCELLED' })).toBeNull()
    expect(parseYoutubePreviewResult({ ...CANCELLED, status: 'error' })).toBeNull()
    expect(parseYoutubePreviewResult({ ...ERROR, code: 'DRM_PROTECTED' })).toBeNull()
  })

  it('비객체·잘못된 requestId 타입을 예외 없이 거부한다', () => {
    const junk = [
      null,
      undefined,
      'ready',
      1,
      [],
      { requestId: 12, status: 'ready', code: 'READY' }
    ]
    for (const raw of junk) {
      expect(() => parseYoutubePreviewResult(raw)).not.toThrow()
      expect(parseYoutubePreviewResult(raw)).toBeNull()
    }
  })

  it('신뢰할 수 없는 추가 필드를 통과시키지 않는다', () => {
    const raw = {
      ...READY,
      stderr: 'ERROR: private video\ncookie=secret',
      cookies: 'SID=abc',
      requested_downloads: [{ url: 'https://signed.example/media?token=xyz' }],
      url: 'https://signed.example/media?token=xyz',
      metadata: {
        title: '제목',
        artist: '가수',
        thumbnailDataUrl: 'data:image/jpeg;base64,abc',
        formats: [{ url: 'https://signed.example/audio' }],
        webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      }
    }
    const parsed = parseYoutubePreviewResult(raw)
    expect(parsed).toEqual(READY)
    expect(parsed).not.toHaveProperty('stderr')
    expect(parsed).not.toHaveProperty('cookies')
    expect(parsed).not.toHaveProperty('requested_downloads')
    expect(parsed).not.toHaveProperty('url')
    expect(parsed?.metadata).not.toHaveProperty('formats')
    expect(parsed?.metadata).not.toHaveProperty('webpage_url')
    expect(JSON.stringify(parsed)).not.toContain('SID=')
    expect(JSON.stringify(parsed)).not.toContain('signed.example')
    expect(JSON.stringify(parsed)).not.toContain('token=xyz')
  })

  it('DISABLED를 타입과 런타임에서 받을 수 있다', () => {
    const disabled: YoutubePreviewResult = {
      requestId: 'sess:9',
      canonicalUrl: null,
      status: 'error',
      code: 'DISABLED',
      message: YOUTUBE_PREVIEW_MESSAGES.DISABLED,
      checkedAt: null,
      metadata: null,
      thumbnailWarning: null
    }
    expect(parseYoutubePreviewResult(disabled)).toEqual(disabled)
    expect(disabled.code).toBe('DISABLED')
    expect(disabled.message).toBe(URL_IMPORT_DISABLED_REASON)
  })
})

describe('makeYoutubePreviewRequestId', () => {
  it('세션과 generation 조합이 서로 다르다', () => {
    const a = makeYoutubePreviewRequestId('popup-a', 1)
    const b = makeYoutubePreviewRequestId('popup-a', 2)
    const c = makeYoutubePreviewRequestId('popup-b', 1)
    expect(new Set([a, b, c]).size).toBe(3)
    expect(makeYoutubePreviewRequestId('popup-a', 1)).toBe(a)
  })
})

describe('YOUTUBE_PREVIEW_MESSAGES', () => {
  it('모든 code에 사용자 메시지가 있다', () => {
    for (const code of YOUTUBE_PREVIEW_CODES) {
      expect(YOUTUBE_PREVIEW_MESSAGES[code].length).toBeGreaterThan(0)
      expect(youtubePreviewMessage(code)).toBe(YOUTUBE_PREVIEW_MESSAGES[code])
    }
    expect(YOUTUBE_PREVIEW_MESSAGES.DRM_PROTECTED).toBe(
      'DRM으로 보호된 콘텐츠는 가져올 수 없습니다'
    )
    expect(YOUTUBE_PREVIEW_MESSAGES.NETWORK).toBe('확인하지 못했습니다. 다시 시도해 주세요')
    expect(YOUTUBE_PREVIEW_MESSAGES.INVALID_URL).toBe('올바른 YouTube 동영상 URL을 입력하세요')
    expect(YOUTUBE_PREVIEW_MESSAGES.DISABLED).toBe(URL_IMPORT_DISABLED_REASON)
  })
})

describe('IPC_CHANNELS', () => {
  it('미리보기 채널을 importUrl 옆에 둔다', () => {
    expect(IPC_CHANNELS.importUrl).toBe('library:import-url')
    expect(IPC_CHANNELS.previewYoutube).toBe('library:preview-youtube')
    expect(IPC_CHANNELS.cancelYoutubePreview).toBe('library:cancel-youtube-preview')
  })
})
