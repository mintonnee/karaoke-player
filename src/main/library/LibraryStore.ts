import type Database from 'better-sqlite3'
import { hangulIncludes, hangulLooseIncludes } from '../../shared/hangul'
import { parseUserBpm, parseUserMusicKey } from '../../shared/trackEdit'
import type { TrackMetaPatch } from '../../shared/trackEdit'
import { ANALYSIS_VERSION } from '../../shared/types'
import type {
  AnalysisSource,
  GuideKind,
  ImportKind,
  LyricsSource,
  Track,
  TrackVolumes,
  TrackMetaInput,
  TrackStatus
} from '../../shared/types'
import { openLibraryDatabase } from './db/open'
import type { LibraryStoreOptions } from './db/options'

export {
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_LIBRARY_APP_VERSION,
  LIBRARY_DB_ERROR_CODES,
  LibraryDbError,
  SCHEMA_VERSION,
  defaultLibraryBackupDir,
  isLibraryDbError,
  restoreLibraryBackup
} from './db'
export type {
  LibraryBackupFault,
  LibraryDbErrorCode,
  LibraryDbErrorInit,
  LibraryMigrateFault,
  LibraryStoreDebugOptions,
  LibraryStoreOptions
} from './db'

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
  /** v5: separated | paired */
  import_kind: ImportKind
  /** v5: vocal_only | full_mix */
  guide_kind: GuideKind
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
    importKind: row.import_kind,
    guideKind: row.guide_kind,
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
  /** 기본 imported. 두 파일 가져오기는 파일 확정 후 ready로 한 번에 넣는다 */
  status?: TrackStatus
  /** 기본 separated */
  importKind?: ImportKind
  /** 기본 vocal_only */
  guideKind?: GuideKind
}

