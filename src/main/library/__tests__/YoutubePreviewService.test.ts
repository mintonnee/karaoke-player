import { EventEmitter } from 'events'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  youtubePreviewMessage,
  type ImportFilesResponse,
  type ImportUserMeta,
  type YoutubePreviewRequest
} from '../../../shared/types'
import { precheckImportUrl } from '../importUrlPrecheck'
import type { ImportMetaHint } from '../ImportService'
import {
  YoutubePreviewService,
  YOUTUBE_PREVIEW_FORMAT_POLICY,
  YOUTUBE_THUMBNAIL_MAX_BYTES,
  YOUTUBE_THUMBNAIL_WARNING,
  buildYtDlpPreviewArgs,
  classifyYoutubePreviewJson,
  isAllowedYoutubeThumbnailUrl,
  pickThumbnailUrl,
  type YoutubePreviewSender,
  type YoutubePreviewServiceOptions
} from '../YoutubePreviewService'
import { YtDlpService } from '../YtDlpService'
import { PNG_1X1 } from './coverFixtures'

const FAKE_YTDLP = join(process.cwd(), 'src', 'main', 'library', '__tests__', 'fake_ytdlp.mjs')
const CANONICAL = (id: string): string => `https://www.youtube.com/watch?v=${id}`

class FakeSender extends EventEmitter implements YoutubePreviewSender {
  constructor(readonly id: number) {
    super()
  }
}

function m4a(hasDrm?: boolean | string): Record<string, unknown> {
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

function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12)
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function okFetch(
  bytes: Buffer = PNG_1X1,
  status = 200,
  headers: Record<string, string> = {}
): typeof fetch {
  return (async () => {
    if (headers.location) {
      return new Response(null, { status, headers: { location: headers.location } })
    }
    return new Response(Uint8Array.from(bytes), {
      status,
      headers: {
        'content-type': 'image/png',
        'content-length': String(bytes.byteLength),
        ...headers
      }
    })
  }) as typeof fetch
}

describe('buildYtDlpPreviewArgs', () => {
  it('조회 인자만 넣고 URL을 마지막에 둔다', () => {
    const args = buildYtDlpPreviewArgs({
      denoPath: 'C:\\bin\\deno.exe',
      url: CANONICAL('readyM4a000')
    })
    expect(args).toEqual([
      '--ignore-config',
      '--encoding',
      'utf-8',
      '--simulate',
      '--dump-single-json',
      '--no-playlist',
      '--no-cache-dir',
      '--js-runtimes',
      'deno:C:\\bin\\deno.exe',
      CANONICAL('readyM4a000')
    ])
    expect(args.includes('--write-thumbnail')).toBe(false)
    expect(args.includes('-o')).toBe(false)
    expect(args.includes('-f')).toBe(false)
  })
})

describe('isAllowedYoutubeThumbnailUrl', () => {
  it('HTTPS 기본 포트 ytimg 호스트만 허용한다', () => {
    expect(isAllowedYoutubeThumbnailUrl('https://i.ytimg.com/vi/x/hqdefault.jpg')).toBe(true)
    expect(isAllowedYoutubeThumbnailUrl('https://img.youtube.com/vi/x/0.jpg')).toBe(true)
    expect(isAllowedYoutubeThumbnailUrl('http://i.ytimg.com/vi/x/hqdefault.jpg')).toBe(false)
    expect(isAllowedYoutubeThumbnailUrl('https://i.ytimg.com:444/vi/x/hqdefault.jpg')).toBe(false)
    expect(isAllowedYoutubeThumbnailUrl('https://user:pass@i.ytimg.com/vi/x/hqdefault.jpg')).toBe(
      false
    )
    expect(isAllowedYoutubeThumbnailUrl('https://evil.example/x.jpg')).toBe(false)
    expect(isAllowedYoutubeThumbnailUrl('https://127.0.0.1/x.jpg')).toBe(false)
  })
})

