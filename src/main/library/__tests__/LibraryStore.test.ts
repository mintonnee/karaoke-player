import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LibraryStore } from '../LibraryStore'

describe('LibraryStore', () => {
  let dir: string
  let store: LibraryStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karaoke-library-'))
    store = new LibraryStore(join(dir, 'library.sqlite'))
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const createTrack = (
    id: string,
    overrides: Partial<Parameters<LibraryStore['createTrack']>[0]> = {}
  ): ReturnType<LibraryStore['createTrack']> =>
    store.createTrack({
      id,
      title: `title-${id}`,
      artist: 'artist',
      album: null,
      duration: 187.2,
      sourcePath: `C:\\music\\${id}.flac`,
      ...overrides
    })

  it('트랙 생성 시 imported/none 기본 상태로 저장한다', () => {
    const track = createTrack('t1')

    expect(track.status).toBe('imported')
    expect(track.lyricsSource).toBe('none')
    expect(track.title).toBe('title-t1')
    expect(track.createdAt).toBe(track.updatedAt)
    expect(store.getTrack('t1')).toEqual(track)
  })

  it('상태 갱신 시 updated_at이 바뀌고 조회에 반영된다', () => {
    const created = createTrack('t1')
    const updated = store.updateStatus('t1', 'separating')

    expect(updated.status).toBe('separating')
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt))
    expect(store.getTrack('t1')?.status).toBe('separating')
  })

  it('failStaleSeparating은 separating만 failed로 바꾼다', () => {
    createTrack('a')
    createTrack('b')
    createTrack('c')
    store.updateStatus('a', 'separating')
    store.updateStatus('b', 'ready')

    expect(store.failStaleSeparating()).toBe(1)
    expect(store.getTrack('a')?.status).toBe('failed')
    expect(store.getTrack('b')?.status).toBe('ready')
    expect(store.getTrack('c')?.status).toBe('imported')
  })

  it('재오픈 후에도 데이터가 남아 있다 (S3 DoD 기반)', () => {
    createTrack('t1')
    store.close()

    store = new LibraryStore(join(dir, 'library.sqlite'))
    expect(store.getTrack('t1')?.title).toBe('title-t1')
  })

  it('없는 트랙 갱신은 오류를 던진다', () => {
    expect(() => store.updateStatus('missing', 'ready')).toThrow('track not found')
  })
})
