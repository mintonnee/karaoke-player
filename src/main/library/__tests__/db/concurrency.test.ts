import Database from 'better-sqlite3'
import { join } from 'path'
import type { ChildProcess } from 'child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { LibraryStore, isLibraryDbError } from '../../LibraryStore'
import {
  createVersionedDatabase,
  dbPathIn,
  killChildHard,
  makeTempDir,
  removeTempDir,
  snapshotFile,
  spawnMigrateChild,
  waitForFile
} from './helpers'

describe('initializer concurrency (criterion 7)', () => {
  let dir: string
  let store: LibraryStore | undefined
  const extra: Database.Database[] = []
  const children: ChildProcess[] = []

  afterEach(async () => {
    for (const child of children.splice(0)) {
      await killChildHard(child)
    }
    for (const db of extra.splice(0)) {
      try {
        if (db.inTransaction) db.exec('ROLLBACK')
      } catch {
        // ignore
      }
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

  it('쓰기 잠금을 잡은 연결이 있으면 제한 시간 내 DB_BUSY로 실패한다', () => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    createVersionedDatabase(dbPath, 7)
    const holder = new Database(dbPath, { timeout: 1 })
    extra.push(holder)
    holder.exec('BEGIN EXCLUSIVE')
    const started = Date.now()
    try {
      new LibraryStore(dbPath, { busyTimeoutMs: 300 })
      throw new Error('expected throw')
    } catch (error) {
      expect(isLibraryDbError(error) && error.code).toBe('DB_BUSY')
    }
    expect(Date.now() - started).toBeLessThan(2000)
    holder.exec('ROLLBACK')
    holder.close()
    extra.pop()
    expect(snapshotFile(dbPath).version).toBe(7)
    store = new LibraryStore(dbPath, { busyTimeoutMs: 1000 })
    expect(snapshotFile(dbPath).version).toBe(8)
  })

  it('다른 프로세스가 exclusive를 유지하면 초기화가 성공하지 않는다', async () => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    createVersionedDatabase(dbPath, 6)
    const readyPath = join(dir, 'ready.txt')
    const child = spawnMigrateChild(dbPath, 'hold-exclusive', readyPath)
    children.push(child)
    await waitForFile(readyPath)
    try {
      new LibraryStore(dbPath, { busyTimeoutMs: 250 })
      throw new Error('expected throw')
    } catch (error) {
      expect(isLibraryDbError(error) && error.code).toBe('DB_BUSY')
    }
    await killChildHard(child)
    children.pop()
    expect(snapshotFile(dbPath).version).toBe(6)
    store = new LibraryStore(dbPath)
    expect(snapshotFile(dbPath).version).toBe(8)
  }, 15000)
})
