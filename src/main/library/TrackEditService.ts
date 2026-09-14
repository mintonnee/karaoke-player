import { join } from 'path'
import {
  hasTrackEditCoverChange,
  isTrackMetaPatchEmpty,
  sanitizeTrackEditSaveRequest,
  trackEditChangesSearchKeys
} from '../../shared/trackEdit'
import type { TrackEditSaveRequest } from '../../shared/trackEdit'
import { IPC_CHANNELS } from '../../shared/types'
import type { Track } from '../../shared/types'
import type { CoverService } from './CoverService'
import {
  beginCoverEdit,
  finalizeTrackEditFiles,
  installCoverAction,
  markCoverFilesApplied,
  rollbackTrackEditFiles
} from './coverRecovery'
import type { TrackEditJournal } from './coverRecovery'
import type { LibraryStore } from './LibraryStore'

export interface TrackEditServiceOptions {
  store: LibraryStore
  tracksDir: string
  coverService: CoverService
  searchKeyService: { refresh(track: Track): void }
  notify: (channel: string, payload: unknown) => void
  /** 커버 파일을 복사하기 직전 (테스트에서 원본 삭제 등) */
  beforeInstallCover?: (req: TrackEditSaveRequest) => Promise<void>
  /** DB 확정 직전 (테스트에서 실패·크래시 주입) */
  beforeCommitMeta?: (req: TrackEditSaveRequest) => Promise<void>
}

export class TrackEditService {
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly options: TrackEditServiceOptions) {}

  async save(raw: unknown): Promise<Track> {
    const req = sanitizeTrackEditSaveRequest(raw)
    return this.withTrackLock(req.trackId, () => this.saveLocked(req))
  }

  async withTrackLock<T>(trackId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(trackId) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    this.locks.set(
      trackId,
      prev.then(
        () => next,
        () => next
      )
    )
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private async saveLocked(req: TrackEditSaveRequest): Promise<Track> {
    const existing = this.options.store.getTrack(req.trackId)
    if (!existing) throw new Error(`track not found: ${req.trackId}`)

    const coverChanged = hasTrackEditCoverChange(req.cover)
    const metaChanged = !isTrackMetaPatchEmpty(req.meta)
    if (!coverChanged && !metaChanged) return existing

    const dir = join(this.options.tracksDir, req.trackId)
    let journal: TrackEditJournal | null = null
    if (req.cover.type === 'replace' || req.cover.type === 'remove') {
      this.options.coverService.noteUserCoverChange(req.trackId)
      journal = await beginCoverEdit(dir, req.trackId, req.cover, req.meta)
      try {
        await this.options.beforeInstallCover?.(req)
        await installCoverAction(dir, req.cover)
        await markCoverFilesApplied(dir, journal)
      } catch (error) {
        await rollbackTrackEditFiles(dir, journal)
        await finalizeTrackEditFiles(dir)
        throw error
      }
    }

    let updated: Track
    try {
      await this.options.beforeCommitMeta?.(req)
      if (!this.options.store.getTrack(req.trackId)) {
        throw new Error(`track not found: ${req.trackId}`)
      }
      updated = this.options.store.applyMetaPatch(req.trackId, req.meta)
    } catch (error) {
      if (journal) {
        await rollbackTrackEditFiles(dir, journal)
        await finalizeTrackEditFiles(dir)
      }
      throw error
    }

    if (journal) await finalizeTrackEditFiles(dir)
    this.options.notify(IPC_CHANNELS.trackUpdated, updated)
    if (trackEditChangesSearchKeys(req.meta)) {
      this.options.searchKeyService.refresh(updated)
    }
    return updated
  }
}
