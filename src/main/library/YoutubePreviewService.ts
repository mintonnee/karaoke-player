import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { isIP } from 'node:net'
import {
  youtubePreviewMessage,
  youtubePreviewStatusForCode,
  type YoutubePreviewBlockedCode,
  type YoutubePreviewCode,
  type YoutubePreviewErrorCode,
  type YoutubePreviewMetadata,
  type YoutubePreviewRequest,
  type YoutubePreviewResult
} from '../../shared/types'
import { parseYoutubeVideoUrl } from '../../shared/youtubeUrl'
import { normalizeArtist, type BinaryHashSpec, type VerifyCommandFn } from './YtDlpService'

export const YOUTUBE_PREVIEW_LOOKUP_MS = 20_000
export const YOUTUBE_PREVIEW_THUMBNAIL_MS = 5_000
export const YOUTUBE_PREVIEW_TOTAL_MS = 25_000
export const YOUTUBE_PREVIEW_CACHE_TTL_MS = 60_000
export const YOUTUBE_PREVIEW_STDOUT_MAX = 8 * 1024 * 1024
export const YOUTUBE_PREVIEW_STDERR_MAX_BYTES = 64 * 1024
export const YOUTUBE_PREVIEW_STDERR_MAX_LINES = 40
export const YOUTUBE_PREVIEW_FORMAT_POLICY = 'bestaudio[ext=m4a]'
export const YOUTUBE_THUMBNAIL_WARNING = '썸네일을 불러오지 못했습니다'
export const YOUTUBE_THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024
export const YOUTUBE_THUMBNAIL_MAX_PIXELS = 16 * 1024 * 1024
export const YOUTUBE_THUMBNAIL_MAX_DATA_URL = 1024 * 1024
export const YOUTUBE_THUMBNAIL_MAX_EDGE = 512

const THUMB_HOSTS = new Set(['i.ytimg.com', 'img.youtube.com'])
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface YoutubePreviewSender {
  readonly id: number
}

export interface YoutubePreviewServiceOptions {
  command: string
  baseArgs?: string[]
  denoPath: string
  ytDlpHash?: BinaryHashSpec
  denoHash?: BinaryHashSpec
  verifyCommand?: VerifyCommandFn
  enabled?: boolean
  now?: () => number
  lookupTimeoutMs?: number
  thumbnailTimeoutMs?: number
  totalTimeoutMs?: number
  cacheTtlMs?: number
  stdoutMaxBytes?: number
  stderrMaxBytes?: number
  stderrMaxLines?: number
  formatPolicy?: string
  fetchImpl?: typeof fetch
  encodeThumbnail?: (bytes: Buffer, width: number, height: number) => string | null
  onLog?: (line: string) => void
}

export interface YoutubePreviewClassification {
  code: YoutubePreviewCode
  title: string | null
  artist: string | null
  thumbnailUrl: string | null
}

export type YoutubeImportConfirmation =
  | { ok: true; canonicalUrl: string; checkedAt: number }
  | { ok: false; reason: string; result: YoutubePreviewResult }

interface ReadyCacheEntry {
  requestId: string
  canonicalUrl: string
  checkedAt: number
  formatPolicy: string
  binaryId: string
}

interface ActivePreview {
  senderId: number
  sender: YoutubePreviewSender
  requestId: string
  canonicalUrl: string
  skipThumbnail: boolean
  cacheOnReady: boolean
  child: ChildProcess | null
  resolve: (result: YoutubePreviewResult) => void
  lookupTimer: NodeJS.Timeout | null
  totalTimer: NodeJS.Timeout | null
  stdoutChunks: Buffer[]
  stdoutBytes: number
  stderrLines: string[]
  stderrTail: string
  stderrBytes: number
  stderrLineCount: number
  settled: boolean
  lookupClosed: boolean
  startedAt: number
  onDestroyed: (() => void) | null
}

/** 조회 전용 인자. 미디어 다운로드·후처리·출력 파일 옵션은 넣지 않는다. */
export function buildYtDlpPreviewArgs(params: { denoPath: string; url: string }): string[] {
  return [
    '--ignore-config',
    '--encoding',
    'utf-8',
    '--simulate',
    '--dump-single-json',
    '--no-playlist',
    '--no-cache-dir',
    '--js-runtimes',
    `deno:${params.denoPath}`,
    params.url
  ]
}

export function isAllowedYoutubeThumbnailUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.trim() === '') return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.port !== '') return false
  const host = url.hostname.toLowerCase()
  if (isBlockedIpHost(host)) return false
  return THUMB_HOSTS.has(host)
}

/**
 * Electron nativeImage는 WebP 버퍼를 비워 둔다. JPEG/PNG를 우선하고,
 * vi_webp/*.webp 만 있으면 같은 파일명의 .jpg로 바꾼다.
 */
