import Database from 'better-sqlite3'
import type { LyricsSource, Track, TrackStatus } from '../../shared/types'

/** §4.3 tracks 스키마. 변경 시 user_version을 올리고 마이그레이션을 추가한다. */
const SCHEMA_VERSION = 1

interface TrackRow {
  id: string
  title: string
  artist: string | null
  album: string | null
  duration: number
  source_path: string
  status: TrackStatus
  lyrics_source: LyricsSource
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

  listTracks(): Track[] {
    const rows = this.db
      .prepare('SELECT * FROM tracks ORDER BY created_at DESC, id')
      .all() as TrackRow[]
    return rows.map(toTrack)
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
