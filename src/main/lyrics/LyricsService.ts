import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { formatLrc } from '../../shared/lrc'
import { IPC_CHANNELS } from '../../shared/types'
import type {
  AlignLang,
  AlignedLine,
  LyricsPayload,
  LyricsProgressEvent,
  LyricsSource,
  Track
} from '../../shared/types'
import type { JobQueue } from '../library/JobQueue'
import type { LibraryStore } from '../library/LibraryStore'
import type { SidecarManager } from '../sidecar/SidecarManager'
import { chooseSearchResult } from './lrclib'
import type { LrclibRecord } from './lrclib'

const LRCLIB_BASE = 'https://lrclib.net/api'
const FETCH_TIMEOUT_MS = 10_000

export interface LyricsServiceOptions {
  store: LibraryStore
  sidecar: SidecarManager
  /** 정렬/전사 작업은 분리와 같은 큐에서 직렬화한다 (§4 JobQueue) */
  queue: JobQueue
  tracksDir: string
  /** LRCLIB 요청 User-Agent (앱 식별, LRCLIB 문서 권장) */
  userAgent: string
  notify: (channel: string, payload: unknown) => void
  onLog?: (line: string) => void
}

/**
 * §4.4 가사 파이프라인.
 * S4: LRCLIB 조회(get→search) → lyrics.lrc / lyrics.txt 저장.
 * S5: forced alignment(align)와 전사(transcribe), 수동 보정 저장.
 * 네트워크 실패는 삼킨다 — 오프라인이어도 임포트 파이프라인은 계속된다.
 */
export class LyricsService {
  constructor(private readonly options: LyricsServiceOptions) {}

  /** 저장된 가사 읽기 (정렬 결과 conf 포함) */
  async getLyrics(trackId: string): Promise<LyricsPayload> {
    const track = this.options.store.getTrack(trackId)
    if (!track) throw new Error(`track not found: ${trackId}`)
    const dir = this.trackDir(trackId)
    const alignJson = await readIfExists(join(dir, 'align.json'))
    return {
      source: track.lyricsSource,
      lrc: await readIfExists(join(dir, 'lyrics.lrc')),
      plain: await readIfExists(join(dir, 'lyrics.txt')),
      lines: alignJson ? (JSON.parse(alignJson) as AlignedLine[]) : null
    }
  }

  /** LRCLIB 조회 후 파일/DB 반영. 실패해도 throw하지 않는다. */
  async fetchAndStore(track: Track): Promise<LyricsPayload> {
    try {
      const record = await this.lookup(track)
      if (!record) {
        this.log(`no lyrics found for "${track.title}"`)
        return this.getLyrics(track.id)
      }

      const dir = this.trackDir(track.id)
      let source: LyricsSource = 'none'
      if (record.instrumental) {
        this.log(`"${track.title}" is instrumental`)
      } else if (record.syncedLyrics) {
        await writeFile(join(dir, 'lyrics.lrc'), record.syncedLyrics, 'utf-8')
        source = 'lrclib_synced'
        if (record.plainLyrics) {
          await writeFile(join(dir, 'lyrics.txt'), record.plainLyrics, 'utf-8')
        }
      } else if (record.plainLyrics) {
        // 정렬(S5) 전까지는 원문만 저장, lyrics_source는 none 유지
        await writeFile(join(dir, 'lyrics.txt'), record.plainLyrics, 'utf-8')
      }

      if (source !== 'none') {
        this.updateSource(track.id, source)
      }
      return this.getLyrics(track.id)
    } catch (error) {
      this.log(`lyrics fetch failed for "${track.title}": ${String(error)}`)
      return this.getLyrics(track.id)
    }
  }

  /** S5.1/S5.2: 가사 텍스트를 저장하고 forced alignment를 실행한다 */
  async alignLyrics(
    trackId: string,
    text: string,
    lang: AlignLang,
    fromLrclibPlain: boolean
  ): Promise<LyricsPayload> {
    this.mustGetReadyTrack(trackId)
    const dir = this.trackDir(trackId)
    await writeFile(join(dir, 'lyrics.txt'), text, 'utf-8')

    await this.runQueued(async () => {
      const result = (await this.options.sidecar.run(
        [
          'align',
          '--vocal',
          join(dir, 'vocal.wav'),
          '--lyrics',
          join(dir, 'lyrics.txt'),
          '--lang',
          lang,
          '--out',
          join(dir, 'lyrics.lrc'),
          '--json'
        ],
        { onProgress: (event) => this.notifyProgress(trackId, 'align', event.pct, event.msg) }
      )) as { lines: AlignedLine[] }

      await this.writeAlignJson(trackId, result.lines)
      this.updateSource(trackId, fromLrclibPlain ? 'lrclib_plain_aligned' : 'user_aligned')
    })
    return this.getLyrics(trackId)
  }