export function pickThumbnailUrl(info: Record<string, unknown>): string | null {
  const ranked = collectThumbnailCandidates(info).sort((a, b) => {
    const aJpeg = isJpegOrPngThumbnailUrl(a.url) ? 1 : 0
    const bJpeg = isJpegOrPngThumbnailUrl(b.url) ? 1 : 0
    if (aJpeg !== bJpeg) return bJpeg - aJpeg
    return b.preference - a.preference || b.height - a.height
  })
  const picked = ranked[0]?.url
  if (!picked) return null
  if (isJpegOrPngThumbnailUrl(picked)) return picked
  return jpegFallbackFromWebp(picked) ?? picked
}

/**
 * 번들/fake yt-dlp dump 계약: 콘텐츠 `has_drm` 생략은 포맷 목록이 있고
 * 선택 후보가 DRM으로 표시되지 않았을 때만 비보호로 본다.
 * 포맷 일부의 `has_drm === true`는 그 포맷만 제외한다 (drmMissing0 / drmMixed000).
 */
export function classifyYoutubePreviewJson(
  json: unknown,
  stderr: string,
  exitCode: number
): YoutubePreviewClassification {
  const empty = { title: null, artist: null, thumbnailUrl: null }
  const stderrCode = classifyPreviewStderr(stderr)

  if (json != null && (typeof json !== 'object' || Array.isArray(json))) {
    return { code: 'EXTRACTOR_ERROR', ...empty }
  }

  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const info = json as Record<string, unknown>
    const meta = metadataFields(info)
    const fromJson = classifyPreviewInfo(info)
    if (fromJson === 'UNKNOWN' && stderrCode && stderrCode !== 'UNKNOWN') {
      return withMetaForCode(stderrCode, meta)
    }
    return withMetaForCode(fromJson, meta)
  }

  if (stderrCode) return { code: stderrCode, ...empty }
  if (exitCode !== 0) return { code: 'EXTRACTOR_ERROR', ...empty }
  return { code: 'EXTRACTOR_ERROR', ...empty }
}

export function classifyPreviewStderr(stderr: string): YoutubePreviewCode | null {
  if (!stderr.trim()) return null
  if (/HTTP Error 429|Too Many Requests|rate[- ]?limit/i.test(stderr)) return 'RATE_LIMITED'
  if (/DRM protected|only DRM formats|\bWidevine\b|\bPlayReady\b/i.test(stderr)) {
    return 'DRM_PROTECTED'
  }
  if (
    /sign in to confirm your age|age[- ]restricted|members-only|members only|music premium|requires payment|please sign in|login required|join this channel/i.test(
      stderr
    )
  ) {
    return 'AUTH_REQUIRED'
  }
  if (/this live event will begin|is live now|premieres in/i.test(stderr)) {
    return 'LIVE_UNSUPPORTED'
  }
  if (
    /private video|video unavailable|has been removed|does not exist|not available in your country|geo(?:graphically)? restricted|blocked it in your country|account associated with this video has been terminated/i.test(
      stderr
    )
  ) {
    return 'UNAVAILABLE'
  }
  if (/timed out|timeout(?:error)?/i.test(stderr)) return 'TIMEOUT'
  if (
    /unable to download (?:webpage|api page)|urlopen error|getaddrinfo failed|failed to resolve|network is unreachable|connection refused|connection reset|HTTP Error 5\d\d/i.test(
      stderr
    )
  ) {
    return 'NETWORK'
  }
  if (/ERROR:/i.test(stderr)) return 'EXTRACTOR_ERROR'
  return null
}

export function buildYoutubePreviewResult(params: {
  requestId: string
  code: YoutubePreviewCode
  canonicalUrl: string | null
  checkedAt: number | null
  metadata: YoutubePreviewMetadata | null
  thumbnailWarning: string | null
}): YoutubePreviewResult {
  const message = youtubePreviewMessage(params.code)
  const status = youtubePreviewStatusForCode(params.code)
  if (status === 'ready') {
    return {
      requestId: params.requestId,
      status: 'ready',
      code: 'READY',
      message,
      canonicalUrl: params.canonicalUrl ?? '',
      checkedAt: params.checkedAt ?? 0,
      metadata: params.metadata,
      thumbnailWarning: params.thumbnailWarning
    }
  }
  if (status === 'blocked') {
    return {
      requestId: params.requestId,
      status: 'blocked',
      code: params.code as YoutubePreviewBlockedCode,
      message,
      canonicalUrl: params.canonicalUrl,
      checkedAt: params.checkedAt,
      metadata: params.metadata,
      thumbnailWarning: params.thumbnailWarning
    }
  }
  if (status === 'cancelled') {
    return {
      requestId: params.requestId,
      status: 'cancelled',
      code: 'CANCELLED',
      message,
      canonicalUrl: params.canonicalUrl,
      checkedAt: params.checkedAt,
      metadata: params.metadata,
      thumbnailWarning: params.thumbnailWarning
    }
  }
  return {
    requestId: params.requestId,
    status: 'error',
    code: params.code as YoutubePreviewErrorCode,
    message,
    canonicalUrl: params.canonicalUrl,
    checkedAt: params.checkedAt,
    metadata: params.metadata,
    thumbnailWarning: params.thumbnailWarning
  }
}

