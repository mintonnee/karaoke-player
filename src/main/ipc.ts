import { dialog, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import type { PickAndProbeResponse, ProbeResult } from '../shared/types'
import { SidecarError } from './sidecar/SidecarManager'
import type { SidecarManager } from './sidecar/SidecarManager'

const PROBE_TIMEOUT_MS = 30_000

const AUDIO_FILE_FILTERS = [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a'] }]

export function registerIpcHandlers(sidecar: SidecarManager): void {
  ipcMain.handle(IPC_CHANNELS.pickAndProbe, async (): Promise<PickAndProbeResponse> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: AUDIO_FILE_FILTERS
    })
    if (canceled || filePaths.length === 0) {
      return { canceled: true }
    }

    const filePath = filePaths[0]
    try {
      const result = (await sidecar.run(['probe', '--input', filePath, '--json'], {
        timeoutMs: PROBE_TIMEOUT_MS
      })) as ProbeResult
      return { canceled: false, filePath, result }
    } catch (error) {
      const message =
        error instanceof SidecarError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error)
      return { canceled: false, filePath, error: message }
    }
  })
}