  /** S5.4: faster-whisper 전사. 교정용 텍스트를 반환한다 (파일은 transcript.txt) */
  async transcribe(trackId: string): Promise<string> {
    this.mustGetReadyTrack(trackId)
    const dir = this.trackDir(trackId)
    const outPath = join(dir, 'transcript.txt')

    await this.runQueued(async () => {
      await this.options.sidecar.run(
        [
          'transcribe',
          '--vocal',
          join(dir, 'vocal.wav'),
          '--lang',
          'auto',
          '--out',
          outPath,
          '--json'
        ],
        { onProgress: (event) => this.notifyProgress(trackId, 'transcribe', event.pct, event.msg) }
      )
    })
    return (await readIfExists(outPath)) ?? ''
  }

  /** S5.3: 수동 보정 결과를 lyrics.lrc/align.json에 반영한다 */
  async saveLines(trackId: string, lines: AlignedLine[]): Promise<LyricsPayload> {
    const track = this.options.store.getTrack(trackId)
    if (!track) throw new Error(`track not found: ${trackId}`)
    const dir = this.trackDir(trackId)
    await writeFile(
      join(dir, 'lyrics.lrc'),
      formatLrc(lines.map((line) => ({ time: line.t, text: line.text }))),
      'utf-8'
    )
    await this.writeAlignJson(trackId, lines)
    if (track.lyricsSource !== 'user_aligned') {
      this.updateSource(trackId, 'user_aligned')
    }
    return this.getLyrics(trackId)
  }

  private async lookup(track: Track): Promise<LrclibRecord | null> {
    const getParams = new URLSearchParams({
      track_name: track.title,
      artist_name: track.artist ?? '',
      album_name: track.album ?? '',
      duration: String(Math.round(track.duration))
    })
    const exact = await this.request<LrclibRecord>(`/get?${getParams}`)
    if (exact) return exact

    const searchParams = new URLSearchParams({ track_name: track.title })
    if (track.artist) searchParams.set('artist_name', track.artist)
    const results = (await this.request<LrclibRecord[]>(`/search?${searchParams}`)) ?? []
    return chooseSearchResult(results, track.duration)
  }

  /** 404는 "없음"이므로 null. 그 외 비정상 상태는 오류로 던진다. */
  private async request<T>(pathAndQuery: string): Promise<T | null> {
    const response = await fetch(`${LRCLIB_BASE}${pathAndQuery}`, {
      headers: { 'User-Agent': this.options.userAgent },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`LRCLIB responded ${response.status}`)
    return (await response.json()) as T
  }

  private runQueued<T>(work: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.options.queue.enqueue(async () => {
        try {
          resolve(await work())
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
  }

  private async writeAlignJson(trackId: string, lines: AlignedLine[]): Promise<void> {
    await writeFile(join(this.trackDir(trackId), 'align.json'), JSON.stringify(lines), 'utf-8')
  }

  private updateSource(trackId: string, source: LyricsSource): void {
    const updated = this.options.store.updateLyricsSource(trackId, source)
    this.options.notify(IPC_CHANNELS.trackUpdated, updated)
  }

  private notifyProgress(
    trackId: string,
    stage: LyricsProgressEvent['stage'],
    pct: number,
    msg?: string
  ): void {
    const event: LyricsProgressEvent = { trackId, stage, pct, msg }
    this.options.notify(IPC_CHANNELS.lyricsProgress, event)
  }

  private mustGetReadyTrack(trackId: string): Track {
    const track = this.options.store.getTrack(trackId)
    if (!track) throw new Error(`track not found: ${trackId}`)
    if (track.status !== 'ready') {
      throw new Error(`track is not ready (status: ${track.status})`)
    }
    return track
  }

  private trackDir(trackId: string): string {
    return join(this.options.tracksDir, trackId)
  }

  private log(line: string): void {
    ;(this.options.onLog ?? console.error)(`[lyrics] ${line}`)
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}
