import {
  makeYoutubePreviewRequestId,
  parseYoutubePreviewResult,
  youtubePreviewMessage,
  type YoutubePreviewCancelRequest,
  type YoutubePreviewCode,
  type YoutubePreviewRequest,
  type YoutubePreviewResult
} from '../../../shared/types'
import { parseYoutubeVideoUrl } from '../../../shared/youtubeUrl'
import type { ImportMethod } from './form'

export const YOUTUBE_PREVIEW_DEBOUNCE_MS = 500

export const YOUTUBE_PREVIEW_IDLE_DESCRIPTION = 'YouTube 동영상 URL을 입력하세요'
export const YOUTUBE_PREVIEW_DEBOUNCE_DESCRIPTION = '확인 대기 중'
export const YOUTUBE_PREVIEW_CHECKING_DESCRIPTION = '가져올 수 있는지 확인 중'
export const YOUTUBE_THUMBNAIL_LOAD_FAILED = '썸네일을 불러오지 못했습니다'

export type YoutubePreviewUiStatus =
  'idle' | 'invalid' | 'debouncing' | 'checking' | 'ready' | 'blocked' | 'error'

export interface YoutubePreviewSnapshot {
  sessionId: string
  generation: number
  status: YoutubePreviewUiStatus
  description: string
  url: string
  method: ImportMethod | null
  composing: boolean
  requestId: string | null
  result: YoutubePreviewResult | null
  code: YoutubePreviewCode | null
  invalidReason: string | null
  showRetry: boolean
}

export interface YoutubePreviewLookupApi {
  previewYoutube: (req: YoutubePreviewRequest) => Promise<unknown>
  cancelYoutubePreview: (req: YoutubePreviewCancelRequest) => Promise<void>
}

export interface YoutubePreviewControllerOptions {
  sessionId?: string
  api: YoutubePreviewLookupApi
  onChange?: (snapshot: YoutubePreviewSnapshot) => void
}

interface InFlightLookup {
  requestId: string
  url: string
  generation: number
}

export function createYoutubePreviewSessionId(): string {
  return crypto.randomUUID()
}

export function idleYoutubePreviewSnapshot(sessionId: string): YoutubePreviewSnapshot {
  return {
    sessionId,
    generation: 0,
    status: 'idle',
    description: YOUTUBE_PREVIEW_IDLE_DESCRIPTION,
    url: '',
    method: null,
    composing: false,
    requestId: null,
    result: null,
    code: null,
    invalidReason: null,
    showRetry: false
  }
}

export function youtubePreviewDescription(
  status: YoutubePreviewUiStatus,
  detail?: { invalidReason?: string | null; code?: YoutubePreviewCode | null }
): string {
  switch (status) {
    case 'idle':
      return YOUTUBE_PREVIEW_IDLE_DESCRIPTION
    case 'invalid':
      return detail?.invalidReason?.trim() || youtubePreviewMessage('INVALID_URL')
    case 'debouncing':
      return YOUTUBE_PREVIEW_DEBOUNCE_DESCRIPTION
    case 'checking':
      return YOUTUBE_PREVIEW_CHECKING_DESCRIPTION
    case 'ready':
      return youtubePreviewMessage('READY')
    case 'blocked':
      return detail?.code
        ? youtubePreviewMessage(detail.code)
        : youtubePreviewMessage('UNAVAILABLE')
    case 'error':
      return detail?.code ? youtubePreviewMessage(detail.code) : youtubePreviewMessage('UNKNOWN')
  }
}

export function shouldApplyYoutubePreviewResult(args: {
  sessionId: string
  generation: number
  url: string
  method: ImportMethod | null
  requestId: string
  requestUrl: string
  result: YoutubePreviewResult
}): boolean {
  if (args.method !== 'url') return false
  if (args.result.status === 'cancelled') return false
  if (args.url !== args.requestUrl) return false
  if (args.result.requestId !== args.requestId) return false
  const expected = makeYoutubePreviewRequestId(args.sessionId, args.generation)
  return args.requestId === expected
}

