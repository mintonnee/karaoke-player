import type Database from 'better-sqlite3'
import { LibraryDbError } from './errors'
import type { LibraryMigrateFault } from './options'
import {
  CREATE_V8_TRACKS_SQL,
  SCHEMA_VERSION,
  listTracksColumns,
  structureMismatch
} from './schema'

export function createCurrentSchema(db: Database.Database): void {
  db.exec(CREATE_V8_TRACKS_SQL)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

function throwFault(dbPath: string, version: number, message: string): never {
  throw new LibraryDbError({
    code: 'DB_MIGRATION_FAILED',
    dbPath,
    discoveredVersion: version,
    message
  })
}

function assertCurrentStructure(db: Database.Database, dbPath: string, startVersion: number): void {
  const mismatch = structureMismatch(listTracksColumns(db), SCHEMA_VERSION)
  if (mismatch) {
    throwFault(dbPath, startVersion, `마이그레이션 후 구조 검사 실패: ${mismatch}`)
  }
}

/** 구버전 → v8. 호출자는 이미 하나의 트랜잭션 안에 있어야 한다. */
export function applyUpgradeToCurrent(
  db: Database.Database,
  dbPath: string,
  fromVersion: number,
  fault?: LibraryMigrateFault
): void {
  if (fromVersion < 2) {
    db.exec(`ALTER TABLE tracks ADD COLUMN search_keys TEXT NOT NULL DEFAULT ''`)
  }
  if (fromVersion < 3) {
    db.exec(`
      ALTER TABLE tracks ADD COLUMN bpm              REAL;
      ALTER TABLE tracks ADD COLUMN music_key        TEXT;
      ALTER TABLE tracks ADD COLUMN bpm_conf         REAL;
      ALTER TABLE tracks ADD COLUMN key_conf         REAL;
      ALTER TABLE tracks ADD COLUMN analysis_version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tracks ADD COLUMN analysis_source  TEXT NOT NULL DEFAULT 'none';
    `)
  }
  if (fault === 'mid-ddl') {
    throwFault(dbPath, fromVersion, 'injected mid-ddl fault')
  }
  if (fromVersion < 4) {
    db.exec(`ALTER TABLE tracks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`)
    const ids = db.prepare('SELECT id FROM tracks ORDER BY created_at DESC, id').all() as Array<{
      id: string
    }>
    if (fault === 'data-conversion') {
      throwFault(dbPath, fromVersion, 'injected data-conversion fault')
    }
    const update = db.prepare('UPDATE tracks SET sort_order = ? WHERE id = ?')
    ids.forEach((row, i) => update.run(i, row.id))
  }
  if (fromVersion >= 4 && fault === 'data-conversion') {
    throwFault(dbPath, fromVersion, 'injected data-conversion fault')
  }
  if (fromVersion < 5) {
    db.exec(`
      ALTER TABLE tracks ADD COLUMN import_kind TEXT NOT NULL DEFAULT 'separated';
      ALTER TABLE tracks ADD COLUMN guide_kind TEXT NOT NULL DEFAULT 'vocal_only';
    `)
  }
  if (fromVersion < 6) {
    db.exec(`
      ALTER TABLE tracks ADD COLUMN master_db REAL;
      ALTER TABLE tracks ADD COLUMN inst_db REAL;
      ALTER TABLE tracks ADD COLUMN vocal_db REAL;
    `)
  }
  if (fromVersion < 7) {
    db.exec(`
      ALTER TABLE tracks ADD COLUMN master_muted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tracks ADD COLUMN inst_muted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tracks ADD COLUMN vocal_muted INTEGER NOT NULL DEFAULT 0;
    `)
  }
  if (fromVersion < 8) {
    db.exec(`ALTER TABLE tracks ADD COLUMN pitch_semitones INTEGER NOT NULL DEFAULT 0`)
  }
  assertCurrentStructure(db, dbPath, fromVersion)
  if (fault === 'version-write') {
    throwFault(dbPath, fromVersion, 'injected version-write fault')
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}
