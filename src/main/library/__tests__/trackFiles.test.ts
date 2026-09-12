import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Track } from '../../../shared/types'
import { LibraryStore } from '../LibraryStore'
import { requireReadyTrackFiles, resolveTrackFiles } from '../trackFiles'

function baseTrack(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    title: id,
    artist: null,
    album: null,
    duration: 1,
    sourcePath: 'x.wav',
    status: 'ready',
    lyricsSource: 'none',
    bpm: null,
    musicKey: null,
    bpmConf: null,
    keyConf: null,
    analysisSource: 'none',
    importKind: 'separated',
    guideKind: 'vocal_only',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('requireReadyTrackFiles', () => {
  let root: string
  let tracksDir: string
  let store: LibraryStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'karaoke-track-files-'))
    tracksDir = join(root, 'tracks')
    store = new LibraryStore(join(root, 'library.sqlite'))
  })

  afterEach(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })

  it('vocal_only는 vocal.wav를 guide/vocal 별칭으로 돌려준다', async () => {
    const track = baseTrack('t1')
    await mkdir(join(tracksDir, 't1'), { recursive: true })
    await writeFile(join(tracksDir, 't1', 'inst.wav'), 'i')
    await writeFile(join(tracksDir, 't1', 'vocal.wav'), 'v')
    const files = requireReadyTrackFiles(tracksDir, track)
    expect(files.inst).toBe(join(tracksDir, 't1', 'inst.wav'))
    expect(files.guide).toBe(join(tracksDir, 't1', 'vocal.wav'))
    expect(files.vocal).toBe(files.guide)
    expect(files.guideKind).toBe('vocal_only')
  })

  it('full_mix는 guide.wav를 쓰고 vocal.wav를 요구하지 않는다', async () => {
    const track = baseTrack('t1', { importKind: 'paired', guideKind: 'full_mix' })
    await mkdir(join(tracksDir, 't1'), { recursive: true })
    await writeFile(join(tracksDir, 't1', 'inst.wav'), 'i')
    await writeFile(join(tracksDir, 't1', 'guide.wav'), 'g')
    const files = requireReadyTrackFiles(tracksDir, track)
    expect(files.guide).toBe(join(tracksDir, 't1', 'guide.wav'))
    expect(files.vocal).toBe(files.guide)
  })

  it('ready여도 필수 파일이 없으면 throw한다', async () => {
    const track = baseTrack('t1')
    await mkdir(join(tracksDir, 't1'), { recursive: true })
    await writeFile(join(tracksDir, 't1', 'inst.wav'), 'i')
    expect(() => requireReadyTrackFiles(tracksDir, track)).toThrow('required files missing')
    expect(resolveTrackFiles(tracksDir, track).vocal).toBe(join(tracksDir, 't1', 'vocal.wav'))
  })

  it('none requires only inst.wav, including after reading from the database', async () => {
    const track = baseTrack('mr-only', { importKind: 'paired', guideKind: 'none' })
    store.createTrack(track)
    await mkdir(join(tracksDir, track.id), { recursive: true })
    expect(() => requireReadyTrackFiles(tracksDir, track)).toThrow('required files missing')
    await writeFile(join(tracksDir, track.id, 'inst.wav'), 'mr')
    const files = requireReadyTrackFiles(tracksDir, store.getTrack(track.id)!)
    expect(files.guide).toBeNull()
    expect(files.vocal).toBeNull()
  })
})
