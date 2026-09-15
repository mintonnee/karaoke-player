export const SCHEMA_VERSION = 8

const V1 = [
  'id',
  'title',
  'artist',
  'album',
  'duration',
  'source_path',
  'status',
  'lyrics_source',
  'created_at',
  'updated_at'
] as const

export const TRACKS_COLUMNS_BY_VERSION: Readonly<Record<number, readonly string[]>> = {
  1: V1,
  2: [...V1, 'search_keys'],
  3: [
    ...V1,
    'search_keys',
    'bpm',
    'music_key',
    'bpm_conf',
    'key_conf',
    'analysis_version',
    'analysis_source'
  ],
  4: [
    ...V1,
    'search_keys',
    'bpm',
    'music_key',
    'bpm_conf',
    'key_conf',
    'analysis_version',
    'analysis_source',
    'sort_order'
  ],
  5: [
    ...V1,
    'search_keys',
    'bpm',
    'music_key',
    'bpm_conf',
    'key_conf',
    'analysis_version',
    'analysis_source',
    'sort_order',
    'import_kind',
    'guide_kind'
  ],
  6: [
    ...V1,
    'search_keys',
    'bpm',
    'music_key',
    'bpm_conf',
    'key_conf',
    'analysis_version',
    'analysis_source',
    'sort_order',
    'import_kind',
    'guide_kind',
    'master_db',
    'inst_db',
    'vocal_db'
  ],
  7: [
    ...V1,
    'search_keys',
    'bpm',
    'music_key',
    'bpm_conf',
    'key_conf',
    'analysis_version',
    'analysis_source',
    'sort_order',
    'import_kind',
    'guide_kind',
    'master_db',
    'inst_db',
    'vocal_db',
    'master_muted',
    'inst_muted',
    'vocal_muted'
  ],
  8: [
    ...V1,
    'search_keys',
    'bpm',
    'music_key',
    'bpm_conf',
    'key_conf',
    'analysis_version',
    'analysis_source',
    'sort_order',
    'import_kind',
    'guide_kind',
    'master_db',
    'inst_db',
    'vocal_db',
    'master_muted',
    'inst_muted',
    'vocal_muted',
    'pitch_semitones'
  ]
}

export const CREATE_V8_TRACKS_SQL = `
  CREATE TABLE tracks (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    artist        TEXT,
    album         TEXT,
    duration      REAL NOT NULL,
    source_path   TEXT NOT NULL,
    status        TEXT NOT NULL,
    lyrics_source TEXT NOT NULL DEFAULT 'none',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    search_keys   TEXT NOT NULL DEFAULT '',
    bpm           REAL,
    music_key     TEXT,
    bpm_conf      REAL,
    key_conf      REAL,
    analysis_version INTEGER NOT NULL DEFAULT 0,
    analysis_source  TEXT NOT NULL DEFAULT 'none',
    sort_order    INTEGER NOT NULL DEFAULT 0,
    import_kind   TEXT NOT NULL DEFAULT 'separated',
    guide_kind    TEXT NOT NULL DEFAULT 'vocal_only',
    master_db     REAL,
    inst_db       REAL,
    vocal_db      REAL,
    master_muted  INTEGER NOT NULL DEFAULT 0,
    inst_muted    INTEGER NOT NULL DEFAULT 0,
    vocal_muted   INTEGER NOT NULL DEFAULT 0,
    pitch_semitones INTEGER NOT NULL DEFAULT 0
  )
`

export function readUserVersion(db: {
  pragma: (source: string, options?: { simple?: boolean }) => unknown
}): number {
  return db.pragma('user_version', { simple: true }) as number
}

export function listUserTables(db: {
  prepare: (sql: string) => { all: () => Array<{ name: string }> }
}): string[] {
  return db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all()
    .map((row) => row.name)
}

export function listTracksColumns(db: {
  prepare: (sql: string) => { all: () => Array<{ name: string }> }
}): string[] {
  return db
    .prepare('PRAGMA table_info(tracks)')
    .all()
    .map((row) => row.name)
}

export function columnsMatchVersion(columns: readonly string[], version: number): boolean {
  const expected = TRACKS_COLUMNS_BY_VERSION[version]
  if (!expected) return false
  if (columns.length !== expected.length) return false
  const actual = new Set(columns)
  return expected.every((name) => actual.has(name))
}

export function structureMismatch(columns: readonly string[], version: number): string | undefined {
  const expected = TRACKS_COLUMNS_BY_VERSION[version]
  if (!expected) return `지원하지 않는 스키마 버전 ${version}`
  if (columnsMatchVersion(columns, version)) return undefined
  return `버전 ${version}의 필수 컬럼과 실제 tracks 구조가 일치하지 않습니다 (expected ${expected.length}, actual ${columns.length})`
}