describe('pickThumbnailUrl', () => {
  it('최고 해상도 WebP보다 JPEG를 고른다', () => {
    expect(
      pickThumbnailUrl({
        thumbnail: 'https://i.ytimg.com/vi_webp/CkvWJNt77mU/maxresdefault.webp',
        thumbnails: [
          {
            url: 'https://i.ytimg.com/vi_webp/CkvWJNt77mU/maxresdefault.webp',
            preference: 0,
            height: 1080
          },
          {
            url: 'https://i.ytimg.com/vi/CkvWJNt77mU/maxresdefault.jpg',
            preference: -1,
            height: 720
          },
          {
            url: 'https://i.ytimg.com/vi/CkvWJNt77mU/hqdefault.jpg',
            preference: -8,
            height: 360
          }
        ]
      })
    ).toBe('https://i.ytimg.com/vi/CkvWJNt77mU/maxresdefault.jpg')
  })

  it('JPEG가 없으면 vi_webp WebP를 같은 파일명의 jpg로 바꾼다', () => {
    expect(
      pickThumbnailUrl({
        thumbnail: 'https://i.ytimg.com/vi_webp/abc/maxresdefault.webp'
      })
    ).toBe('https://i.ytimg.com/vi/abc/maxresdefault.jpg')
  })
})

