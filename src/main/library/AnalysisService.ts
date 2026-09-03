import { existsSync } from 'fs'
import { join } from 'path'
import { IPC_CHANNELS } from '../../shared/types'
import type { AnalyzeResult, AppErrorReport } from '../../shared/types'
import { SidecarError } from '../sidecar/SidecarManager'
import type { SidecarManager } from '../sidecar/SidecarManager'
import type { JobQueue } from './JobQueue'
import type { LibraryStore } from './LibraryStore'

/** 스펙 002 §4.2: 분석 타임아웃 120초 */
const ANALYZE_TIMEOUT_MS = 120_000

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
}

/**
 * 반주 스템(inst.wav)에서 BPM·조성을 추정해 tracks 행에 저장한다 (스펙 002 §4.2).
 * 분리 완료 직후와 앱 시작 백필에서 호출된다. 실패는 로그만 남기고 트랙 상태는 바꾸지 않는다.
 */
export class AnalysisService {
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

  private async analyze(trackId: string): Promise<void> {
    const track = this.options.store.getTrack(trackId)
    if (!track || track.status !== 'ready') return
    if (track.analysisSource === 'user') return

    const inst = join(this.options.tracksDir, trackId, 'inst.wav')
    if (!existsSync(inst)) {
      this.log(`skip ${trackId}: inst.wav not found`)
      return
    }

    const result = (await this.options.sidecar.run(['analyze', '--input', inst, '--json'], {
      timeoutMs: ANALYZE_TIMEOUT_MS
    })) as AnalyzeResult
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

  private log(line: string): void {
    ;(this.options.onLog ?? console.error)(`[analysis] ${line}`)
  }
}

function describeError(error: unknown): string {
  if (error instanceof SidecarError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}
