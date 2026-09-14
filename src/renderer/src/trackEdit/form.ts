import {
  hasTrackEditCoverChange,
  isAllowedCoverExt,
  isTrackMetaPatchEmpty,
  isTrackNotFoundError,
  parseUserBpm,
  parseUserMusicKey
} from '../../../shared/trackEdit'
import type {
  TrackCoverAction,
  TrackEditSaveRequest,
  TrackMetaPatch
} from '../../../shared/trackEdit'
import type { Track } from '../../../shared/types'

export interface TrackEditSnapshot {
  title: string
  artist: string | null
  album: string | null
  bpm: number | null
  musicKey: string | null
}

export interface TrackEditFields {
  title: string
  artist: string
  album: string
  bpm: string
  musicKey: string
}

export interface TrackEditFieldErrors {
  title: string | null
  bpm: string | null
  musicKey: string | null
}

export interface TrackEditErrors extends TrackEditFieldErrors {
  cover: string | null
  general: string | null
}

export type CoverDraft =
  { type: 'keep' } | { type: 'replace'; path: string; dataUrl: string } | { type: 'remove' }

export type CoverDropClassification =
  { kind: 'empty' } | { kind: 'ok'; path: string } | { kind: 'error'; message: string }

export type SaveErrorTarget = 'title' | 'bpm' | 'musicKey' | 'cover' | 'general'

export interface ClassifiedSaveError {
  target: SaveErrorTarget
  message: string
  notFound: boolean
}

export const COVER_DROP_TOO_MANY = '커버 이미지는 한 개만 놓을 수 있습니다'
export const COVER_DROP_UNSUPPORTED = '커버는 JPG/PNG/WebP만 사용할 수 있습니다'

const COVER_ERROR_MARKERS = [
  '커버 파일을 찾을 수 없습니다',
  '커버가 일반 파일이 아닙니다',
  '커버는 JPG/PNG/WebP만 사용할 수 있습니다',
  '커버 이미지를 읽을 수 없습니다',
  '커버 파일이 너무 큽니다'
]

export function emptyTrackEditErrors(): TrackEditErrors {
  return { title: null, bpm: null, musicKey: null, cover: null, general: null }
}

export function snapshotFromTrack(track: Track): TrackEditSnapshot {
  return {
    title: track.title,
    artist: track.artist,
    album: track.album,
    bpm: track.bpm,
    musicKey: track.musicKey
  }
}

export function fieldsFromSnapshot(snapshot: TrackEditSnapshot): TrackEditFields {
  return {
    title: snapshot.title,
    artist: snapshot.artist ?? '',
    album: snapshot.album ?? '',
    bpm: snapshot.bpm === null ? '' : String(snapshot.bpm),
    musicKey: snapshot.musicKey ?? ''
  }
}

export function keepCoverDraft(): CoverDraft {
  return { type: 'keep' }
}

export function replaceCoverDraft(path: string, dataUrl: string): CoverDraft {
  return { type: 'replace', path, dataUrl }
}

export function removeCoverDraft(): CoverDraft {
  return { type: 'remove' }
}

export function toCoverAction(draft: CoverDraft): TrackCoverAction {
  if (draft.type === 'replace') return { type: 'replace', path: draft.path }
  if (draft.type === 'remove') return { type: 'remove' }
  return { type: 'keep' }
}

export function isCoverDraftChanged(draft: CoverDraft): boolean {
  return draft.type !== 'keep'
}

/** 초안에 보이는 커버가 있으면 제거 가능. 원본 존재 여부는 CoverArt 로드로 확정 */
export function canRemoveCoverDraft(draft: CoverDraft, originalHasCover: boolean | null): boolean {
  if (draft.type === 'replace') return true
  if (draft.type === 'remove') return false
  return originalHasCover === true
}

export function coverSelectLabel(draft: CoverDraft, originalHasCover: boolean | null): string {
  if (coverDraftShowsArt(draft, originalHasCover)) return '이미지 변경'
  return '이미지 선택'
}

