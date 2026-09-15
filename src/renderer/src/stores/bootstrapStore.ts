import { create } from 'zustand'
import { isRuntimeReady } from '../../../shared/bootstrap'
import type { BootstrapState } from '../../../shared/types'

interface BootstrapStore {
  state: BootstrapState | null
  setState: (state: BootstrapState) => void
}

export const useBootstrapStore = create<BootstrapStore>((set) => ({
  state: null,
  setState: (state) => set({ state })
}))

export function useRuntimeReady(): boolean {
  return useBootstrapStore((s) => isRuntimeReady(s.state))
}
