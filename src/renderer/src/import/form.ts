import type {
  AudioTagPreview,
  GuideKind,
  ImportRejection,
  ImportUserMeta,
  PairImportStage
} from '../../../shared/types'
import { parseYoutubeVideoUrl } from '../../../shared/youtubeUrl'

export type ImportMethod = 'general' | 'pair' | 'url'

/** 곡 정보 칸을 누가 채웠는지. 사용자 입력은 파일 태그가 덮어쓰지 않는다 */
export type SongMetaOrigin = 'user' | 'general' | 'mr' | 'guide'

export interface ImportFormErrors {
  general: string | null
  mr: string | null
  guide: string | null
  pair: string | null
  url: string | null
  count: string | null
}

export interface ImportFormState {
  method: ImportMethod | null
  generalPath: string | null
  mrPath: string | null
  guidePath: string | null
  guideKind: GuideKind | null
  unassigned: string[]
  url: string
  title: string
  artist: string
  titleOrigin: SongMetaOrigin | null
  artistOrigin: SongMetaOrigin | null
  coverPath: string | null
  errors: ImportFormErrors
}

export type DropClassification =
  | { kind: 'none' }
  | { kind: 'general'; path: string }
  | { kind: 'cover'; path: string }
  | { kind: 'pair'; paths: [string, string] }
  | { kind: 'tooMany'; count: number }

export const PAIR_STAGE_LABEL: Record<PairImportStage, string> = {
  queued: '준비 대기',
  probe: '파일 확인',
  prepare: '파일 준비',
  save: '저장'
}

const AUDIO_EXT_RE = /\.(mp3|wav|flac|m4a)$/i
const COVER_EXT_RE = /\.(jpe?g|png|webp)$/i
const SLOT_ONE_FILE = '슬롯에는 파일 1개만 놓을 수 있습니다'
const TOO_MANY = '파일은 한 번에 보컬 포함 음원 1개 또는 MR과 가이드 2개만 놓을 수 있습니다'

export function emptyErrors(): ImportFormErrors {
  return {
    general: null,
    mr: null,
    guide: null,
    pair: null,
    url: null,
    count: null
  }
}

export function emptyImportForm(): ImportFormState {
  return {
    method: 'general',
    generalPath: null,
    mrPath: null,
    guidePath: null,
    guideKind: null,
    unassigned: [],
    url: '',
    title: '',
    artist: '',
    titleOrigin: null,
    artistOrigin: null,
    coverPath: null,
    errors: emptyErrors()
  }
}

/** 비어 있으면 undefined. 메인에서 태그·파일명으로 채운다 */
export function songMetaFromForm(
  state: Pick<ImportFormState, 'title' | 'artist' | 'coverPath'>
): ImportUserMeta | undefined {
  const title = state.title.trim()
  const artist = state.artist.trim()
  const coverPath = state.coverPath?.trim() ?? ''
  if (title === '' && artist === '' && coverPath === '') return undefined
  const meta: ImportUserMeta = {}
  if (title !== '') meta.title = title
  if (artist !== '') meta.artist = artist
  if (coverPath !== '') meta.coverPath = coverPath
  return meta
}

function withSongMeta(from: ImportFormState, next: ImportFormState): ImportFormState {
  return {
    ...next,
    title: from.title,
    artist: from.artist,
    titleOrigin: from.titleOrigin,
    artistOrigin: from.artistOrigin,
    coverPath: from.coverPath
  }
}

const ORIGIN_RANK: Record<SongMetaOrigin, number> = {
  user: 4,
  guide: 3,
  general: 2,
  mr: 1
}

function applyTagField(
  current: string,
  origin: SongMetaOrigin | null,
  tag: string | null,
  source: Exclude<SongMetaOrigin, 'user'>
): { value: string; origin: SongMetaOrigin | null } {
  const trimmed = tag?.trim() ?? ''
  if (origin === 'user') return { value: current, origin }
  if (trimmed !== '') {
    if (origin === null || ORIGIN_RANK[source] >= ORIGIN_RANK[origin]) {
      return { value: trimmed, origin: source }
    }
    return { value: current, origin }
  }
  if (origin === source) return { value: '', origin: null }
  return { value: current, origin }
}

