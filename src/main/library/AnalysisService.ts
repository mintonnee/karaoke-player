import { existsSync } from 'fs'
import { join } from 'path'
import {
  parsePreviewBpmValue,
  parsePreviewConfidence,
  parsePreviewMusicKeyValue,
  previewAnalysisFailure,
  type PreviewAnalysisField,
  type PreviewAnalysisRequest,
  type PreviewAnalysisResult
} from '../../shared/previewAnalysis'
import { IPC_CHANNELS } from '../../shared/types'
import type { AnalyzeResult, AppErrorReport } from '../../shared/types'
import { SidecarError } from '../sidecar/SidecarManager'
import type { SidecarManager } from '../sidecar/SidecarManager'
import type { JobQueue } from './JobQueue'
import type { LibraryStore } from './LibraryStore'

/** 스펙 002 §4.2: 분석 타임아웃 120초. 큐 대기에는 쓰지 않는다 */
export const ANALYZE_TIMEOUT_MS = 120_000

export interface AnalysisServiceOptions {
  store: LibraryStore
  sidecar: SidecarManager
  /** 분리와 같은 직렬화 큐 (torch 프로세스 동시 실행 방지) */
  queue: JobQueue
  /** <userData>/tracks */
  tracksDir: string
  /** 렌더러 브로드캐스트 */
  notify: (channel: string, payload: unknown) => void
  onLog?: (line: string) => void
  /** 테스트에서만 단축. 운영 기본은 ANALYZE_TIMEOUT_MS */
  analyzeTimeoutMs?: number
}

/**
 * 반주 스템(inst.wav)에서 BPM·조성을 추정해 tracks 행에 저장한다 (스펙 002 §4.2).
 * 분리 완료 직후와 앱 시작 백필에서 호출된다. 실패는 로그만 남기고 트랙 상태는 바꾸지 않는다.
 * 곡 수정 재측정은 preview로 저장 없이 측정값만 돌려준다 (스펙 011).
 */
export class AnalysisService {
  /** 같은 곡의 수동 미리보기 점유. 대기+실행을 합쳐 하나만 허용 */
  private readonly inFlight = new Set<string>()

  constructor(private readonly options: AnalysisServiceOptions) {}

  /** 분석 작업을 큐에 넣는다. ready가 아니거나 사용자 값이 있으면 실행 시점에 건너뛴다 */
  refresh(trackId: string): void {
    this.options.queue.enqueue(async () => {
      try {
        await this.analyze(trackId)
      } catch (error) {
        const message = describeError(error)
        this.log(`analyze failed for ${trackId}: ${message}`)
        const title = this.options.store.getTrack(trackId)?.title ?? trackId
        const report: AppErrorReport = {
          source: 'analyze',
          message: `"${title}" BPM·키 분석 실패: ${message}`,
          at: new Date().toISOString(),
          trackId
        }
        this.options.notify(IPC_CHANNELS.appError, report)
      }
    })
  }

  /** 분석이 없거나 구버전인 기존 ready 트랙을 채운다 (앱 시작 시) */
  backfill(): void {
    for (const track of this.options.store.listTracksNeedingAnalysis()) {
      this.refresh(track.id)
    }
  }

  /** 저장·통지 없이 요청 필드만 측정한다. analysis_source='user'여도 실행한다 */
  async preview(req: PreviewAnalysisRequest): Promise<PreviewAnalysisResult> {
    const field: PreviewAnalysisField = req.field === 'key' ? 'key' : 'bpm'
    const trackId = typeof req.trackId === 'string' ? req.trackId.trim() : ''
    if (trackId === '' || (req.field !== 'bpm' && req.field !== 'key')) {
      return previewAnalysisFailure(field, 'INVALID_REQUEST')
    }
    if (this.inFlight.has(trackId)) {
      return previewAnalysisFailure(field, 'IN_PROGRESS')
    }

    const early = this.previewPrecheck(trackId, field, 'start')
    if (early) return early

    this.inFlight.add(trackId)
    try {
      return await this.options.queue.enqueueAndWait(() => this.runPreview(trackId, field))
    } catch (error) {
      this.log(`preview ${field} failed for ${trackId}: ${describeError(error)}`)
      return sidecarFailure(field, error)
    } finally {
      this.inFlight.delete(trackId)
    }
  }