/**
 * IPC sender별 사전 조회. ImportRequestGate·다운로드 체인과 독립적으로 spawn한다.
 */
export class YoutubePreviewService {
  private readonly active = new Map<number, ActivePreview>()
  private readonly readyCache = new Map<number, ReadyCacheEntry>()
  private readonly lastRequestId = new Map<number, string>()
  private readonly running = new Set<ChildProcess>()
  private disposed = false
  private spawns = 0

  constructor(private readonly options: YoutubePreviewServiceOptions) {}

  spawnCount(): number {
    return this.spawns
  }

  runningCount(): number {
    return this.running.size
  }

  preview(sender: YoutubePreviewSender, req: YoutubePreviewRequest): Promise<YoutubePreviewResult> {
    const requestId = typeof req?.requestId === 'string' ? req.requestId : ''
    if (this.disposed) {
      return Promise.resolve(this.result(requestId, 'CANCELLED', null, null, null, null))
    }
    if (this.options.enabled === false) {
      return Promise.resolve(this.result(requestId, 'DISABLED', null, null, null, null))
    }
    const parsed = parseYoutubeVideoUrl(req?.url)
    if (!parsed.ok) {
      return Promise.resolve(this.result(requestId, 'INVALID_URL', null, null, null, null))
    }
    this.lastRequestId.set(sender.id, requestId)
    return this.runLookup({
      sender,
      requestId,
      canonicalUrl: parsed.canonicalUrl,
      skipThumbnail: false,
      cacheOnReady: true
    })
  }

  cancel(sender: YoutubePreviewSender, requestId: string): void {
    if (typeof requestId !== 'string' || requestId === '') return
    const session = this.active.get(sender.id)
    const last = this.lastRequestId.get(sender.id)
    if (session && session.requestId === requestId) {
      this.settle(
        session,
        this.result(requestId, 'CANCELLED', session.canonicalUrl, null, null, null)
      )
      this.readyCache.delete(sender.id)
      return
    }
    if (last === requestId) this.readyCache.delete(sender.id)
  }

  abortActive(sender: YoutubePreviewSender): void {
    const session = this.active.get(sender.id)
    if (!session) return
    this.settle(
      session,
      this.result(session.requestId, 'CANCELLED', session.canonicalUrl, null, null, null)
    )
  }

  invalidateSender(senderId: number): void {
    const session = this.active.get(senderId)
    if (session) {
      this.settle(
        session,
        this.result(session.requestId, 'CANCELLED', session.canonicalUrl, null, null, null)
      )
    }
    this.readyCache.delete(senderId)
    this.lastRequestId.delete(senderId)
  }

  async confirmReadyForImport(
    sender: YoutubePreviewSender,
    url: string
  ): Promise<YoutubeImportConfirmation> {
    const requestId = `import-recheck:${sender.id}`
    if (this.disposed) {
      const result = this.result(requestId, 'CANCELLED', null, null, null, null)
      return { ok: false, reason: result.message, result }
    }
    if (this.options.enabled === false) {
      const result = this.result(requestId, 'DISABLED', null, null, null, null)
      return { ok: false, reason: result.message, result }
    }
    const parsed = parseYoutubeVideoUrl(url)
    if (!parsed.ok) {
      const result = this.result(requestId, 'INVALID_URL', null, null, null, null)
      return { ok: false, reason: result.message, result }
    }
    const cached = this.validCache(sender.id, parsed.canonicalUrl)
    if (cached) {
      return { ok: true, canonicalUrl: cached.canonicalUrl, checkedAt: cached.checkedAt }
    }
    const result = await this.runLookup({
      sender,
      requestId,
      canonicalUrl: parsed.canonicalUrl,
      skipThumbnail: true,
      cacheOnReady: true
    })
    if (result.status === 'ready') {
      return { ok: true, canonicalUrl: result.canonicalUrl, checkedAt: result.checkedAt }
    }
    return { ok: false, reason: result.message, result }
  }

  dispose(): void {
    this.disposed = true
    for (const session of [...this.active.values()]) {
      this.settle(
        session,
        this.result(session.requestId, 'CANCELLED', session.canonicalUrl, null, null, null)
      )
    }
    this.active.clear()
    this.readyCache.clear()
    this.lastRequestId.clear()
    for (const child of this.running) this.terminateChild(child)
    this.running.clear()
  }