export function createYoutubePreviewController(
  options: YoutubePreviewControllerOptions
): YoutubePreviewController {
  return new YoutubePreviewController(options)
}

export class YoutubePreviewController {
  private readonly sessionId: string
  private readonly api: YoutubePreviewLookupApi
  private onChange: ((snapshot: YoutubePreviewSnapshot) => void) | undefined
  private generation = 0
  private url = ''
  private method: ImportMethod | null = null
  private composing = false
  private status: YoutubePreviewUiStatus = 'idle'
  private invalidReason: string | null = null
  private code: YoutubePreviewCode | null = null
  private result: YoutubePreviewResult | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: InFlightLookup | null = null
  private disposed = false

  constructor(options: YoutubePreviewControllerOptions) {
    this.sessionId = options.sessionId ?? createYoutubePreviewSessionId()
    this.api = options.api
    this.onChange = options.onChange
  }

  snapshot(): YoutubePreviewSnapshot {
    return {
      sessionId: this.sessionId,
      generation: this.generation,
      status: this.status,
      description: youtubePreviewDescription(this.status, {
        invalidReason: this.invalidReason,
        code: this.code
      }),
      url: this.url,
      method: this.method,
      composing: this.composing,
      requestId: this.inFlight?.requestId ?? null,
      result: this.result,
      code: this.code,
      invalidReason: this.invalidReason,
      showRetry: this.status === 'error'
    }
  }

  setUrl(url: string): void {
    if (this.disposed) return
    const changed = url !== this.url
    this.url = url
    if (this.method !== 'url') {
      this.emit()
      return
    }
    if (changed) {
      this.resetLookupVisual()
      this.cancelInFlight()
    }
    this.reschedule()
  }

  setMethod(method: ImportMethod | null): void {
    if (this.disposed) return
    if (this.method === method) return
    this.method = method
    this.clearTimer()
    this.cancelInFlight()
    this.result = null
    this.code = null
    if (method !== 'url') {
      this.url = ''
      this.status = 'idle'
      this.invalidReason = null
      this.composing = false
      this.emit()
      return
    }
    this.resetLookupVisual()
    this.reschedule()
  }

  setComposing(composing: boolean): void {
    if (this.disposed) return
    if (this.composing === composing) return
    this.composing = composing
    if (composing) {
      this.clearTimer()
      return
    }
    this.reschedule()
  }

  retry(): void {
    if (this.disposed || this.method !== 'url' || this.composing) return
    if (!parseYoutubeVideoUrl(this.url).ok) return
    this.clearTimer()
    this.cancelInFlight()
    this.startLookup()
  }

  /** 다운로드 시작 후 실패. ready를 해제하고 재확인 가능하게 한다 */
  invalidateReady(): void {
    if (this.disposed) return
    if (this.method !== 'url') {
      this.status = 'idle'
      this.result = null
      this.code = null
      this.emit()
      return
    }
    const parsed = parseYoutubeVideoUrl(this.url)
    this.result = null
    if (this.url.trim() === '') {
      this.status = 'idle'
      this.code = null
      this.invalidReason = null
    } else if (!parsed.ok) {
      this.status = 'invalid'
      this.code = 'INVALID_URL'
      this.invalidReason = parsed.reason
    } else {
      this.status = 'error'
      this.code = 'UNKNOWN'
      this.invalidReason = null
    }
    this.emit()
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
    this.cancelInFlight()
    this.onChange = undefined
  }

