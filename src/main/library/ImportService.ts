import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { copyFile, mkdir, realpath, rename, rm, stat, writeFile } from 'fs/promises'
import { basename, extname, isAbsolute, join, normalize } from 'path'
import {
  guideAudioFileName,
  IPC_CHANNELS,
  PAIR_LENGTH_DELTA_MS,
  PREPARE_PAIR_VERSION
} from '../../shared/types'
import type {
  AppErrorReport,
  GuideKind,
  ImportFilesResponse,
  ImportProgressEvent,
  ImportRejection,
  PairImportProgressEvent,
  AudioTagPreview,
  ImportUserMeta,
  PairImportRequest,
  PairImportRole,
  PreparePairResult,
  ProbeResult,
  Track
} from '../../shared/types'
import { SidecarError } from '../sidecar/SidecarManager'
import type { SidecarManager } from '../sidecar/SidecarManager'
import { JobQueue } from './JobQueue'
import type { LibraryStore } from './LibraryStore'
import { PAIR_JOB_MARKER, PAIR_TMP_DIRNAME } from './pairRecovery'
import type { PairJobRecord } from './pairRecovery'

const PROBE_TIMEOUT_MS = 30_000
const ALLOWED_AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.m4a'])
const ALLOWED_COVER_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const MAX_COVER_BYTES = 20 * 1024 * 1024

export interface ImportServiceOptions {
  store: LibraryStore
  sidecar: SidecarManager
  /** 분리/정렬 작업 공용 직렬화 큐 (§4, 동시 1개) */
  queue: JobQueue
  /** <userData>/tracks */
  tracksDir: string
  /** KARAOKE_MAX_DURATION_SEC, 초과 시 임포트 거부 */
  maxDurationSec: number
  /** 분리 시점의 Demucs 모델 (설정에서 변경 가능하므로 매 작업마다 조회) */
  getDemucsModel: () => string
  /** 렌더러 브로드캐스트 */
  notify: (channel: string, payload: unknown) => void
  /** 임포트 직후 LRCLIB 가사 조회 (§4.4). 실패는 서비스 내부에서 삼킨다 */
  fetchLyrics?: (track: Track) => Promise<unknown>
  /** 임포트 직후 검색용 발음 키 생성 (SearchKeyService.refresh) */
  refreshSearchKeys?: (track: Track) => void
  /** 임포트 직후 앨범 커버 추출 (CoverService.refresh) */
  extractCover?: (track: Track) => void
  /** 분리 성공·ready 통지 뒤 BPM·키 분석 (AnalysisService.refresh, 스펙 002 §4.2). 같은 큐에 후속 잡으로 들어간다 */
  analyze?: (track: Track) => void
  onLog?: (line: string) => void
}

/**
 * 파일 태그(probe)에 값이 없을 때 대신 쓰는 메타 힌트.
 * URL 임포트에서 yt-dlp가 알려준 아티스트/채널명을 넘기는 용도 — 태그가 있으면 태그가 우선한다.
 */
export interface ImportMetaHint {
  /** 태그에 제목이 없을 때 파일명 대신 쓸 제목 (yt-dlp `%(title)s`) */
  title?: string | null
  artist?: string | null
}

export class PairImportError extends Error {
  constructor(
    message: string,
    readonly role: PairImportRole,
    readonly filePath: string
  ) {
    super(message)
    this.name = 'PairImportError'
  }
}

/** 임포트 파이프라인: probe → 원본 복사 → DB 등록 → 분리 잡 큐잉 (S1.2/S1.3) */
export class ImportService {
  private readonly queue: JobQueue

  constructor(private readonly options: ImportServiceOptions) {
    this.queue = options.queue
  }

  /** 가져오기 팝업용. 등록하지 않고 태그만 읽는다. 실패는 빈 값 */
  async probeTags(filePath: string): Promise<AudioTagPreview> {
    const empty: AudioTagPreview = { title: null, artist: null }
    try {
      await assertLocalAudioFile(filePath, 'mr')
      const probe = (await this.options.sidecar.run(['probe', '--input', filePath, '--json'], {
        timeoutMs: PROBE_TIMEOUT_MS
      })) as ProbeResult
      return {
        title: nonEmpty(probe.title) ?? null,
        artist: nonEmpty(probe.artist) ?? null
      }
    } catch {
      return empty
    }
  }