  private async analyze(trackId: string): Promise<void> {
    const track = this.options.store.getTrack(trackId)
    if (!track || track.status !== 'ready') return
    if (track.analysisSource === 'user') return

    const inst = this.instPath(trackId)
    if (!existsSync(inst)) {
      this.log(`skip ${trackId}: inst.wav not found`)
      return
    }

    const result = await this.runAnalyzeWorker(inst)
    const updated = this.options.store.setAnalysis(trackId, {
      bpm: result.bpm,
      musicKey: result.key,
      bpmConf: result.bpm_conf,
      keyConf: result.key_conf,
      version: result.version
    })
    this.options.notify(IPC_CHANNELS.trackUpdated, updated)
    this.log(`analyzed "${track.title}": bpm=${result.bpm ?? '-'} key=${result.key ?? '-'}`)
  }

  private async runPreview(
    trackId: string,
    field: PreviewAnalysisField
  ): Promise<PreviewAnalysisResult> {
    const blocked = this.previewPrecheck(trackId, field, 'queued')
    if (blocked) return blocked

    let result: AnalyzeResult
    try {
      result = await this.runAnalyzeWorker(this.instPath(trackId))
    } catch (error) {
      this.log(`preview ${field} failed for ${trackId}: ${describeError(error)}`)
      return sidecarFailure(field, error)
    }

    const gone = this.previewTargetGone(trackId, field)
    if (gone) return gone

    return pickPreviewField(field, result)
  }

  private previewPrecheck(
    trackId: string,
    field: PreviewAnalysisField,
    phase: 'start' | 'queued'
  ): PreviewAnalysisResult | null {
    const track = this.options.store.getTrack(trackId)
    if (phase === 'start') {
      if (!track) return previewAnalysisFailure(field, 'TRACK_NOT_FOUND')
      if (track.status !== 'ready') return previewAnalysisFailure(field, 'TRACK_NOT_READY')
    } else if (!track || track.status !== 'ready') {
      return previewAnalysisFailure(field, 'TRACK_GONE')
    }
    if (!existsSync(this.instPath(trackId))) {
      return previewAnalysisFailure(field, 'INST_MISSING')
    }
    return null
  }

  private previewTargetGone(
    trackId: string,
    field: PreviewAnalysisField
  ): PreviewAnalysisResult | null {
    const track = this.options.store.getTrack(trackId)
    if (!track || track.status !== 'ready') {
      return previewAnalysisFailure(field, 'TRACK_GONE')
    }
    return null
  }

  private instPath(trackId: string): string {
    return join(this.options.tracksDir, trackId, 'inst.wav')
  }

  private async runAnalyzeWorker(inst: string): Promise<AnalyzeResult> {
    return (await this.options.sidecar.run(['analyze', '--input', inst, '--json'], {
      timeoutMs: this.options.analyzeTimeoutMs ?? ANALYZE_TIMEOUT_MS
    })) as AnalyzeResult
  }

  private log(line: string): void {
    ;(this.options.onLog ?? console.error)(`[analysis] ${line}`)
  }
}

function pickPreviewField(
  field: PreviewAnalysisField,
  result: AnalyzeResult
): PreviewAnalysisResult {
  if (field === 'bpm') {
    const bpm = parsePreviewBpmValue(result.bpm)
    if (bpm === null) return previewAnalysisFailure(field, 'FIELD_UNAVAILABLE')
    const bpmConf = parsePreviewConfidence(result.bpm_conf)
    return { ok: true, field: 'bpm', bpm, bpmConf: bpmConf ?? null }
  }
  const musicKey = parsePreviewMusicKeyValue(result.key)
  if (musicKey === null) return previewAnalysisFailure(field, 'FIELD_UNAVAILABLE')
  const keyConf = parsePreviewConfidence(result.key_conf)
  return { ok: true, field: 'key', musicKey, keyConf: keyConf ?? null }
}

function sidecarFailure(field: PreviewAnalysisField, error: unknown): PreviewAnalysisResult {
  if (error instanceof SidecarError && error.code === 'TIMEOUT') {
    return previewAnalysisFailure(field, 'TIMEOUT')
  }
  return previewAnalysisFailure(field, 'ANALYZE_FAILED')
}

function describeError(error: unknown): string {
  if (error instanceof SidecarError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}
