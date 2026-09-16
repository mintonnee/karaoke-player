import type {
  AudioTagPreview,
  GuideKind,
  ImportRejection,
  ImportUserMeta,
  PairImportStage,
  YoutubePreviewResult
} from '../../../shared/types'
import { parseYoutubeVideoUrl } from '../../../shared/youtubeUrl'
import type { YoutubePreviewSnapshot } from './youtubePreview'

export type ImportMethod = 'general' | 'pair' | 'url'

/** 곡 정보 칸을 누가 채웠는지. 사용자 입력은 자동값이 덮어쓰지 않는다 */
export type SongMetaOrigin = 'user' | 'general' | 'mr' | 'guide' | 'youtube'
export type FileSongMetaOrigin = 'general' | 'mr' | 'guide'

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
  /** youtube 자동 제목을 채운 preview generation. URL 변경 시 제거 */
  titleYoutubeGeneration: number | null
  artistYoutubeGeneration: number | null
  /** 로컬 파일 경로만. data URL·원격 URL 금지 */
  coverPath: string | null
  youtubeThumbnailDataUrl: string | null
  youtubeThumbnailGeneration: number | null
  youtubeThumbnailWarning: string | null
  urlPreviewReady: boolean
  urlPreviewUrl: string | null
  urlPreviewGeneration: number | null
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
    titleYoutubeGeneration: null,
    artistYoutubeGeneration: null,
    coverPath: null,
    youtubeThumbnailDataUrl: null,
    youtubeThumbnailGeneration: null,
    youtubeThumbnailWarning: null,
    urlPreviewReady: false,
    urlPreviewUrl: null,
    urlPreviewGeneration: null,
    errors: emptyErrors()
  }
}

function serializeSongMeta(
  title: string,
  artist: string,
  coverPath: string | null
): ImportUserMeta | undefined {
  const trimmedTitle = title.trim()
  const trimmedArtist = artist.trim()
  const trimmedCover = coverPath?.trim() ?? ''
  if (trimmedTitle === '' && trimmedArtist === '' && trimmedCover === '') return undefined
  const meta: ImportUserMeta = {}
  if (trimmedTitle !== '') meta.title = trimmedTitle
  if (trimmedArtist !== '') meta.artist = trimmedArtist
  if (trimmedCover !== '') meta.coverPath = trimmedCover
  return meta
}

/** 비어 있으면 undefined. URL 방식은 수동값만 보내고 자동 제목·썸네일은 제외한다 */
export function songMetaFromForm(
  state: Pick<ImportFormState, 'title' | 'artist' | 'coverPath'> &
    Partial<Pick<ImportFormState, 'method' | 'titleOrigin' | 'artistOrigin'>>
): ImportUserMeta | undefined {
  if (state.method === 'url') return songMetaFromUrlForm(state)
  return serializeSongMeta(state.title, state.artist, state.coverPath)
}

/** URL 제출: 비어 있지 않은 수동 제목·아티스트와 로컬 coverPath만 */
export function songMetaFromUrlForm(
  state: Pick<ImportFormState, 'title' | 'artist' | 'coverPath'> &
    Partial<Pick<ImportFormState, 'titleOrigin' | 'artistOrigin'>>
): ImportUserMeta | undefined {
  const title = state.titleOrigin === 'user' ? state.title : ''
  const artist = state.artistOrigin === 'user' ? state.artist : ''
  return serializeSongMeta(title, artist, state.coverPath)
}

function withSongMeta(from: ImportFormState, next: ImportFormState): ImportFormState {
  const titleFromYoutube = from.titleOrigin === 'youtube'
  const artistFromYoutube = from.artistOrigin === 'youtube'
  return {
    ...next,
    title: titleFromYoutube ? '' : from.title,
    artist: artistFromYoutube ? '' : from.artist,
    titleOrigin: titleFromYoutube ? null : from.titleOrigin,
    artistOrigin: artistFromYoutube ? null : from.artistOrigin,
    titleYoutubeGeneration: null,
    artistYoutubeGeneration: null,
    coverPath: from.coverPath,
    youtubeThumbnailDataUrl: null,
    youtubeThumbnailGeneration: null,
    youtubeThumbnailWarning: null,
    urlPreviewReady: false,
    urlPreviewUrl: null,
    urlPreviewGeneration: null
  }
}

const ORIGIN_RANK: Record<SongMetaOrigin, number> = {
  user: 5,
  youtube: 4,
  guide: 3,
  general: 2,
  mr: 1
}

function applyTagField(
  current: string,
  origin: SongMetaOrigin | null,
  tag: string | null,
  source: FileSongMetaOrigin
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
  source: FileSongMetaOrigin
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
  return { ...state, title: value, titleOrigin: 'user', titleYoutubeGeneration: null }
}

export function setSongArtist(state: ImportFormState, value: string): ImportFormState {
  return { ...state, artist: value, artistOrigin: 'user', artistYoutubeGeneration: null }
}

