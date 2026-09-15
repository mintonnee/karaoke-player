import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { LibraryStore } from '../../LibraryStore'
import {
  createVersionedDatabase,
  dbPathIn,
  expectedColumns,
  killChildHard,
  makeTempDir,
  removeTempDir,
  snapshotFile,
  spawnMigrateChild,
  waitForFile
} from './helpers'

describe('process crash recovery (criterion 5)', () => {
  let dir: string
  let store: LibraryStore | undefined

  afterEach(async () => {
    try {
      store?.close()
    } catch {
      // ignore
    }
    store = undefined
    if (dir) removeTempDir(dir)
  })

  async function crashAt(mode: 'before-commit' | 'after-commit'): Promise<string> {
    dir = makeTempDir()
    const dbPath = dbPathIn(dir)
    createVersionedDatabase(dbPath, 2)
    const readyPath = join(dir, 'ready.txt')
    const child = spawnMigrateChild(dbPath, mode, readyPath)
    const stderr: Buffer[] = []
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    try {
      await waitForFile(readyPath)
      await killChildHard(child)
    } catch (error) {
      await killChildHard(child)
      throw new Error(`${String(error)}\nstderr: ${Buffer.concat(stderr).toString() || '(empty)'}`)
    }
    return dbPath
  }

  it('commit 전 강제 종료 후 재개방은 이전 상태이며 이후 v8로 완료된다', async () => {
    const dbPath = await crashAt('before-commit')
    const afterKill = snapshotFile(dbPath)
    expect(afterKill.version).toBe(2)
    expect(afterKill.columns).toEqual([...expectedColumns(2)])
    expect(afterKill.columns).not.toContain('pitch_semitones')
    expect(afterKill.columns).not.toContain('sort_order')
    store = new LibraryStore(dbPath)
    expect(store.mustGetTrack('old').title).toBe('옛 트랙')
    const migrated = snapshotFile(dbPath)
    expect(migrated.version).toBe(8)
    expect(migrated.columns).toEqual([...expectedColumns(8)])
  }, 15000)

  it('commit 후 강제 종료 후 재개방은 완료된 v8이며 중간 버전이 아니다', async () => {
    const dbPath = await crashAt('after-commit')
    const afterKill = snapshotFile(dbPath)
    expect(afterKill.version).toBe(8)
    expect(afterKill.columns).toEqual([...expectedColumns(8)])
    store = new LibraryStore(dbPath)
    expect(store.mustGetTrack('old').title).toBe('옛 트랙')
    expect(snapshotFile(dbPath).version).toBe(8)
  }, 15000)
})
