import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COVER_FILE_NAME, COVER_NONE_MARKER } from '../../../shared/trackEdit'
import type { SidecarManager } from '../../sidecar/SidecarManager'
import { CoverService } from '../CoverService'
import { COVER_EXTRACT_TMP } from '../coverRecovery'
import { LibraryStore } from '../LibraryStore'
import { PNG_1X1 } from './coverFixtures'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('CoverService extract vs user cover', () => {
  let root: string
  let tracksDir: string
  let store: LibraryStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'karaoke-cover-service-'))
    tracksDir = join(root, 'tracks')
    store = new LibraryStore(join(root, 'library.sqlite'))
  })

  afterEach(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })

  it('실행 중인 추출이 사용자 교체 커버를 덮지 않는다', async () => {
    const id = 't1'
    store.createTrack({
      id,
      title: 'song',
      artist: null,
      album: null,
      duration: 1,
      sourcePath: 'C:\\music\\a.flac'
    })
    const dir = join(tracksDir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'source.flac'), 'audio')

    const gate = deferred()
    const reached = deferred()
    const sidecar = {
      run: async (args: string[]) => {
        const out = args[args.indexOf('--out') + 1]
        await writeFile(out, 'extracted')
        return { cover: out }
      }
    } as unknown as SidecarManager
    const coverService = new CoverService({
      store,
      sidecar,
      tracksDir,
      beforeInstallExtract: async () => {
        reached.resolve()
        await gate.promise
      }
    })

    coverService.refresh(store.mustGetTrack(id))
    await reached.promise
    await writeFile(join(dir, COVER_FILE_NAME), PNG_1X1)
    coverService.noteUserCoverChange(id)
    gate.resolve()
    await coverService.idle()

    expect(await readFile(join(dir, COVER_FILE_NAME))).toEqual(PNG_1X1)
    expect(existsSync(join(dir, COVER_EXTRACT_TMP))).toBe(false)
  })

  it('실행 중인 추출이 사용자 제거 결과를 복원하지 않는다', async () => {
    const id = 't1'
    store.createTrack({
      id,
      title: 'song',
      artist: null,
      album: null,
      duration: 1,
      sourcePath: 'C:\\music\\a.flac'
    })
    const dir = join(tracksDir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'source.flac'), 'audio')

    const gate = deferred()
    const reached = deferred()
    const sidecar = {
      run: async (args: string[]) => {
        const out = args[args.indexOf('--out') + 1]
        await writeFile(out, 'extracted')
        return { cover: out }
      }
    } as unknown as SidecarManager
    const coverService = new CoverService({
      store,
      sidecar,
      tracksDir,
      beforeInstallExtract: async () => {
        reached.resolve()
        await gate.promise
      }
    })

    coverService.refresh(store.mustGetTrack(id))
    await reached.promise
    await writeFile(join(dir, COVER_NONE_MARKER), '')
    coverService.noteUserCoverChange(id)
    gate.resolve()
    await coverService.idle()

    expect(existsSync(join(dir, COVER_FILE_NAME))).toBe(false)
    expect(existsSync(join(dir, COVER_NONE_MARKER))).toBe(true)
  })
})