  async importFiles(
    filePaths: string[],
    hint?: ImportMetaHint,
    userMeta?: ImportUserMeta
  ): Promise<ImportFilesResponse> {
    const imported: Track[] = []
    const rejected: ImportRejection[] = []

    for (const filePath of filePaths) {
      try {
        imported.push(await this.importOne(filePath, hint, userMeta))
      } catch (error) {
        rejected.push({ filePath, reason: describeError(error) })
      }
    }
    return { imported, rejected }
  }

  /**
   * MR+가이드 한 곡. importFiles를 두 번 호출하지 않고 separate/Demucs도 호출하지 않는다.
   * 실패는 rejected로만 돌린다 (등록 전 오류 센터 중복 금지).
   */
  async importPair(req: PairImportRequest): Promise<ImportFilesResponse> {
    try {
      const track = await this.importPairOne(req)
      this.notifyTrack(track)
      void this.options.fetchLyrics?.(track)
      this.options.refreshSearchKeys?.(track)
      if (!req.coverPath) this.options.extractCover?.(track)
      this.options.analyze?.(track)
      return { imported: [track], rejected: [] }
    } catch (error) {
      if (error instanceof PairImportError) {
        return {
          imported: [],
          rejected: [{ filePath: error.filePath, reason: error.message, role: error.role }]
        }
      }
      const filePath = typeof req?.mrPath === 'string' ? req.mrPath : ''
      return {
        imported: [],
        rejected: [{ filePath, reason: describeError(error), role: 'pair' }]
      }
    }
  }

  private async importOne(
    filePath: string,
    hint?: ImportMetaHint,
    userMeta?: ImportUserMeta
  ): Promise<Track> {
    const probe = (await this.options.sidecar.run(['probe', '--input', filePath, '--json'], {
      timeoutMs: PROBE_TIMEOUT_MS
    })) as ProbeResult

    if (probe.duration > this.options.maxDurationSec) {
      throw new Error(
        `duration ${Math.round(probe.duration)}s exceeds limit ${this.options.maxDurationSec}s`
      )
    }

    const id = randomUUID()
    const trackDir = this.trackDir(id)
    await mkdir(trackDir, { recursive: true })
    await copyFile(filePath, join(trackDir, `source${extname(filePath)}`))

    const track = this.options.store.createTrack({
      id,
      title:
        pickMetaField(userMeta?.title, probe.title, hint?.title) ??
        basename(filePath, extname(filePath)),
      artist: pickMetaField(userMeta?.artist, probe.artist, hint?.artist) ?? null,
      album: probe.album ?? null,
      duration: probe.duration,
      sourcePath: filePath
    })
    if (userMeta?.coverPath) await installUserCover(trackDir, userMeta.coverPath)
    this.notifyTrack(track)
    void this.options.fetchLyrics?.(track)
    this.options.refreshSearchKeys?.(track)
    if (!userMeta?.coverPath) this.options.extractCover?.(track)
    this.enqueueSeparation(id)
    return track
  }

  private async importPairOne(req: PairImportRequest): Promise<Track> {
    const parsed = parsePairRequest(req)
    await assertLocalAudioFile(parsed.mrPath, 'mr')
    if (parsed.guidePath !== null) await assertLocalAudioFile(parsed.guidePath, 'guide')
    if (parsed.guidePath !== null && (await isSameRealFile(parsed.mrPath, parsed.guidePath))) {
      throw new PairImportError('MR과 가이드가 같은 파일입니다', 'pair', parsed.mrPath)
    }

    const trackId = randomUUID()
    const jobDir = join(this.options.tracksDir, PAIR_TMP_DIRNAME, trackId)
    const finalDir = this.trackDir(trackId)
    let committed = false

    try {
      await mkdir(jobDir, { recursive: true })
      const record: PairJobRecord = {
        version: 1,
        jobId: trackId,
        trackId,
        guideKind: parsed.guideKind,
        mrPath: parsed.mrPath,
        guidePath: parsed.guidePath,
        createdAt: new Date().toISOString()
      }
      await writeFile(join(jobDir, PAIR_JOB_MARKER), JSON.stringify(record), 'utf-8')

      this.emitPairProgress({ jobId: trackId, stage: 'queued' })
      const track = await this.runQueued(() =>
        this.prepareAndCommitPair(parsed, trackId, jobDir, finalDir)
      )
      committed = true
      return track
    } finally {
      if (!committed) {
        await rm(jobDir, { recursive: true, force: true }).catch(() => undefined)
        if (existsSync(join(finalDir, PAIR_JOB_MARKER)) && !this.options.store.getTrack(trackId)) {
          await rm(finalDir, { recursive: true, force: true }).catch(() => undefined)
        }
      }
    }
  }

