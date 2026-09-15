import Database from 'better-sqlite3'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LibraryDbError,
  LibraryStore,
  SCHEMA_VERSION,
  defaultLibraryBackupDir,
  isLibraryDbError
} from '../../LibraryStore'
import {
  createVersionedDatabase,
  dbPathIn,
  expectedColumns,
  listBackupSqliteFiles,
  makeTempDir,
  removeTempDir,
  snapshotFile
} from './helpers'

describe('DB schema safety (criteria 1, 2, 8)', () => {
  let dir: string
  let store: LibraryStore | undefined

  afterEach(() => {
    try {
      store?.close()
    } catch {
      // 실패 경로에서 이미 닫혔을 수 있다
    }
    store = undefined
    if (dir) removeTempDir(dir)
  })

  it('없는 DB는 v8을 만들고 백업하지 않는다', () => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    store = new LibraryStore(dbPath)
    store.createTrack({
      id: 't1',
      title: '새 곡',
      artist: null,
      album: null,
      duration: 1,
      sourcePath: 'C:\\a.flac'
    })
    store.close()
    store = undefined
    const snap = snapshotFile(dbPath)
    expect(snap.version).toBe(SCHEMA_VERSION)
    expect(snap.columns).toEqual([...expectedColumns(8)])
    expect(listBackupSqliteFiles(defaultLibraryBackupDir(dbPath))).toEqual([])
  })

  it('v0 빈 DB는 신규 v8로 초기화한다', () => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    const raw = new Database(dbPath)
    raw.close()
    store = new LibraryStore(dbPath)
    expect(snapshotFile(dbPath).version).toBe(8)
    expect(store.listTracks()).toEqual([])
  })

  it.each([1, 2, 3, 4, 5, 6, 7])('유효한 v%s fixture를 v8로 이전하고 행을 보존한다', (version) => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir, `v${version}.sqlite`)
    createVersionedDatabase(dbPath, version)
    store = new LibraryStore(dbPath)
    const old = store.mustGetTrack('old')
    expect(old.title).toBe('옛 트랙')
    expect(old.artist).toBe('Eve')
    expect(old.status).toBe('ready')
    expect(old.importKind).toBe('separated')
    expect(old.guideKind).toBe('vocal_only')
    expect(store.getTrackPitch('old')).toBe(0)
    expect(snapshotFile(dbPath).version).toBe(8)
    expect(snapshotFile(dbPath).columns).toEqual([...expectedColumns(8)])
  })

  it('v8 재개방은 백업하지 않고 user_version을 유지한다', () => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    store = new LibraryStore(dbPath)
    store.createTrack({
      id: 't1',
      title: '곡',
      artist: null,
      album: null,
      duration: 1,
      sourcePath: 'C:\\a.flac'
    })
    store.close()
    const before = snapshotFile(dbPath)
    store = new LibraryStore(dbPath)
    store.close()
    store = undefined
    const after = snapshotFile(dbPath)
    expect(after.version).toBe(8)
    expect(after.rows).toEqual(before.rows)
    expect(listBackupSqliteFiles(defaultLibraryBackupDir(dbPath))).toEqual([])
  })

  it('미래 버전은 DB_SCHEMA_TOO_NEW로 거부하고 스키마·행·버전·journal mode를 바꾸지 않는다', () => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    store = new LibraryStore(dbPath)
    store.createTrack({
      id: 't1',
      title: '곡',
      artist: 'A',
      album: null,
      duration: 10,
      sourcePath: 'C:\\a.flac'
    })
    store.close()
    store = undefined
    const raw = new Database(dbPath)
    raw.pragma('journal_mode = DELETE')
    raw.pragma('user_version = 99')
    raw.close()
    const before = snapshotFile(dbPath)
    expect(before.version).toBe(99)
    expect(before.journalMode.toLowerCase()).toBe('delete')

    expect(() => {
      store = new LibraryStore(dbPath)
    }).toThrow(LibraryDbError)
    try {
      store = new LibraryStore(dbPath)
    } catch (error) {
      expect(isLibraryDbError(error)).toBe(true)
      expect(error).toMatchObject({
        code: 'DB_SCHEMA_TOO_NEW',
        discoveredVersion: 99,
        supportedVersion: 8,
        dbPath
      })
    }
    const after = snapshotFile(dbPath)
    expect(after).toEqual(before)
    expect(listBackupSqliteFiles(defaultLibraryBackupDir(dbPath))).toEqual([])
    expect(existsSync(join(dir, 'backups'))).toBe(false)
  })

  it('테이블이 없는 미래 버전도 구조 검사 전에 TOO_NEW로 거부한다', () => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    const raw = new Database(dbPath)
    raw.pragma('user_version = 12')
    raw.close()
    const before = snapshotFile(dbPath)
    expect(before.userTables).toEqual([])
    expect(() => new LibraryStore(dbPath)).toThrow(/DB_SCHEMA_TOO_NEW|지원하는 버전/)
    try {
      new LibraryStore(dbPath)
    } catch (error) {
      expect(isLibraryDbError(error) && error.code).toBe('DB_SCHEMA_TOO_NEW')
      expect((error as LibraryDbError).discoveredVersion).toBe(12)
    }
    expect(snapshotFile(dbPath)).toEqual(before)
  })

  it('사용자 테이블이 있는 v0은 DB_INVALID로 보존한다', () => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    const raw = new Database(dbPath)
    raw.exec('CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT)')
    raw.exec("INSERT INTO tracks VALUES ('x', '남김')")
    raw.pragma('user_version = 0')
    raw.close()
    const before = snapshotFile(dbPath)
    expect(() => new LibraryStore(dbPath)).toThrow(LibraryDbError)
    try {
      new LibraryStore(dbPath)
    } catch (error) {
      expect(isLibraryDbError(error) && error.code).toBe('DB_INVALID')
    }
    expect(snapshotFile(dbPath)).toEqual(before)
  })

  it('음수 버전은 DB_INVALID로 보존한다', () => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    createVersionedDatabase(dbPath, 8)
    const raw = new Database(dbPath)
    raw.pragma('user_version = -1')
    raw.close()
    const before = snapshotFile(dbPath)
    try {
      new LibraryStore(dbPath)
      throw new Error('expected throw')
    } catch (error) {
      expect(isLibraryDbError(error) && error.code).toBe('DB_INVALID')
    }
    expect(snapshotFile(dbPath)).toEqual(before)
  })

  it('버전과 필수 구조가 불일치하면 DB_INVALID로 보존한다', () => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    createVersionedDatabase(dbPath, 8)
    const raw = new Database(dbPath)
    raw.exec('ALTER TABLE tracks DROP COLUMN pitch_semitones')
    raw.pragma('user_version = 8')
    raw.close()
    const before = snapshotFile(dbPath)
    try {
      new LibraryStore(dbPath)
      throw new Error('expected throw')
    } catch (error) {
      expect(isLibraryDbError(error) && error.code).toBe('DB_INVALID')
    }
    expect(snapshotFile(dbPath)).toEqual(before)
  })

  it('부분 마이그레이션 잔여 컬럼(구버전+신컬럼)을 추정 완성하지 않는다', () => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    createVersionedDatabase(dbPath, 4)
    const raw = new Database(dbPath)
    raw.exec("ALTER TABLE tracks ADD COLUMN import_kind TEXT NOT NULL DEFAULT 'separated'")
    raw.pragma('user_version = 4')
    raw.close()
    const before = snapshotFile(dbPath)
    try {
      new LibraryStore(dbPath)
      throw new Error('expected throw')
    } catch (error) {
      expect(isLibraryDbError(error) && error.code).toBe('DB_INVALID')
    }
    expect(snapshotFile(dbPath)).toEqual(before)
  })

  it('백업 디렉터리가 파일이면 신규 설치는 영향 없고 구버전은 BACKUP_FAILED다', () => {
    dir = makeTempDir()
    mkdirSync(join(dir, 'backups'))
    writeFileSync(join(dir, 'backups', 'db'), 'not-a-dir')
    const fresh = dbPathIn(dir, 'fresh.sqlite')
    store = new LibraryStore(fresh)
    store.close()
    store = undefined
    expect(snapshotFile(fresh).version).toBe(8)

    const oldPath = dbPathIn(dir, 'old.sqlite')
    createVersionedDatabase(oldPath, 5)
    const before = snapshotFile(oldPath)
    try {
      new LibraryStore(oldPath)
      throw new Error('expected throw')
    } catch (error) {
      expect(isLibraryDbError(error) && error.code).toBe('DB_BACKUP_FAILED')
    }
    expect(snapshotFile(oldPath)).toEqual(before)
  })
})