/** separated + full_mix는 재생 계약이 없어 거부한다 */
export function assertTrackKinds(importKind: ImportKind, guideKind: GuideKind): void {
  if (importKind === 'separated' && guideKind !== 'vocal_only') {
    throw new Error(`separated tracks cannot have guideKind ${guideKind}`)
  }
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

/** 커버 캐시 키가 같은 시각에 충돌하지 않게 기존 값보다 큰 ISO 시각을 고른다 */
function nextUpdatedAt(previous: string): string {
  const now = new Date().toISOString()
  if (now > previous) return now
  const prevMs = Date.parse(previous)
  if (Number.isFinite(prevMs)) return new Date(prevMs + 1).toISOString()
  return `${previous}+`
}

export class LibraryStore {
  private readonly db: Database.Database

  constructor(dbPath: string, options?: LibraryStoreOptions) {
    this.db = openLibraryDatabase(dbPath, options)
  }

  getTrackPitch(id: string): number {
    const row = this.db.prepare('SELECT pitch_semitones FROM tracks WHERE id = ?').get(id) as
      { pitch_semitones: number } | undefined
    if (!row) throw new Error(`track not found: ${id}`)
    return row.pitch_semitones
  }

  setTrackPitch(id: string, semitones: number): void {
    if (!Number.isInteger(semitones) || semitones < -6 || semitones > 6) {
      throw new Error('pitch must be an integer between -6 and 6')
    }
    const result = this.db
      .prepare('UPDATE tracks SET pitch_semitones = ? WHERE id = ?')
      .run(semitones, id)
    if (result.changes === 0) throw new Error(`track not found: ${id}`)
  }

  getTrackVolumes(id: string): TrackVolumes | null {
    const row = this.db
      .prepare(
        `SELECT master_db AS masterDb, inst_db AS instDb, vocal_db AS vocalDb,
                master_muted AS masterMuted, inst_muted AS instMuted, vocal_muted AS vocalMuted
         FROM tracks WHERE id = ?`
      )
      .get(id) as { [K in keyof TrackVolumes]: number | null } | undefined
    if (!row) throw new Error(`track not found: ${id}`)
    const { masterDb, instDb, vocalDb } = row
    if (masterDb === null || instDb === null || vocalDb === null) return null
    return {
      masterDb,
      instDb,
      vocalDb,
      masterMuted: row.masterMuted === 1,
      instMuted: row.instMuted === 1,
      vocalMuted: row.vocalMuted === 1
    }
  }

  setTrackVolumes(id: string, volumes: TrackVolumes): void {
    if (
      !volumes ||
      !['masterDb', 'instDb', 'vocalDb'].every((key) => {
        const value = volumes[key as keyof TrackVolumes]
        return typeof value === 'number' && Number.isFinite(value) && value >= -60 && value <= 0
      })
    )
      throw new Error('volume must be a finite number between -60 and 0 dB')
    if (
      !['masterMuted', 'instMuted', 'vocalMuted'].every(
        (key) => typeof volumes[key as keyof TrackVolumes] === 'boolean'
      )
    )
      throw new Error('mute must be a boolean')
    const { masterDb, instDb, vocalDb } = volumes
    const result = this.db
      .prepare(
        `UPDATE tracks SET master_db = @masterDb, inst_db = @instDb, vocal_db = @vocalDb,
          master_muted = @masterMuted, inst_muted = @instMuted, vocal_muted = @vocalMuted WHERE id = @id`
      )
      .run({
        id,
        masterDb,
        instDb,
        vocalDb,
        masterMuted: Number(volumes.masterMuted),
        instMuted: Number(volumes.instMuted),
        vocalMuted: Number(volumes.vocalMuted)
      })
    if (result.changes === 0) throw new Error(`track not found: ${id}`)
  }

  createTrack(input: CreateTrackInput): Track {
    const importKind = input.importKind ?? 'separated'
    const guideKind = input.guideKind ?? 'vocal_only'
    const status = input.status ?? 'imported'
    assertTrackKinds(importKind, guideKind)
    const now = new Date().toISOString()
    // 새 트랙은 목록 맨 위로: 현재 최솟값 - 1
    this.db
      .prepare(
        `INSERT INTO tracks (id, title, artist, album, duration, source_path, status, lyrics_source,
                             import_kind, guide_kind, sort_order, created_at, updated_at)
         VALUES (@id, @title, @artist, @album, @duration, @sourcePath, @status, 'none',
                 @importKind, @guideKind,
                 (SELECT COALESCE(MIN(sort_order), 0) - 1 FROM tracks), @now, @now)`
      )
      .run({
        id: input.id,
        title: input.title,
        artist: input.artist,
        album: input.album,
        duration: input.duration,
        sourcePath: input.sourcePath,
        status,
        importKind,
        guideKind,
        now
      })
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
          bpm: meta.bpm === undefined ? current.bpm : parseUserBpm(meta.bpm),
          musicKey:
            meta.musicKey === undefined ? current.musicKey : parseUserMusicKey(meta.musicKey)
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

  /**
   * 변경된 메타 필드만 최신 행에 합친다. 빈 패치여도 updated_at은 올린다 (커버만 변경).
   * 대상 행이 없으면 만들지 않는다.
   */
  applyMetaPatch(id: string, patch: TrackMetaPatch): Track {
    const current = this.mustGetTrack(id)
    const title = patch.title !== undefined ? patch.title.trim() : current.title
    if (!title) throw new Error('title must not be empty')
    const artist = patch.artist !== undefined ? patch.artist?.trim() || null : current.artist
    const album = patch.album !== undefined ? patch.album?.trim() || null : current.album
    const hasAnalysis = patch.bpm !== undefined || patch.musicKey !== undefined
    const bpm = patch.bpm !== undefined ? parseUserBpm(patch.bpm) : current.bpm
    const musicKey =
      patch.musicKey !== undefined ? parseUserMusicKey(patch.musicKey) : current.musicKey
    const now = nextUpdatedAt(current.updatedAt)
    const params = { id, title, artist, album, now }
    if (hasAnalysis) {
      this.db
        .prepare(
          `UPDATE tracks
           SET title = @title, artist = @artist, album = @album, updated_at = @now,
               bpm = @bpm, music_key = @musicKey, bpm_conf = NULL, key_conf = NULL,
               analysis_version = @version, analysis_source = 'user'
           WHERE id = @id`
        )
        .run({ ...params, bpm, musicKey, version: ANALYSIS_VERSION })
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

  mustGetTrack(id: string): Track {
    const track = this.getTrack(id)
    if (!track) throw new Error(`track not found: ${id}`)
    return track
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
}