/** 파일 태그로 제목·아티스트를 채운다. 사용자가 적은 값은 유지한다 */
export function applyAudioTags(
  state: ImportFormState,
  tags: AudioTagPreview,
  source: Exclude<SongMetaOrigin, 'user'>
): ImportFormState {
  const title = applyTagField(state.title, state.titleOrigin, tags.title, source)
  const artist = applyTagField(state.artist, state.artistOrigin, tags.artist, source)
  return {
    ...state,
    title: title.value,
    titleOrigin: title.origin,
    artist: artist.value,
    artistOrigin: artist.origin
  }
}

export function setSongTitle(state: ImportFormState, value: string): ImportFormState {
  return { ...state, title: value, titleOrigin: value.trim() === '' ? null : 'user' }
}

export function setSongArtist(state: ImportFormState, value: string): ImportFormState {
  return { ...state, artist: value, artistOrigin: value.trim() === '' ? null : 'user' }
}

function clearMetaFromSource(
  state: ImportFormState,
  source: Exclude<SongMetaOrigin, 'user'>
): ImportFormState {
  return {
    ...state,
    title: state.titleOrigin === source ? '' : state.title,
    titleOrigin: state.titleOrigin === source ? null : state.titleOrigin,
    artist: state.artistOrigin === source ? '' : state.artist,
    artistOrigin: state.artistOrigin === source ? null : state.artistOrigin
  }
}

export function isSupportedAudioPath(filePath: string): boolean {
  return AUDIO_EXT_RE.test(filePath)
}

export function isSupportedCoverPath(filePath: string): boolean {
  return COVER_EXT_RE.test(filePath)
}

export function setCoverPath(state: ImportFormState, path: string | null): ImportFormState {
  return { ...state, coverPath: path }
}

export function fileNameFromPath(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(index + 1) : filePath
}

export function classifyDroppedPaths(paths: string[]): DropClassification {
  const files = paths.filter((path) => path !== '')
  if (files.length === 0) return { kind: 'none' }
  const first = files[0]
  const second = files[1]
  if (files.length === 1 && first !== undefined) {
    if (isSupportedCoverPath(first)) return { kind: 'cover', path: first }
    return { kind: 'general', path: first }
  }
  if (files.length === 2 && first !== undefined && second !== undefined) {
    return { kind: 'pair', paths: [first, second] }
  }
  return { kind: 'tooMany', count: files.length }
}

export function canSubmitGeneral(path: string | null): boolean {
  return path !== null && path !== '' && isSupportedAudioPath(path)
}

export function canSubmitPair(
  mrPath: string | null,
  guidePath: string | null,
  guideKind: GuideKind | null
): boolean {
  return (
    typeof mrPath === 'string' &&
    mrPath !== '' &&
    (guideKind === 'none'
      ? guidePath === null
      : typeof guidePath === 'string' && guidePath !== '' && guideKind === 'vocal_only')
  )
}

export function canSubmitUrl(url: string): boolean {
  return parseYoutubeVideoUrl(url).ok
}

export function canSubmit(state: ImportFormState): boolean {
  if (state.method === 'general') return canSubmitGeneral(state.generalPath)
  if (state.method === 'pair') {
    return canSubmitPair(state.mrPath, state.guidePath, state.guideKind)
  }
  if (state.method === 'url') return canSubmitUrl(state.url)
  return false
}

/** 방식 변경 시 이전 방식의 입력과 오류를 모두 비운다. 같은 방식이면 유지. */
export function switchImportMethod(
  state: ImportFormState,
  next: ImportMethod | null
): ImportFormState {
  if (state.method === next) return state
  return withSongMeta(state, {
    ...emptyImportForm(),
    method: next,
    guideKind: next === 'pair' ? 'vocal_only' : null
  })
}

