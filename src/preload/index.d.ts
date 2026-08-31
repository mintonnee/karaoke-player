import { ElectronAPI } from '@electron-toolkit/preload'
import type { PickAndProbeResponse } from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      pickAndProbe: () => Promise<PickAndProbeResponse>
    }
  }
}
