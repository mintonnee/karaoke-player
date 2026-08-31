import { create } from 'zustand'
import type {
  ImportProgressEvent,
  ImportRejection,
  Track,
  TrackMetaInput
} from '../../../shared/types'

interface LibraryState {
  tracks: Track[]
  /** trackId → 분리 진행률 */
  progress: Record<string, ImportProgressEvent>
  rejections: ImportRejection[]
  importing: boolean
  search: string
  refresh: () => Promise<void>
  setSearch: (query: string) => Promise<void>
  importFiles: (filePaths: string[]) => Promise<void>
  importViaDialog: () => Promise<void>
  deleteTrack: (trackId: string) => Promise<void>
  updateTrackMeta: (trackId: string, meta: TrackMetaInput) => Promise<void>
  dismissRejections: () => void
}

function upsertTrack(tracks: Track[], track: Track): Track[] {
  const index = tracks.findIndex((t) => t.id === track.id)
  if (index === -1) return [track, ...tracks]
  const next = [...tracks]
  next[index] = track
  return next
}

export const useLibraryStore = create<LibraryState>((set, get) => {
  window.api.onTrackUpdated((track) => {
    set((state) => {
      const progress = { ...state.progress }
      if (track.status === 'ready' || track.status === 'failed') {
        delete progress[track.id]
      }
      return { tracks: upsertTrack(state.tracks, track), progress }
    })
  })
  window.api.onImportProgress((event) => {
    set((state) => ({ progress: { ...state.progress, [event.trackId]: event } }))
  })

  const applyImportResult = async (
    run: () => Promise<{ rejected: ImportRejection[] }>
  ): Promise<void> => {
    set({ importing: true })
    try {
      const { rejected } = await run()
      set((state) => ({ rejections: [...state.rejections, ...rejected] }))
    } finally {
      set({ importing: false })
      await get().refresh()
    }
  }

  return {
    tracks: [],
    progress: {},
    rejections: [],
    importing: false,
    search: '',
    refresh: async () => {
      set({ tracks: await window.api.listTracks(get().search) })
    },
    setSearch: async (query) => {
      set({ search: query })
      set({ tracks: await window.api.listTracks(query) })
    },
    importFiles: (filePaths) => applyImportResult(() => window.api.importFiles(filePaths)),
    importViaDialog: () => applyImportResult(() => window.api.importDialog()),
    deleteTrack: async (trackId) => {
      await window.api.deleteTrack(trackId)
      set((state) => ({ tracks: state.tracks.filter((t) => t.id !== trackId) }))
    },
    updateTrackMeta: async (trackId, meta) => {
      const updated = await window.api.updateTrackMeta(trackId, meta)
      set((state) => ({ tracks: upsertTrack(state.tracks, updated) }))
    },
    dismissRejections: () => set({ rejections: [] })
  }
})
