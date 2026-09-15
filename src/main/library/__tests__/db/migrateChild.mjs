import { writeFileSync } from 'fs'
import Database from 'better-sqlite3'

const dbPath = process.argv[2]
const mode = process.argv[3]
const readyPath = process.argv[4]

if (!dbPath || !mode || !readyPath) {
  process.stderr.write('usage: migrateChild.mjs <dbPath> <mode> <readyPath>\n')
  process.exit(2)
}

function upgradeToV8(db, version) {
  if (version < 2) db.exec("ALTER TABLE tracks ADD COLUMN search_keys TEXT NOT NULL DEFAULT ''")
  if (version < 3) {
    db.exec(`
      ALTER TABLE tracks ADD COLUMN bpm REAL;
      ALTER TABLE tracks ADD COLUMN music_key TEXT;
      ALTER TABLE tracks ADD COLUMN bpm_conf REAL;
      ALTER TABLE tracks ADD COLUMN key_conf REAL;
      ALTER TABLE tracks ADD COLUMN analysis_version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tracks ADD COLUMN analysis_source TEXT NOT NULL DEFAULT 'none';
    `)
  }
  if (version < 4) {
    db.exec('ALTER TABLE tracks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
    const ids = db.prepare('SELECT id FROM tracks ORDER BY created_at DESC, id').all()
    const update = db.prepare('UPDATE tracks SET sort_order = ? WHERE id = ?')
    ids.forEach((row, i) => update.run(i, row.id))
  }
  if (version < 5) {
    db.exec(`
      ALTER TABLE tracks ADD COLUMN import_kind TEXT NOT NULL DEFAULT 'separated';
      ALTER TABLE tracks ADD COLUMN guide_kind TEXT NOT NULL DEFAULT 'vocal_only';
    `)
  }
  if (version < 6) {
    db.exec(`
      ALTER TABLE tracks ADD COLUMN master_db REAL;
      ALTER TABLE tracks ADD COLUMN inst_db REAL;
      ALTER TABLE tracks ADD COLUMN vocal_db REAL;
    `)
  }
  if (version < 7) {
    db.exec(`
      ALTER TABLE tracks ADD COLUMN master_muted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tracks ADD COLUMN inst_muted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tracks ADD COLUMN vocal_muted INTEGER NOT NULL DEFAULT 0;
    `)
  }
  if (version < 8) {
    db.exec('ALTER TABLE tracks ADD COLUMN pitch_semitones INTEGER NOT NULL DEFAULT 0')
  }
  db.exec('PRAGMA user_version = 8')
}

function ready() {
  writeFileSync(readyPath, `${mode}\n`)
}

function hang() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

const db = new Database(dbPath, { timeout: 5000 })
try {
  if (mode === 'hold-exclusive') {
    db.exec('BEGIN EXCLUSIVE')
    ready()
    hang()
  }

  db.pragma('synchronous = FULL')
  db.exec('BEGIN EXCLUSIVE')
  upgradeToV8(db, db.pragma('user_version', { simple: true }))
  if (mode === 'before-commit') {
    ready()
    hang()
  }
  db.exec('COMMIT')
  if (mode === 'after-commit') {
    ready()
    hang()
  }
  ready()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
} finally {
  try {
    if (db.open) db.close()
  } catch {
    // kill 직전에 close가 실패할 수 있다
  }
}