export function coverDraftShowsArt(draft: CoverDraft, originalHasCover: boolean | null): boolean {
  if (draft.type === 'replace') return true
  if (draft.type === 'remove') return false
  return originalHasCover !== false
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function validateTrackEditFields(fields: TrackEditFields): TrackEditFieldErrors {
  const errors: TrackEditFieldErrors = { title: null, bpm: null, musicKey: null }
  if (fields.title.trim() === '') errors.title = 'title must not be empty'

  const bpmRaw = fields.bpm.trim()
  if (bpmRaw !== '') {
    try {
      parseUserBpm(Number(bpmRaw))
    } catch (error) {
      errors.bpm = errorMessage(error)
    }
  }

  try {
    parseUserMusicKey(fields.musicKey)
  } catch (error) {
    errors.musicKey = errorMessage(error)
  }

  return errors
}

export function hasFieldErrors(errors: TrackEditFieldErrors): boolean {
  return errors.title !== null || errors.bpm !== null || errors.musicKey !== null
}

function parsedOptionalString(value: string): string | null {
  return value.trim() || null
}

function parsedBpm(fields: TrackEditFields): number | null {
  const raw = fields.bpm.trim()
  if (raw === '') return null
  return parseUserBpm(Number(raw))
}

export function buildMetaPatch(
  snapshot: TrackEditSnapshot,
  fields: TrackEditFields
): TrackMetaPatch {
  const patch: TrackMetaPatch = {}
  const title = fields.title.trim()
  const artist = parsedOptionalString(fields.artist)
  const album = parsedOptionalString(fields.album)
  const bpm = parsedBpm(fields)
  const musicKey = parseUserMusicKey(fields.musicKey)

  if (title !== snapshot.title) patch.title = title
  if (artist !== snapshot.artist) patch.artist = artist
  if (album !== snapshot.album) patch.album = album
  if (bpm !== snapshot.bpm) patch.bpm = bpm
  if (musicKey !== snapshot.musicKey) patch.musicKey = musicKey
  return patch
}

export function canSaveTrackEdit(
  snapshot: TrackEditSnapshot,
  fields: TrackEditFields,
  cover: CoverDraft
): boolean {
  if (hasFieldErrors(validateTrackEditFields(fields))) return false
  const patch = buildMetaPatch(snapshot, fields)
  return !isTrackMetaPatchEmpty(patch) || hasTrackEditCoverChange(toCoverAction(cover))
}

export function buildSaveRequest(
  trackId: string,
  snapshot: TrackEditSnapshot,
  fields: TrackEditFields,
  cover: CoverDraft
): TrackEditSaveRequest {
  return {
    trackId,
    meta: buildMetaPatch(snapshot, fields),
    cover: toCoverAction(cover)
  }
}

export function fileExt(filePath: string): string {
  const base = filePath.replaceAll('\\', '/').split('/').pop() ?? filePath
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot)
}

export function isSupportedCoverPath(filePath: string): boolean {
  return isAllowedCoverExt(fileExt(filePath))
}

export function classifyCoverDrop(paths: string[]): CoverDropClassification {
  const files = paths.filter((path) => path !== '')
  if (files.length === 0) return { kind: 'empty' }
  if (files.length > 1) return { kind: 'error', message: COVER_DROP_TOO_MANY }
  const path = files[0]
  if (path === undefined) return { kind: 'empty' }
  if (!isSupportedCoverPath(path)) return { kind: 'error', message: COVER_DROP_UNSUPPORTED }
  return { kind: 'ok', path }
}

export function classifySaveError(error: unknown): ClassifiedSaveError {
  const message = errorMessage(error)
  if (isTrackNotFoundError(error)) {
    return { target: 'general', message, notFound: true }
  }
  if (message === 'title must not be empty') {
    return { target: 'title', message, notFound: false }
  }
  if (message.includes('bpm must be between')) {
    return { target: 'bpm', message, notFound: false }
  }
  if (message.startsWith('invalid music key')) {
    return { target: 'musicKey', message, notFound: false }
  }
  if (
    COVER_ERROR_MARKERS.some((marker) => message.includes(marker)) ||
    message.startsWith('커버')
  ) {
    return { target: 'cover', message, notFound: false }
  }
  return { target: 'general', message, notFound: false }
}

export function applySaveError(classified: ClassifiedSaveError): TrackEditErrors {
  const next = emptyTrackEditErrors()
  next[classified.target] = classified.message
  return next
}

/** 검색 중에는 목록에 없는 곡을 끼워 넣지 않는다. 이미 있는 행은 갱신한다. */
export function mergeUpdatedTrack(tracks: Track[], updated: Track, search: string): Track[] {
  const index = tracks.findIndex((track) => track.id === updated.id)
  if (index !== -1) {
    const next = [...tracks]
    next[index] = updated
    return next
  }
  if (search.trim() !== '') return tracks
  return [updated, ...tracks]
}
