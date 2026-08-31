import { create } from 'zustand'
import type { ProbeResult } from '../../../shared/types'

interface ProbeState {
  status: 'idle' | 'probing' | 'done' | 'error'
  filePath?: string
  result?: ProbeResult
  error?: string
  pickAndProbe: () => Promise<void>
}

export const useProbeStore = create<ProbeState>((set) => ({
  status: 'idle',
  pickAndProbe: async () => {
    set({ status: 'probing', filePath: undefined, result: undefined, error: undefined })
    const response = await window.api.pickAndProbe()
    if (response.canceled) {
      set({ status: 'idle' })
    } else if (response.error !== undefined) {
      set({ status: 'error', filePath: response.filePath, error: response.error })
    } else {
      set({ status: 'done', filePath: response.filePath, result: response.result })
    }
  }
}))
