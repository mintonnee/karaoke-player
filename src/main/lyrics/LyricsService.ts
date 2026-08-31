import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { IPC_CHANNELS } from '../../shared/types'
import type { LyricsPayload, LyricsSource, Track } from '../../shared/types'
import type { LibraryStore } from '../library/LibraryStore'
import { chooseSearchResult } from './lrclib'
import type { LrclibRecord } from './lrclib'

const LRCLIB_BASE = 'https://lrclib.net/api'
const FETCH_TIMEOUT_MS = 10_000

export interface LyricsServiceOptions {
  store: LibraryStore
  tracksDir: string
  /** LRCLIB 요청 User-Agent (앱 식별, LRCLIB 문서 권장) */
  userAgent: string
  notify: (channel: string, payload: unknown) => void
  onLog?: (line: string) => void
}

/**
 * §4.4 가사 파이프라인의 S4 구간.
 * LRCLIB /api/get → /api/search 순으로 조회해서
 * syncedLyrics → lyrics.lrc (source: lrclib_synced),
 * plainLyrics → lyrics.txt (source는 S5 정렬 전까지 none 유지)로 저장한다.
 * 네트워크 실패는 삼킨다 — 오프라인이어도 임포트 파이프라인은 계속된다.
 */
export class LyricsService {
  constructor(private readonly options: LyricsServiceOptions) {}

  /** 저장된 가사 읽기 */
  async getLyrics(trackId: string): Promise<LyricsPayload> {
    const track = this.options.store.getTrack(trackId)
    if (!track) throw new Error(`track not found: ${trackId}`)
    const dir = join(this.options.tracksDir, trackId)
    return {
      source: track.lyricsSource,
      lrc: await readIfExists(join(dir, 'lyrics.lrc')),
      plain: await readIfExists(join(dir, 'lyrics.txt'))
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

      const dir = join(this.options.tracksDir, track.id)
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
        const updated = this.options.store.updateLyricsSource(track.id, source)
        this.options.notify(IPC_CHANNELS.trackUpdated, updated)
      }
      return this.getLyrics(track.id)
    } catch (error) {
      this.log(`lyrics fetch failed for "${track.title}": ${String(error)}`)
      return this.getLyrics(track.id)
    }
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
