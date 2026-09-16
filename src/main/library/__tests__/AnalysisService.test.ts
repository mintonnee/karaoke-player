import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ANALYSIS_VERSION, IPC_CHANNELS } from '../../../shared/types'
import type { Track } from '../../../shared/types'
import { SidecarManager } from '../../sidecar/SidecarManager'
import { AnalysisService } from '../AnalysisService'
import { JobQueue } from '../JobQueue'
import { LibraryStore } from '../LibraryStore'

const FAKE_WORKER = join(
  process.cwd(),
  'src',
  'main',
  'library',
  '__tests__',
  'fake_analyze_worker.mjs'
)

/** 큐가 비고 실행 중인 잡이 없을 때까지 기다린다 */
async function drain(queue: JobQueue): Promise<void> {
  while (queue.isRunning || queue.pending > 0) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('AnalysisService', () => {
  let root: string
  let tracksDir: string
  let store: LibraryStore
  let queue: JobQueue
  let events: Array<{ channel: string; payload: unknown }>
  let logs: string[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'karaoke-analysis-'))
    tracksDir = join(root, 'tracks')
    store = new LibraryStore(join(root, 'library.sqlite'))
    queue = new JobQueue((error) => logs.push(`queue: ${String(error)}`))
    events = []
    logs = []
  })

  afterEach(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })

  function createService(mode: 'ok' | 'partial' | 'error'): AnalysisService {
    const sidecar = new SidecarManager({
      command: process.execPath,
      baseArgs: [FAKE_WORKER, mode, String(ANALYSIS_VERSION)],
      onLog: () => {}
    })
    return new AnalysisService({
      store,
      sidecar,
      queue,
      tracksDir,
      notify: (channel, payload) => events.push({ channel, payload }),
      onLog: (line) => logs.push(line)
    })
  }

  async function createReadyTrack(id: string, withInst = true): Promise<Track> {
    store.createTrack({
      id,
      title: `title-${id}`,
      artist: null,
      album: null,
      duration: 180,
      sourcePath: `C:\\music\\${id}.flac`
    })
    if (withInst) {
      await mkdir(join(tracksDir, id), { recursive: true })
      await writeFile(join(tracksDir, id, 'inst.wav'), 'fake-wav')
    }
    return store.updateStatus(id, 'ready')
  }

  function updates(): Track[] {
    return events
      .filter((e) => e.channel === IPC_CHANNELS.trackUpdated)
      .map((e) => e.payload as Track)
  }

  it('ok: 결과를 auto로 저장하고 trackUpdated를 통지한다', async () => {
    const before = await createReadyTrack('t1')
    createService('ok').refresh('t1')
    await drain(queue)

    const track = store.getTrack('t1')!
    expect(track.bpm).toBe(128)
    expect(track.musicKey).toBe('C#m')
    expect(track.bpmConf).toBe(0.72)
    expect(track.keyConf).toBe(0.41)
    expect(track.analysisSource).toBe('auto')
    expect(track.status).toBe('ready')
    expect(track.updatedAt).toBe(before.updatedAt)

    expect(updates()).toHaveLength(1)
    expect(updates()[0]).toEqual(track)
    expect(logs.some((l) => l.startsWith('[analysis] analyzed'))).toBe(true)
  })

  it('partial: bpm null·key 값만 있어도 저장한다', async () => {
    await createReadyTrack('t1')
    createService('partial').refresh('t1')
    await drain(queue)

    const track = store.getTrack('t1')!
    expect(track.bpm).toBeNull()
    expect(track.bpmConf).toBeNull()
    expect(track.musicKey).toBe('Am')
    expect(track.keyConf).toBe(0.55)
    expect(track.analysisSource).toBe('auto')
    expect(updates()).toHaveLength(1)
  })

  it('error: 상태는 ready 유지, [analysis] 로그만 남기고 통지하지 않는다', async () => {
    await createReadyTrack('t1')
    createService('error').refresh('t1')
    await drain(queue)

    const track = store.getTrack('t1')!
    expect(track.status).toBe('ready')
    expect(track.bpm).toBeNull()
    expect(track.musicKey).toBeNull()
    expect(track.analysisSource).toBe('none')
    expect(updates()).toEqual([])
    expect(logs).toEqual([
      expect.stringMatching(/^\[analysis\] analyze failed for t1: UNSUPPORTED_FORMAT/)
    ])
  })

  it('사용자 값(user)이 있는 트랙은 건너뛴다', async () => {
    await createReadyTrack('t1')
    store.updateMeta('t1', {
      title: 'title-t1',
      artist: null,
      album: null,
      bpm: 96,
      musicKey: 'Bm'
    })
    createService('ok').refresh('t1')
    await drain(queue)

    const track = store.getTrack('t1')!
    expect(track.bpm).toBe(96)
    expect(track.musicKey).toBe('Bm')
    expect(track.analysisSource).toBe('user')
    expect(updates()).toEqual([])
  })

  it('inst.wav가 없으면 로그만 남기고 건너뛴다', async () => {
    await createReadyTrack('t1', false)
    createService('ok').refresh('t1')
    await drain(queue)

    expect(store.getTrack('t1')!.analysisSource).toBe('none')
    expect(updates()).toEqual([])
    expect(logs).toEqual(['[analysis] skip t1: inst.wav not found'])
  })

  it('ready가 아닌 트랙은 건너뛴다', async () => {
    store.createTrack({
      id: 't1',
      title: 't',
      artist: null,
      album: null,
      duration: 1,
      sourcePath: 'x'
    })
    createService('ok').refresh('t1')
    await drain(queue)

    expect(store.getTrack('t1')!.analysisSource).toBe('none')
    expect(updates()).toEqual([])
  })

  it('backfill: 분석이 필요한 ready 트랙만 순차 분석한다', async () => {
    await createReadyTrack('a')
    await createReadyTrack('b')
    await createReadyTrack('c')
    // 008 이전 코드가 BPM 실행 실패를 최신(v2) 결과로 저장했던 곡도 복구한다.
    store.setAnalysis('b', {
      bpm: null,
      musicKey: 'Am',
      bpmConf: null,
      keyConf: 0.5,
      version: 2
    })
    store.updateMeta('c', { title: 'c', artist: null, album: null, bpm: 100, musicKey: null })
    store.createTrack({
      id: 'd',
      title: 'd',
      artist: null,
      album: null,
      duration: 1,
      sourcePath: 'x'
    })

    createService('ok').backfill()
    await drain(queue)

    expect(store.getTrack('a')!.analysisSource).toBe('auto')
    expect(store.getTrack('b')!.analysisSource).toBe('auto')
    expect(store.getTrack('b')!.bpm).toBe(128)
    expect(store.getTrack('c')!.bpm).toBe(100)
    expect(store.getTrack('c')!.analysisSource).toBe('user')
    expect(store.getTrack('d')!.analysisSource).toBe('none')
    expect(
      updates()
        .map((t) => t.id)
        .sort()
    ).toEqual(['a', 'b'])
    expect(store.listTracksNeedingAnalysis()).toEqual([])
  })
})
