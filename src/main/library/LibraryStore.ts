import Database from 'better-sqlite3'
import { hangulIncludes, hangulLooseIncludes } from '../../shared/hangul'
import { ANALYSIS_VERSION, BPM_MAX, BPM_MIN, MUSIC_KEY_RE } from '../../shared/types'
import type {
  AnalysisSource,
  LyricsSource,
  Track,
  TrackMetaInput,
  TrackStatus
} from '../../shared/types'

/** §4.3 tracks 스키마. 변경 시 user_version을 올리고 마이그레이션을 추가한다. */
const SCHEMA_VERSION = 4

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
  /** v3: BPM·키 분석 결과 (스펙 002 §4.2) */
  bpm: number | null
  music_key: string | null
  bpm_conf: number | null
  key_conf: number | null
  analysis_version: number
  analysis_source: AnalysisSource
  /** v4: 사용자 드래그 정렬 순서 (오름차순). 새 트랙은 맨 위(최솟값-1)로 들어간다 */
  sort_order: number
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
    bpm: row.bpm,
    musicKey: row.music_key,
    bpmConf: row.bpm_conf,
    keyConf: row.key_conf,
    analysisSource: row.analysis_source,
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

/** 사이드카 analyze 결과 저장 입력 (AnalysisService → setAnalysis) */
export interface AnalysisInput {
  bpm: number | null
  musicKey: string | null
  bpmConf: number | null
  keyConf: number | null
  /** 사이드카가 보고한 알고리즘 버전 (AnalyzeResult.version) */
  version: number
}

/** 사용자 입력 BPM 검증. null은 "값 없음"으로 허용 */
function validateBpm(bpm: number | null): number | null {
  if (bpm === null) return null
  if (!Number.isFinite(bpm) || bpm < BPM_MIN || bpm > BPM_MAX) {
    throw new Error(`bpm must be between ${BPM_MIN} and ${BPM_MAX}`)
  }
  return bpm
}

