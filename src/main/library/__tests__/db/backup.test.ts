import Database from 'better-sqlite3'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LibraryDbError,
  LibraryStore,
  defaultLibraryBackupDir,
  isLibraryDbError,
  restoreLibraryBackup
} from '../../LibraryStore'
import { readUserVersion } from '../../db/schema'
import {
  createVersionedDatabase,
  dbPathIn,
  listBackupSqliteFiles,
  makeTempDir,
  readTrackRows,
  removeTempDir,
  snapshotFile
} from './helpers'

describe('DB backup and restore (criteria 3, 8)', () => {
  let dir: string
  let store: LibraryStore | undefined
  const extra: Database.Database[] = []

  afterEach(() => {
    for (const db of extra.splice(0)) {
      try {
        db.close()
      } catch {
        // ignore
      }
    }
    try {
      store?.close()
    } catch {
      // ignore
    }
    store = undefined
    if (dir) removeTempDir(dir)
  })

  it('구버전 마이그레이션 전 백업은 시작 버전·행·이름 메타를 남긴다', () => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    createVersionedDatabase(dbPath, 4)
    const before = snapshotFile(dbPath)
    store = new LibraryStore(dbPath, { appVersion: '0.1.0-test' })
    const backupDir = defaultLibraryBackupDir(dbPath)
    const files = listBackupSqliteFiles(backupDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^library-v4-to-v8-.*\.sqlite$/)
    const backupPath = join(backupDir, files[0])
    const jsonName = files[0].replace(/\.sqlite$/, '.json')
    expect(existsSync(join(backupDir, jsonName))).toBe(true)
    const meta = JSON.parse(readFileSync(join(backupDir, jsonName), 'utf8')) as {
      startVersion: number
      targetVersion: number
      appVersion: string
      createdAt: string
      id: string
    }
    expect(meta.startVersion).toBe(4)
    expect(meta.targetVersion).toBe(8)
    expect(meta.appVersion).toBe('0.1.0-test')
    expect(meta.createdAt).toMatch(/Z$/)
    expect(meta.id).toMatch(/^[0-9a-f-]{36}$/i)
    const backup = snapshotFile(backupPath)
    expect(backup.version).toBe(4)
    expect(backup.rows).toEqual(before.rows)
    expect(backup.columns).toEqual(before.columns)
    expect(snapshotFile(dbPath).version).toBe(8)
  })

  it('checkpoint되지 않은 WAL 커밋을 백업에 포함한다', () => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    createVersionedDatabase(dbPath, 7)
    const writer = new Database(dbPath)
    extra.push(writer)
    writer.pragma('journal_mode = WAL')
    writer
      .prepare(
        `INSERT INTO tracks (id, title, artist, album, duration, source_path, status, lyrics_source,
           created_at, updated_at, search_keys, sort_order, import_kind, guide_kind,
           master_muted, inst_muted, vocal_muted)
         VALUES ('wal', 'WAL 곡', 'W', null, 1, 'C:\\w.flac', 'ready', 'none',
           '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', '', 1, 'separated', 'vocal_only',
           0, 0, 0)`
      )
      .run()
    expect(existsSync(`${dbPath}-wal`)).toBe(true)
    store = new LibraryStore(dbPath)
    const backupDir = defaultLibraryBackupDir(dbPath)
    const files = listBackupSqliteFiles(backupDir)
    expect(files).toHaveLength(1)
    const backup = snapshotFile(join(backupDir, files[0]))
    expect(backup.version).toBe(7)
    expect(backup.rows.map((row) => row.id).sort()).toEqual(['old', 'wal'])
    expect(
      store
        .listTracks()
        .map((track) => track.id)
        .sort()
    ).toEqual(['old', 'wal'])
  })

  it('백업 검증 실패 시 원본을 변경하지 않고 완료 백업을 만들지 않는다', () => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    createVersionedDatabase(dbPath, 6)
    const before = snapshotFile(dbPath)
    try {
      new LibraryStore(dbPath, { debug: { backupFault: 'verify' } })
      throw new Error('expected throw')
    } catch (error) {
      expect(isLibraryDbError(error) && error.code).toBe('DB_BACKUP_FAILED')
      expect((error as LibraryDbError).backupDir).toBe(defaultLibraryBackupDir(dbPath))
    }
    expect(snapshotFile(dbPath)).toEqual(before)
    const leftover = existsSync(defaultLibraryBackupDir(dbPath))
      ? readdirSync(defaultLibraryBackupDir(dbPath))
      : []
    expect(leftover.filter((name) => name.endsWith('.sqlite'))).toEqual([])
  })

  it('이전 정상 백업을 덮어쓰지 않는다', () => {
    dir = makeTempDir()
    const first = dbPathIn(dir, 'a.sqlite')
    createVersionedDatabase(first, 5)
    store = new LibraryStore(first)
    store.close()
    const backupDir = defaultLibraryBackupDir(first)
    const firstFiles = listBackupSqliteFiles(backupDir)
    expect(firstFiles).toHaveLength(1)
    const second = dbPathIn(dir, 'b.sqlite')
    createVersionedDatabase(second, 3)
    store = new LibraryStore(second)
    const all = listBackupSqliteFiles(backupDir)
    expect(all).toHaveLength(2)
    expect(all).toContain(firstFiles[0])
    expect(snapshotFile(join(backupDir, firstFiles[0])).version).toBe(5)
  })

  it('검증된 백업을 별도 경로에 복원하고 원본 WAL을 붙이지 않는다', () => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    createVersionedDatabase(dbPath, 4)
    store = new LibraryStore(dbPath)
    store.close()
    store = undefined
    const backupDir = defaultLibraryBackupDir(dbPath)
    const backupPath = join(backupDir, listBackupSqliteFiles(backupDir)[0])
    const dest = join(dir, 'restored', 'library.sqlite')
    restoreLibraryBackup(backupPath, dest)
    expect(existsSync(`${dest}-wal`)).toBe(false)
    expect(existsSync(`${dest}-shm`)).toBe(false)
    const restored = snapshotFile(dest)
    expect(restored.version).toBe(4)
    store = new LibraryStore(dest)
    expect(store.mustGetTrack('old').title).toBe('옛 트랙')
    expect(snapshotFile(dest).version).toBe(8)
    const live = new Database(dbPath, { readonly: true })
    extra.push(live)
    expect(readUserVersion(live)).toBe(8)
    expect(readTrackRows(live).some((row) => row.id === 'old')).toBe(true)
  })
})