describe('classifyYoutubePreviewJson', () => {
  it('제목만 있거나 exit 0만으로는 READY가 아니다', () => {
    expect(classifyYoutubePreviewJson({ title: 'Only Title', has_drm: false }, '', 0).code).toBe(
      'UNKNOWN'
    )
    expect(classifyYoutubePreviewJson(null, '', 0).code).toBe('EXTRACTOR_ERROR')
  })

  it('비보호 m4a audio-only 가 확인될 때만 READY', () => {
    expect(
      classifyYoutubePreviewJson({ title: 'Ok', has_drm: false, formats: [m4a(false)] }, '', 0).code
    ).toBe('READY')
  })

  it('has_drm true/false/생략/비boolean/혼합을 구분한다', () => {
    expect(
      classifyYoutubePreviewJson({ title: 'D', has_drm: true, formats: [m4a(true)] }, '', 0).code
    ).toBe('DRM_PROTECTED')
    expect(
      classifyYoutubePreviewJson({ title: 'D', has_drm: false, formats: [m4a(false)] }, '', 0).code
    ).toBe('READY')
    expect(classifyYoutubePreviewJson({ title: 'D', formats: [m4a()] }, '', 0).code).toBe('READY')
    expect(
      classifyYoutubePreviewJson({ title: 'D', has_drm: 'unknown', formats: [m4a(false)] }, '', 0)
        .code
    ).toBe('UNKNOWN')
    expect(
      classifyYoutubePreviewJson(
        {
          title: 'D',
          has_drm: false,
          formats: [
            { format_id: '999', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a.40.2', has_drm: true },
            m4a(false)
          ]
        },
        '',
        0
      ).code
    ).toBe('READY')
  })

  it('private/deleted/geo/auth/live/upcoming/완료 VOD를 구분한다', () => {
    expect(
      classifyYoutubePreviewJson({ title: 'P', availability: 'private', formats: [] }, '', 1).code
    ).toBe('UNAVAILABLE')
    expect(
      classifyYoutubePreviewJson(
        null,
        'ERROR: [youtube] x: Video unavailable. This video has been removed',
        1
      ).code
    ).toBe('UNAVAILABLE')
    expect(
      classifyYoutubePreviewJson(
        { title: 'G', availability: 'unavailable', formats: [] },
        'ERROR: not available in your country',
        1
      ).code
    ).toBe('UNAVAILABLE')
    expect(
      classifyYoutubePreviewJson(
        { title: 'A', availability: 'needs_auth', formats: [] },
        'ERROR: Sign in to confirm your age',
        1
      ).code
    ).toBe('AUTH_REQUIRED')
    expect(
      classifyYoutubePreviewJson(
        {
          title: 'L',
          is_live: true,
          live_status: 'is_live',
          has_drm: false,
          formats: [m4a(false)]
        },
        '',
        0
      ).code
    ).toBe('LIVE_UNSUPPORTED')
    expect(
      classifyYoutubePreviewJson(
        { title: 'U', live_status: 'is_upcoming', has_drm: false, formats: [] },
        '',
        0
      ).code
    ).toBe('LIVE_UNSUPPORTED')
    expect(
      classifyYoutubePreviewJson(
        {
          title: 'V',
          live_status: 'was_live',
          was_live: true,
          has_drm: false,
          formats: [m4a(false)]
        },
        '',
        0
      ).code
    ).toBe('READY')
  })

  it('webm-only·포맷 없음·손상 JSON·rate limit을 구분한다', () => {
    expect(
      classifyYoutubePreviewJson(
        {
          title: 'W',
          has_drm: false,
          formats: [
            { format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus', has_drm: false }
          ]
        },
        '',
        0
      ).code
    ).toBe('NO_SUPPORTED_AUDIO')
    expect(
      classifyYoutubePreviewJson({ title: 'N', has_drm: false, formats: [] }, '', 0).code
    ).toBe('NO_SUPPORTED_AUDIO')
    expect(classifyYoutubePreviewJson(null, '', 0).code).toBe('EXTRACTOR_ERROR')
    expect(
      classifyYoutubePreviewJson(null, 'ERROR: [youtube] x: HTTP Error 429: Too Many Requests', 1)
        .code
    ).toBe('RATE_LIMITED')
  })

  it('artist는 Topic 접미를 정규화하고 title은 trim만 한다', () => {
    const result = classifyYoutubePreviewJson(
      {
        title: '  Song  ',
        artist: 'YOASOBI - Topic',
        has_drm: false,
        formats: [m4a(false)]
      },
      '',
      0
    )
    expect(result.title).toBe('Song')
    expect(result.artist).toBe('YOASOBI')
  })
})

describe('YoutubePreviewService', () => {
  let root: string
  let importCalls: string[][]
  const senders: FakeSender[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yt-preview-'))
    importCalls = []
    senders.length = 0
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function sender(id = 1): FakeSender {
    const s = new FakeSender(id)
    senders.push(s)
    return s
  }

  function createPreview(
    overrides: Partial<YoutubePreviewServiceOptions> = {}
  ): YoutubePreviewService {
    return new YoutubePreviewService({
      command: process.execPath,
      baseArgs: [FAKE_YTDLP],
      denoPath: join(root, 'deno.exe'),
      enabled: true,
      fetchImpl: okFetch(),
      onLog: () => {},
      ...overrides
    })
  }

  function req(id: string, requestId = `sess:${id}`): YoutubePreviewRequest {
    return { requestId, url: `https://youtu.be/${id}` }
  }

  function createDownloader(): {
    service: YtDlpService
    imported: string[][]
  } {
    const imported: string[][] = []
    const service = new YtDlpService({
      command: process.execPath,
      baseArgs: [FAKE_YTDLP],
      denoPath: join(root, 'deno.exe'),
      scratchRoot: join(root, 'scratch'),
      tracksDir: join(root, 'tracks'),
      importFiles: async (
        filePaths: string[],
        _hint?: ImportMetaHint,
        _userMeta?: ImportUserMeta
      ) => {
        imported.push(filePaths)
        importCalls.push(filePaths)
        const response: ImportFilesResponse = { imported: [], rejected: [] }
        return response
      },
      notify: () => {},
      onLog: () => {}
    })
    return { service, imported }
  }

  async function importWithPreview(
    preview: YoutubePreviewService,
    downloader: YtDlpService,
    s: YoutubePreviewSender,
    url: string
  ): Promise<ImportFilesResponse> {
    const precheck = precheckImportUrl(url, true)
    if (precheck.action === 'reject') return precheck.response
    preview.abortActive(s)
    const confirmed = await preview.confirmReadyForImport(s, precheck.url)
    if (!confirmed.ok) {
      return { imported: [], rejected: [{ filePath: url, reason: confirmed.reason }] }
    }
    return downloader.importUrl(precheck.url)
  }

  it('READY는 비보호 m4a가 확인될 때만이며 메타를 채운다', async () => {
    const preview = createPreview()
    const result = await preview.preview(sender(), req('readyM4a000'))
    expect(result.status).toBe('ready')
    expect(result.code).toBe('READY')
    expect(result.canonicalUrl).toBe(CANONICAL('readyM4a000'))
    expect(result.message).toBe(youtubePreviewMessage('READY'))
    expect(Number.isFinite(result.checkedAt)).toBe(true)
    expect(result.metadata?.title).toBe('Ready Song')
    expect(result.metadata?.artist).toBe('Ready Artist')
    expect(result.metadata?.thumbnailDataUrl?.startsWith('data:image/png')).toBe(true)
    expect(preview.runningCount()).toBe(0)
    preview.dispose()
  })

  it.each([
    ['drmTrue0000', 'DRM_PROTECTED', 'blocked'],
    ['drmFalse000', 'READY', 'ready'],
    ['drmMissing0', 'READY', 'ready'],
    ['drmUnknown0', 'UNKNOWN', 'error'],
    ['drmMixed000', 'READY', 'ready'],
    ['private0000', 'UNAVAILABLE', 'blocked'],
    ['deleted0000', 'UNAVAILABLE', 'blocked'],
    ['geoBlock000', 'UNAVAILABLE', 'blocked'],
    ['authNeed000', 'AUTH_REQUIRED', 'blocked'],
    ['liveNow0000', 'LIVE_UNSUPPORTED', 'blocked'],
    ['upcoming000', 'LIVE_UNSUPPORTED', 'blocked'],
    ['vodWasLive0', 'READY', 'ready'],
    ['webmOnly000', 'NO_SUPPORTED_AUDIO', 'blocked'],
    ['noFormats00', 'NO_SUPPORTED_AUDIO', 'blocked'],
    ['badJson0000', 'EXTRACTOR_ERROR', 'error'],
    ['rateLimit00', 'RATE_LIMITED', 'error'],
    ['extractor00', 'EXTRACTOR_ERROR', 'error']
  ] as const)('%s → %s', async (id, code, status) => {
    const preview = createPreview()
    const result = await preview.preview(sender(), req(id))
    expect(result.code).toBe(code)
    expect(result.status).toBe(status)
    expect(result.message).toBe(youtubePreviewMessage(code))
    if (status === 'error') expect(result.metadata).toBeNull()
    preview.dispose()
  })

  it('A 다음 B는 이전 요청을 취소하고 늦은 응답을 무시한다', async () => {
    const preview = createPreview({ lookupTimeoutMs: 2_000 })
    const s = sender()
    const first = preview.preview(s, req('timeoutSim0', 'sess:1'))
    const second = preview.preview(s, req('readyM4a000', 'sess:2'))
    const [a, b] = await Promise.all([first, second])
    expect(a.status).toBe('cancelled')
    expect(a.code).toBe('CANCELLED')
    expect(b.status).toBe('ready')
    expect(b.requestId).toBe('sess:2')
    expect(preview.runningCount()).toBe(0)
    preview.dispose()
  })

  it('sender가 다르면 조회를 병렬로 둔다', async () => {
    const preview = createPreview()
    const [a, b] = await Promise.all([
      preview.preview(sender(1), req('readyM4a000', 's1')),
      preview.preview(sender(2), req('drmTrue0000', 's2'))
    ])
    expect(a.code).toBe('READY')
    expect(b.code).toBe('DRM_PROTECTED')
    preview.dispose()
  })

  it('cancel은 같은 sender+requestId만 적용하고 캐시를 지운다', async () => {
    const preview = createPreview({ lookupTimeoutMs: 2_000 })
    const s = sender()
    const pending = preview.preview(s, req('timeoutSim0', 'sess:c'))
    preview.cancel(s, 'other')
    expect(preview.runningCount()).toBe(1)
    preview.cancel(s, 'sess:c')
    const result = await pending
    expect(result.code).toBe('CANCELLED')
    expect(preview.runningCount()).toBe(0)
    preview.dispose()
  })

  it('stdout 상한을 넘기면 프로세스를 죽이고 오류를 반환한다', async () => {
    const preview = createPreview({ stdoutMaxBytes: 1024 })
    const result = await preview.preview(sender(), req('hugeJson000'))
    expect(result.code).toBe('EXTRACTOR_ERROR')
    expect(preview.runningCount()).toBe(0)
    preview.dispose()
  })

  it('조회 deadline을 넘기면 TIMEOUT이고 자식이 남지 않는다', async () => {
    const preview = createPreview({ lookupTimeoutMs: 80, totalTimeoutMs: 200 })
    const result = await preview.preview(sender(), req('timeoutSim0'))
    expect(result.code).toBe('TIMEOUT')
    expect(result.message).toBe(youtubePreviewMessage('TIMEOUT'))
    expect(preview.runningCount()).toBe(0)
    preview.dispose()
  })

  it('dispose는 활성 조회와 타이머를 정리한다', async () => {
    const preview = createPreview({ lookupTimeoutMs: 5_000 })
    const pending = preview.preview(sender(), req('timeoutSim0', 'sess:d'))
    preview.dispose()
    const result = await pending
    expect(result.code).toBe('CANCELLED')
    expect(preview.runningCount()).toBe(0)
  })

  it('sender destroyed 시 자식과 캐시를 정리한다', async () => {
    const preview = createPreview({ lookupTimeoutMs: 2_000 })
    const s = sender()
    const pending = preview.preview(s, req('timeoutSim0', 'sess:x'))
    s.emit('destroyed')
    const result = await pending
    expect(result.code).toBe('CANCELLED')
    expect(preview.runningCount()).toBe(0)
    preview.dispose()
  })

  it('미리보기는 importFiles를 호출하지 않는다', async () => {
    const preview = createPreview()
    const downloader = createDownloader()
    await preview.preview(sender(), req('readyM4a000'))
    expect(downloader.imported).toEqual([])
    expect(importCalls).toEqual([])
    preview.dispose()
    downloader.service.dispose()
  })

  it('썸네일 404·과대·금지 redirect·디코딩 실패는 경고만 하고 READY를 유지한다', async () => {
    const cases: Array<{ fetchImpl: typeof fetch; name: string }> = [
      { name: '404', fetchImpl: okFetch(PNG_1X1, 404) },
      {
        name: 'oversize',
        fetchImpl: okFetch(PNG_1X1, 200, {
          'content-length': String(YOUTUBE_THUMBNAIL_MAX_BYTES + 1)
        })
      },
      {
        name: 'forbidden-redirect',
        fetchImpl: okFetch(PNG_1X1, 302, { location: 'https://127.0.0.1/secret.jpg' })
      },
      { name: 'decode', fetchImpl: okFetch(Buffer.from('not-an-image')) }
    ]
    for (const item of cases) {
      const preview = createPreview({ fetchImpl: item.fetchImpl })
      const result = await preview.preview(sender(), req('readyM4a000', `thumb:${item.name}`))
      expect(result.status, item.name).toBe('ready')
      expect(result.thumbnailWarning, item.name).toBe(YOUTUBE_THUMBNAIL_WARNING)
      expect(result.metadata?.thumbnailDataUrl, item.name).toBeNull()
      preview.dispose()
    }
    const oversizePixels = createPreview({
      fetchImpl: okFetch(pngHeader(4096, 4097))
    })
    const decoded = await oversizePixels.preview(sender(), req('readyM4a000', 'thumb:mp'))
    expect(decoded.status).toBe('ready')
    expect(decoded.thumbnailWarning).toBe(YOUTUBE_THUMBNAIL_WARNING)
    oversizePixels.dispose()
  })

  it('capability off·잘못된 URL·비문자열 URL은 spawn 없이 오류다', async () => {
    const disabled = createPreview({ enabled: false })
    const off = await disabled.preview(sender(), req('readyM4a000'))
    expect(off.code).toBe('DISABLED')
    expect(off.message).toBe(youtubePreviewMessage('DISABLED'))
    expect(disabled.spawnCount()).toBe(0)
    disabled.dispose()

    const preview = createPreview()
    const invalid = await preview.preview(sender(), {
      requestId: 'x',
      url: 'https://example.com/watch?v=dQw4w9WgXcQ'
    })
    expect(invalid.code).toBe('INVALID_URL')
    const nonString = await preview.preview(sender(), {
      requestId: 'y',
      url: 1 as unknown as string
    })
    expect(nonString.code).toBe('INVALID_URL')
    expect(preview.spawnCount()).toBe(0)
    preview.dispose()
  })

  it('60초 캐시를 재사용하고 만료·정책·바이너리 불일치는 재검사한다', async () => {
    let now = 1_700_000_000_000
    const options: YoutubePreviewServiceOptions = {
      command: process.execPath,
      baseArgs: [FAKE_YTDLP],
      denoPath: join(root, 'deno.exe'),
      enabled: true,
      fetchImpl: okFetch(),
      onLog: () => {},
      now: (): number => now,
      cacheTtlMs: 60_000,
      formatPolicy: YOUTUBE_PREVIEW_FORMAT_POLICY,
      ytDlpHash: { sha256: 'aaa', size: 1, id: 'yt-dlp' },
      verifyCommand: (): void => {}
    }
    const preview = new YoutubePreviewService(options)
    const s = sender()
    await preview.preview(s, req('readyM4a000', 'cache:1'))
    const afterPreview = preview.spawnCount()
    now += 59_000
    const hit = await preview.confirmReadyForImport(s, CANONICAL('readyM4a000'))
    expect(hit.ok).toBe(true)
    expect(preview.spawnCount()).toBe(afterPreview)

    now += 2_000
    const expired = await preview.confirmReadyForImport(s, CANONICAL('readyM4a000'))
    expect(expired.ok).toBe(true)
    expect(preview.spawnCount()).toBe(afterPreview + 1)

    options.formatPolicy = 'bestaudio'
    const policy = await preview.confirmReadyForImport(s, CANONICAL('readyM4a000'))
    expect(policy.ok).toBe(true)
    expect(preview.spawnCount()).toBe(afterPreview + 2)

    options.formatPolicy = YOUTUBE_PREVIEW_FORMAT_POLICY
    options.ytDlpHash = { sha256: 'bbb', size: 1, id: 'yt-dlp' }
    const binary = await preview.confirmReadyForImport(s, CANONICAL('readyM4a000'))
    expect(binary.ok).toBe(true)
    expect(preview.spawnCount()).toBe(afterPreview + 3)
    preview.dispose()
  })

  it('직접 importUrl은 캐시가 없으면 재확인하고 실패하면 다운로드하지 않는다', async () => {
    const preview = createPreview()
    const downloader = createDownloader()
    const s = sender()
    const blocked = await importWithPreview(
      preview,
      downloader.service,
      s,
      'https://youtu.be/drmTrue0000'
    )
    expect(blocked.imported).toEqual([])
    expect(blocked.rejected[0]?.reason).toBe(youtubePreviewMessage('DRM_PROTECTED'))
    expect(downloader.imported).toEqual([])

    const ok = await importWithPreview(
      preview,
      downloader.service,
      s,
      'https://youtu.be/okM4aAudio0'
    )
    expect(ok.rejected).toEqual([])
    expect(downloader.imported).toHaveLength(1)
    preview.dispose()
    downloader.service.dispose()
  })

  it('캐시된 READY는 제출 재확인에서 spawn하지 않는다', async () => {
    const preview = createPreview()
    const downloader = createDownloader()
    const s = sender()
    await preview.preview(s, req('readyM4a000', 'submit:1'))
    const spawns = preview.spawnCount()
    const imported = await importWithPreview(
      preview,
      downloader.service,
      s,
      'https://youtu.be/readyM4a000'
    )
    expect(imported.rejected).toEqual([])
    expect(preview.spawnCount()).toBe(spawns)
    expect(downloader.imported).toHaveLength(1)
    preview.dispose()
    downloader.service.dispose()
  })

  it('닫기 cancel은 해당 sender 캐시를 폐기한다', async () => {
    const preview = createPreview()
    const downloader = createDownloader()
    const s = sender()
    await preview.preview(s, req('readyM4a000', 'drop:1'))
    const spawns = preview.spawnCount()
    preview.cancel(s, 'drop:1')
    const again = await importWithPreview(
      preview,
      downloader.service,
      s,
      'https://youtu.be/readyM4a000'
    )
    expect(again.rejected).toEqual([])
    expect(preview.spawnCount()).toBe(spawns + 1)
    preview.dispose()
    downloader.service.dispose()
  })
})
