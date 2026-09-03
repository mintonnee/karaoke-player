import { randomUUID } from 'crypto'
import { copyFile, mkdir, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { IPC_CHANNELS } from '../../shared/types'
import type {
  ImportFilesResponse,
  ImportProgressEvent,
  ImportRejection,
  ProbeResult,
  Track
} from '../../shared/types'
import { SidecarError } from '../sidecar/SidecarManager'
import type { SidecarManager } from '../sidecar/SidecarManager'
import { JobQueue } from './JobQueue'
import type { LibraryStore } from './LibraryStore'

const PROBE_TIMEOUT_MS = 30_000

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
  artist?: string | null
}

/** 임포트 파이프라인: probe → 원본 복사 → DB 등록 → 분리 잡 큐잉 (S1.2/S1.3) */
export class ImportService {
  private readonly queue: JobQueue

  constructor(private readonly options: ImportServiceOptions) {
    this.queue = options.queue
  }

  async importFiles(filePaths: string[], hint?: ImportMetaHint): Promise<ImportFilesResponse> {
    const imported: Track[] = []
    const rejected: ImportRejection[] = []

    for (const filePath of filePaths) {
      try {
        imported.push(await this.importOne(filePath, hint))
      } catch (error) {
        rejected.push({ filePath, reason: describeError(error) })
      }
    }
    return { imported, rejected }
  }

  private async importOne(filePath: string, hint?: ImportMetaHint): Promise<Track> {
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
      title: probe.title ?? basename(filePath, extname(filePath)),
      artist: probe.artist ?? hint?.artist ?? null,
      album: probe.album ?? null,
      duration: probe.duration,
      sourcePath: filePath
    })
    this.notifyTrack(track)
    void this.options.fetchLyrics?.(track)
    this.options.refreshSearchKeys?.(track)
    this.options.extractCover?.(track)
    this.enqueueSeparation(id)
    return track
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
        this.log(`separate failed for ${trackId}: ${describeError(error)}`)
        this.notifyTrack(this.options.store.updateStatus(trackId, 'failed'))
      }
    })
  }

  private trackDir(trackId: string): string {
    return join(this.options.tracksDir, trackId)
  }

  private notifyTrack(track: Track): void {
    this.options.notify(IPC_CHANNELS.trackUpdated, track)
  }

  private log(line: string): void {
    ;(this.options.onLog ?? console.error)(`[import] ${line}`)
  }
}

function describeError(error: unknown): string {
  if (error instanceof SidecarError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}
