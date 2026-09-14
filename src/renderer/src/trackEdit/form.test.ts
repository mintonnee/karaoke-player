import { describe, expect, it } from 'vitest'
import { BPM_MAX, BPM_MIN } from '../../../shared/types'
import type { Track } from '../../../shared/types'
import {
  applySaveError,
  buildMetaPatch,
  buildSaveRequest,
  canRemoveCoverDraft,
  canSaveTrackEdit,
  classifyCoverDrop,
  classifySaveError,
  COVER_DROP_TOO_MANY,
  COVER_DROP_UNSUPPORTED,
  coverSelectLabel,
  fieldsFromSnapshot,
  isCoverDraftChanged,
  keepCoverDraft,
  mergeUpdatedTrack,
  removeCoverDraft,
  replaceCoverDraft,
  snapshotFromTrack,
  toCoverAction,
  validateTrackEditFields,
  type TrackEditFields,
  type TrackEditSnapshot
} from './form'

function snapshot(overrides: Partial<TrackEditSnapshot> = {}): TrackEditSnapshot {
  return {
    title: '제목',
    artist: '가수',
    album: '앨범',
    bpm: 120,
    musicKey: 'Am',
    ...overrides
  }
}

function fieldsFrom(
  snap: TrackEditSnapshot,
  overrides: Partial<TrackEditFields> = {}
): TrackEditFields {
  return { ...fieldsFromSnapshot(snap), ...overrides }
}

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: 't1',
    title: '제목',
    artist: '가수',
    album: '앨범',
    duration: 10,
    sourcePath: 'C:\\a.mp3',
    status: 'ready',
    lyricsSource: 'none',
    bpm: 120,
    musicKey: 'Am',
    bpmConf: 0.9,
    keyConf: 0.8,
    analysisSource: 'auto',
    importKind: 'separated',
    guideKind: 'vocal_only',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('snapshotFromTrack', () => {
  it('트랙의 편집 가능 필드만 복사한다', () => {
    const source = track({ title: 'A', artist: null, album: 'B', bpm: null, musicKey: 'C' })
    expect(snapshotFromTrack(source)).toEqual({
      title: 'A',
      artist: null,
      album: 'B',
      bpm: null,
      musicKey: 'C'
    })
  })
})

describe('buildMetaPatch', () => {
  it('미변경 필드는 생략하고 trim하며 빈 선택 필드는 null이다', () => {
    const snap = snapshot()
    expect(buildMetaPatch(snap, fieldsFrom(snap))).toEqual({})
    expect(
      buildMetaPatch(
        snap,
        fieldsFrom(snap, {
          title: '  새 제목  ',
          artist: '  ',
          album: '  새 앨범 '
        })
      )
    ).toEqual({ title: '새 제목', artist: null, album: '새 앨범' })
  })

  it('BPM·키를 수정하지 않으면 요청에서 생략한다', () => {
    const snap = snapshot({ bpm: 128.4, musicKey: 'C#m' })
    const patched = buildMetaPatch(
      snap,
      fieldsFrom(snap, { title: '다른 제목', bpm: '128.4', musicKey: '  C#m  ' })
    )
    expect(patched).toEqual({ title: '다른 제목' })
    expect(patched.bpm).toBeUndefined()
    expect(patched.musicKey).toBeUndefined()
  })

  it('BPM·키를 지우면 null을 보낸다', () => {
    const snap = snapshot()
    expect(buildMetaPatch(snap, fieldsFrom(snap, { bpm: '  ', musicKey: '' }))).toEqual({
      bpm: null,
      musicKey: null
    })
  })

  it('스냅샷이 비어 있던 선택 필드를 채우면 값이 들어간다', () => {
    const snap = snapshot({ artist: null, album: null, bpm: null, musicKey: null })
    expect(
      buildMetaPatch(
        snap,
        fieldsFrom(snap, { artist: '가수', album: '앨범', bpm: '90', musicKey: 'F#' })
      )
    ).toEqual({ artist: '가수', album: '앨범', bpm: 90, musicKey: 'F#' })
  })
})