export function applyDropToForm(state: ImportFormState, paths: string[]): ImportFormState {
  const classified = classifyDroppedPaths(paths)
  if (classified.kind === 'none') return state
  if (classified.kind === 'tooMany') {
    return {
      ...state,
      errors: {
        ...state.errors,
        count: `${TOO_MANY} (${classified.count}개)`
      }
    }
  }
  if (classified.kind === 'cover') {
    return setCoverPath(state, classified.path)
  }
  if (classified.kind === 'general') {
    if (state.method === 'pair' && state.guideKind === 'none') {
      return applySlotDrop(state, 'mr', [classified.path])
    }
    return fillGeneral(withSongMeta(state, emptyImportForm()), classified.path)
  }
  return withSongMeta(state, {
    ...emptyImportForm(),
    method: 'pair',
    guideKind: 'vocal_only',
    unassigned: [...classified.paths]
  })
}

export function applySlotDrop(
  state: ImportFormState,
  slot: 'general' | 'mr' | 'guide',
  paths: string[]
): ImportFormState {
  const files = paths.filter((path) => path !== '')
  if (files.length !== 1) {
    const message = files.length === 0 ? null : SLOT_ONE_FILE
    if (message === null) return state
    if (slot === 'general') {
      return { ...state, errors: { ...state.errors, general: message, count: null } }
    }
    if (slot === 'mr') {
      return { ...state, errors: { ...state.errors, mr: message, count: null } }
    }
    return { ...state, errors: { ...state.errors, guide: message, count: null } }
  }
  const path = files[0]
  if (path === undefined) return state
  if (slot === 'general') return fillGeneral(state, path)
  return assignPath(state, slot, path, { fromUnassigned: false })
}

export function assignUnassigned(
  state: ImportFormState,
  path: string,
  slot: 'mr' | 'guide'
): ImportFormState {
  return assignPath(state, slot, path, { fromUnassigned: true })
}

export function clearSlot(
  state: ImportFormState,
  slot: 'general' | 'mr' | 'guide'
): ImportFormState {
  if (slot === 'general') {
    return clearMetaFromSource(
      { ...state, generalPath: null, errors: { ...state.errors, general: null } },
      'general'
    )
  }
  const prev = slot === 'mr' ? state.mrPath : state.guidePath
  const unassigned = [...state.unassigned]
  if (prev && !unassigned.includes(prev)) unassigned.push(prev)
  if (slot === 'mr') {
    return clearMetaFromSource(
      { ...state, mrPath: null, unassigned, errors: { ...state.errors, mr: null } },
      'mr'
    )
  }
  return clearMetaFromSource(
    { ...state, guidePath: null, unassigned, errors: { ...state.errors, guide: null } },
    'guide'
  )
}

export function applyRejections(
  state: ImportFormState,
  rejected: ImportRejection[]
): ImportFormState {
  if (rejected.length === 0) return state
  const errors = { ...state.errors }
  if (state.method === 'general') {
    errors.general = rejected[0]?.reason ?? null
    return { ...state, errors }
  }
  if (state.method === 'url') {
    errors.url = rejected[0]?.reason ?? null
    return { ...state, errors }
  }
  for (const item of rejected) {
    if (item.role === 'mr') errors.mr = item.reason
    else if (item.role === 'guide') errors.guide = item.reason
    else errors.pair = item.reason
  }
  return { ...state, errors }
}

function fillGeneral(state: ImportFormState, path: string): ImportFormState {
  const supported = isSupportedAudioPath(path)
  return {
    ...state,
    method: 'general',
    generalPath: path,
    errors: {
      ...emptyErrors(),
      general: supported ? null : '지원 형식이 아닙니다 (MP3/WAV/FLAC/M4A)'
    }
  }
}

function assignPath(
  state: ImportFormState,
  slot: 'mr' | 'guide',
  path: string,
  options: { fromUnassigned: boolean }
): ImportFormState {
  const prev = slot === 'mr' ? state.mrPath : state.guidePath
  const unassigned = state.unassigned.filter((item) => item !== path)
  if (options.fromUnassigned && prev && prev !== path && !unassigned.includes(prev)) {
    unassigned.push(prev)
  }
  const errors = { ...state.errors, count: null, pair: null }
  if (slot === 'mr') {
    return { ...state, method: 'pair', mrPath: path, unassigned, errors: { ...errors, mr: null } }
  }
  return {
    ...state,
    method: 'pair',
    guidePath: path,
    guideKind:
      state.guideKind === 'none' || state.guideKind === null ? 'vocal_only' : state.guideKind,
    unassigned,
    errors: { ...errors, guide: null }
  }
}
