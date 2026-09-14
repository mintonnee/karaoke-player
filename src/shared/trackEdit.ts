import { BPM_MAX, BPM_MIN, MUSIC_KEY_RE } from './types'

/** 가져오기와 곡 수정이 같은 확장자를 쓴다 (스펙 005 §4.2, 004) */
export const ALLOWED_COVER_EXT = ['.jpg', '.jpeg', '.png', '.webp'] as const
export type AllowedCoverExt = (typeof ALLOWED_COVER_EXT)[number]

/** 커버 파일 바이트 상한. 가져오기와 동일 */
export const MAX_COVER_BYTES = 20 * 1024 * 1024

/** 트랙 디렉토리에 저장하는 커버 파일명. 실제 인코딩과 무관하게 고정 */
export const COVER_FILE_NAME = 'cover.jpg'

/** 커버가 없음을 기록해 자동 추출을 건너뛴다. 명시적 제거 저장에만 만든다 */
export const COVER_NONE_MARKER = 'cover.none'

export function isAllowedCoverExt(ext: string): boolean {
  const lower = ext.toLowerCase()
  return (ALLOWED_COVER_EXT as readonly string[]).includes(lower)
}

export type TrackCoverAction =
  { type: 'keep' } | { type: 'replace'; path: string } | { type: 'remove' }

/** 변경할 필드만 보낸다. 생략하면 최신 행 값을 유지한다 */
export interface TrackMetaPatch {
  title?: string
  artist?: string | null
  album?: string | null
  bpm?: number | null
  musicKey?: string | null
}

export interface TrackEditSaveRequest {
  trackId: string
  meta: TrackMetaPatch
  cover: TrackCoverAction
}

/** 미리보기 IPC. 실패 사유가 필요하면 이쪽을 쓴다. 기존 previewCover는 null만 반환 */
export type CoverPreviewResult = { ok: true; dataUrl: string } | { ok: false; message: string }

export const TRACK_EDIT_NOT_FOUND_PREFIX = 'track not found:'

export function isTrackNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(TRACK_EDIT_NOT_FOUND_PREFIX)
}

export function parseUserBpm(bpm: number | null): number | null {
  if (bpm === null) return null
  if (!Number.isFinite(bpm) || bpm < BPM_MIN || bpm > BPM_MAX) {
    throw new Error(`bpm must be between ${BPM_MIN} and ${BPM_MAX}`)
  }
  return bpm
}

export function parseUserMusicKey(key: string | null): string | null {
  const trimmed = key?.trim() ?? ''
  if (trimmed === '') return null
  if (!MUSIC_KEY_RE.test(trimmed)) {
    throw new Error(`invalid music key: ${trimmed} (expected e.g. C, F#, Am, C#m)`)
  }
  return trimmed
}

export function isTrackMetaPatchEmpty(patch: TrackMetaPatch): boolean {
  return (
    patch.title === undefined &&
    patch.artist === undefined &&
    patch.album === undefined &&
    patch.bpm === undefined &&
    patch.musicKey === undefined
  )
}

export function trackEditChangesSearchKeys(patch: TrackMetaPatch): boolean {
  return patch.title !== undefined || patch.artist !== undefined || patch.album !== undefined
}

export function hasTrackEditCoverChange(cover: TrackCoverAction): boolean {
  return cover.type !== 'keep'
}

export function sanitizeTrackCoverAction(raw: unknown): TrackCoverAction {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid track edit request')
  }
  const rec = raw as Record<string, unknown>
  if (rec.type === 'keep') return { type: 'keep' }
  if (rec.type === 'remove') return { type: 'remove' }
  if (rec.type === 'replace') {
    if (typeof rec.path !== 'string' || rec.path.trim() === '') {
      throw new Error('invalid track edit request')
    }
    return { type: 'replace', path: rec.path.trim() }
  }
  throw new Error('invalid track edit request')
}

export function sanitizeTrackMetaPatch(raw: unknown): TrackMetaPatch {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid track edit request')
  }
  const rec = raw as Record<string, unknown>
  const patch: TrackMetaPatch = {}
  if (hasOwn(rec, 'title')) {
    if (typeof rec.title !== 'string') throw new Error('invalid track edit request')
    const title = rec.title.trim()
    if (title === '') throw new Error('title must not be empty')
    patch.title = title
  }
  if (hasOwn(rec, 'artist')) {
    patch.artist = optionalNullableString(rec.artist)
  }
  if (hasOwn(rec, 'album')) {
    patch.album = optionalNullableString(rec.album)
  }
  if (hasOwn(rec, 'bpm')) {
    if (rec.bpm === null) patch.bpm = null
    else if (typeof rec.bpm === 'number') patch.bpm = parseUserBpm(rec.bpm)
    else throw new Error('invalid track edit request')
  }
  if (hasOwn(rec, 'musicKey')) {
    if (rec.musicKey === null) patch.musicKey = null
    else if (typeof rec.musicKey === 'string') patch.musicKey = parseUserMusicKey(rec.musicKey)
    else throw new Error('invalid track edit request')
  }
  return patch
}

export function sanitizeTrackEditSaveRequest(raw: unknown): TrackEditSaveRequest {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid track edit request')
  }
  const rec = raw as Record<string, unknown>
  if (typeof rec.trackId !== 'string' || rec.trackId.trim() === '') {
    throw new Error('invalid track edit request')
  }
  return {
    trackId: rec.trackId.trim(),
    meta: sanitizeTrackMetaPatch(rec.meta ?? {}),
    cover: sanitizeTrackCoverAction(rec.cover ?? { type: 'keep' })
  }
}

function hasOwn(rec: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(rec, key)
}

function optionalNullableString(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error('invalid track edit request')
  return value.trim() || null
}
