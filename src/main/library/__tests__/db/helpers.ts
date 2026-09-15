import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn, type ChildProcess } from 'child_process'
import {
  SCHEMA_VERSION,
  TRACKS_COLUMNS_BY_VERSION,
  listTracksColumns,
  readUserVersion
} from '../../db/schema'

export interface LegacyTrackSeed {
  id?: string
  title?: string
  artist?: string | null
  album?: string | null
  duration?: number
  sourcePath?: string
  status?: string
  lyricsSource?: string
  createdAt?: string
  updatedAt?: string
  searchKeys?: string
  sortOrder?: number
}

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'karaoke-db-safety-'))
}

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

export function dbPathIn(dir: string, name = 'library.sqlite'): string {
  return join(dir, name)
}

export function openRaw(path: string, options?: Database.Options): Database.Database {
  return new Database(path, options)
}

export function readJournalMode(db: Database.Database): string {
  return db.pragma('journal_mode', { simple: true }) as string
}

export function readTrackRows(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM tracks ORDER BY id').all() as Array<Record<string, unknown>>
}

export function snapshotFile(path: string): {
  version: number
  journalMode: string
  columns: string[]
  rows: Array<Record<string, unknown>>
  userTables: string[]
} {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1000 })
  try {
    const userTables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      )
      .all() as Array<{ name: string }>
    const hasTracks = userTables.some((row) => row.name === 'tracks')
    return {
      version: readUserVersion(db),
      journalMode: readJournalMode(db),
      columns: hasTracks ? listTracksColumns(db) : [],
      rows: hasTracks ? readTrackRows(db) : [],
      userTables: userTables.map((row) => row.name)
    }
  } finally {
    db.close()
  }
}

function columnSql(version: number): string {
  const columns: string[] = [
    'id TEXT PRIMARY KEY',
    'title TEXT NOT NULL',
    'artist TEXT',
    'album TEXT',
    'duration REAL NOT NULL',
    'source_path TEXT NOT NULL',
    'status TEXT NOT NULL',
    "lyrics_source TEXT NOT NULL DEFAULT 'none'",
    'created_at TEXT NOT NULL',
    'updated_at TEXT NOT NULL'
  ]
  if (version >= 2) columns.push("search_keys TEXT NOT NULL DEFAULT ''")
  if (version >= 3) {
    columns.push(
      'bpm REAL',
      'music_key TEXT',
      'bpm_conf REAL',
      'key_conf REAL',
      'analysis_version INTEGER NOT NULL DEFAULT 0',
      "analysis_source TEXT NOT NULL DEFAULT 'none'"
    )
  }
  if (version >= 4) columns.push('sort_order INTEGER NOT NULL DEFAULT 0')
  if (version >= 5) {
    columns.push(
      "import_kind TEXT NOT NULL DEFAULT 'separated'",
      "guide_kind TEXT NOT NULL DEFAULT 'vocal_only'"
    )
  }
  if (version >= 6) columns.push('master_db REAL', 'inst_db REAL', 'vocal_db REAL')
  if (version >= 7) {
    columns.push(
      'master_muted INTEGER NOT NULL DEFAULT 0',
      'inst_muted INTEGER NOT NULL DEFAULT 0',
      'vocal_muted INTEGER NOT NULL DEFAULT 0'
    )
  }
  if (version >= 8) columns.push('pitch_semitones INTEGER NOT NULL DEFAULT 0')
  return columns.join(',\n      ')
}

export function createVersionedDatabase(
  path: string,
  version: number,
  seed: LegacyTrackSeed = {}
): void {
  const db = new Database(path)
  try {
    if (version >= 1) {
      db.exec(`CREATE TABLE tracks (\n      ${columnSql(version)}\n    )`)
      const createdAt = seed.createdAt ?? '2026-01-01T00:00:00.000Z'
      const updatedAt = seed.updatedAt ?? '2026-01-02T00:00:00.000Z'
      const row: Record<string, unknown> = {
        id: seed.id ?? 'old',
        title: seed.title ?? '옛 트랙',
        artist: seed.artist === undefined ? 'Eve' : seed.artist,
        album: seed.album === undefined ? null : seed.album,
        duration: seed.duration ?? 200,
        source_path: seed.sourcePath ?? 'C:\\music\\old.flac',
        status: seed.status ?? 'ready',
        lyrics_source: seed.lyricsSource ?? 'lrclib_synced',
        created_at: createdAt,
        updated_at: updatedAt
      }
      const names = [...TRACKS_COLUMNS_BY_VERSION[version]]
      if (version >= 2) row.search_keys = seed.searchKeys ?? '요루시카'
      if (version >= 3) {
        row.bpm = null
        row.music_key = null
        row.bpm_conf = null
        row.key_conf = null
        row.analysis_version = 0
        row.analysis_source = 'none'
      }
      if (version >= 4) row.sort_order = seed.sortOrder ?? 0
      if (version >= 5) {
        row.import_kind = 'separated'
        row.guide_kind = 'vocal_only'
      }
      if (version >= 6) {
        row.master_db = null
        row.inst_db = null
        row.vocal_db = null
      }
      if (version >= 7) {
        row.master_muted = 0
        row.inst_muted = 0
        row.vocal_muted = 0
      }
      if (version >= 8) row.pitch_semitones = 0
      const placeholders = names.map((name) => `@${name}`).join(', ')
      db.prepare(`INSERT INTO tracks (${names.join(', ')}) VALUES (${placeholders})`).run(row)
    }
    db.pragma(`user_version = ${version}`)
  } finally {
    db.close()
  }
}

export function listBackupSqliteFiles(backupDir: string): string[] {
  if (!existsSync(backupDir)) return []
  return readdirSync(backupDir)
    .filter((name) => name.endsWith('.sqlite'))
    .sort()
}

export function expectedColumns(version: number): readonly string[] {
  return TRACKS_COLUMNS_BY_VERSION[version] ?? []
}

export const MIGRATE_CHILD = join(
  process.cwd(),
  'src',
  'main',
  'library',
  '__tests__',
  'db',
  'migrateChild.mjs'
)

export async function waitForFile(path: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  readFileSync(path)
}

export function spawnMigrateChild(dbPath: string, mode: string, readyPath: string): ChildProcess {
  return spawn(process.execPath, [MIGRATE_CHILD, dbPath, mode, readyPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
}

export async function killChildHard(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGKILL')
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
}

export { SCHEMA_VERSION }
