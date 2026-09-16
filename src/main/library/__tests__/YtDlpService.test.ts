import { existsSync } from 'fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IPC_CHANNELS } from '../../../shared/types'
import type {
  ImportFilesResponse,
  ImportUserMeta,
  Track,
  UrlImportProgressEvent
} from '../../../shared/types'
import type { ImportMetaHint } from '../ImportService'
import {
  YtDlpService,
  buildYtDlpArgs,
  hasUrlImportBinaries,
  normalizeArtist,
  parseDownloadProgress,
  titleFromFilename,
  urlImportAvailability
} from '../YtDlpService'

const FAKE_YTDLP = join(process.cwd(), 'src', 'main', 'library', '__tests__', 'fake_ytdlp.mjs')

function track(id: string): Track {
  return {
    id,
    title: 'Fake Song',
    artist: null,
    album: null,
    duration: 19,
    sourcePath: 'C:/scratch/Fake Song [abc123].m4a',
    status: 'imported',
    lyricsSource: 'none',
    bpm: null,
    musicKey: null,
    bpmConf: null,
    keyConf: null,
    analysisSource: 'none',
    importKind: 'separated',
    guideKind: 'vocal_only',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

describe('parseDownloadProgress', () => {
  it('[download] 진행 줄에서 퍼센트를 뽑는다', () => {
    expect(parseDownloadProgress('[download]   0.3% of  302.04KiB at  291.68KiB/s ETA 00:01')).toBe(
      0.3
    )
    expect(parseDownloadProgress('[download]  45.3% of  302.04KiB')).toBe(45.3)
    expect(parseDownloadProgress('[download] 100% of  302.04KiB in 00:00:00')).toBe(100)
  })

  it('진행 줄이 아니면 null', () => {
    expect(parseDownloadProgress('[download] Destination: foo.m4a')).toBeNull()
    expect(parseDownloadProgress('[youtube] abc: Downloading webpage')).toBeNull()
    expect(parseDownloadProgress('C:\\tmp\\Fake Song [abc123].m4a')).toBeNull()
    expect(parseDownloadProgress('')).toBeNull()
  })
})

describe('buildYtDlpArgs', () => {
  it('스펙 §4.3의 다운로드 인자를 만든다', () => {
    const args = buildYtDlpArgs({
      denoPath: 'C:\\bin\\deno.exe',
      outputTemplate: 'C:\\scratch\\%(title)s [%(id)s].%(ext)s',
      url: 'https://example.test/watch'
    })
    expect(args).toEqual([
      '--ignore-config',
      '--encoding',
      'utf-8',
      '-f',
      'bestaudio[ext=m4a]',
      '--no-playlist',
      '--write-thumbnail',
      '--no-mtime',
      '--newline',
      '--progress',
      '--print',
      'after_move:filepath',
      '--print',
      'after_move:__artist__=%(artist,channel,uploader|)s',
      '--print',
      'after_move:__title__=%(title|)s',
      '--js-runtimes',
      'deno:C:\\bin\\deno.exe',
      '-o',
      'C:\\scratch\\%(title)s [%(id)s].%(ext)s',
      'https://example.test/watch'
    ])
    // URL은 항상 마지막 — 옵션으로 해석되지 않게 한다
    expect(args[args.length - 1]).toBe('https://example.test/watch')
  })
})

describe('normalizeArtist', () => {
  it('YouTube Music 자동 생성 채널의 " - Topic" 꼬리를 뗀다', () => {
    expect(normalizeArtist('YOASOBI - Topic')).toBe('YOASOBI')
    expect(normalizeArtist('  Yorushika - topic ')).toBe('Yorushika')
  })

  it('일반 채널명과 음악 메타 아티스트는 그대로 둔다', () => {
    expect(normalizeArtist('Official Channel')).toBe('Official Channel')
    expect(normalizeArtist('Artist A, Artist B')).toBe('Artist A, Artist B')
    expect(normalizeArtist('Topic Talk')).toBe('Topic Talk')
  })

  it('빈 값은 null', () => {
    expect(normalizeArtist('')).toBeNull()
    expect(normalizeArtist('   ')).toBeNull()
  })
})

describe('titleFromFilename', () => {
  it('출력 템플릿의 [id] 꼬리와 확장자를 뗀다', () => {
    expect(titleFromFilename('C:\\scratch\\Song Name [dQw4w9WgXcQ].m4a')).toBe('Song Name')
    expect(titleFromFilename('/tmp/曲名 feat. X [abc123].webm')).toBe('曲名 feat. X')
  })

  it('꼬리가 없으면 파일명 그대로, 제목 안의 대괄호는 건드리지 않는다', () => {
    expect(titleFromFilename('C:\\scratch\\Plain Title.m4a')).toBe('Plain Title')
    expect(titleFromFilename('C:\\scratch\\[MV] Title [dQw4w9WgXcQ].m4a')).toBe('[MV] Title')
  })

  it('꼬리를 떼고 아무것도 남지 않으면 null', () => {
    expect(titleFromFilename('C:\\scratch\\[dQw4w9WgXcQ].m4a')).toBeNull()
  })
})

describe('hasUrlImportBinaries', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ytdlp-caps-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('두 파일이 모두 있을 때만 true', async () => {
    const ytDlp = join(dir, 'yt-dlp.exe')
    const deno = join(dir, 'deno.exe')
    expect(hasUrlImportBinaries(ytDlp, deno)).toBe(false)

    await writeFile(ytDlp, '')
    expect(hasUrlImportBinaries(ytDlp, deno)).toBe(false)

    await writeFile(deno, '')
    expect(hasUrlImportBinaries(ytDlp, deno)).toBe(true)
  })
})

describe('urlImportAvailability', () => {
  it('APPX에서 yt-dlp가 없어도 오류가 아니다', () => {
    expect(urlImportAvailability({ ytDlpExists: false, denoExists: true, appx: true })).toEqual({
      urlImport: false,
      missingYtDlpOk: true
    })
  })

  it('ZIP에서 두 파일이 있으면 켠다', () => {
    expect(urlImportAvailability({ ytDlpExists: true, denoExists: true, appx: false })).toEqual({
      urlImport: true,
      missingYtDlpOk: false
    })
  })
})

describe('YtDlpService', () => {
  let root: string
  let scratchRoot: string
  let tracksDir: string
  let imported: string[][]
  /** importFiles에 함께 넘어온 메타 힌트 (호출 순서대로) */
  let hints: (ImportMetaHint | undefined)[]
  let userMetas: (ImportUserMeta | undefined)[]
  let events: Array<{ channel: string; payload: unknown }>
  let importResult: ImportFilesResponse

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ytdlp-'))
    scratchRoot = join(root, 'tmp', 'url-import')
    tracksDir = join(root, 'tracks')
    imported = []
    hints = []
    userMetas = []
    events = []
    importResult = { imported: [track('t1')], rejected: [] }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function createService(overrides: { touchTrack?: (t: Track) => Track } = {}): YtDlpService {
    return new YtDlpService({
      command: process.execPath,
      baseArgs: [FAKE_YTDLP],
      denoPath: join(root, 'deno.exe'),
      scratchRoot,
      tracksDir,
      importFiles: async (filePaths, hint, userMeta) => {
        imported.push(filePaths)
        hints.push(hint)
        userMetas.push(userMeta)
        return importResult
      },
      notify: (channel, payload) => events.push({ channel, payload }),
      onLog: () => {},
      ...overrides
    })
  }

  function progressEvents(): UrlImportProgressEvent[] {
    return events
      .filter((e) => e.channel === IPC_CHANNELS.urlImportProgress)
      .map((e) => e.payload as UrlImportProgressEvent)
  }

  async function scratchDirs(): Promise<string[]> {
    return existsSync(scratchRoot) ? readdir(scratchRoot) : []
  }

  it('성공 경로: 진행률 브로드캐스트 → importFiles → cover.jpg 복사 → 스크래치 정리', async () => {
    const service = createService()
    const response = await service.importUrl('https://youtu.be/okM4aAudio0')

    expect(response.rejected).toEqual([])
    expect(response.imported).toHaveLength(1)

    // 다운로드 파일이 스크래치에서 그대로 파이프라인으로 넘어간다
    expect(imported).toHaveLength(1)
    expect(imported[0][0]).toMatch(/Fake Song \[abc123\]\.m4a$/)
    // --print 제목·아티스트 힌트가 파이프라인에 전달된다 (아티스트는 " - Topic" 제거 후)
    expect(hints[0]).toEqual({ title: 'Fake Song', artist: 'Fake Artist' })
    expect(userMetas[0]).toBeUndefined()

    const pcts = progressEvents().map((e) => e.pct)
    expect(pcts).toEqual([0, 0.3, 45.3, 100, 100])
    expect(
      progressEvents().every((e) => e.url === 'https://www.youtube.com/watch?v=okM4aAudio0')
    ).toBe(true)
    expect(new Set(progressEvents().map((e) => e.id)).size).toBe(1)

    // 썸네일이 확장자와 무관하게 cover.jpg 로 고정 복사된다
    const cover = join(tracksDir, 't1', 'cover.jpg')
    expect(existsSync(cover)).toBe(true)
    expect(await readFile(cover, 'utf-8')).toBe('fake-webp-bytes')

    // 복사 후 렌더러 재렌더 알림
    const updates = events.filter((e) => e.channel === IPC_CHANNELS.trackUpdated)
    expect(updates).toHaveLength(1)
    expect((updates[0].payload as Track).id).toBe('t1')

    expect(await scratchDirs()).toEqual([])
  })

  it('touchTrack으로 갱신한 트랙을 trackUpdated로 알린다', async () => {
    const service = createService({
      touchTrack: (t) => ({ ...t, updatedAt: '2026-09-02T01:00:00.000Z' })
    })
    await service.importUrl('https://youtu.be/okM4aAudio0')

    const updates = events.filter((e) => e.channel === IPC_CHANNELS.trackUpdated)
    expect((updates[0].payload as Track).updatedAt).toBe('2026-09-02T01:00:00.000Z')
  })

  it('--print 출력이 없어도 스크래치에서 오디오 파일을 찾는다', async () => {
    const service = createService()
    const response = await service.importUrl('https://youtu.be/noprint0000')

    expect(response.rejected).toEqual([])
    expect(imported[0][0]).toMatch(/Fake Song \[abc123\]\.m4a$/)
    expect(existsSync(join(tracksDir, 't1', 'cover.jpg'))).toBe(true)
  })

  it('썸네일이 없어도 임포트는 성공한다', async () => {
    const service = createService()
    const response = await service.importUrl('https://youtu.be/nothumb0000')

    expect(response.imported).toHaveLength(1)
    expect(existsSync(join(tracksDir, 't1', 'cover.jpg'))).toBe(false)
    expect(events.filter((e) => e.channel === IPC_CHANNELS.trackUpdated)).toEqual([])
    // 아티스트 후보가 비어 있으면 null. 제목 --print가 없으면 파일명에서 [id] 꼬리를 뗀 값으로 폴백
    expect(hints[0]).toEqual({ title: 'Fake Song', artist: null })
  })

  it('실패 경로: stderr의 ERROR 줄을 rejection 사유로 쓰고 스크래치를 정리한다', async () => {
    const service = createService()
    const response = await service.importUrl('https://youtu.be/fail0000000')

    expect(response.imported).toEqual([])
    expect(response.rejected).toEqual([
      {
        filePath: 'https://youtu.be/fail0000000',
        reason: 'ERROR: [youtube] zzz: Requested format is not available'
      }
    ])
    expect(imported).toEqual([])
    expect(await scratchDirs()).toEqual([])
  })

  it('다운로드가 파일을 남기지 않으면 거부한다', async () => {
    const service = createService()
    const response = await service.importUrl('https://youtu.be/empty000000')

    expect(response.imported).toEqual([])
    expect(response.rejected[0].reason).toContain('오디오 파일을 찾지 못했습니다')
    expect(await scratchDirs()).toEqual([])
  })

  it('YouTube가 아닌 http URL은 프로세스를 띄우지 않고 거부한다', async () => {
    const service = createService()
    const response = await service.importUrl('https://example.com/watch?v=abc')

    expect(response.imported).toEqual([])
    expect(response.rejected[0].reason).toContain('YouTube')
    expect(imported).toEqual([])
    expect(await scratchDirs()).toEqual([])
  })

  it('http(s)가 아닌 입력은 프로세스를 띄우지 않고 거부한다', async () => {
    const service = createService()
    const response = await service.importUrl('--version')

    expect(response.rejected[0].filePath).toBe('--version')
    expect(response.rejected[0].reason).toMatch(/올바른 URL|http\(s\) YouTube/)
    expect(await scratchDirs()).toEqual([])
  })

  it('사용자 커버가 있으면 YouTube 썸네일을 복사하지 않는다', async () => {
    await createService().importUrl('https://youtu.be/okM4aAudio0', { coverPath: 'C:\\art.jpg' })
    expect(existsSync(join(tracksDir, 't1', 'cover.jpg'))).toBe(false)
  })

  it('사용자 곡 정보는 importFiles 세 번째 인자로 넘기고 yt-dlp 힌트는 유지한다', async () => {
    await createService().importUrl('https://youtu.be/okM4aAudio0', {
      title: '내 제목',
      artist: '내 가수'
    })
    expect(hints[0]).toEqual({ title: 'Fake Song', artist: 'Fake Artist' })
    expect(userMetas[0]).toEqual({ title: '내 제목', artist: '내 가수' })
  })

  it('importFiles의 거부 사유는 URL을 filePath로 바꿔 표면화한다', async () => {
    importResult = {
      imported: [],
      rejected: [{ filePath: 'C:/scratch/x.m4a', reason: 'too long' }]
    }
    const service = createService()
    const response = await service.importUrl('https://youtu.be/okM4aAudio0')

    expect(response.rejected).toEqual([
      { filePath: 'https://youtu.be/okM4aAudio0', reason: 'too long' }
    ])
  })

  it('동시 요청을 직렬화한다', async () => {
    const service = createService()
    const [a, b] = await Promise.all([
      service.importUrl('https://youtu.be/okM4aAudio0'),
      service.importUrl('https://youtu.be/okM4aAudio0')
    ])

    expect(a.imported).toHaveLength(1)
    expect(b.imported).toHaveLength(1)
    expect(imported).toHaveLength(2)
    // 각 요청은 서로 다른 스크래치 디렉토리를 쓴다
    expect(imported[0][0]).not.toBe(imported[1][0])
    expect(await scratchDirs()).toEqual([])
  })

  it('해시 불일치면 spawn하지 않고 거부한다', async () => {
    let verified = 0
    const service = new YtDlpService({
      command: process.execPath,
      baseArgs: [FAKE_YTDLP],
      denoPath: join(root, 'deno.exe'),
      scratchRoot,
      tracksDir,
      ytDlpHash: { sha256: 'deadbeef', size: 1, id: 'yt-dlp' },
      denoHash: { sha256: 'cafebabe', size: 1, id: 'deno' },
      verifyCommand: (_path, expected) => {
        verified += 1
        throw new Error(`sha256 mismatch for ${expected.id}`)
      },
      importFiles: async (filePaths, hint, userMeta) => {
        imported.push(filePaths)
        hints.push(hint)
        userMetas.push(userMeta)
        return importResult
      },
      notify: (channel, payload) => events.push({ channel, payload }),
      onLog: () => {}
    })
    const response = await service.importUrl('https://youtu.be/okM4aAudio0')
    expect(verified).toBe(1)
    expect(imported).toEqual([])
    expect(response.imported).toEqual([])
    expect(response.rejected[0].reason).toMatch(/sha256 mismatch for yt-dlp/)
    expect(await scratchDirs()).toEqual([])
  })

  it('dispose 후에는 새 요청을 받지 않는다', async () => {
    const service = createService()
    service.dispose()
    const response = await service.importUrl('https://youtu.be/okM4aAudio0')

    expect(response.rejected[0].reason).toContain('종료 중')
    expect(imported).toEqual([])
  })
})
