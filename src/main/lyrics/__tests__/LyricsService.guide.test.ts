import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SidecarManager } from '../../sidecar/SidecarManager'
import { JobQueue } from '../../library/JobQueue'
import { LibraryStore } from '../../library/LibraryStore'
import { LyricsService } from '../LyricsService'

describe('LyricsService guide audio path', () => {
  let root: string
  let tracksDir: string
  let store: LibraryStore
  let queue: JobQueue
  let vocalArgs: string[][]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'karaoke-lyrics-guide-'))
    tracksDir = join(root, 'tracks')
    store = new LibraryStore(join(root, 'library.sqlite'))
    queue = new JobQueue()
    vocalArgs = []
  })

  afterEach(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })

  function createService(): LyricsService {
    const sidecar = {
      run: async (args: string[]) => {
        vocalArgs.push(args)
        if (args[0] === 'align') return { lines: [] }
        return {}
      }
    } as unknown as SidecarManager
    return new LyricsService({
      store,
      sidecar,
      queue,
      tracksDir,
      userAgent: 'test',
      notify: () => {},
      onLog: () => {}
    })
  }

  async function seed(id: string, guideKind: 'vocal_only' | 'full_mix' | 'none'): Promise<void> {
    store.createTrack({
      id,
      title: id,
      artist: null,
      album: null,
      duration: 10,
      sourcePath: join(root, `${id}.wav`),
      status: 'ready',
      importKind: guideKind !== 'vocal_only' ? 'paired' : 'separated',
      guideKind
    })
    await mkdir(join(tracksDir, id), { recursive: true })
  }

  it('full_mix align/transcribe는 guide.wav를 쓰고 vocal.wav는 쓰지 않는다', async () => {
    await seed('ar', 'full_mix')
    const service = createService()
    await service.alignLyrics('ar', '가사', 'ja', false)
    await service.transcribe('ar')

    const vocalFlags = vocalArgs.map((args) => args[args.indexOf('--vocal') + 1])
    expect(vocalFlags).toEqual([
      join(tracksDir, 'ar', 'guide.wav'),
      join(tracksDir, 'ar', 'guide.wav')
    ])
    expect(vocalFlags.some((p) => p.endsWith('vocal.wav'))).toBe(false)
  })

  it('vocal_only는 기존처럼 vocal.wav를 쓴다', async () => {
    await seed('vo', 'vocal_only')
    const service = createService()
    await service.alignLyrics('vo', '가사', 'ja', false)
    await service.transcribe('vo')
    const vocalFlags = vocalArgs.map((args) => args[args.indexOf('--vocal') + 1])
    expect(vocalFlags).toEqual([
      join(tracksDir, 'vo', 'vocal.wav'),
      join(tracksDir, 'vo', 'vocal.wav')
    ])
  })

  it('none rejects alignment and transcription before invoking the worker', async () => {
    await seed('mr', 'none')
    const service = createService()
    await expect(service.alignLyrics('mr', '가사', 'ko', false)).rejects.toThrow(
      '가이드 보컬이 없어'
    )
    await expect(service.transcribe('mr')).rejects.toThrow('가이드 보컬이 없어')
    expect(vocalArgs).toEqual([])
  })
})