  private reschedule(): void {
    this.clearTimer()
    if (this.disposed || this.method !== 'url') return
    if (this.url.trim() === '') {
      this.status = 'idle'
      this.invalidReason = null
      this.code = null
      this.result = null
      this.emit()
      return
    }
    const parsed = parseYoutubeVideoUrl(this.url)
    if (!parsed.ok) {
      this.status = 'invalid'
      this.invalidReason = parsed.reason
      this.code = 'INVALID_URL'
      this.result = null
      this.emit()
      return
    }
    if (this.composing) {
      if (
        this.status !== 'checking' &&
        this.status !== 'ready' &&
        this.status !== 'blocked' &&
        this.status !== 'error'
      ) {
        this.status = 'debouncing'
        this.invalidReason = null
      }
      this.emit()
      return
    }
    if (this.inFlight && this.inFlight.url === this.url) {
      this.emit()
      return
    }
    if (
      this.inFlight == null &&
      (this.status === 'ready' || this.status === 'blocked' || this.status === 'error')
    ) {
      this.emit()
      return
    }
    this.status = 'debouncing'
    this.invalidReason = null
    this.emit()
    this.timer = setTimeout(() => {
      this.timer = null
      this.startLookup()
    }, YOUTUBE_PREVIEW_DEBOUNCE_MS)
  }

  private resetLookupVisual(): void {
    this.result = null
    this.code = null
    this.invalidReason = null
    if (this.url.trim() === '') {
      this.status = 'idle'
      return
    }
    const parsed = parseYoutubeVideoUrl(this.url)
    if (!parsed.ok) {
      this.status = 'invalid'
      this.invalidReason = parsed.reason
      this.code = 'INVALID_URL'
      return
    }
    this.status = 'debouncing'
  }

  private startLookup(): void {
    if (this.disposed || this.method !== 'url' || this.composing) return
    const parsed = parseYoutubeVideoUrl(this.url)
    if (!parsed.ok) {
      this.resetLookupVisual()
      this.emit()
      return
    }
    this.generation += 1
    const generation = this.generation
    const url = this.url
    const requestId = makeYoutubePreviewRequestId(this.sessionId, generation)
    this.inFlight = { requestId, url, generation }
    this.status = 'checking'
    this.result = null
    this.code = null
    this.invalidReason = null
    this.emit()
    void this.runLookup(requestId, url, generation)
  }

  private async runLookup(requestId: string, url: string, generation: number): Promise<void> {
    try {
      const raw = await this.api.previewYoutube({ requestId, url })
      this.handleRaw(raw, requestId, url, generation)
    } catch {
      this.handleLookupFailure(requestId, url, generation)
    }
  }

  private handleRaw(raw: unknown, requestId: string, url: string, generation: number): void {
    if (this.disposed) return
    const parsed = parseYoutubePreviewResult(raw)
    if (parsed == null) {
      this.handleLookupFailure(requestId, url, generation)
      return
    }
    if (generation !== this.generation) return
    if (
      !shouldApplyYoutubePreviewResult({
        sessionId: this.sessionId,
        generation: this.generation,
        url: this.url,
        method: this.method,
        requestId,
        requestUrl: url,
        result: parsed
      })
    ) {
      return
    }
    this.inFlight = null
    this.result = parsed
    this.code = parsed.code
    this.invalidReason = null
    if (parsed.status === 'ready') this.status = 'ready'
    else if (parsed.status === 'blocked') this.status = 'blocked'
    else this.status = 'error'
    this.emit()
  }

  private handleLookupFailure(requestId: string, url: string, generation: number): void {
    if (this.disposed) return
    if (this.method !== 'url') return
    if (this.inFlight?.requestId !== requestId) return
    if (this.url !== url || this.generation !== generation) return
    this.inFlight = null
    this.result = null
    this.code = 'UNKNOWN'
    this.status = 'error'
    this.invalidReason = null
    this.emit()
  }

  private cancelInFlight(): void {
    const current = this.inFlight
    this.inFlight = null
    if (current == null) return
    void this.api.cancelYoutubePreview({ requestId: current.requestId }).then(
      () => undefined,
      () => undefined
    )
  }

  private clearTimer(): void {
    if (this.timer == null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private emit(): void {
    this.onChange?.(this.snapshot())
  }
}
