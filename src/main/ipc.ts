import { dialog, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import type { ImportFilesResponse, Track } from '../shared/types'
import type { ImportService } from './library/ImportService'
import type { LibraryStore } from './library/LibraryStore'

const AUDIO_FILE_FILTERS = [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a'] }]

export interface IpcDeps {
  store: LibraryStore
  importService: ImportService
}

export function registerIpcHandlers({ store, importService }: IpcDeps): void {
  ipcMain.handle(IPC_CHANNELS.listTracks, (): Track[] => store.listTracks())

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