  private runLookup(params: {
    sender: YoutubePreviewSender
    requestId: string
    canonicalUrl: string
    skipThumbnail: boolean
    cacheOnReady: boolean
  }): Promise<YoutubePreviewResult> {
    const previous = this.active.get(params.sender.id)
    if (previous) {
      this.settle(
        previous,
        this.result(previous.requestId, 'CANCELLED', previous.canonicalUrl, null, null, null)
      )
    }

    return new Promise((resolve) => {
      const startedAt = this.now()
      const session: ActivePreview = {
        senderId: params.sender.id,
        sender: params.sender,
        requestId: params.requestId,
        canonicalUrl: params.canonicalUrl,
        skipThumbnail: params.skipThumbnail,
        cacheOnReady: params.cacheOnReady,
        child: null,
        resolve,
        lookupTimer: null,
        totalTimer: null,
        stdoutChunks: [],
        stdoutBytes: 0,
        stderrLines: [],
        stderrTail: '',
        stderrBytes: 0,
        stderrLineCount: 0,
        settled: false,
        lookupClosed: false,
        startedAt,
        onDestroyed: null
      }
      this.active.set(params.sender.id, session)
      this.attachDestroyed(params.sender, session)

      const totalMs = this.options.totalTimeoutMs ?? YOUTUBE_PREVIEW_TOTAL_MS
      const lookupMs = this.options.lookupTimeoutMs ?? YOUTUBE_PREVIEW_LOOKUP_MS
      session.totalTimer = setTimeout(() => {
        if (session.lookupClosed) return
        this.settle(
          session,
          this.result(params.requestId, 'TIMEOUT', params.canonicalUrl, null, null, null)
        )
      }, totalMs)
      session.lookupTimer = setTimeout(() => {
        this.settle(
          session,
          this.result(params.requestId, 'TIMEOUT', params.canonicalUrl, null, null, null)
        )
      }, lookupMs)

      try {
        this.verifyBinaries()
      } catch (error) {
        this.log(`binary verify failed: ${error instanceof Error ? error.message : String(error)}`)
        this.settle(
          session,
          this.result(params.requestId, 'UNKNOWN', params.canonicalUrl, null, null, null)
        )
        return
      }

      const args = [
        ...(this.options.baseArgs ?? []),
        ...buildYtDlpPreviewArgs({
          denoPath: this.options.denoPath,
          url: params.canonicalUrl
        })
      ]
      this.spawns += 1
      this.log(`spawn preview ${params.requestId}`)
      let child: ChildProcess
      try {
        child = spawn(this.options.command, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (error) {
        this.log(`spawn failed: ${error instanceof Error ? error.message : String(error)}`)
        this.settle(
          session,
          this.result(params.requestId, 'EXTRACTOR_ERROR', params.canonicalUrl, null, null, null)
        )
        return
      }
      session.child = child
      this.running.add(child)
      this.pipeLimits(session, child)

      child.on('error', (error) => {
        this.log(`child error: ${redactPreviewLog(error.message)}`)
        this.settle(
          session,
          this.result(params.requestId, 'EXTRACTOR_ERROR', params.canonicalUrl, null, null, null)
        )
      })
      child.on('close', (code) => {
        this.running.delete(child)
        if (session.settled) return
        if (session.lookupTimer) {
          clearTimeout(session.lookupTimer)
          session.lookupTimer = null
        }
        void this.finishLookup(session, code ?? -1)
      })
    })
  }

  private pipeLimits(session: ActivePreview, child: ChildProcess): void {
    const stdoutMax = this.options.stdoutMaxBytes ?? YOUTUBE_PREVIEW_STDOUT_MAX
    const stderrMaxBytes = this.options.stderrMaxBytes ?? YOUTUBE_PREVIEW_STDERR_MAX_BYTES
    const stderrMaxLines = this.options.stderrMaxLines ?? YOUTUBE_PREVIEW_STDERR_MAX_LINES

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (session.settled) return
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      session.stdoutBytes += buf.byteLength
      if (session.stdoutBytes > stdoutMax) {
        this.settle(
          session,
          this.result(session.requestId, 'EXTRACTOR_ERROR', session.canonicalUrl, null, null, null)
        )
        return
      }
      session.stdoutChunks.push(buf)
    })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (session.settled) return
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      session.stderrBytes += buf.byteLength
      if (session.stderrBytes > stderrMaxBytes) {
        this.settle(
          session,
          this.result(session.requestId, 'EXTRACTOR_ERROR', session.canonicalUrl, null, null, null)
        )
        return
      }
      const text = buf.toString('utf8')
      session.stderrTail += text
      const parts = session.stderrTail.split(/\r\n|\r|\n/)
      session.stderrTail = parts.pop() ?? ''
      for (const part of parts) {
        session.stderrLineCount += 1
        const trimmed = part.trim()
        if (trimmed) {
          session.stderrLines.push(trimmed)
          if (session.stderrLines.length > stderrMaxLines) session.stderrLines.shift()
        }
        if (session.stderrLineCount > stderrMaxLines) {
          this.settle(
            session,
            this.result(
              session.requestId,
              'EXTRACTOR_ERROR',
              session.canonicalUrl,
              null,
              null,
              null
            )
          )
          return
        }
      }
    })
  }

  private async finishLookup(session: ActivePreview, exitCode: number): Promise<void> {
    if (session.settled) return
    session.lookupClosed = true
    if (session.lookupTimer) {
      clearTimeout(session.lookupTimer)
      session.lookupTimer = null
    }
    if (session.stderrTail.trim()) {
      session.stderrLines.push(session.stderrTail.trim())
      session.stderrTail = ''
    }
    const stdout = Buffer.concat(session.stdoutChunks).toString('utf8')
    const stderr = session.stderrLines.join('\n')
    let json: unknown = null
    const trimmed = stdout.trim()
    if (trimmed) {
      try {
        json = JSON.parse(trimmed)
      } catch {
        json = null
      }
    }
    const classified = classifyYoutubePreviewJson(json, stderr, exitCode)
    if (session.settled) return

    const status = youtubePreviewStatusForCode(classified.code)
    let metadata: YoutubePreviewMetadata | null = null
    let thumbnailWarning: string | null = null
    if (status === 'ready' || status === 'blocked') {
      metadata = {
        title: classified.title,
        artist: classified.artist,
        thumbnailDataUrl: null
      }
      if (!session.skipThumbnail && classified.thumbnailUrl) {
        const remainTotal =
          (this.options.totalTimeoutMs ?? YOUTUBE_PREVIEW_TOTAL_MS) -
          (this.now() - session.startedAt)
        const thumbCap = this.options.thumbnailTimeoutMs ?? YOUTUBE_PREVIEW_THUMBNAIL_MS
        const thumbTimeout = Math.max(0, Math.min(thumbCap, remainTotal))
        const loaded = await this.loadThumbnail(classified.thumbnailUrl, thumbTimeout)
        if (session.settled) return
        metadata.thumbnailDataUrl = loaded.dataUrl
        thumbnailWarning = loaded.warning
      }
    }

    const checkedAt = status === 'ready' ? this.now() : status === 'blocked' ? this.now() : null
    if (classified.code === 'READY') {
      this.settle(
        session,
        this.result(
          session.requestId,
          'READY',
          session.canonicalUrl,
          checkedAt,
          metadata,
          thumbnailWarning
        )
      )
      return
    }
    this.settle(
      session,
      this.result(
        session.requestId,
        classified.code,
        session.canonicalUrl,
        checkedAt,
        status === 'error' || status === 'cancelled' ? null : metadata,
        thumbnailWarning
      )
    )
  }

  private async loadThumbnail(
    url: string,
    timeoutMs: number
  ): Promise<{ dataUrl: string | null; warning: string | null }> {
    if (timeoutMs <= 0) return { dataUrl: null, warning: YOUTUBE_THUMBNAIL_WARNING }
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      return { dataUrl: null, warning: YOUTUBE_THUMBNAIL_WARNING }
    }
    try {
      const bytes = await fetchAllowedThumbnail({
        url,
        fetchImpl,
        timeoutMs,
        maxBytes: YOUTUBE_THUMBNAIL_MAX_BYTES
      })
      if (!bytes) return { dataUrl: null, warning: YOUTUBE_THUMBNAIL_WARNING }
      const info = inspectThumbnailBytes(bytes)
      if (!info) return { dataUrl: null, warning: YOUTUBE_THUMBNAIL_WARNING }
      if (info.width * info.height > YOUTUBE_THUMBNAIL_MAX_PIXELS) {
        return { dataUrl: null, warning: YOUTUBE_THUMBNAIL_WARNING }
      }
      const dataUrl = toThumbnailDataUrl(bytes, info, this.options.encodeThumbnail)
      if (!dataUrl) return { dataUrl: null, warning: YOUTUBE_THUMBNAIL_WARNING }
      return { dataUrl, warning: null }
    } catch {
      return { dataUrl: null, warning: YOUTUBE_THUMBNAIL_WARNING }
    }
  }

  private validCache(senderId: number, canonicalUrl: string): ReadyCacheEntry | null {
    const cached = this.readyCache.get(senderId)
    if (!cached) return null
    if (cached.canonicalUrl !== canonicalUrl) return null
    if (cached.formatPolicy !== this.formatPolicy()) return null
    if (cached.binaryId !== this.binaryId()) return null
    if (this.now() - cached.checkedAt > (this.options.cacheTtlMs ?? YOUTUBE_PREVIEW_CACHE_TTL_MS)) {
      return null
    }
    return cached
  }

  private settle(session: ActivePreview, result: YoutubePreviewResult): void {
    if (session.settled) return
    session.settled = true
    if (session.lookupTimer) clearTimeout(session.lookupTimer)
    if (session.totalTimer) clearTimeout(session.totalTimer)
    session.lookupTimer = null
    session.totalTimer = null
    this.detachDestroyed(session)
    if (this.active.get(session.senderId) === session) this.active.delete(session.senderId)
    const child = session.child
    session.child = null
    if (child) {
      this.running.delete(child)
      this.terminateChild(child)
    }
    if (result.status === 'ready' && session.cacheOnReady) {
      this.readyCache.set(session.senderId, {
        requestId: session.requestId,
        canonicalUrl: result.canonicalUrl,
        checkedAt: result.checkedAt,
        formatPolicy: this.formatPolicy(),
        binaryId: this.binaryId()
      })
    }
    session.resolve(result)
  }

  private attachDestroyed(sender: YoutubePreviewSender, session: ActivePreview): void {
    const events = senderDestroyedEvents(sender)
    if (!events) return
    const onDestroyed = (): void => this.invalidateSender(sender.id)
    session.onDestroyed = onDestroyed
    events.on('destroyed', onDestroyed)
  }

  private detachDestroyed(session: ActivePreview): void {
    if (!session.onDestroyed) return
    senderDestroyedEvents(session.sender)?.off('destroyed', session.onDestroyed)
    session.onDestroyed = null
  }

  private terminateChild(child: ChildProcess): void {
    if (child.exitCode != null || child.signalCode != null) return
    const pid = child.pid
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    if (process.platform === 'win32' && pid && child.exitCode == null) {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
      } catch {
        /* ignore */
      }
    }
  }

  private verifyBinaries(): void {
    const verify = this.options.verifyCommand
    if (verify) {
      if (this.options.ytDlpHash) verify(this.options.command, this.options.ytDlpHash)
      if (this.options.denoHash) verify(this.options.denoPath, this.options.denoHash)
    } else if (this.options.ytDlpHash || this.options.denoHash) {
      throw new Error('yt-dlp hash spec requires verifyCommand')
    }
  }

  private formatPolicy(): string {
    return this.options.formatPolicy ?? YOUTUBE_PREVIEW_FORMAT_POLICY
  }

  private binaryId(): string {
    const hash = this.options.ytDlpHash
    return `${this.options.command}|${hash?.sha256 ?? ''}|${hash?.id ?? ''}`
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private result(
    requestId: string,
    code: YoutubePreviewCode,
    canonicalUrl: string | null,
    checkedAt: number | null,
    metadata: YoutubePreviewMetadata | null,
    thumbnailWarning: string | null
  ): YoutubePreviewResult {
    return buildYoutubePreviewResult({
      requestId,
      code,
      canonicalUrl,
      checkedAt,
      metadata,
      thumbnailWarning
    })
  }

  private log(line: string): void {
    const sink =
      this.options.onLog ?? ((text: string) => console.error(`[youtube-preview] ${text}`))
    sink(redactPreviewLog(line))
  }
}

