import { existsSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LibraryStore } from '../LibraryStore'
import { PAIR_JOB_MARKER, PAIR_TMP_DIRNAME, recoverIncompletePairImports } from '../pairRecovery'

describe('recoverIncompletePairImports', () => {
  let root: string
  let tracksDir: string
  let store: LibraryStore
  let userFile: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'karaoke-pair-recovery-'))
    tracksDir = join(root, 'tracks')
    await mkdir(tracksDir, { recursive: true })
    store = new LibraryStore(join(root, 'library.sqlite'))
    userFile = join(root, 'user-input.wav')
    await writeFile(userFile, 'keep-me')
  })

  afterEach(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })

  it('파일이 이동됐지만 DB 행이 없으면 디렉토리를 지우고 ready 행도 없다', async () => {
    const id = 'moved-no-row'
    const dir = join(tracksDir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, PAIR_JOB_MARKER), JSON.stringify({ trackId: id }), 'utf-8')
    await writeFile(join(dir, 'inst.wav'), 'inst')
    await writeFile(join(dir, 'vocal.wav'), 'vocal')

    const cleaned = await recoverIncompletePairImports(tracksDir, store)
    expect(cleaned).toBeGreaterThan(0)
    expect(existsSync(dir)).toBe(false)
    expect(store.getTrack(id)).toBeUndefined()
    expect(store.listTracks()).toEqual([])
    expect(existsSync(userFile)).toBe(true)
  })

  it('완료된 DB 행의 디렉토리는 보존한다', async () => {
    const id = 'ready-row'
    store.createTrack({
      id,
      title: 'kept',
      artist: null,
      album: null,
      duration: 10,
      sourcePath: userFile,
      status: 'ready',
      importKind: 'paired',
      guideKind: 'vocal_only'
    })
    const dir = join(tracksDir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'inst.wav'), 'inst')
    await writeFile(join(dir, 'vocal.wav'), 'vocal')
    await writeFile(join(dir, PAIR_JOB_MARKER), JSON.stringify({ trackId: id }), 'utf-8')

    const cleaned = await recoverIncompletePairImports(tracksDir, store)
    expect(cleaned).toBe(0)
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(join(dir, 'inst.wav'))).toBe(true)
    expect(store.getTrack(id)?.status).toBe('ready')
  })

  it('.pair-tmp 잔여와 무관한 기존 곡은 그대로 둔다', async () => {
    const existing = 'already-there'
    store.createTrack({
      id: existing,
      title: 'old',
      artist: null,
      album: null,
      duration: 1,
      sourcePath: userFile
    })
    const existingDir = join(tracksDir, existing)
    await mkdir(existingDir, { recursive: true })
    await writeFile(join(existingDir, 'source.wav'), 'src')

    const tmpJob = join(tracksDir, PAIR_TMP_DIRNAME, 'job-1')
    await mkdir(tmpJob, { recursive: true })
    await writeFile(join(tmpJob, PAIR_JOB_MARKER), '{}', 'utf-8')
    await writeFile(join(tmpJob, 'inst.wav'), 'tmp')

    const cleaned = await recoverIncompletePairImports(tracksDir, store)
    expect(cleaned).toBeGreaterThan(0)
    expect(existsSync(join(tracksDir, PAIR_TMP_DIRNAME))).toBe(false)
    expect(existsSync(existingDir)).toBe(true)
    expect(store.getTrack(existing)?.title).toBe('old')
    expect(existsSync(userFile)).toBe(true)
  })
})
