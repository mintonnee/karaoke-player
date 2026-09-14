import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COVER_FILE_NAME, COVER_NONE_MARKER } from '../../../shared/trackEdit'
import {
  COVER_BACKUP,
  COVER_EXTRACT_TMP,
  COVER_STAGING,
  recoverIncompleteTrackEdits,
  TRACK_EDIT_JOURNAL
} from '../coverRecovery'
import { LibraryStore } from '../LibraryStore'
import { PNG_1X1 } from './coverFixtures'

describe('recoverIncompleteTrackEdits', () => {
  let root: string
  let tracksDir: string
  let store: LibraryStore
  let sourceImage: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'karaoke-cover-recovery-'))
    tracksDir = join(root, 'tracks')
    await mkdir(tracksDir, { recursive: true })
    store = new LibraryStore(join(root, 'library.sqlite'))
    sourceImage = join(root, 'user-art.png')
    await writeFile(sourceImage, PNG_1X1)
  })

  afterEach(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })

  function createTrack(id: string): void {
    store.createTrack({
      id,
      title: 'old-title',
      artist: 'artist',
      album: null,
      duration: 10,
      sourcePath: join(root, 'song.flac')
    })
  }

  it('파일만 바뀌고 DB 확정 전 종료면 패치를 재적용해 한 세트로 맞춘다', async () => {
    const id = 't1'
    createTrack(id)
    const dir = join(tracksDir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, COVER_FILE_NAME), 'old-cover')
    await writeFile(join(dir, COVER_BACKUP), 'old-cover')
    await writeFile(join(dir, COVER_FILE_NAME), PNG_1X1)
    await writeFile(
      join(dir, TRACK_EDIT_JOURNAL),
      JSON.stringify({
        version: 1,
        trackId: id,
        cover: 'replace',
        filesApplied: true,
        patch: { title: 'new-title' },
        hadCover: true,
        hadNone: false,
        createdAt: '2026-09-14T00:00:00.000Z'
      }),
      'utf-8'
    )

    const cleaned = await recoverIncompleteTrackEdits(tracksDir, store)
    expect(cleaned).toBeGreaterThan(0)
    expect(store.getTrack(id)?.title).toBe('new-title')
    expect(await readFile(join(dir, COVER_FILE_NAME))).toEqual(PNG_1X1)
    expect(existsSync(join(dir, TRACK_EDIT_JOURNAL))).toBe(false)
    expect(existsSync(join(dir, COVER_BACKUP))).toBe(false)
    expect(existsSync(sourceImage)).toBe(true)
  })

  it('파일 설치 완료 전 종료면 기존 커버를 되돌린다', async () => {
    const id = 't1'
    createTrack(id)
    const dir = join(tracksDir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, COVER_BACKUP), 'old-cover')
    await writeFile(join(dir, COVER_STAGING), PNG_1X1)
    await writeFile(
      join(dir, TRACK_EDIT_JOURNAL),
      JSON.stringify({
        version: 1,
        trackId: id,
        cover: 'replace',
        filesApplied: false,
        patch: { title: 'new-title' },
        hadCover: true,
        hadNone: false,
        createdAt: '2026-09-14T00:00:00.000Z'
      }),
      'utf-8'
    )

    await recoverIncompleteTrackEdits(tracksDir, store)
    expect(store.getTrack(id)?.title).toBe('old-title')
    expect(await readFile(join(dir, COVER_FILE_NAME), 'utf-8')).toBe('old-cover')
    expect(existsSync(join(dir, COVER_STAGING))).toBe(false)
    expect(existsSync(join(dir, TRACK_EDIT_JOURNAL))).toBe(false)
    expect(existsSync(sourceImage)).toBe(true)
  })

  it('DB에 없는 곡은 재생성하지 않고 임시 파일만 지운다', async () => {
    const id = 'gone'
    const dir = join(tracksDir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'inst.wav'), 'inst')
    await writeFile(join(dir, COVER_EXTRACT_TMP), 'tmp')
    await writeFile(
      join(dir, TRACK_EDIT_JOURNAL),
      JSON.stringify({
        version: 1,
        trackId: id,
        cover: 'remove',
        filesApplied: false,
        patch: { title: 'x' },
        hadCover: false,
        hadNone: false,
        createdAt: '2026-09-14T00:00:00.000Z'
      }),
      'utf-8'
    )

    await recoverIncompleteTrackEdits(tracksDir, store)
    expect(store.getTrack(id)).toBeUndefined()
    expect(existsSync(join(dir, 'inst.wav'))).toBe(true)
    expect(existsSync(join(dir, TRACK_EDIT_JOURNAL))).toBe(false)
    expect(existsSync(join(dir, COVER_EXTRACT_TMP))).toBe(false)
    expect(existsSync(join(dir, COVER_NONE_MARKER))).toBe(false)
  })
})