type DrmFlag = 'true' | 'false' | 'omitted' | 'unknown'

function withMetaForCode(
  code: YoutubePreviewCode,
  meta: { title: string | null; artist: string | null; thumbnailUrl: string | null }
): YoutubePreviewClassification {
  const status = youtubePreviewStatusForCode(code)
  if (status === 'error' || status === 'cancelled') {
    return { code, title: null, artist: null, thumbnailUrl: null }
  }
  return { code, ...meta }
}

function classifyPreviewInfo(info: Record<string, unknown>): YoutubePreviewCode {
  const availability = typeof info.availability === 'string' ? info.availability.toLowerCase() : ''
  if (
    availability === 'private' ||
    availability === 'unavailable' ||
    info.geo_restricted === true
  ) {
    return 'UNAVAILABLE'
  }
  if (
    availability === 'needs_auth' ||
    availability === 'premium_only' ||
    availability === 'subscriber_only'
  ) {
    return 'AUTH_REQUIRED'
  }
  if (isLiveUnsupported(info)) return 'LIVE_UNSUPPORTED'

  const contentDrm = drmFlagOf(info)
  if (contentDrm === 'true') return 'DRM_PROTECTED'
  if (contentDrm === 'unknown') return 'UNKNOWN'

  if (!Object.prototype.hasOwnProperty.call(info, 'formats')) return 'UNKNOWN'
  if (!Array.isArray(info.formats)) return 'UNKNOWN'

  const formats = info.formats.filter(
    (item): item is Record<string, unknown> =>
      item != null && typeof item === 'object' && !Array.isArray(item)
  )
  for (const format of formats) {
    if (drmFlagOf(format) === 'unknown' && isM4aAudioOnly(format)) return 'UNKNOWN'
  }
  if (formats.length === 0) return 'NO_SUPPORTED_AUDIO'

  const candidates = formats.filter(isM4aAudioOnly)
  const unprotected = candidates.filter((format) => {
    const flag = drmFlagOf(format)
    return flag === 'false' || flag === 'omitted'
  })
  if (unprotected.length > 0) return 'READY'
  if (candidates.some((format) => drmFlagOf(format) === 'true')) return 'DRM_PROTECTED'
  return 'NO_SUPPORTED_AUDIO'
}

