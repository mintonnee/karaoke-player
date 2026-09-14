import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ImportService } from '../ImportService'
import { LibraryStore } from '../LibraryStore'
import { JobQueue } from '../JobQueue'
import type { SidecarManager } from '../../sidecar/SidecarManager'
import { PNG_1X1 } from './coverFixtures'

let root: string
let tracksDir: string
let source: string
let store: LibraryStore
let service: ImportService
let enqueue: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'karaoke-files-'))
  tracksDir = join(root, 'tracks')
  source = join(root, 'song.wav')
  await mkdir(tracksDir)
  await writeFile(source, 'audio')
  store = new LibraryStore(join(root, 'library.sqlite'))
  const queue = new JobQueue()
  enqueue = vi.spyOn(queue, 'enqueue').mockImplementation(() => {})
  service = new ImportService({
    store,
    queue,
    tracksDir,
    maxDurationSec: 900,
    sidecar: { run: async () => ({ duration: 100 }) } as unknown as SidecarManager,
    getDemucsModel: () => 'htdemucs',
    notify: () => {}
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  store.close()
  await rm(root, { recursive: true, force: true })
})

it('커버 실패 시 DB 등록과 분리 작업 없이 준비 파일을 정리한다', async () => {
  const create = vi.spyOn(store, 'createTrack')
  const result = await service.importFiles([source], undefined, {
    coverPath: join(root, 'missing.png')
  })
  expect(result.imported).toEqual([])
  expect(result.rejected).toHaveLength(1)
  expect(create).not.toHaveBeenCalled()
  expect(await readdir(tracksDir)).toEqual([])
  expect(enqueue).not.toHaveBeenCalled()
  expect(await readFile(source, 'utf8')).toBe('audio')
})

it('DB 등록 실패 시 복사한 원본과 커버를 정리한다', async () => {
  const cover = join(root, 'cover.png')
  await writeFile(cover, PNG_1X1)
  vi.spyOn(store, 'createTrack').mockImplementation(() => {
    throw new Error('db failure')
  })
  const result = await service.importFiles([source], undefined, { coverPath: cover })
  expect(result.rejected).toHaveLength(1)
  expect(await readdir(tracksDir)).toEqual([])
  expect(enqueue).not.toHaveBeenCalled()
  expect(await readFile(cover)).toEqual(PNG_1X1)
})

it('원본 복사 실패도 준비 디렉터리를 남기지 않는다', async () => {
  const result = await service.importFiles([join(root, 'missing.wav')])
  expect(result.rejected).toHaveLength(1)
  expect(await readdir(tracksDir)).toEqual([])
  expect(enqueue).not.toHaveBeenCalled()
})

it('INSERT 후 오류도 DB 행과 파일을 함께 정리한다', async () => {
  const original = store.createTrack.bind(store)
  let id = ''
  vi.spyOn(store, 'createTrack').mockImplementation((input) => {
    id = input.id
    original(input)
    throw new Error('readback failed')
  })
  const result = await service.importFiles([source])
  expect(result.rejected).toHaveLength(1)
  expect(store.getTrack(id)).toBeUndefined()
  expect(await readdir(tracksDir)).toEqual([])
  expect(enqueue).not.toHaveBeenCalled()
})

it('준비 완료 후 DB 등록과 분리 큐 등록을 수행한다', async () => {
  const cover = join(root, 'cover.png')
  await writeFile(cover, PNG_1X1)
  const result = await service.importFiles([source], undefined, { coverPath: cover })
  expect(result.rejected).toEqual([])
  const track = result.imported[0]
  expect(store.getTrack(track.id)?.status).toBe('imported')
  expect(await readFile(join(tracksDir, track.id, 'source.wav'), 'utf8')).toBe('audio')
  expect(await readFile(join(tracksDir, track.id, 'cover.jpg'))).toEqual(PNG_1X1)
  expect(enqueue).toHaveBeenCalledTimes(1)
})
