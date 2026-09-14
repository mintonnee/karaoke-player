import { create } from 'zustand'
import type { TrackEditSaveRequest } from '../../../shared/trackEdit'
import type {
  ImportFilesResponse,
  ImportProgressEvent,
  ImportRejection,
  ImportUserMeta,
  PairImportProgressEvent,
  PairImportRequest,
  Track,
  TrackMetaInput,
  UrlImportProgressEvent
} from '../../../shared/types'
import { mergeUpdatedTrack } from '../trackEdit/form'

interface LibraryState {
  tracks: Track[]
  /** trackId → 분리 진행률 */
  progress: Record<string, ImportProgressEvent>
  rejections: ImportRejection[]
  importing: boolean
  search: string
  /** yt-dlp 동봉 여부 (스펙 001 §4.3). false면 URL 임포트 UI를 그리지 않는다 */
  urlImportAvailable: boolean
  urlImporting: boolean
  /** 진행 중인 URL 다운로드 진행률. 요청 밖에서는 null */
  urlImportProgress: UrlImportProgressEvent | null
  pairImporting: boolean
  pairImportProgress: PairImportProgressEvent | null
  refresh: () => Promise<void>
  setSearch: (query: string) => Promise<void>
  importFiles: (filePaths: string[], userMeta?: ImportUserMeta) => Promise<ImportFilesResponse>
  loadCapabilities: () => Promise<void>
  importUrl: (url: string, userMeta?: ImportUserMeta) => Promise<ImportFilesResponse>
  importPair: (req: PairImportRequest) => Promise<ImportFilesResponse>
  deleteTrack: (trackId: string) => Promise<void>
  /** 드래그 정렬 저장. ids는 검색 필터 없는 전체 순서. 화면은 즉시 반영하고 저장은 뒤따른다 */
  reorderTracks: (ids: string[]) => Promise<void>
  updateTrackMeta: (trackId: string, meta: TrackMetaInput) => Promise<void>
  saveTrackEdit: (req: TrackEditSaveRequest) => Promise<Track>
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
      return { tracks: mergeUpdatedTrack(state.tracks, track, state.search), progress }
    })
  })
  window.api.onImportProgress((event) => {
    set((state) => ({ progress: { ...state.progress, [event.trackId]: event } }))
  })
  window.api.onUrlImportProgress((event) => {
    set({ urlImportProgress: event })
  })
  window.api.onPairImportProgress((event) => {
    set({ pairImportProgress: event })
  })

  return {
    tracks: [],
    progress: {},
    rejections: [],
    importing: false,
    search: '',
    urlImportAvailable: false,
    urlImporting: false,
    urlImportProgress: null,
    pairImporting: false,
    pairImportProgress: null,
    refresh: async () => {
      set({ tracks: await window.api.listTracks(get().search) })
    },
    setSearch: async (query) => {
      set({ search: query })
      set({ tracks: await window.api.listTracks(query) })
    },
    importFiles: async (filePaths, userMeta) => {
      set({ importing: true })
      try {
        return await window.api.importFiles(filePaths, userMeta)
      } finally {
        try {
          await get().refresh()
        } finally {
          set({ importing: false })
        }
      }
    },
    loadCapabilities: async () => {
      const { urlImport } = await window.api.getCapabilities()
      set({ urlImportAvailable: urlImport })
    },
    importUrl: async (url, userMeta) => {
      set({ urlImporting: true, urlImportProgress: null })
      try {
        return await window.api.importUrl(url, userMeta)
      } finally {
        try {
          await get().refresh()
        } finally {
          set({ urlImporting: false, urlImportProgress: null })
        }
      }
    },
    importPair: async (req) => {
      set({ pairImporting: true, pairImportProgress: null })
      try {
        return await window.api.importPair(req)
      } finally {
        try {
          await get().refresh()
        } finally {
          set({ pairImporting: false, pairImportProgress: null })
        }
      }
    },
    deleteTrack: async (trackId) => {
      await window.api.deleteTrack(trackId)
      set((state) => ({ tracks: state.tracks.filter((t) => t.id !== trackId) }))
    },
    reorderTracks: async (ids) => {
      const byId = new Map(get().tracks.map((t) => [t.id, t]))
      const ordered = ids.flatMap((id) => {
        const track = byId.get(id)
        return track ? [track] : []
      })
      set({ tracks: ordered })
      await window.api.reorderTracks(ids)
    },
    updateTrackMeta: async (trackId, meta) => {
      const updated = await window.api.updateTrackMeta(trackId, meta)
      set((state) => ({ tracks: upsertTrack(state.tracks, updated) }))
    },
    saveTrackEdit: async (req) => {
      const updated = await window.api.saveTrackEdit(req)
      try {
        await get().refresh()
      } catch {
        // 저장은 이미 반영됨. 목록 재조회 실패는 팝업을 붙잡지 않는다
      }
      return updated
    },
    dismissRejections: () => set({ rejections: [] })
  }
})