export function dropUrlPreviewReady(state: ImportFormState): ImportFormState {
  if (!state.urlPreviewReady && state.urlPreviewUrl == null && state.urlPreviewGeneration == null) {
    return state
  }
  return {
    ...state,
    urlPreviewReady: false,
    urlPreviewUrl: null,
    urlPreviewGeneration: null
  }
}

/** URL이 채운 제목·아티스트·썸네일만 지운다. 수동값·로컬 커버는 유지 */
export function clearYoutubeAutoFill(state: ImportFormState): ImportFormState {
  return {
    ...state,
    title: state.titleOrigin === 'youtube' ? '' : state.title,
    titleOrigin: state.titleOrigin === 'youtube' ? null : state.titleOrigin,
    titleYoutubeGeneration: null,
    artist: state.artistOrigin === 'youtube' ? '' : state.artist,
    artistOrigin: state.artistOrigin === 'youtube' ? null : state.artistOrigin,
    artistYoutubeGeneration: null,
    youtubeThumbnailDataUrl: null,
    youtubeThumbnailGeneration: null,
    youtubeThumbnailWarning: null,
    urlPreviewReady: false,
    urlPreviewUrl: null,
    urlPreviewGeneration: null
  }
}

export function setImportUrl(state: ImportFormState, url: string): ImportFormState {
  const clearedErrors = { ...state, errors: { ...state.errors, url: null } }
  if (state.url === url) return clearedErrors
  return clearYoutubeAutoFill({ ...clearedErrors, url })
}

export function withUrlReady(state: ImportFormState, generation = 1): ImportFormState {
  return {
    ...state,
    method: 'url',
    urlPreviewReady: true,
    urlPreviewUrl: state.url,
    urlPreviewGeneration: generation
  }
}

function applyYoutubeMetaField(
  current: string,
  origin: SongMetaOrigin | null,
  incoming: string | null,
  generation: number
): { value: string; origin: SongMetaOrigin | null; generation: number | null } {
  if (origin === 'user') {
    return { value: current, origin, generation: null }
  }
  const trimmed = incoming?.trim() ?? ''
  if (trimmed === '') {
    return {
      value: current,
      origin,
      generation: origin === 'youtube' ? generation : null
    }
  }
  return { value: trimmed, origin: 'youtube', generation }
}

/** ready·blocked 메타데이터를 비-dirty 칸에만 채운다. coverPath는 건드리지 않는다 */
export function applyYoutubePreviewToForm(
  state: ImportFormState,
  result: YoutubePreviewResult,
  generation: number,
  url: string
): ImportFormState {
  if (state.method !== 'url' || state.url !== url) return state
  if (result.status === 'cancelled') return state

  const ready = result.status === 'ready'
  let next: ImportFormState = {
    ...state,
    urlPreviewReady: ready,
    urlPreviewUrl: ready ? url : null,
    urlPreviewGeneration: ready ? generation : null
  }

  if (result.status === 'error') return next

  const meta = result.metadata
  if (meta == null) {
    if (result.thumbnailWarning) {
      next = { ...next, youtubeThumbnailWarning: result.thumbnailWarning }
    }
    return next
  }

  const title = applyYoutubeMetaField(next.title, next.titleOrigin, meta.title, generation)
  const artist = applyYoutubeMetaField(next.artist, next.artistOrigin, meta.artist, generation)
  next = {
    ...next,
    title: title.value,
    titleOrigin: title.origin,
    titleYoutubeGeneration: title.origin === 'youtube' ? title.generation : null,
    artist: artist.value,
    artistOrigin: artist.origin,
    artistYoutubeGeneration: artist.origin === 'youtube' ? artist.generation : null
  }

  if (meta.thumbnailDataUrl) {
    next = {
      ...next,
      youtubeThumbnailDataUrl: meta.thumbnailDataUrl,
      youtubeThumbnailGeneration: generation,
      youtubeThumbnailWarning: result.thumbnailWarning
    }
  } else if (result.thumbnailWarning) {
    next = { ...next, youtubeThumbnailWarning: result.thumbnailWarning }
  }

  return next
}

export function applyYoutubePreviewSnapshot(
  state: ImportFormState,
  snapshot: YoutubePreviewSnapshot
): ImportFormState {
  if (snapshot.status === 'ready' || snapshot.status === 'blocked') {
    if (snapshot.result == null) return dropUrlPreviewReady(state)
    return applyYoutubePreviewToForm(state, snapshot.result, snapshot.generation, snapshot.url)
  }
  return dropUrlPreviewReady(state)
}

function clearMetaFromSource(state: ImportFormState, source: FileSongMetaOrigin): ImportFormState {
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
  if (state.method === 'url') {
    return (
      canSubmitUrl(state.url) &&
      state.urlPreviewReady &&
      state.urlPreviewUrl === state.url &&
      state.urlPreviewGeneration != null
    )
  }
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
