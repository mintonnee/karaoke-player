import { existsSync } from 'fs'
import { link, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS, PAIR_LENGTH_DELTA_MS } from '../../../shared/types'
import type {
  GuideKind,
  PairImportProgressEvent,
  PairImportRequest,
  ProbeResult,
  Track
} from '../../../shared/types'
import { SidecarError } from '../../sidecar/SidecarManager'
import type {
  SidecarManager,
  SidecarProgressEvent,
  SidecarRunOptions
} from '../../sidecar/SidecarManager'
import { PNG_1X1 } from './coverFixtures'
import { ImportService } from '../ImportService'
import { JobQueue } from '../JobQueue'
import { LibraryStore } from '../LibraryStore'
import { PAIR_JOB_MARKER, PAIR_TMP_DIRNAME } from '../pairRecovery'

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

describe('ImportService.importPair', () => {
  let root: string
  let tracksDir: string
  let store: LibraryStore
  let queue: JobQueue
  let events: Array<{ channel: string; payload: unknown }>
  let sidecarCalls: string[][]
  let mrPath: string
  let guidePath: string
  let fetchLyrics: ReturnType<typeof vi.fn<(track: Track) => Promise<unknown>>>
  let refreshSearchKeys: ReturnType<typeof vi.fn<(track: Track) => void>>
  let extractCover: ReturnType<typeof vi.fn<(track: Track) => void>>
  let analyze: ReturnType<typeof vi.fn<(track: Track) => void>>
  let getDemucsModel: ReturnType<typeof vi.fn<() => string>>
  let probeByCopy: (input: string) => ProbeResult
  let prepareHandler: (
    args: string[],
    onProgress?: (event: SidecarProgressEvent) => void
  ) => Promise<{ inst: string; guide: string | null; duration: number }>
  let prepareDuration: number

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'karaoke-pair-'))
    tracksDir = join(root, 'tracks')
    await mkdir(tracksDir, { recursive: true })
    store = new LibraryStore(join(root, 'library.sqlite'))
    queue = new JobQueue()
    events = []
    sidecarCalls = []
    mrPath = join(root, 'mr.wav')
    guidePath = join(root, 'guide.mp3')
    await writeFile(mrPath, 'mr-bytes')
    await writeFile(guidePath, 'guide-bytes')
    fetchLyrics = vi.fn(async (_track: Track) => undefined)
    refreshSearchKeys = vi.fn((_track: Track) => undefined)
    extractCover = vi.fn((_track: Track) => undefined)
    analyze = vi.fn((_track: Track) => undefined)
    getDemucsModel = vi.fn((): string => 'htdemucs_ft')
    prepareDuration = 12.3
    probeByCopy = (input: string) => {
      const name = basename(input)
      if (name.startsWith('source-inst')) {
        return {
          duration: 12.3,
          sample_rate: 44100,
          channels: 2,
          title: 'MR Title',
          artist: 'MR Artist',
          album: 'MR Album'
        }
      }
      return {
        duration: 12.3,
        sample_rate: 44100,
        channels: 2,
        title: 'Guide Title',
        artist: 'Guide Artist',
        album: 'Guide Album'
      }
    }
    prepareHandler = async (args) => {
      const out = flagValue(args, '--out')!
      const kind = flagValue(args, '--guide-kind') as GuideKind
      const inst = join(out, 'inst.wav')
      if (kind === 'none') {
        await writeFile(inst, 'inst-wav')
        return { inst, guide: null, duration: prepareDuration }
      }
      const guide = join(out, kind === 'full_mix' ? 'guide.wav' : 'vocal.wav')
      await writeFile(inst, 'inst-wav')
      await writeFile(guide, 'guide-wav')
      return { inst, guide, duration: prepareDuration }
    }
  })

  afterEach(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })

  function createSidecar(): SidecarManager {
    return {
      run: async (args: string[], runOptions?: SidecarRunOptions) => {
        sidecarCalls.push(args)
        const cmd = args[0]
        if (cmd === 'probe') {
          return probeByCopy(flagValue(args, '--input') ?? '')
        }
        if (cmd === 'prepare-pair') {
          return prepareHandler(args, runOptions?.onProgress)
        }
        if (cmd === 'separate') {
          throw new Error('separate must not be called for pair import')
        }
        throw new Error(`unexpected sidecar command: ${cmd}`)
      }
    } as unknown as SidecarManager
  }

  function createService(): ImportService {
    return new ImportService({
      store,
      sidecar: createSidecar(),
      queue,
      tracksDir,
      maxDurationSec: 900,
      getDemucsModel,
      notify: (channel, payload) => events.push({ channel, payload }),
      fetchLyrics,
      refreshSearchKeys,
      extractCover,
      analyze,
      onLog: () => {}
    })
  }

  function req(overrides: Partial<PairImportRequest> = {}): PairImportRequest {
    return { mrPath, guidePath, guideKind: 'vocal_only', ...overrides }
  }

  it('MR alone persists ready without a guide file or separation', async () => {
    const response = await createService().importPair(req({ guideKind: 'none', guidePath: null }))
    expect(response.rejected).toEqual([])
    const track = response.imported[0]
    expect(track).toMatchObject({ guideKind: 'none', sourcePath: mrPath, status: 'ready' })
    expect(store.getTrack(track.id)?.guideKind).toBe('none')
    const files = await readdir(join(tracksDir, track.id))
    expect(files.sort()).toEqual(['inst.wav', 'meta.json', 'source.wav'])
    expect(sidecarCalls.filter((args) => args[0] === 'probe')).toHaveLength(1)
    const prepare = sidecarCalls.find((args) => args[0] === 'prepare-pair')!
    expect(prepare).not.toContain('--guide')
    expect(getDemucsModel).not.toHaveBeenCalled()
  })

  it('rejects an extra guide file for none before creating files or running the worker', async () => {
    const result = await createService().importPair(req({ guideKind: 'none' }))
    expect(result.imported).toEqual([])
    expect(result.rejected[0].role).toBe('guide')
    expect(sidecarCalls).toEqual([])
    expect(await leftoverTrackDirs()).toEqual([])
  })

  async function leftoverTrackDirs(): Promise<string[]> {
    if (!existsSync(tracksDir)) return []
    const names = await readdir(tracksDir)
    const leftovers: string[] = []
    for (const name of names) {
      if (name === PAIR_TMP_DIRNAME) {
        const tmp = await readdir(join(tracksDir, name)).catch(() => [])
        leftovers.push(...tmp.map((child) => `${name}/${child}`))
        continue
      }
      leftovers.push(name)
    }
    return leftovers
  }

  async function expectCleanFailure(response: {
    imported: unknown[]
    rejected: Array<{ role?: string; reason: string }>
  }): Promise<void> {
    expect(response.imported).toEqual([])
    expect(store.listTracks()).toEqual([])
    expect(await leftoverTrackDirs()).toEqual([])
  }

  it('vocal_only 성공: ready 한 곡, inst+vocal, 원본 복사, demucs 없음, 부가 서비스 호출', async () => {
    const importFiles = vi.spyOn(ImportService.prototype, 'importFiles')
    const response = await createService().importPair(req())
    expect(importFiles).not.toHaveBeenCalled()
    importFiles.mockRestore()

    expect(response.rejected).toEqual([])
    expect(response.imported).toHaveLength(1)
    const track = response.imported[0]
    expect(track.status).toBe('ready')
    expect(track.importKind).toBe('paired')
    expect(track.guideKind).toBe('vocal_only')
    expect(track.title).toBe('Guide Title')
    expect(track.artist).toBe('Guide Artist')
    expect(track.album).toBe('Guide Album')
    expect(track.sourcePath).toBe(guidePath)
    expect(track.duration).toBe(12.3)
    expect(store.listTracks()).toHaveLength(1)

    const dir = join(tracksDir, track.id)
    expect(await readFile(join(dir, 'inst.wav'), 'utf-8')).toBe('inst-wav')
    expect(await readFile(join(dir, 'vocal.wav'), 'utf-8')).toBe('guide-wav')
    expect(existsSync(join(dir, 'guide.wav'))).toBe(false)
    expect(await readFile(join(dir, 'source.mp3'), 'utf-8')).toBe('guide-bytes')
    expect(await readFile(join(dir, 'source-inst.wav'), 'utf-8')).toBe('mr-bytes')
    expect(existsSync(join(dir, PAIR_JOB_MARKER))).toBe(false)

    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(meta.model).toBeUndefined()
    expect(meta.importKind).toBe('paired')
    expect(meta.guideKind).toBe('vocal_only')
    expect(meta.inputs).toEqual({ mr: 'mr.wav', guide: 'guide.mp3' })

    expect(sidecarCalls.filter((args) => args[0] === 'separate')).toHaveLength(0)
    expect(
      sidecarCalls.some((args) => args.includes('--model') || args.some((a) => /demucs/i.test(a)))
    ).toBe(false)
    expect(getDemucsModel).not.toHaveBeenCalled()
    expect(fetchLyrics).toHaveBeenCalledTimes(1)
    expect(refreshSearchKeys).toHaveBeenCalledTimes(1)
    expect(extractCover).toHaveBeenCalledTimes(1)
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(analyze.mock.calls[0][0].id).toBe(track.id)

    const prepare = sidecarCalls.find((args) => args[0] === 'prepare-pair')
    expect(prepare).toBeDefined()
    expect(flagValue(prepare!, '--guide-kind')).toBe('vocal_only')
    expect(prepare).toContain('--json')
  })

  it('full_mix 성공: guide.wav를 쓰고 vocal.wav는 남기지 않는다', async () => {
    const response = await createService().importPair(req({ guideKind: 'full_mix' }))
    const track = response.imported[0]
    const dir = join(tracksDir, track.id)
    expect(track.guideKind).toBe('full_mix')
    expect(existsSync(join(dir, 'inst.wav'))).toBe(true)
    expect(existsSync(join(dir, 'guide.wav'))).toBe(true)
    expect(existsSync(join(dir, 'vocal.wav'))).toBe(false)
  })

  it('probeTags는 등록 없이 제목·아티스트만 읽는다', async () => {
    const tags = await createService().probeTags(guidePath)
    expect(tags).toEqual({ title: 'Guide Title', artist: 'Guide Artist' })
    expect(store.listTracks()).toEqual([])
    expect(sidecarCalls.filter((args) => args[0] === 'separate')).toHaveLength(0)
  })

  it('사용자 커버를 cover.jpg로 복사하고 추출은 건너뛴다', async () => {
    const coverPath = join(root, 'art.png')
    await writeFile(coverPath, PNG_1X1)
    const response = await createService().importPair(req({ coverPath }))
    const track = response.imported[0]
    expect(await readFile(join(tracksDir, track.id, 'cover.jpg'))).toEqual(PNG_1X1)
    expect(extractCover).not.toHaveBeenCalled()
  })

  it('잘못된 커버 파일은 거부하고 잔여물이 없다', async () => {
    const response = await createService().importPair(req({ coverPath: join(root, 'missing.png') }))
    expect(response.imported).toEqual([])
    expect(response.rejected[0].reason).toContain('커버')
    await expectCleanFailure(response)
  })

  it('사용자 제목·아티스트는 태그보다 우선하고 빈 값은 태그를 유지한다', async () => {
    const overridden = await createService().importPair(
      req({ title: '  직접 제목  ', artist: '직접 아티스트' })
    )
    expect(overridden.imported[0].title).toBe('직접 제목')
    expect(overridden.imported[0].artist).toBe('직접 아티스트')

    const blank = await createService().importPair(req({ title: '  ', artist: '' }))
    expect(blank.imported[0].title).toBe('Guide Title')
    expect(blank.imported[0].artist).toBe('Guide Artist')
  })

  it('가이드 태그가 없으면 MR 태그, 제목도 없으면 MR 파일명', async () => {
    probeByCopy = (input: string) => {
      const name = basename(input)
      if (name.startsWith('source-inst')) {
        return { duration: 12.3, sample_rate: 44100, channels: 2, title: 'From MR' }
      }
      return { duration: 12.3, sample_rate: 44100, channels: 2 }
    }
    const response = await createService().importPair(req())
    expect(response.imported[0].title).toBe('From MR')

    probeByCopy = () => ({ duration: 12.3, sample_rate: 44100, channels: 2 })
    const untitled = await createService().importPair(req())
    expect(untitled.imported[0].title).toBe('mr')
  })

  it('누락 파일은 역할과 함께 거부하고 잔여물이 없다', async () => {
    const response = await createService().importPair(req({ mrPath: join(root, 'missing.wav') }))
    expect(response.rejected[0].role).toBe('mr')
    expect(response.rejected[0].reason).toContain('찾을 수 없습니다')
    await expectCleanFailure(response)
  })

  it('같은 실제 파일은 거부한다', async () => {
    const response = await createService().importPair(req({ guidePath: mrPath }))
    expect(response.rejected[0].role).toBe('pair')
    expect(response.rejected[0].reason).toContain('같은 파일')
    await expectCleanFailure(response)
  })

  it('하드링크가 가능하면 같은 inode도 같은 파일로 본다', async () => {
    const linked = join(root, 'guide-link.wav')
    try {
      await link(mrPath, linked)
    } catch {
      return
    }
    const response = await createService().importPair(req({ guidePath: linked }))
    expect(response.rejected[0].role).toBe('pair')
    await expectCleanFailure(response)
  })

  it('미지원 확장자는 거부한다', async () => {
    const txt = join(root, 'guide.txt')
    await writeFile(txt, 'nope')
    const response = await createService().importPair(req({ guidePath: txt }))
    expect(response.rejected[0].role).toBe('guide')
    expect(response.rejected[0].reason).toContain('지원하지 않는 형식')
    await expectCleanFailure(response)
  })

  it('probe 실패(손상)는 해당 역할로 거부한다', async () => {
    probeByCopy = (input: string) => {
      if (basename(input).startsWith('source-inst')) {
        throw new SidecarError('DECODE', 'corrupt')
      }
      return { duration: 12.3, sample_rate: 44100, channels: 2 }
    }
    const response = await createService().importPair(req())
    expect(response.rejected[0].role).toBe('mr')
    expect(response.rejected[0].reason).toContain('DECODE')
    await expectCleanFailure(response)
  })

  it('probe 길이가 maxDurationSec을 넘으면 거부한다', async () => {
    probeByCopy = () => ({ duration: 1000, sample_rate: 44100, channels: 2 })
    const response = await createService().importPair(req())
    expect(response.rejected[0].reason).toContain('exceeds limit')
    await expectCleanFailure(response)
  })

  it(`probe 길이 차이가 ${PAIR_LENGTH_DELTA_MS}ms를 넘으면 prepare-pair 전에 거부한다`, async () => {
    probeByCopy = (input: string) => {
      const duration = basename(input).startsWith('source-inst') ? 10 : 10 + 0.101
      return { duration, sample_rate: 44100, channels: 2 }
    }
    const response = await createService().importPair(req())
    expect(response.rejected[0].role).toBe('pair')
    expect(response.rejected[0].reason).toContain('101')
    expect(sidecarCalls.filter((args) => args[0] === 'prepare-pair')).toHaveLength(0)
    await expectCleanFailure(response)
  })

  it('prepare-pair 오류는 행과 임시 파일을 남기지 않는다', async () => {
    prepareHandler = async () => {
      throw new SidecarError('PREPARE_FAILED', 'decode boom')
    }
    const response = await createService().importPair(req())
    expect(response.rejected[0].role).toBe('pair')
    expect(response.rejected[0].reason).toContain('PREPARE_FAILED')
    await expectCleanFailure(response)
  })

  it('DB insert 실패 시 이동한 디렉토리도 정리한다', async () => {
    const spy = vi.spyOn(store, 'createTrack').mockImplementation(() => {
      throw new Error('db down')
    })
    try {
      const response = await createService().importPair(req())
      expect(response.rejected[0].reason).toContain('db down')
      await expectCleanFailure(response)
    } finally {
      spy.mockRestore()
    }
  })

  it('지연된 진행 이벤트는 jobId로 연결된다', async () => {
    prepareHandler = async (args, onProgress) => {
      await new Promise((r) => setTimeout(r, 40))
      onProgress?.({ type: 'progress', stage: 'prepare', pct: 40, msg: 'decoding' })
      await new Promise((r) => setTimeout(r, 40))
      onProgress?.({ type: 'progress', stage: 'prepare', pct: 90 })
      const out = flagValue(args, '--out')!
      const inst = join(out, 'inst.wav')
      const guide = join(out, 'vocal.wav')
      await writeFile(inst, 'inst-wav')
      await writeFile(guide, 'guide-wav')
      return { inst, guide, duration: 12.3 }
    }

    const response = await createService().importPair(req())
    const jobId = response.imported[0].id
    const progress = events
      .filter((e) => e.channel === IPC_CHANNELS.pairImportProgress)
      .map((e) => e.payload as PairImportProgressEvent)

    expect(progress.map((p) => p.stage)).toEqual([
      'queued',
      'probe',
      'prepare',
      'prepare',
      'prepare',
      'save'
    ])
    expect(progress.every((p) => p.jobId === jobId)).toBe(true)
    expect(progress[0].pct).toBeUndefined()
    expect(progress.find((p) => p.pct === 40)?.msg).toBe('decoding')
  })
})
