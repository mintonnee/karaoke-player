import { afterEach, describe, expect, it } from 'vitest'
import { LibraryStore, isLibraryDbError } from '../../LibraryStore'
import type { LibraryMigrateFault } from '../../LibraryStore'
import {
  createVersionedDatabase,
  dbPathIn,
  expectedColumns,
  makeTempDir,
  removeTempDir,
  snapshotFile
} from './helpers'

describe('atomic migration (criterion 4)', () => {
  let dir: string
  let store: LibraryStore | undefined

  afterEach(() => {
    try {
      store?.close()
    } catch {
      // ignore
    }
    store = undefined
    if (dir) removeTempDir(dir)
  })

  it.each<LibraryMigrateFault>(['mid-ddl', 'data-conversion', 'version-write'])(
    '%s 오류 주입 시 전부 롤백되고 시작 스키마가 남는다',
    (fault) => {
      dir = makeTempDir()
      const dbPath = dbPathIn(dir)
      createVersionedDatabase(dbPath, 2)
      const before = snapshotFile(dbPath)
      expect(before.version).toBe(2)
      expect(before.columns).toEqual([...expectedColumns(2)])
      try {
        new LibraryStore(dbPath, { debug: { migrateFault: fault } })
        throw new Error('expected throw')
      } catch (error) {
        expect(isLibraryDbError(error) && error.code).toBe('DB_MIGRATION_FAILED')
      }
      expect(snapshotFile(dbPath)).toEqual(before)
    }
  )

  it('실패 후 정상 재시도는 중복 컬럼 오류 없이 v8로 성공한다', () => {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    createVersionedDatabase(dbPath, 2)
    try {
      new LibraryStore(dbPath, { debug: { migrateFault: 'mid-ddl' } })
    } catch (error) {
      expect(isLibraryDbError(error) && error.code).toBe('DB_MIGRATION_FAILED')
    }
    expect(snapshotFile(dbPath).version).toBe(2)
    store = new LibraryStore(dbPath)
    expect(store.mustGetTrack('old').title).toBe('옛 트랙')
    const after = snapshotFile(dbPath)
    expect(after.version).toBe(8)
    expect(after.columns).toEqual([...expectedColumns(8)])
  })
})