  private async prepareAndCommitPair(
    req: PairImportRequest,
    trackId: string,
    jobDir: string,
    finalDir: string
  ): Promise<Track> {
    const mrExt = extname(req.mrPath)
    const mrCopy = join(jobDir, `${req.guideKind === 'none' ? 'source' : 'source-inst'}${mrExt}`)
    const guideCopy =
      req.guidePath === null ? null : join(jobDir, `source${extname(req.guidePath)}`)
    await copyFile(req.mrPath, mrCopy)
    if (req.guidePath !== null && guideCopy !== null) await copyFile(req.guidePath, guideCopy)

    this.emitPairProgress({ jobId: trackId, stage: 'probe' })
    const mrProbe = await this.probePairFile(mrCopy, 'mr', req.mrPath)
    const guideProbe =
      guideCopy !== null && req.guidePath !== null
        ? await this.probePairFile(guideCopy, 'guide', req.guidePath)
        : mrProbe
    if (guideCopy !== null)
      assertPairDurationDelta(mrProbe.duration, guideProbe.duration, req.mrPath)

    this.emitPairProgress({ jobId: trackId, stage: 'prepare' })
    const result = await this.runPreparePair(
      mrCopy,
      guideCopy,
      jobDir,
      req.guideKind,
      trackId,
      req.mrPath
    )
    await this.verifyPrepareOutputs(jobDir, req.guideKind, result, req.mrPath)

    const meta = {
      importKind: 'paired' as const,
      guideKind: req.guideKind,
      roles: { mr: 'inst.wav', guide: guideAudioFileName(req.guideKind) },
      inputs: {
        mr: basename(req.mrPath),
        guide: req.guidePath === null ? null : basename(req.guidePath)
      },
      prepareVersion: PREPARE_PAIR_VERSION,
      processedAt: new Date().toISOString()
    }
    await writeFile(join(jobDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8')

    this.emitPairProgress({ jobId: trackId, stage: 'save' })
    await rm(finalDir, { recursive: true, force: true }).catch(() => undefined)
    await rename(jobDir, finalDir)
    if (req.coverPath) {
      try {
        await installUserCover(finalDir, req.coverPath)
      } catch (error) {
        throw new PairImportError(describeError(error), 'pair', req.coverPath)
      }
    }

    const track = this.options.store.createTrack({
      id: trackId,
      title:
        pickMetaField(req.title, guideProbe.title, mrProbe.title) ??
        basename(req.mrPath, extname(req.mrPath)),
      artist: pickMetaField(req.artist, guideProbe.artist, mrProbe.artist) ?? null,
      album: nonEmpty(guideProbe.album) ?? nonEmpty(mrProbe.album) ?? null,
      duration: result.duration,
      sourcePath: req.guidePath ?? req.mrPath,
      status: 'ready',
      importKind: 'paired',
      guideKind: req.guideKind
    })
    await rm(join(finalDir, PAIR_JOB_MARKER), { force: true })
    return track
  }

  private async probePairFile(
    filePath: string,
    role: 'mr' | 'guide',
    originalPath: string
  ): Promise<ProbeResult> {
    let probe: ProbeResult
    try {
      probe = (await this.options.sidecar.run(['probe', '--input', filePath, '--json'], {
        timeoutMs: PROBE_TIMEOUT_MS
      })) as ProbeResult
    } catch (error) {
      throw new PairImportError(
        `파일을 읽을 수 없습니다: ${describeError(error)}`,
        role,
        originalPath
      )
    }
    assertFiniteDuration(probe.duration, role, originalPath, this.options.maxDurationSec)
    return probe
  }

  private async runPreparePair(
    mrCopy: string,
    guideCopy: string | null,
    outDir: string,
    guideKind: GuideKind,
    jobId: string,
    originalMrPath: string
  ): Promise<PreparePairResult> {
    try {
      return (await this.options.sidecar.run(
        [
          'prepare-pair',
          '--mr',
          mrCopy,
          ...(guideCopy === null ? [] : ['--guide', guideCopy]),
          '--out',
          outDir,
          '--guide-kind',
          guideKind,
          '--json'
        ],
        {
          onProgress: (event) => {
            const stage = event.stage === 'probe' ? 'probe' : 'prepare'
            const progress: PairImportProgressEvent = { jobId, stage, msg: event.msg }
            if (typeof event.pct === 'number' && Number.isFinite(event.pct)) {
              progress.pct = event.pct
            }
            this.emitPairProgress(progress)
          }
        }
      )) as PreparePairResult
    } catch (error) {
      throw new PairImportError(
        `파일 준비에 실패했습니다: ${describeError(error)}`,
        'pair',
        originalMrPath
      )
    }
  }

  private async verifyPrepareOutputs(
    outDir: string,
    guideKind: GuideKind,
    result: PreparePairResult,
    mrPath: string
  ): Promise<void> {
    if (!result || typeof result !== 'object') {
      throw new PairImportError('준비 결과가 올바르지 않습니다', 'pair', mrPath)
    }
    assertFiniteDuration(result.duration, 'pair', mrPath, this.options.maxDurationSec)

    const expectedInst = join(outDir, 'inst.wav')
    const instPath = resolveOutPath(result.inst, outDir)
    if (guideKind === 'none') {
      if (
        !existsSync(expectedInst) ||
        basename(instPath) !== 'inst.wav' ||
        result.guide !== null ||
        existsSync(join(outDir, 'vocal.wav')) ||
        existsSync(join(outDir, 'guide.wav'))
      ) {
        throw new PairImportError('MR 단독 준비 산출물이 올바르지 않습니다', 'pair', mrPath)
      }
      return
    }
    const expectedGuide = join(outDir, guideAudioFileName(guideKind)!)
    if (typeof result.guide !== 'string')
      throw new PairImportError('가이드 산출물이 없습니다', 'pair', mrPath)
    const guidePath = resolveOutPath(result.guide, outDir)
    if (!existsSync(expectedInst) || !existsSync(expectedGuide)) {
      throw new PairImportError('준비 산출물이 없습니다', 'pair', mrPath)
    }
    if (basename(instPath) !== 'inst.wav' || basename(guidePath) !== basename(expectedGuide)) {
      throw new PairImportError('준비 산출물 이름이 올바르지 않습니다', 'pair', mrPath)
    }
    const unexpected = guideKind === 'full_mix' ? 'vocal.wav' : 'guide.wav'
    await rm(join(outDir, unexpected), { force: true })
  }

  private enqueueSeparation(trackId: string): void {
    this.queue.enqueue(async () => {
      const track = this.options.store.getTrack(trackId)
      if (!track) return

      this.notifyTrack(this.options.store.updateStatus(trackId, 'separating'))
      const trackDir = this.trackDir(trackId)
      const sourceCopy = join(trackDir, `source${extname(track.sourcePath)}`)
      const model = this.options.getDemucsModel()

      try {
        await this.options.sidecar.run(
          ['separate', '--input', sourceCopy, '--out', trackDir, '--model', model, '--json'],
          {
            onProgress: (event) => {
              const progress: ImportProgressEvent = {
                trackId,
                pct: event.pct,
                msg: event.msg
              }
              this.options.notify(IPC_CHANNELS.importProgress, progress)
            }
          }
        )
        await writeFile(
          join(trackDir, 'meta.json'),
          JSON.stringify({ model, processedAt: new Date().toISOString() }, null, 2)
        )
        const readyTrack = this.options.store.updateStatus(trackId, 'ready')
        this.notifyTrack(readyTrack)
        // ready 통지 이후에 큐잉하므로 재생 가능 시점이 늦어지지 않는다
        this.options.analyze?.(readyTrack)
      } catch (error) {
        const message = describeError(error)
        this.log(`separate failed for ${trackId}: ${message}`)
        this.notifyTrack(this.options.store.updateStatus(trackId, 'failed'))
        // 오류 센터로: 상태 아이콘만으로는 사유를 알 수 없다
        const report: AppErrorReport = {
          source: 'separate',
          message: `"${track.title}" 보컬 분리 실패: ${message}`,
          at: new Date().toISOString(),
          trackId
        }
        this.options.notify(IPC_CHANNELS.appError, report)
      }
    })
  }

  private runQueued<T>(work: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.enqueue(async () => {
        try {
          resolve(await work())
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
  }

  private trackDir(trackId: string): string {
    return join(this.options.tracksDir, trackId)
  }

  private notifyTrack(track: Track): void {
    this.options.notify(IPC_CHANNELS.trackUpdated, track)
  }

  private emitPairProgress(event: PairImportProgressEvent): void {
    this.options.notify(IPC_CHANNELS.pairImportProgress, event)
  }

  private log(line: string): void {
    ;(this.options.onLog ?? console.error)(`[import] ${line}`)
  }
}

function parsePairRequest(req: PairImportRequest): PairImportRequest {
  if (req === null || typeof req !== 'object') {
    throw new PairImportError('가져오기 요청이 올바르지 않습니다', 'pair', '')
  }
  if (typeof req.mrPath !== 'string' || req.mrPath.trim() === '') {
    throw new PairImportError(
      'MR 파일이 없습니다',
      'mr',
      typeof req.mrPath === 'string' ? req.mrPath : ''
    )
  }
  if (req.guideKind === 'none') {
    if (req.guidePath !== null)
      throw new PairImportError(
        '가이드 보컬 없음에는 가이드 파일을 지정할 수 없습니다',
        'guide',
        ''
      )
    return {
      mrPath: req.mrPath,
      guidePath: null,
      guideKind: 'none',
      title: req.title,
      artist: req.artist,
      coverPath: req.coverPath
    }
  }
  if (typeof req.guidePath !== 'string' || req.guidePath.trim() === '') {
    throw new PairImportError(
      '가이드 파일이 없습니다',
      'guide',
      typeof req.guidePath === 'string' ? req.guidePath : ''
    )
  }
  if (req.guideKind !== 'vocal_only' && req.guideKind !== 'full_mix') {
    throw new PairImportError('가이드 종류를 선택하세요', 'pair', req.mrPath)
  }
  return {
    mrPath: req.mrPath,
    guidePath: req.guidePath,
    guideKind: req.guideKind,
    title: req.title,
    artist: req.artist,
    coverPath: req.coverPath
  }
}

async function assertLocalAudioFile(filePath: string, role: 'mr' | 'guide'): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(filePath)
  } catch {
    throw new PairImportError('파일을 찾을 수 없습니다', role, filePath)
  }
  if (!info.isFile()) {
    throw new PairImportError('일반 파일이 아닙니다', role, filePath)
  }
  if (!ALLOWED_AUDIO_EXT.has(extname(filePath).toLowerCase())) {
    throw new PairImportError('지원하지 않는 형식입니다 (mp3/wav/flac/m4a)', role, filePath)
  }
}

async function isSameRealFile(a: string, b: string): Promise<boolean> {
  if (equalPath(a, b)) return true
  let realA: string
  let realB: string
  try {
    realA = await realpath(a)
    realB = await realpath(b)
  } catch {
    return false
  }
  if (equalPath(realA, realB)) return true
  const [sa, sb] = await Promise.all([stat(realA), stat(realB)])
  if (sa.ino === 0 || sb.ino === 0) return false
  return sa.dev === sb.dev && sa.ino === sb.ino
}

function equalPath(a: string, b: string): boolean {
  const left = normalize(a)
  const right = normalize(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function assertFiniteDuration(
  duration: number,
  role: PairImportRole,
  filePath: string,
  maxDurationSec: number
): void {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new PairImportError('길이가 올바르지 않습니다', role, filePath)
  }
  if (duration > maxDurationSec) {
    throw new PairImportError(
      `duration ${Math.round(duration)}s exceeds limit ${maxDurationSec}s`,
      role,
      filePath
    )
  }
}

function assertPairDurationDelta(mrDuration: number, guideDuration: number, mrPath: string): void {
  const deltaMs = Math.abs(mrDuration - guideDuration) * 1000
  if (deltaMs > PAIR_LENGTH_DELTA_MS) {
    throw new PairImportError(
      `길이 차이가 ${Math.round(deltaMs)}ms로 허용치 ${PAIR_LENGTH_DELTA_MS}ms를 초과합니다 (MR ${mrDuration.toFixed(3)}s, 가이드 ${guideDuration.toFixed(3)}s)`,
      'pair',
      mrPath
    )
  }
}

function resolveOutPath(reported: string, outDir: string): string {
  if (typeof reported !== 'string' || reported === '') return reported
  return isAbsolute(reported) ? reported : join(outDir, reported)
}

async function installUserCover(trackDir: string, imagePath: string): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(imagePath)
  } catch {
    throw new Error('커버 파일을 찾을 수 없습니다')
  }
  if (!info.isFile()) throw new Error('커버가 일반 파일이 아닙니다')
  if (!ALLOWED_COVER_EXT.has(extname(imagePath).toLowerCase())) {
    throw new Error('커버는 JPG/PNG/WebP만 사용할 수 있습니다')
  }
  if (info.size > MAX_COVER_BYTES) throw new Error('커버 파일이 너무 큽니다')
  await copyFile(imagePath, join(trackDir, 'cover.jpg'))
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/** 사용자가 적은 값 > 태그 > 자동 힌트. 빈 문자열은 없는 값으로 본다 */
function pickMetaField(
  user: string | null | undefined,
  tagged: string | null | undefined,
  fallback?: string | null
): string | undefined {
  return nonEmpty(user) ?? nonEmpty(tagged) ?? nonEmpty(fallback)
}

function describeError(error: unknown): string {
  if (error instanceof SidecarError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}
