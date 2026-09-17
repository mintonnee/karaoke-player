import { existsSync } from 'fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ANALYZE_TIMEOUT_MS, AnalysisService } from '../AnalysisService'
import { JobQueue } from '../JobQueue'
import { LibraryStore } from '../LibraryStore'
import { SidecarError, SidecarManager } from '../../sidecar/SidecarManager'
import type { SidecarRunOptions } from '../../sidecar/SidecarManager'
import { ANALYSIS_VERSION } from '../../../shared/types'
import type { AnalyzeResult, Track } from '../../../shared/types'
import { PREVIEW_ANALYSIS_MESSAGES } from '../../../shared/previewAnalysis'

const FAKE_WORKER = join(
  process.cwd(),
  'src',
  'main',
  'library',
  '__tests__',
  'fake_analyze_worker.mjs'
)

const OK_RESULT: AnalyzeResult = {
  bpm: 128,
  bpm_conf: 0.72,
  key: 'C#m',
  key_conf: 0.41,
  version: ANALYSIS_VERSION
}

async function drain(queue: JobQueue): Promise<void> {
  while (queue.isRunning || queue.pending > 0) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('AnalysisService.preview', () => {
  let root: string
  let tracksDir: string
  let store: LibraryStore
  let queue: JobQueue
  let events: Array<{ channel: string; payload: unknown }>
  let logs: string[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'karaoke-preview-analysis-'))
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

  function createService(
    run: SidecarManager['run'],
    extra?: { analyzeTimeoutMs?: number }
  ): AnalysisService {
    return new AnalysisService({
      store,
      sidecar: { run } as SidecarManager,
      queue,
      tracksDir,
      notify: (channel, payload) => events.push({ channel, payload }),
      onLog: (line) => logs.push(line),
      analyzeTimeoutMs: extra?.analyzeTimeoutMs
    })
  }

  function createWorkerService(mode: string, analyzeTimeoutMs?: number): AnalysisService {
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
      onLog: (line) => logs.push(line),
      analyzeTimeoutMs
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

  function analysisSnapshot(id: string): {
    bpm: Track['bpm']
    musicKey: Track['musicKey']
    bpmConf: Track['bpmConf']
    keyConf: Track['keyConf']
    analysisSource: Track['analysisSource']
    status: Track['status']
    title: Track['title']
    artist: Track['artist']
    album: Track['album']
    updatedAt: Track['updatedAt']
  } | null {
    const track = store.getTrack(id)
    if (!track) return null
    return {
      bpm: track.bpm,
      musicKey: track.musicKey,
      bpmConf: track.bpmConf,
      keyConf: track.keyConf,
      analysisSource: track.analysisSource,
      status: track.status,
      title: track.title,
      artist: track.artist,
      album: track.album,
      updatedAt: track.updatedAt
    }
  }

  async function fileSnapshot(id: string): Promise<string[]> {
    const dir = join(tracksDir, id)
    if (!existsSync(dir)) return []
    return (await readdir(dir)).sort()
  }

  function notifyChannels(): string[] {
    return events.map((e) => e.channel)
  }

  it('user 출처 ready 곡도 분석하고 DB·파일·이벤트를 바꾸지 않는다', async () => {
    await createReadyTrack('t1')
    store.updateMeta('t1', {
      title: 'title-t1',
      artist: 'singer',
      album: 'album',
      bpm: 96,
      musicKey: 'Bm'
    })
    const before = analysisSnapshot('t1')
    const filesBefore = await fileSnapshot('t1')
    const service = createWorkerService('ok')

    service.refresh('t1')
    await drain(queue)
    expect(analysisSnapshot('t1')).toEqual(before)
    expect(notifyChannels()).toEqual([])

    const bpm = await service.preview({ trackId: 't1', field: 'bpm' })
    expect(bpm).toEqual({ ok: true, field: 'bpm', bpm: 128, bpmConf: 0.72 })
    expect('musicKey' in bpm).toBe(false)

    const key = await service.preview({ trackId: 't1', field: 'key' })
    expect(key).toEqual({ ok: true, field: 'key', musicKey: 'C#m', keyConf: 0.41 })
    expect('bpm' in key).toBe(false)

    expect(analysisSnapshot('t1')).toEqual(before)
    expect(await fileSnapshot('t1')).toEqual(filesBefore)
    expect(notifyChannels()).toEqual([])
  })

  it('요청 필드만 적용하고 미요청 필드 실패는 버린다', async () => {
    await createReadyTrack('t1')
    const before = analysisSnapshot('t1')

    const partialBpm = await createWorkerService('partial').preview({
      trackId: 't1',
      field: 'bpm'
    })
    expect(partialBpm).toMatchObject({ ok: false, field: 'bpm', code: 'FIELD_UNAVAILABLE' })
    if (!partialBpm.ok) {
      expect(partialBpm.message).toBe('BPM을 추정하지 못했습니다')
    }

    const partialKey = await createWorkerService('partial').preview({
      trackId: 't1',
      field: 'key'
    })
    expect(partialKey).toEqual({ ok: true, field: 'key', musicKey: 'Am', keyConf: 0.55 })

    const bpmWithBadKey = await createWorkerService('invalid-key').preview({
      trackId: 't1',
      field: 'bpm'
    })
    expect(bpmWithBadKey).toEqual({ ok: true, field: 'bpm', bpm: 128, bpmConf: 0.72 })

    const keyWithBadBpm = await createWorkerService('invalid-bpm').preview({
      trackId: 't1',
      field: 'key'
    })
    expect(keyWithBadBpm).toEqual({ ok: true, field: 'key', musicKey: 'C#m', keyConf: 0.41 })

    expect(analysisSnapshot('t1')).toEqual(before)
    expect(notifyChannels()).toEqual([])
  })

  it('범위·형식 밖 값은 성공으로 취급하지 않고 낮은 신뢰도 유효 BPM은 성공한다', async () => {
    await createReadyTrack('t1')

    const invalidBpm = await createWorkerService('invalid-bpm').preview({
      trackId: 't1',
      field: 'bpm'
    })
    expect(invalidBpm).toMatchObject({ ok: false, code: 'FIELD_UNAVAILABLE' })

    const invalidKey = await createWorkerService('invalid-key').preview({
      trackId: 't1',
      field: 'key'
    })
    expect(invalidKey).toMatchObject({ ok: false, code: 'FIELD_UNAVAILABLE' })

    const nullKey = await createWorkerService('null-key').preview({
      trackId: 't1',
      field: 'key'
    })
    expect(nullKey).toMatchObject({ ok: false, code: 'FIELD_UNAVAILABLE' })

    const low = await createWorkerService('low-conf').preview({
      trackId: 't1',
      field: 'bpm'
    })
    expect(low).toEqual({ ok: true, field: 'bpm', bpm: 128, bpmConf: 0.2 })
    expect(notifyChannels()).toEqual([])
  })

  it('워커 오류는 ANALYZE_FAILED이고 입력·DB를 유지한다', async () => {
    await createReadyTrack('t1')
    const before = analysisSnapshot('t1')
    const filesBefore = await fileSnapshot('t1')

    const result = await createWorkerService('error').preview({ trackId: 't1', field: 'bpm' })
    expect(result).toMatchObject({ ok: false, field: 'bpm', code: 'ANALYZE_FAILED' })
    if (!result.ok) expect(result.message).toBe(PREVIEW_ANALYSIS_MESSAGES.ANALYZE_FAILED)
    expect(analysisSnapshot('t1')).toEqual(before)
    expect(await fileSnapshot('t1')).toEqual(filesBefore)
    expect(notifyChannels()).toEqual([])
    expect(logs.some((l) => l.includes('queue:'))).toBe(false)
  })

  it('타임아웃은 TIMEOUT 코드로 돌려준다', async () => {
    await createReadyTrack('t1')
    const result = await createWorkerService('hang', 250).preview({
      trackId: 't1',
      field: 'key'
    })
    expect(result).toMatchObject({ ok: false, field: 'key', code: 'TIMEOUT' })
    if (!result.ok) expect(result.message).toBe(PREVIEW_ANALYSIS_MESSAGES.TIMEOUT)
    expect(notifyChannels()).toEqual([])
  })

  it('반주 누락·미준비·없는 곡은 구분된 오류다', async () => {
    await createReadyTrack('no-inst', false)
    const missingInst = await createService(async () => OK_RESULT).preview({
      trackId: 'no-inst',
      field: 'bpm'
    })
    expect(missingInst).toMatchObject({ ok: false, code: 'INST_MISSING' })
    expect(analysisSnapshot('no-inst')?.analysisSource).toBe('none')

    store.createTrack({
      id: 'imported',
      title: 't',
      artist: null,
      album: null,
      duration: 1,
      sourcePath: 'x'
    })
    const notReady = await createService(async () => OK_RESULT).preview({
      trackId: 'imported',
      field: 'key'
    })
    expect(notReady).toMatchObject({ ok: false, code: 'TRACK_NOT_READY' })

    const missing = await createService(async () => OK_RESULT).preview({
      trackId: 'no-such',
      field: 'bpm'
    })
    expect(missing).toMatchObject({ ok: false, code: 'TRACK_NOT_FOUND' })
    expect(notifyChannels()).toEqual([])
  })

  it('같은 곡의 대기·실행 중 중복 요청을 거부하고 끝나면 다시 받는다', async () => {
    await createReadyTrack('t1')
    const blocker = deferred<void>()
    queue.enqueue(async () => blocker.promise)

    const running = deferred<AnalyzeResult>()
    const runStarted = deferred<void>()
    const service = createService(async () => {
      runStarted.resolve()
      return running.promise
    })
    const first = service.preview({ trackId: 't1', field: 'bpm' })
    await new Promise((r) => setTimeout(r, 20))
    expect(queue.pending).toBe(1)

    const queuedDup = await service.preview({ trackId: 't1', field: 'key' })
    expect(queuedDup).toMatchObject({ ok: false, code: 'IN_PROGRESS' })

    blocker.resolve()
    await runStarted.promise
    const runningDup = await service.preview({ trackId: 't1', field: 'bpm' })
    expect(runningDup).toMatchObject({ ok: false, code: 'IN_PROGRESS' })

    running.resolve(OK_RESULT)
    expect(await first).toEqual({ ok: true, field: 'bpm', bpm: 128, bpmConf: 0.72 })

    const after = await service.preview({ trackId: 't1', field: 'key' })
    expect(after).toEqual({ ok: true, field: 'key', musicKey: 'C#m', keyConf: 0.41 })
  })

  it('성공·실패 모두에서 점유를 해제한다', async () => {
    await createReadyTrack('t1')
    let shouldFail = true
    const service = createService(async () => {
      if (shouldFail) {
        shouldFail = false
        throw new SidecarError('UNSUPPORTED_FORMAT', 'not a wav file')
      }
      return OK_RESULT
    })
    const failed = await service.preview({ trackId: 't1', field: 'bpm' })
    expect(failed).toMatchObject({ ok: false, code: 'ANALYZE_FAILED' })
    const ok = await service.preview({ trackId: 't1', field: 'bpm' })
    expect(ok.ok).toBe(true)
  })

  it('자동 refresh와 미리보기는 큐에서 동시에 돌지 않는다', async () => {
    await createReadyTrack('a')
    await createReadyTrack('b')
    let concurrent = 0
    let maxConcurrent = 0
    const service = createService(async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 40))
      concurrent -= 1
      return OK_RESULT
    })

    service.refresh('a')
    const preview = service.preview({ trackId: 'b', field: 'bpm' })
    await preview
    await drain(queue)
    expect(maxConcurrent).toBe(1)
    expect(store.getTrack('a')!.analysisSource).toBe('auto')
    expect(store.getTrack('b')!.analysisSource).toBe('none')
  })

  it('큐 대기에는 워커 타임아웃을 쓰지 않고 sidecar.run에만 넘긴다', async () => {
    await createReadyTrack('t1')
    const blocker = deferred<void>()
    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 80))
      blocker.resolve()
    })

    const timeoutMsList: Array<number | undefined> = []
    const service = createService(
      async (_args, opts?: SidecarRunOptions) => {
        timeoutMsList.push(opts?.timeoutMs)
        return OK_RESULT
      },
      { analyzeTimeoutMs: 30 }
    )

    const result = await service.preview({ trackId: 't1', field: 'bpm' })
    expect(result.ok).toBe(true)
    expect(timeoutMsList).toEqual([30])
    await blocker.promise
  })

  it('요청마다 새 분석을 실행하고 관리 경로의 inst.wav만 넘긴다', async () => {
    await createReadyTrack('t1')
    const calls: string[][] = []
    const service = createService(async (args) => {
      calls.push(args)
      return OK_RESULT
    })
    await service.preview({ trackId: 't1', field: 'bpm' })
    await service.preview({ trackId: 't1', field: 'key' })
    const inst = join(tracksDir, 't1', 'inst.wav')
    expect(calls).toEqual([
      ['analyze', '--input', inst, '--json'],
      ['analyze', '--input', inst, '--json']
    ])
  })

  it('대기 중 삭제되면 성공을 적용하지 않고 곡을 재생성하지 않는다', async () => {
    await createReadyTrack('t1')
    const blocker = deferred<void>()
    queue.enqueue(async () => blocker.promise)
    let ran = false
    const service = createService(async () => {
      ran = true
      return OK_RESULT
    })
    const preview = service.preview({ trackId: 't1', field: 'bpm' })
    await new Promise((r) => setTimeout(r, 20))

    store.deleteTrack('t1')
    await rm(join(tracksDir, 't1'), { recursive: true, force: true })
    blocker.resolve()

    const result = await preview
    expect(result).toMatchObject({ ok: false, code: 'TRACK_GONE' })
    expect(ran).toBe(false)
    expect(store.getTrack('t1')).toBeUndefined()
    expect(existsSync(join(tracksDir, 't1'))).toBe(false)
    expect(notifyChannels()).toEqual([])
  })

  it('실행 중 삭제·ready 상실이면 성공을 적용하지 않는다', async () => {
    await createReadyTrack('t1')
    const started = deferred<void>()
    const finish = deferred<AnalyzeResult>()
    const service = createService(async () => {
      started.resolve()
      return finish.promise
    })

    const deleted = service.preview({ trackId: 't1', field: 'bpm' })
    await started.promise
    store.deleteTrack('t1')
    await rm(join(tracksDir, 't1'), { recursive: true, force: true })
    finish.resolve(OK_RESULT)
    expect(await deleted).toMatchObject({ ok: false, code: 'TRACK_GONE' })
    expect(store.getTrack('t1')).toBeUndefined()
    expect(existsSync(join(tracksDir, 't1'))).toBe(false)

    await createReadyTrack('t2')
    const started2 = deferred<void>()
    const finish2 = deferred<AnalyzeResult>()
    const service2 = createService(async () => {
      started2.resolve()
      return finish2.promise
    })
    const before = analysisSnapshot('t2')
    const lostReady = service2.preview({ trackId: 't2', field: 'key' })
    await started2.promise
    store.updateStatus('t2', 'failed')
    finish2.resolve(OK_RESULT)
    expect(await lostReady).toMatchObject({ ok: false, code: 'TRACK_GONE' })
    expect(store.getTrack('t2')!.status).toBe('failed')
    expect(analysisSnapshot('t2')).toMatchObject({
      bpm: before!.bpm,
      musicKey: before!.musicKey,
      analysisSource: before!.analysisSource
    })
    expect(notifyChannels()).toEqual([])
  })

  it('대기 중 반주가 사라지면 INST_MISSING이다', async () => {
    await createReadyTrack('t1')
    const blocker = deferred<void>()
    queue.enqueue(async () => blocker.promise)
    const service = createService(async () => OK_RESULT)
    const preview = service.preview({ trackId: 't1', field: 'bpm' })
    await new Promise((r) => setTimeout(r, 20))
    await rm(join(tracksDir, 't1', 'inst.wav'))
    blocker.resolve()
    expect(await preview).toMatchObject({ ok: false, code: 'INST_MISSING' })
    expect(store.getTrack('t1')).toBeDefined()
    expect(analysisSnapshot('t1')?.analysisSource).toBe('none')
  })

  it('기본 워커 타임아웃은 120초다', async () => {
    await createReadyTrack('t1')
    let timeoutMs: number | undefined
    const service = createService(async (_args, opts?: SidecarRunOptions) => {
      timeoutMs = opts?.timeoutMs
      return OK_RESULT
    })
    await service.preview({ trackId: 't1', field: 'bpm' })
    expect(timeoutMs).toBe(ANALYZE_TIMEOUT_MS)
    expect(ANALYZE_TIMEOUT_MS).toBe(120_000)
  })
})