describe('validateTrackEditFields', () => {
  it('빈 제목은 title must not be empty', () => {
    const errors = validateTrackEditFields(fieldsFrom(snapshot(), { title: '   ' }))
    expect(errors.title).toBe('title must not be empty')
    expect(errors.bpm).toBeNull()
    expect(errors.musicKey).toBeNull()
  })

  it('잘못된 BPM은 Main과 같은 범위 오류다', () => {
    expect(validateTrackEditFields(fieldsFrom(snapshot(), { bpm: String(BPM_MIN - 1) })).bpm).toBe(
      `bpm must be between ${BPM_MIN} and ${BPM_MAX}`
    )
    expect(validateTrackEditFields(fieldsFrom(snapshot(), { bpm: String(BPM_MAX + 1) })).bpm).toBe(
      `bpm must be between ${BPM_MIN} and ${BPM_MAX}`
    )
    expect(validateTrackEditFields(fieldsFrom(snapshot(), { bpm: 'abc' })).bpm).toBe(
      `bpm must be between ${BPM_MIN} and ${BPM_MAX}`
    )
    expect(validateTrackEditFields(fieldsFrom(snapshot(), { bpm: '' })).bpm).toBeNull()
    expect(validateTrackEditFields(fieldsFrom(snapshot(), { bpm: String(BPM_MIN) })).bpm).toBeNull()
  })

  it('잘못된 키는 Main과 같은 invalid music key 오류다', () => {
    const errors = validateTrackEditFields(fieldsFrom(snapshot(), { musicKey: 'H' }))
    expect(errors.musicKey).toContain('invalid music key')
    expect(validateTrackEditFields(fieldsFrom(snapshot(), { musicKey: 'c#' })).musicKey).toContain(
      'invalid music key'
    )
    expect(validateTrackEditFields(fieldsFrom(snapshot(), { musicKey: '' })).musicKey).toBeNull()
    expect(
      validateTrackEditFields(fieldsFrom(snapshot(), { musicKey: ' C#m ' })).musicKey
    ).toBeNull()
  })
})

describe('cover draft', () => {
  it('keep/replace/remove와 변경 취소를 구분한다', () => {
    const keep = keepCoverDraft()
    const replaced = replaceCoverDraft('C:\\art.png', 'data:image/png;base64,aaa')
    const removed = removeCoverDraft()
    expect(toCoverAction(keep)).toEqual({ type: 'keep' })
    expect(toCoverAction(replaced)).toEqual({ type: 'replace', path: 'C:\\art.png' })
    expect(toCoverAction(removed)).toEqual({ type: 'remove' })
    expect(isCoverDraftChanged(keep)).toBe(false)
    expect(isCoverDraftChanged(replaced)).toBe(true)
    expect(isCoverDraftChanged(removed)).toBe(true)
  })

  it('제거 버튼은 초안에 커버가 있을 때만 활성이다', () => {
    expect(canRemoveCoverDraft(keepCoverDraft(), null)).toBe(false)
    expect(canRemoveCoverDraft(keepCoverDraft(), false)).toBe(false)
    expect(canRemoveCoverDraft(keepCoverDraft(), true)).toBe(true)
    expect(canRemoveCoverDraft(replaceCoverDraft('a.jpg', 'data:'), false)).toBe(true)
    expect(canRemoveCoverDraft(removeCoverDraft(), true)).toBe(false)
  })

  it('선택 버튼 문구는 초안의 커버 유무를 따른다', () => {
    expect(coverSelectLabel(keepCoverDraft(), true)).toBe('이미지 변경')
    expect(coverSelectLabel(keepCoverDraft(), false)).toBe('이미지 선택')
    expect(coverSelectLabel(removeCoverDraft(), true)).toBe('이미지 선택')
    expect(coverSelectLabel(replaceCoverDraft('a.png', 'data:'), false)).toBe('이미지 변경')
  })
})

describe('canSaveTrackEdit', () => {
  it('변경 없으면 저장할 수 없다', () => {
    const snap = snapshot()
    expect(canSaveTrackEdit(snap, fieldsFrom(snap), keepCoverDraft())).toBe(false)
    expect(canSaveTrackEdit(snap, fieldsFrom(snap, { title: ' 제목 ' }), keepCoverDraft())).toBe(
      false
    )
  })

  it('메타 또는 커버가 바뀌면 저장할 수 있다', () => {
    const snap = snapshot()
    expect(canSaveTrackEdit(snap, fieldsFrom(snap, { title: '다른' }), keepCoverDraft())).toBe(true)
    expect(canSaveTrackEdit(snap, fieldsFrom(snap), removeCoverDraft())).toBe(true)
    expect(canSaveTrackEdit(snap, fieldsFrom(snap), replaceCoverDraft('C:\\a.jpg', 'data:'))).toBe(
      true
    )
  })

  it('빈 제목·잘못된 BPM/키면 커버가 바뀌어도 저장할 수 없다', () => {
    const snap = snapshot()
    expect(canSaveTrackEdit(snap, fieldsFrom(snap, { title: '  ' }), removeCoverDraft())).toBe(
      false
    )
    expect(canSaveTrackEdit(snap, fieldsFrom(snap, { bpm: '10' }), removeCoverDraft())).toBe(false)
    expect(canSaveTrackEdit(snap, fieldsFrom(snap, { musicKey: 'Db' }), removeCoverDraft())).toBe(
      false
    )
  })
})

