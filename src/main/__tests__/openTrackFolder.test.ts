import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { IPC_CHANNELS } from '../../shared/types'
import { registerIpcHandlers, type IpcDeps } from '../ipc'
import { LibraryStore } from '../library/LibraryStore'

const handlers = new Map<string, (event: unknown, ...args: any[]) => Promise<any>>()
const mockOpenPath = vi.fn(async (_path: string) => '')

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: any[]) => Promise<any>) => {
      handlers.set(channel, handler)
    }
  },
  shell: {
    openPath: (path: string) => mockOpenPath(path)
  },
  dialog: {
    showOpenDialog: vi.fn()
  },
  app: {
    getVersion: () => '0.1.0'
  },
  nativeImage: {}
}))

describe('openTrackFolder IPC', () => {
  let root: string
  let tracksDir: string
  let store: LibraryStore

  beforeEach(async () => {
    handlers.clear()
    mockOpenPath.mockReset()
    mockOpenPath.mockResolvedValue('')

    root = await mkdtemp(join(tmpdir(), 'karaoke-open-track-folder-'))
    tracksDir = join(root, 'tracks')
    await mkdir(tracksDir, { recursive: true })
    store = new LibraryStore(join(root, 'library.sqlite'))

    const deps: IpcDeps = {
      store,
      importService: {} as any,
      lyricsService: {} as any,
      searchKeyService: {} as any,
      settingsStore: {} as any,
      tracksDir,
      notify: vi.fn(),
      capabilities: { urlImport: true },
      ytDlpService: null,
      previewService: null,
      trackEditService: {} as any,
      coverService: {} as any,
      analysisService: {} as any,
      getBootstrapState: () => ({ status: 'ready', message: '', error: null, log: [] })
    }
    registerIpcHandlers(deps)
  })

  afterEach(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })

  it('존재하는 트랙 폴더 경로로 shell.openPath를 호출한다', async () => {
    const trackId = 'test-track-1'
    store.createTrack({
      id: trackId,
      title: 'Title',
      artist: 'Artist',
      album: null,
      duration: 120,
      sourcePath: 'dummy.mp3'
    })
    const trackDir = join(tracksDir, trackId)
    await mkdir(trackDir, { recursive: true })

    const handler = handlers.get(IPC_CHANNELS.openTrackFolder)
    expect(handler).toBeDefined()

    await handler!({}, trackId)
    expect(mockOpenPath).toHaveBeenCalledWith(trackDir)
  })

  it('trackId가 유효하지 않으면 거부한다', async () => {
    const handler = handlers.get(IPC_CHANNELS.openTrackFolder)!
    await expect(handler!({}, '')).rejects.toThrow('invalid trackId')
    await expect(handler!({}, '   ')).rejects.toThrow('invalid trackId')
  })

  it('DB에 없는 trackId면 거부한다', async () => {
    const handler = handlers.get(IPC_CHANNELS.openTrackFolder)!
    await expect(handler!({}, 'non-existent')).rejects.toThrow('track not found')
  })

  it('디스크에 폴더가 없으면 거부한다', async () => {
    const trackId = 'test-track-missing-dir'
    store.createTrack({
      id: trackId,
      title: 'Title',
      artist: 'Artist',
      album: null,
      duration: 120,
      sourcePath: 'dummy.mp3'
    })

    const handler = handlers.get(IPC_CHANNELS.openTrackFolder)!
    await expect(handler!({}, trackId)).rejects.toThrow('track directory not found')
  })

  it('shell.openPath가 에러를 반환하면 예외를 던진다', async () => {
    const trackId = 'test-track-err'
    store.createTrack({
      id: trackId,
      title: 'Title',
      artist: 'Artist',
      album: null,
      duration: 120,
      sourcePath: 'dummy.mp3'
    })
    await mkdir(join(tracksDir, trackId), { recursive: true })
    mockOpenPath.mockResolvedValueOnce('Failed to launch explorer')

    const handler = handlers.get(IPC_CHANNELS.openTrackFolder)!
    await expect(handler!({}, trackId)).rejects.toThrow('failed to open track directory: Failed to launch explorer')
  })
})
