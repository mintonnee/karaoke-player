import Database from 'better-sqlite3'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SidecarManager } from '../../sidecar/SidecarManager'
import { LibraryStore } from '../LibraryStore'
import { SearchKeyService } from '../SearchKeyService'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function readSearchKeys(dbPath: string, id: string): string {
  const db = new Database(dbPath, { readonly: true })
  const row = db.prepare('SELECT search_keys FROM tracks WHERE id = ?').get(id) as {
    search_keys: string
  }
  db.close()
  return row.search_keys
}

describe('SearchKeyService stale results', () => {
  let root: string
  let store: LibraryStore
  let dbPath: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'karaoke-search-keys-'))
    dbPath = join(root, 'library.sqlite')
    store = new LibraryStore(dbPath)
  })

  afterEach(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })

  it('오래된 생성 결과가 최신 메타의 검색 키를 덮지 않는다', async () => {
    store.createTrack({
      id: 't1',
      title: 'ヨルシカ',
      artist: null,
      album: null,
      duration: 1,
      sourcePath: 'C:\\a.flac'
    })
    const gate = deferred()
    const reached = deferred()
    const sidecar = {
      run: async (args: string[]) => {
        const input = args[args.indexOf('--lyrics') + 1]
        const text = await readFile(input, 'utf-8')
        return { lines: [{ text, hint: `hint:${text.split('\n')[0]}` }] }
      }
    } as unknown as SidecarManager
    const service = new SearchKeyService({
      store,
      sidecar,
      workDir: join(root, 'tmp'),
      onLog: () => {},
      beforeSetSearchKeys: async (track) => {
        if (track.title === 'ヨルシカ') {
          reached.resolve()
          await gate.promise
        }
      }
    })

    service.refresh(store.mustGetTrack('t1'))
    await reached.promise
    store.applyMetaPatch('t1', { title: '新しい' })
    service.refresh(store.mustGetTrack('t1'))
    gate.resolve()
    await service.idle()

    expect(readSearchKeys(dbPath, 't1')).toBe('hint:新しい')
  })
})