describe('buildSaveRequest', () => {
  it('변경된 필드와 커버 동작만 담는다', () => {
    const snap = snapshot()
    expect(
      buildSaveRequest('id-1', snap, fieldsFrom(snap, { artist: '다른 가수' }), keepCoverDraft())
    ).toEqual({
      trackId: 'id-1',
      meta: { artist: '다른 가수' },
      cover: { type: 'keep' }
    })
  })
})

describe('classifyCoverDrop', () => {
  it('빈 드롭은 empty', () => {
    expect(classifyCoverDrop([])).toEqual({ kind: 'empty' })
    expect(classifyCoverDrop(['', ''])).toEqual({ kind: 'empty' })
  })

  it('지원 이미지 1개는 ok', () => {
    expect(classifyCoverDrop(['C:\\art.jpg'])).toEqual({ kind: 'ok', path: 'C:\\art.jpg' })
    expect(classifyCoverDrop(['C:\\art.JPEG'])).toEqual({ kind: 'ok', path: 'C:\\art.JPEG' })
    expect(classifyCoverDrop(['C:\\art.png'])).toEqual({ kind: 'ok', path: 'C:\\art.png' })
    expect(classifyCoverDrop(['C:\\art.WEBP'])).toEqual({ kind: 'ok', path: 'C:\\art.WEBP' })
  })

  it('여러 파일은 tooMany 오류', () => {
    expect(classifyCoverDrop(['a.jpg', 'b.png'])).toEqual({
      kind: 'error',
      message: COVER_DROP_TOO_MANY
    })
  })

  it('미지원 형식은 오류이고 직전 초안을 바꾸지 않는 분류만 한다', () => {
    expect(classifyCoverDrop(['C:\\song.mp3'])).toEqual({
      kind: 'error',
      message: COVER_DROP_UNSUPPORTED
    })
    expect(classifyCoverDrop(['C:\\art.gif'])).toEqual({
      kind: 'error',
      message: COVER_DROP_UNSUPPORTED
    })
  })
})

describe('classifySaveError', () => {
  it('필드·커버·없는 곡·일반 오류를 나눈다', () => {
    expect(classifySaveError(new Error('title must not be empty'))).toEqual({
      target: 'title',
      message: 'title must not be empty',
      notFound: false
    })
    expect(classifySaveError(new Error('bpm must be between 30 and 300')).target).toBe('bpm')
    expect(
      classifySaveError(new Error('invalid music key: H (expected e.g. C, F#, Am, C#m)')).target
    ).toBe('musicKey')
    expect(classifySaveError(new Error('커버 파일이 너무 큽니다')).target).toBe('cover')
    expect(classifySaveError(new Error('invalid track edit request'))).toEqual({
      target: 'general',
      message: 'invalid track edit request',
      notFound: false
    })
    expect(classifySaveError(new Error('track not found: abc'))).toEqual({
      target: 'general',
      message: 'track not found: abc',
      notFound: true
    })
  })

  it('저장 오류는 해당 필드만 채운다', () => {
    expect(applySaveError(classifySaveError(new Error('커버 이미지를 읽을 수 없습니다')))).toEqual({
      title: null,
      bpm: null,
      musicKey: null,
      cover: '커버 이미지를 읽을 수 없습니다',
      general: null
    })
  })
})

describe('mergeUpdatedTrack', () => {
  it('검색 중에는 목록에 없는 곡을 끼워 넣지 않는다', () => {
    const listed = track({ id: 'keep' })
    const saved = track({ id: 'saved', title: '검색에 안 맞음' })
    expect(mergeUpdatedTrack([listed], saved, '제목')).toEqual([listed])
    expect(mergeUpdatedTrack([listed], { ...listed, artist: '갱신' }, '제목')).toEqual([
      { ...listed, artist: '갱신' }
    ])
    expect(mergeUpdatedTrack([listed], saved, '')).toEqual([saved, listed])
  })
})