/** 사용자 입력 키 검증. 빈 문자열은 null로 정규화 */
function validateMusicKey(key: string | null): string | null {
  const trimmed = key?.trim() ?? ''
  if (trimmed === '') return null
  if (!MUSIC_KEY_RE.test(trimmed)) {
    throw new Error(`invalid music key: ${trimmed} (expected e.g. C, F#, Am, C#m)`)
  }
  return trimmed
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
    if (version < 3) {
      // 스펙 002 §4.2: BPM·키 분석 컬럼. 기존 행은 미분석(none/0)으로 시작해 백필 대상이 된다
      this.db.exec(`
        ALTER TABLE tracks ADD COLUMN bpm              REAL;
        ALTER TABLE tracks ADD COLUMN music_key        TEXT;
        ALTER TABLE tracks ADD COLUMN bpm_conf         REAL;
        ALTER TABLE tracks ADD COLUMN key_conf         REAL;
        ALTER TABLE tracks ADD COLUMN analysis_version INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tracks ADD COLUMN analysis_source  TEXT NOT NULL DEFAULT 'none';
      `)
    }
    if (version < 4) {
      // 드래그 정렬 순서. 기존 행은 지금까지의 표시 순서(최신 순)를 그대로 번호 매긴다
      this.db.exec(`ALTER TABLE tracks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`)
      const ids = this.db
        .prepare('SELECT id FROM tracks ORDER BY created_at DESC, id')
        .all() as Array<{ id: string }>
      const update = this.db.prepare('UPDATE tracks SET sort_order = ? WHERE id = ?')
      this.db.transaction(() => {
        ids.forEach((row, i) => update.run(i, row.id))
      })()
    }
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
  }

  createTrack(input: CreateTrackInput): Track {
    const now = new Date().toISOString()
    // 새 트랙은 목록 맨 위로: 현재 최솟값 - 1
    this.db
      .prepare(
        `INSERT INTO tracks (id, title, artist, album, duration, source_path, status, lyrics_source, sort_order, created_at, updated_at)
         VALUES (@id, @title, @artist, @album, @duration, @sourcePath, 'imported', 'none',
                 (SELECT COALESCE(MIN(sort_order), 0) - 1 FROM tracks), @now, @now)`
      )
      .run({ ...input, now })
    return this.mustGetTrack(input.id)
  }

  /**
   * 드래그 정렬 결과 저장. ids는 화면에 보이는 전체 순서(검색 필터 없음)여야 한다.
   * 목록에 없는 id는 무시하고, ids에 빠진 트랙은 기존 순서를 유지한 채 뒤로 밀린다.
   */
  reorderTracks(ids: string[]): void {
    const update = this.db.prepare('UPDATE tracks SET sort_order = ? WHERE id = ?')
    const rest = this.db
      .prepare('SELECT id FROM tracks ORDER BY sort_order, created_at DESC, id')
      .all() as Array<{ id: string }>
    const given = new Set(ids)
    const ordered = [...ids, ...rest.map((row) => row.id).filter((id) => !given.has(id))]
    this.db.transaction(() => {
      ordered.forEach((id, i) => update.run(i, id))
    })()
  }

  getTrack(id: string): Track | undefined {
    const row = this.db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow | undefined
    return row ? toTrack(row) : undefined
  }

  /** 검색은 SQL LIKE 대신 자모 매칭(미완성 글자·초성 지원)으로 JS에서 거른다.
   *  로컬 라이브러리 규모에서는 전체 로드 후 필터가 충분히 빠르다. */
  listTracks(query?: string): Track[] {
    const rows = this.db
      .prepare('SELECT * FROM tracks ORDER BY sort_order, created_at DESC, id')
      .all() as TrackRow[]
    const trimmed = query?.trim()
    const filtered = trimmed
      ? rows.filter(
          (row) =>
            hangulIncludes(row.title, trimmed) ||
            (row.artist !== null && hangulIncludes(row.artist, trimmed)) ||
            (row.album !== null && hangulIncludes(row.album, trimmed)) ||
            (row.search_keys !== '' && hangulLooseIncludes(row.search_keys, trimmed))
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

  /**
   * 자동 분석 결과 저장 (source 'auto'). 사용자 값('user')은 덮어쓰지 않고 현재 행을 그대로 돌려준다
   * (백필과 메타 편집의 경쟁 방지). 표시 전용 데이터라 updated_at은 건드리지 않는다
   */
  setAnalysis(id: string, analysis: AnalysisInput): Track {
    this.db
      .prepare(
        `UPDATE tracks
         SET bpm = @bpm, music_key = @musicKey, bpm_conf = @bpmConf, key_conf = @keyConf,
             analysis_version = @version, analysis_source = 'auto'
         WHERE id = @id AND analysis_source != 'user'`
      )
      .run({ ...analysis, id })
    return this.mustGetTrack(id)
  }

  /** 분석이 없거나 구버전인 ready 트랙 (앱 시작 시 백필 대상). 사용자 값은 제외 */
  listTracksNeedingAnalysis(): Track[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tracks
         WHERE status = 'ready' AND analysis_source != 'user' AND analysis_version < ?
         ORDER BY created_at DESC, id`
      )
      .all(ANALYSIS_VERSION) as TrackRow[]
    return rows.map(toTrack)
  }

  /**
   * 메타 편집. bpm/musicKey가 입력에 있으면(undefined가 아니면) 검증 후 사용자 값으로 저장하고
   * 이후 백필이 덮어쓰지 않게 analysis_source='user'로 바꾼다. 둘 다 없으면 분석 컬럼은 손대지 않는다
   * (YtDlpService.touchTrack처럼 title/artist/album만 갱신하는 경로)
   */
  updateMeta(id: string, meta: TrackMetaInput): Track {
    const title = meta.title.trim()
    if (!title) throw new Error('title must not be empty')
    const hasAnalysis = meta.bpm !== undefined || meta.musicKey !== undefined
    const current = hasAnalysis ? this.mustGetTrack(id) : null
    const analysis = current
      ? {
          bpm: meta.bpm === undefined ? current.bpm : validateBpm(meta.bpm),
          musicKey: meta.musicKey === undefined ? current.musicKey : validateMusicKey(meta.musicKey)
        }
      : null
    const now = new Date().toISOString()
    const params = {
      id,
      title,
      artist: meta.artist?.trim() || null,
      album: meta.album?.trim() || null,
      now
    }
    if (analysis) {
      this.db
        .prepare(
          `UPDATE tracks
           SET title = @title, artist = @artist, album = @album, updated_at = @now,
               bpm = @bpm, music_key = @musicKey, bpm_conf = NULL, key_conf = NULL,
               analysis_version = @version, analysis_source = 'user'
           WHERE id = @id`
        )
        .run({ ...params, ...analysis, version: ANALYSIS_VERSION })
    } else {
      this.db
        .prepare(
          `UPDATE tracks SET title = @title, artist = @artist, album = @album, updated_at = @now
           WHERE id = @id`
        )
        .run(params)
    }
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