function isLiveUnsupported(info: Record<string, unknown>): boolean {
  if (info.is_live === true) return true
  const status = typeof info.live_status === 'string' ? info.live_status : ''
  return status === 'is_live' || status === 'is_upcoming'
}

function drmFlagOf(obj: Record<string, unknown>): DrmFlag {
  if (!Object.prototype.hasOwnProperty.call(obj, 'has_drm')) return 'omitted'
  const value = obj.has_drm
  if (value === null || value === undefined) return 'omitted'
  if (value === true) return 'true'
  if (value === false) return 'false'
  return 'unknown'
}

function isM4aAudioOnly(fmt: Record<string, unknown>): boolean {
  const ext = typeof fmt.ext === 'string' ? fmt.ext.toLowerCase() : ''
  const audioExt = typeof fmt.audio_ext === 'string' ? fmt.audio_ext.toLowerCase() : ''
  if (ext !== 'm4a' && audioExt !== 'm4a') return false
  const vcodec = typeof fmt.vcodec === 'string' ? fmt.vcodec.toLowerCase() : ''
  const videoExt = typeof fmt.video_ext === 'string' ? fmt.video_ext.toLowerCase() : ''
  const acodec = typeof fmt.acodec === 'string' ? fmt.acodec.toLowerCase() : ''
  if (vcodec !== '' && vcodec !== 'none') return false
  if (videoExt !== '' && videoExt !== 'none') return false
  if (acodec === 'none') return false
  return true
}

