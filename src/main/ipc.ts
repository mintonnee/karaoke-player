import { dialog, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { DEMUCS_MODELS, IPC_CHANNELS } from '../shared/types'
import type {
  AlignLang,
  AlignedLine,
  AppSettings,
  ImportFilesResponse,
  Track,
  TrackFiles,
  TrackMetaInput
} from '../shared/types'
import type { ImportService } from './library/ImportService'
import type { LibraryStore } from './library/LibraryStore'
import type { SearchKeyService } from './library/SearchKeyService'
import type { LyricsService } from './lyrics/LyricsService'
import type { SettingsStore } from './settings/SettingsStore'

const AUDIO_FILE_FILTERS = [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a'] }]

export interface IpcDeps {
  store: LibraryStore
  importService: ImportService
  lyricsService: LyricsService
  searchKeyService: SearchKeyService
  settingsStore: SettingsStore
  tracksDir: string
  notify: (channel: string, payload: unknown) => void
}

export function registerIpcHandlers({
  store,
  importService,
  lyricsService,
  searchKeyService,
  settingsStore,
  tracksDir,
  notify
}: IpcDeps): void {
  // 렌더러가 cover.jpg 등 트랙 파일의 media:// URL을 만들 때 쓴다
  ipcMain.handle(IPC_CHANNELS.tracksDir, (): string => tracksDir)

  ipcMain.handle(IPC_CHANNELS.settingsGet, (): AppSettings => settingsStore.get())

  ipcMain.handle(IPC_CHANNELS.settingsSet, (_event, patch: Partial<AppSettings>): AppSettings => {
    if (
      patch.demucsModel !== undefined &&
      !DEMUCS_MODELS.some((model) => model.id === patch.demucsModel)
    ) {
      throw new Error(`unknown demucs model: ${patch.demucsModel}`)
    }
    return settingsStore.set(patch)
  })
  ipcMain.handle(IPC_CHANNELS.lyricsGet, (_event, trackId: string) =>
    lyricsService.getLyrics(trackId)
  )

  ipcMain.handle(IPC_CHANNELS.lyricsRefetch, (_event, trackId: string) => {
    const track = store.getTrack(trackId)
    if (!track) throw new Error(`track not found: ${trackId}`)
    return lyricsService.fetchAndStore(track)
  })

  ipcMain.handle(
    IPC_CHANNELS.lyricsAlign,
    (_event, trackId: string, text: string, lang: AlignLang, fromLrclibPlain: boolean) =>
      lyricsService.alignLyrics(trackId, text, lang, fromLrclibPlain)
  )

  ipcMain.handle(IPC_CHANNELS.lyricsTranscribe, (_event, trackId: string) =>
    lyricsService.transcribe(trackId)
  )

  ipcMain.handle(IPC_CHANNELS.lyricsSaveLines, (_event, trackId: string, lines: AlignedLine[]) =>
    lyricsService.saveLines(trackId, lines)
  )

  ipcMain.handle(IPC_CHANNELS.lyricsPronounce, (_event, trackId: string) =>
    lyricsService.pronounce(trackId)
  )

  ipcMain.handle(IPC_CHANNELS.listTracks, (_event, query?: string): Track[] =>
    store.listTracks(query)
  )

  ipcMain.handle(IPC_CHANNELS.deleteTrack, async (_event, trackId: string): Promise<void> => {
    const track = store.getTrack(trackId)
    if (!track) return
    if (track.status === 'separating') {
      throw new Error('분리 작업 중인 트랙은 삭제할 수 없습니다')
    }
    store.deleteTrack(trackId)
    await rm(join(tracksDir, trackId), { recursive: true, force: true })
  })

  ipcMain.handle(
    IPC_CHANNELS.updateTrackMeta,
    (_event, trackId: string, meta: TrackMetaInput): Track => {
      const updated = store.updateMeta(trackId, meta)
      searchKeyService.refresh(updated)
      notify(IPC_CHANNELS.trackUpdated, updated)
      return updated
    }
  )

  ipcMain.handle(IPC_CHANNELS.trackFiles, (_event, trackId: string): TrackFiles => {
    const track = store.getTrack(trackId)
    if (!track) throw new Error(`track not found: ${trackId}`)
    if (track.status !== 'ready') throw new Error(`track not ready: ${trackId} (${track.status})`)

    const files: TrackFiles = {
      inst: join(tracksDir, trackId, 'inst.wav'),
      vocal: join(tracksDir, trackId, 'vocal.wav')
    }
    if (!existsSync(files.inst) || !existsSync(files.vocal)) {
      throw new Error(`separated stems missing for track ${trackId}`)
    }
    return files
  })

  ipcMain.handle(
    IPC_CHANNELS.importFiles,
    (_event, filePaths: string[]): Promise<ImportFilesResponse> =>
      importService.importFiles(filePaths)
  )

  ipcMain.handle(IPC_CHANNELS.importDialog, async (): Promise<ImportFilesResponse> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: AUDIO_FILE_FILTERS
    })
    if (canceled || filePaths.length === 0) {
      return { imported: [], rejected: [] }
    }
    return importService.importFiles(filePaths)
  })
}
