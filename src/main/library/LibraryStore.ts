import Database from 'better-sqlite3'
import { hangulIncludes } from '../../shared/hangul'
import type { LyricsSource, Track, TrackMetaInput, TrackStatus } from '../../shared/types'

/** §4.3 tracks 스키마. 변경 시 user_version을 올리고 마이그레이션을 추가한다. */
const SCHEMA_VERSION = 2

interface TrackRow {
  id: string
  title: string
  artist: string | null
  album: string | null
  duration: number
  source_path: string
  status: TrackStatus
  lyrics_source: LyricsSource
  /** v2: 일본어 메타의 한글 발음 등 검색 전용 보조 키 (SearchKeyService가 채움) */
  search_keys: string
  created_at: string
  updated_at: string
}

function toTrack(row: TrackRow): Track {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    duration: row.duration,
    sourcePath: row.source_path,
    status: row.status,
    lyricsSource: row.lyrics_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export interface CreateTrackInput {
  id: string
  title: string
  artist: string | null
  album: string | null
  duration: number
  sourcePath: string
}

export class LibraryStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tracks (
          id            TEXT PRIMARY KEY,
          title         TEXT NOT NULL,
          artist        TEXT,
          album         TEXT,
          duration      REAL NOT NULL,
          source_path   TEXT NOT NULL,
          status        TEXT NOT NULL,
          lyrics_source TEXT NOT NULL DEFAULT 'none',
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        )
      `)
    }
    if (version < 2) {
      this.db.exec(`ALTER TABLE tracks ADD COLUMN search_keys TEXT NOT NULL DEFAULT ''`)
    }
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
  }

  createTrack(input: CreateTrackInput): Track {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO tracks (id, title, artist, album, duration, source_path, status, lyrics_source, created_at, updated_at)
         VALUES (@id, @title, @artist, @album, @duration, @sourcePath, 'imported', 'none', @now, @now)`
      )
      .run({ ...input, now })
    return this.mustGetTrack(input.id)
  }

  getTrack(id: string): Track | undefined {
    const row = this.db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow | undefined
    return row ? toTrack(row) : undefined
  }

  /** 검색은 SQL LIKE 대신 자모 매칭(미완성 글자·초성 지원)으로 JS에서 거른다.
   *  로컬 라이브러리 규모에서는 전체 로드 후 필터가 충분히 빠르다. */
  listTracks(query?: string): Track[] {
    const rows = this.db
      .prepare('SELECT * FROM tracks ORDER BY created_at DESC, id')
      .all() as TrackRow[]
    const trimmed = query?.trim()
    const filtered = trimmed
      ? rows.filter(
          (row) =>
            hangulIncludes(row.title, trimmed) ||
            (row.artist !== null && hangulIncludes(row.artist, trimmed)) ||
            (row.album !== null && hangulIncludes(row.album, trimmed)) ||
            (row.search_keys !== '' && hangulIncludes(row.search_keys, trimmed))
        )
      : rows
    return filtered.map(toTrack)
  }

  /** 검색 키 갱신. 검색 전용 보조 데이터라 updated_at은 건드리지 않는다 */
  setSearchKeys(id: string, keys: string): void {
    this.db.prepare('UPDATE tracks SET search_keys = @keys WHERE id = @id').run({ id, keys })
  }

  /** 검색 키가 아직 없는 트랙 (앱 시작 시 백필 대상) */
  listTracksWithoutSearchKeys(): Track[] {
    const rows = this.db
      .prepare(`SELECT * FROM tracks WHERE search_keys = '' ORDER BY created_at DESC, id`)
      .all() as TrackRow[]
    return rows.map(toTrack)
  }

  updateMeta(id: string, meta: TrackMetaInput): Track {
    const title = meta.title.trim()
    if (!title) throw new Error('title must not be empty')
    this.db
      .prepare('UPDATE tracks SET title = ?, artist = ?, album = ?, updated_at = ? WHERE id = ?')
      .run(
        title,
        meta.artist?.trim() || null,
        meta.album?.trim() || null,
        new Date().toISOString(),
        id
      )
    return this.mustGetTrack(id)
  }

  /** DB 행만 삭제한다. 트랙 디렉토리 정리는 호출자(IPC 핸들러) 책임. */
  deleteTrack(id: string): boolean {
    return this.db.prepare('DELETE FROM tracks WHERE id = ?').run(id).changes > 0
  }

  updateLyricsSource(id: string, source: LyricsSource): Track {
    this.db
      .prepare('UPDATE tracks SET lyrics_source = ?, updated_at = ? WHERE id = ?')
      .run(source, new Date().toISOString(), id)
    return this.mustGetTrack(id)
  }

  updateStatus(id: string, status: TrackStatus): Track {
    this.db
      .prepare('UPDATE tracks SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id)
    return this.mustGetTrack(id)
  }

  /** 앱 재시작 시 중단된 separating 상태를 failed로 정리한다 (S1.2) */
  failStaleSeparating(): number {
    const result = this.db
      .prepare("UPDATE tracks SET status = 'failed', updated_at = ? WHERE status = 'separating'")
      .run(new Date().toISOString())
    return result.changes
  }

  close(): void {
    this.db.close()
  }

  private mustGetTrack(id: string): Track {
    const track = this.getTrack(id)
    if (!track) throw new Error(`track not found: ${id}`)
    return track
  }
}