function metadataFields(info: Record<string, unknown>): {
  title: string | null
  artist: string | null
  thumbnailUrl: string | null
} {
  const titleRaw = typeof info.title === 'string' ? info.title.trim() : ''
  const artistRaw = firstNonEmpty(info.artist, info.channel, info.uploader)
  return {
    title: titleRaw === '' ? null : titleRaw,
    artist: artistRaw ? normalizeArtist(artistRaw) : null,
    thumbnailUrl: pickThumbnailUrl(info)
  }
}

function firstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed !== '') return trimmed
  }
  return null
}

function collectThumbnailCandidates(info: Record<string, unknown>): Array<{
  url: string
  preference: number
  height: number
}> {
  const out: Array<{ url: string; preference: number; height: number }> = []
  const push = (url: string, preference: number, height: number): void => {
    if (!isAllowedYoutubeThumbnailUrl(url)) return
    out.push({ url, preference, height })
  }
  if (typeof info.thumbnail === 'string') push(info.thumbnail, 0, 0)
  const thumbs = info.thumbnails
  if (!Array.isArray(thumbs)) return out
  for (const item of thumbs) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    push(
      typeof rec.url === 'string' ? rec.url : '',
      typeof rec.preference === 'number' ? rec.preference : 0,
      typeof rec.height === 'number' ? rec.height : 0
    )
  }
  return out
}

function isJpegOrPngThumbnailUrl(url: string): boolean {
  let path: string
  try {
    path = new URL(url).pathname.toLowerCase()
  } catch {
    return false
  }
  return path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.png')
}

function jpegFallbackFromWebp(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname.toLowerCase() !== 'i.ytimg.com') return null
  const nextPath = parsed.pathname.replace(/\/vi_webp\//i, '/vi/').replace(/\.webp$/i, '.jpg')
  if (nextPath === parsed.pathname) return null
  parsed.pathname = nextPath
  return isAllowedYoutubeThumbnailUrl(parsed.href) ? parsed.href : null
}

function isBlockedIpHost(host: string): boolean {
  const hostname = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost') return true
  const version = isIP(hostname)
  if (version === 0) return false
  if (version === 4) {
    const parts = hostname.split('.').map((part) => Number(part))
    const a = parts[0] ?? 0
    const b = parts[1] ?? 0
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    return false
  }
  if (hostname === '::1' || hostname === '::') return true
  if (hostname.startsWith('fe80:')) return true
  if (hostname.startsWith('fc') || hostname.startsWith('fd')) return true
  return false
}

