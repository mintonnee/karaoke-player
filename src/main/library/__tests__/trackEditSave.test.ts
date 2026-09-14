import Database from 'better-sqlite3'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COVER_FILE_NAME, COVER_NONE_MARKER } from '../../../shared/trackEdit'
import { IPC_CHANNELS } from '../../../shared/types'
import type { Track } from '../../../shared/types'
import type { SidecarManager } from '../../sidecar/SidecarManager'
import { CoverService } from '../CoverService'
import { COVER_BACKUP, COVER_STAGING, TRACK_EDIT_JOURNAL } from '../coverRecovery'
import { LibraryStore } from '../LibraryStore'
import { SearchKeyService } from '../SearchKeyService'
import { TrackEditService } from '../TrackEditService'
import { PNG_1X1 } from './coverFixtures'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('TrackEditService.save', () => {
  let root: string
  let dbPath: string
  let tracksDir: string
  let store: LibraryStore
  let events: Array<{ channel: string; payload: unknown }>
  let sourceImage: string
  let sourceImage2: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'karaoke-track-edit-'))
    dbPath = join(root, 'library.sqlite')
    tracksDir = join(root, 'tracks')
    await mkdir(tracksDir, { recursive: true })
    store = new LibraryStore(dbPath)
    events = []
    sourceImage = join(root, 'user-art.png')
    sourceImage2 = join(root, 'user-art-2.png')
    await writeFile(sourceImage, PNG_1X1)
    await writeFile(sourceImage2, PNG_1X1)
  })

  afterEach(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })

  function createTrack(
    id: string,
    overrides: Partial<Parameters<LibraryStore['createTrack']>[0]> = {}
  ): Track {
    return store.createTrack({
      id,
      title: 'old-title',
      artist: 'artist',
      album: 'album',
      duration: 12,
      sourcePath: join(root, `${id}.flac`),
      ...overrides
    })
  }

  function createService(
    extras: Partial<ConstructorParameters<typeof TrackEditService>[0]> & {
      searchKeyService?: { refresh(track: Track): void }
      coverService?: CoverService
    } = {}
  ): TrackEditService {
    const coverService =
      extras.coverService ??
      new CoverService({
        store,
        sidecar: { run: async () => ({ cover: null }) } as unknown as SidecarManager,
        tracksDir
      })
    const searchKeyService = extras.searchKeyService ?? { refresh: vi.fn() }
    return new TrackEditService({
      store,
      tracksDir,
      coverService,
      searchKeyService,
      notify: (channel, payload) => events.push({ channel, payload }),
      beforeInstallCover: extras.beforeInstallCover,
      beforeCommitMeta: extras.beforeCommitMeta
    })
  }

  async function seedCover(id: string, bytes: Buffer | string = 'old-cover'): Promise<string> {
    const dir = join(tracksDir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, COVER_FILE_NAME), bytes)
    return dir
  }

  it('파일 설치 실패 시 기존 메타·커버를 보존하고 임시 산출물을 정리한다', async () => {
    createTrack('t1')
    const dir = await seedCover('t1')
    const service = createService({
      beforeInstallCover: async (req) => {
        if (req.cover.type === 'replace') await rm(req.cover.path)
      }
    })

    await expect(
      service.save({
        trackId: 't1',
        meta: { title: 'new-title' },
        cover: { type: 'replace', path: sourceImage }
      })
    ).rejects.toThrow('커버 파일을 찾을 수 없습니다')

    expect(store.getTrack('t1')?.title).toBe('old-title')
    expect(await readFile(join(dir, COVER_FILE_NAME), 'utf-8')).toBe('old-cover')
    expect(existsSync(join(dir, TRACK_EDIT_JOURNAL))).toBe(false)
    expect(existsSync(join(dir, COVER_STAGING))).toBe(false)
    expect(existsSync(join(dir, COVER_BACKUP))).toBe(false)
    expect(events).toEqual([])
  })

  it('DB 실패 시 파일도 이전 상태로 복구하고 원본 이미지는 남긴다', async () => {
    createTrack('t1')
    const dir = await seedCover('t1')
    const service = createService({
      beforeCommitMeta: async () => {
        throw new Error('db down')
      }
    })

    await expect(
      service.save({
        trackId: 't1',
        meta: { title: 'new-title' },
        cover: { type: 'replace', path: sourceImage }
      })
    ).rejects.toThrow('db down')

    expect(store.getTrack('t1')?.title).toBe('old-title')
    expect(await readFile(join(dir, COVER_FILE_NAME), 'utf-8')).toBe('old-cover')
    expect(existsSync(join(dir, TRACK_EDIT_JOURNAL))).toBe(false)
    expect(await readFile(sourceImage)).toEqual(PNG_1X1)
    expect(events).toEqual([])
  })

  it('삭제된 곡 ID는 거부하고 디렉토리를 재생성하지 않는다', async () => {
    createTrack('gone')
    store.deleteTrack('gone')
    const service = createService()

    await expect(
      service.save({
        trackId: 'gone',
        meta: { title: 'revived' },
        cover: { type: 'replace', path: sourceImage }
      })
    ).rejects.toThrow('track not found: gone')

    expect(store.getTrack('gone')).toBeUndefined()
    expect(existsSync(join(tracksDir, 'gone'))).toBe(false)
    expect(await readFile(sourceImage)).toEqual(PNG_1X1)
    expect(events).toEqual([])
  })

  it('커버만 저장하면 검색 키를 갱신하지 않고 updatedAt이 바뀐다', async () => {
    const before = createTrack('t1')
    store.setAnalysis('t1', {
      bpm: 128,
      musicKey: 'C#m',
      bpmConf: 0.7,
      keyConf: 0.4,
      version: 1
    })
    await seedCover('t1')
    const refresh = vi.fn()
    const lyrics = vi.fn()
    const analyze = vi.fn()
    const separate = vi.fn()
    const service = createService({ searchKeyService: { refresh } })

    const updated = await service.save({
      trackId: 't1',
      meta: {},
      cover: { type: 'replace', path: sourceImage }
    })

    expect(updated.updatedAt).not.toBe(before.updatedAt)
    expect(updated.bpm).toBe(128)
    expect(updated.musicKey).toBe('C#m')
    expect(updated.analysisSource).toBe('auto')
    expect(updated.bpmConf).toBe(0.7)
    expect(refresh).not.toHaveBeenCalled()
    expect(lyrics).not.toHaveBeenCalled()
    expect(analyze).not.toHaveBeenCalled()
    expect(separate).not.toHaveBeenCalled()
    expect(events).toEqual([{ channel: IPC_CHANNELS.trackUpdated, payload: updated }])
    expect(await readFile(join(tracksDir, 't1', COVER_FILE_NAME))).toEqual(PNG_1X1)
    expect(existsSync(join(tracksDir, 't1', COVER_NONE_MARKER))).toBe(false)
    expect(await readFile(sourceImage)).toEqual(PNG_1X1)
  })

  it('연속 두 번 커버만 바꾸면 캐시 키가 달라진다', async () => {
    createTrack('t1')
    const service = createService()
    const first = await service.save({
      trackId: 't1',
      meta: {},
      cover: { type: 'replace', path: sourceImage }
    })
    const second = await service.save({
      trackId: 't1',
      meta: {},
      cover: { type: 'replace', path: sourceImage2 }
    })
    expect(second.updatedAt).not.toBe(first.updatedAt)
    expect(second.updatedAt > first.updatedAt).toBe(true)
  })

  it('제목 변경 시에만 검색 키 갱신을 요청한다', async () => {
    createTrack('t1')
    const refresh = vi.fn()
    const service = createService({ searchKeyService: { refresh } })
    const updated = await service.save({
      trackId: 't1',
      meta: { title: '새 제목' },
      cover: { type: 'keep' }
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith(updated)
  })

  it('실행 중인 커버 추출이 사용자 교체 저장을 덮지 않는다', async () => {
    const id = 't1'
    createTrack(id, { sourcePath: join(root, 'a.flac') })
    const dir = join(tracksDir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'source.flac'), 'audio')

    const gate = deferred()
    const reached = deferred()
    const sidecar = {
      run: async (args: string[]) => {
        const out = args[args.indexOf('--out') + 1]
        await writeFile(out, 'extracted')
        return { cover: out }
      }
    } as unknown as SidecarManager
    const coverService = new CoverService({
      store,
      sidecar,
      tracksDir,
      beforeInstallExtract: async () => {
        reached.resolve()
        await gate.promise
      }
    })
    const service = createService({ coverService })
    coverService.refresh(store.mustGetTrack(id))
    await reached.promise

    const updated = await service.save({
      trackId: id,
      meta: {},
      cover: { type: 'replace', path: sourceImage }
    })
    gate.resolve()
    await coverService.idle()

    expect(await readFile(join(dir, COVER_FILE_NAME))).toEqual(PNG_1X1)
    expect(store.getTrack(id)?.updatedAt).toBe(updated.updatedAt)
  })

  it('메타 A로 검색 키 생성 중 메타 B를 저장하면 A 결과가 덮지 않는다', async () => {
    const id = 't1'
    createTrack(id, { title: 'ヨルシカ' })
    const gate = deferred()
    const reached = deferred()
    const sidecar = {
      run: async (args: string[]) => {
        const input = args[args.indexOf('--lyrics') + 1]
        const text = await readFile(input, 'utf-8')
        return { lines: [{ text, hint: `hint:${text.split('\n')[0]}` }] }
      }
    } as unknown as SidecarManager
    const searchKeyService = new SearchKeyService({
      store,
      sidecar,
      workDir: join(root, 'tmp'),
      onLog: () => {},
      beforeSetSearchKeys: async (track) => {
        if (track.title === 'ヨルシカ') {
          reached.resolve()
          await gate.promise
        }
      }
    })
    searchKeyService.refresh(store.mustGetTrack(id))
    await reached.promise

    const service = createService({ searchKeyService })
    await service.save({
      trackId: id,
      meta: { title: '新しい' },
      cover: { type: 'keep' }
    })
    gate.resolve()
    await searchKeyService.idle()

    expect(store.getTrack(id)?.title).toBe('新しい')
    const db = new Database(dbPath, { readonly: true })
    const row = db.prepare('SELECT search_keys FROM tracks WHERE id = ?').get(id) as {
      search_keys: string
    }
    db.close()
    expect(row.search_keys).toBe('hint:新しい')
  })

  it('BPM만 수정하면 user로 저장하고 제목만 고치면 분석 컬럼을 유지한다', async () => {
    createTrack('t1')
    store.setAnalysis('t1', {
      bpm: 128,
      musicKey: 'C#m',
      bpmConf: 0.7,
      keyConf: 0.4,
      version: 1
    })
    const service = createService()
    const titled = await service.save({
      trackId: 't1',
      meta: { title: 'only-title' },
      cover: { type: 'keep' }
    })
    expect(titled.bpm).toBe(128)
    expect(titled.musicKey).toBe('C#m')
    expect(titled.analysisSource).toBe('auto')

    const bpmOnly = await service.save({
      trackId: 't1',
      meta: { bpm: 96 },
      cover: { type: 'keep' }
    })
    expect(bpmOnly.bpm).toBe(96)
    expect(bpmOnly.musicKey).toBe('C#m')
    expect(bpmOnly.analysisSource).toBe('user')
    expect(bpmOnly.bpmConf).toBeNull()
  })

  it('커버 제거는 cover.none을 남기고 교체는 마커를 지운다', async () => {
    createTrack('t1')
    await seedCover('t1')
    const service = createService()
    await service.save({ trackId: 't1', meta: {}, cover: { type: 'remove' } })
    expect(existsSync(join(tracksDir, 't1', COVER_FILE_NAME))).toBe(false)
    expect(existsSync(join(tracksDir, 't1', COVER_NONE_MARKER))).toBe(true)

    await service.save({
      trackId: 't1',
      meta: {},
      cover: { type: 'replace', path: sourceImage }
    })
    expect(await readFile(join(tracksDir, 't1', COVER_FILE_NAME))).toEqual(PNG_1X1)
    expect(existsSync(join(tracksDir, 't1', COVER_NONE_MARKER))).toBe(false)
  })

  it('검색 키 생성 실패는 이미 완료한 저장을 되돌리지 않는다', async () => {
    createTrack('t1', { title: 'ヨルシカ' })
    const searchKeyService = new SearchKeyService({
      store,
      sidecar: {
        run: async () => {
          throw new Error('pronounce failed')
        }
      } as unknown as SidecarManager,
      workDir: join(root, 'tmp'),
      onLog: () => {}
    })
    const service = createService({ searchKeyService })
    const updated = await service.save({
      trackId: 't1',
      meta: { title: '新しい' },
      cover: { type: 'keep' }
    })
    await searchKeyService.idle()
    expect(updated.title).toBe('新しい')
    expect(store.getTrack('t1')?.title).toBe('新しい')
  })
})
