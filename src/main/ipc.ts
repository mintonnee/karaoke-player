import { dialog, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { IPC_CHANNELS } from '../shared/types'
import type { ImportFilesResponse, Track, TrackFiles } from '../shared/types'
import type { ImportService } from './library/ImportService'
import type { LibraryStore } from './library/LibraryStore'

const AUDIO_FILE_FILTERS = [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a'] }]

export interface IpcDeps {
  store: LibraryStore
  importService: ImportService
  tracksDir: string
}

export function registerIpcHandlers({ store, importService, tracksDir }: IpcDeps): void {
  ipcMain.handle(IPC_CHANNELS.listTracks, (): Track[] => store.listTracks())

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