async function fetchAllowedThumbnail(opts: {
  url: string
  fetchImpl: typeof fetch
  timeoutMs: number
  maxBytes: number
}): Promise<Buffer | null> {
  let current = opts.url
  const deadline = Date.now() + opts.timeoutMs
  for (let hop = 0; hop < 6; hop += 1) {
    if (!isAllowedYoutubeThumbnailUrl(current)) return null
    const remain = deadline - Date.now()
    if (remain <= 0) return null
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), remain)
    let response: Response
    try {
      response = await opts.fetchImpl(current, { redirect: 'manual', signal: ac.signal })
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
    const status = response.status
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location')
      if (!location) return null
      try {
        current = new URL(location, current).href
      } catch {
        return null
      }
      continue
    }
    if (status < 200 || status >= 300) return null
    const lengthHeader = response.headers.get('content-length')
    if (lengthHeader) {
      const length = Number(lengthHeader)
      if (Number.isFinite(length) && length > opts.maxBytes) return null
    }
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.byteLength === 0 || buf.byteLength > opts.maxBytes) return null
    return buf
  }
  return null
}

function inspectThumbnailBytes(
  bytes: Buffer
): { width: number; height: number; kind: 'jpeg' | 'png' | 'webp' } | null {
  const kind = sniffImageKind(bytes)
  if (!kind) return null
  const size = readImageSize(bytes, kind)
  if (!size || size.width <= 0 || size.height <= 0) return null
  return { ...size, kind }
}

function sniffImageKind(bytes: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIG)) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg'
  if (
    bytes.length >= 16 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  return null
}

function readImageSize(
  bytes: Buffer,
  kind: 'jpeg' | 'png' | 'webp'
): { width: number; height: number } | null {
  if (kind === 'png') {
    if (bytes.length < 24) return null
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (kind === 'jpeg') return readJpegSize(bytes)
  return readWebpSize(bytes)
}

function readJpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null
    while (i < buf.length && buf[i] === 0xff) i += 1
    if (i >= buf.length) return null
    const marker = buf[i]
    i += 1
    if (marker === 0xd9) return null
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (i + 2 > buf.length) return null
    const length = buf.readUInt16BE(i)
    if (length < 2) return null
    const sof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (sof) {
      if (length < 7 || i + 7 > buf.length) return null
      return { height: buf.readUInt16BE(i + 3), width: buf.readUInt16BE(i + 5) }
    }
    i += length
  }
  return null
}

function readWebpSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 16) return null
  const fourcc = buf.toString('ascii', 12, 16)
  if (fourcc === 'VP8 ' && buf.length >= 30) {
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff
    }
  }
  if (fourcc === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (fourcc === 'VP8X' && buf.length >= 30) {
    return {
      width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
      height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1
    }
  }
  return null
}

function toThumbnailDataUrl(
  bytes: Buffer,
  info: { width: number; height: number; kind: 'jpeg' | 'png' | 'webp' },
  encode?: (bytes: Buffer, width: number, height: number) => string | null
): string | null {
  const longest = Math.max(info.width, info.height)
  if ((info.kind === 'jpeg' || info.kind === 'png') && longest <= YOUTUBE_THUMBNAIL_MAX_EDGE) {
    const mime = info.kind === 'png' ? 'image/png' : 'image/jpeg'
    const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`
    if (dataUrl.length <= YOUTUBE_THUMBNAIL_MAX_DATA_URL) return dataUrl
  }
  if (!encode) return null
  const dataUrl = encode(bytes, info.width, info.height)
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) return null
  if (dataUrl.length > YOUTUBE_THUMBNAIL_MAX_DATA_URL) return null
  if (!dataUrl.startsWith('data:image/jpeg') && !dataUrl.startsWith('data:image/png')) return null
  return dataUrl
}

function senderDestroyedEvents(sender: YoutubePreviewSender): {
  on: (event: 'destroyed', listener: () => void) => unknown
  off: (event: 'destroyed', listener: () => void) => unknown
} | null {
  const rec = sender as {
    on?: (event: 'destroyed', listener: () => void) => unknown
    off?: (event: 'destroyed', listener: () => void) => unknown
    removeListener?: (event: 'destroyed', listener: () => void) => unknown
  }
  if (typeof rec.on !== 'function') return null
  return {
    on: rec.on.bind(sender),
    off: (event, listener) => {
      rec.off?.(event, listener)
      rec.removeListener?.(event, listener)
    }
  }
}

function redactPreviewLog(line: string): string {
  return line
    .replace(/(cookie|authorization|set-cookie)\s*[:=]\s*\S+/gi, '$1=***')
    .replace(/([?&](?:expire|signature|sig|lsig|pot|xt)=)[^&\s]+/gi, '$1***')
}
