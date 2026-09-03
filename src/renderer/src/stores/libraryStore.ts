import { create } from 'zustand'
import type {
  ImportProgressEvent,
  ImportRejection,
  Track,
  TrackMetaInput,
  UrlImportProgressEvent
} from '../../../shared/types'
import { reportError } from './errorStore'

/** 임포트 거부 사유를 오류 센터에도 남긴다 (배너는 닫으면 사라지므로) */
function reportRejections(source: 'import' | 'url-import', rejected: ImportRejection[]): void {
  for (const rejection of rejected) {
    reportError(source, `${rejection.filePath} — ${rejection.reason}`)
  }
}

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
  refresh: () => Promise<void>
  setSearch: (query: string) => Promise<void>
  importFiles: (filePaths: string[]) => Promise<void>
  importViaDialog: () => Promise<void>
  loadCapabilities: () => Promise<void>
  /** 성공(트랙 추가)이면 true. 실패 사유는 rejections로 표면화된다 */
  importUrl: (url: string) => Promise<boolean>
  deleteTrack: (trackId: string) => Promise<void>
  /** 드래그 정렬 저장. ids는 검색 필터 없는 전체 순서. 화면은 즉시 반영하고 저장은 뒤따른다 */
  reorderTracks: (ids: string[]) => Promise<void>
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
  window.api.onUrlImportProgress((event) => {
    set({ urlImportProgress: event })
  })

  const applyImportResult = async (
    run: () => Promise<{ rejected: ImportRejection[] }>
  ): Promise<void> => {
    set({ importing: true })
    try {
      const { rejected } = await run()
      set((state) => ({ rejections: [...state.rejections, ...rejected] }))
      reportRejections('import', rejected)
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
    urlImportAvailable: false,
    urlImporting: false,
    urlImportProgress: null,
    refresh: async () => {
      set({ tracks: await window.api.listTracks(get().search) })
    },
    setSearch: async (query) => {
      set({ search: query })
      set({ tracks: await window.api.listTracks(query) })
    },
    importFiles: (filePaths) => applyImportResult(() => window.api.importFiles(filePaths)),
    importViaDialog: () => applyImportResult(() => window.api.importDialog()),
    loadCapabilities: async () => {
      const { urlImport } = await window.api.getCapabilities()
      set({ urlImportAvailable: urlImport })
    },
    importUrl: async (url) => {
      set({ urlImporting: true, urlImportProgress: null })
      try {
        const { imported, rejected } = await window.api.importUrl(url)
        if (rejected.length > 0) {
          set((state) => ({ rejections: [...state.rejections, ...rejected] }))
          reportRejections('url-import', rejected)
        }
        return imported.length > 0
      } finally {
        set({ urlImporting: false, urlImportProgress: null })
        await get().refresh()
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
    dismissRejections: () => set({ rejections: [] })
  }
})
