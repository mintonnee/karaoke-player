import { describe, expect, it } from 'vitest'
import { BPM_MAX, BPM_MIN } from '../types'
import {
  hasTrackEditCoverChange,
  isTrackMetaPatchEmpty,
  isTrackNotFoundError,
  parseUserBpm,
  parseUserMusicKey,
  sanitizeTrackCoverAction,
  sanitizeTrackEditSaveRequest,
  sanitizeTrackMetaPatch,
  trackEditChangesSearchKeys
} from '../trackEdit'

describe('parseUserBpm / parseUserMusicKey', () => {
  it('null과 빈 키는 값 없음이고 범위·형식을 거부한다', () => {
    expect(parseUserBpm(null)).toBeNull()
    expect(parseUserBpm(30)).toBe(30)
    expect(parseUserBpm(300)).toBe(300)
    expect(() => parseUserBpm(BPM_MIN - 1)).toThrow('bpm must be between')
    expect(() => parseUserBpm(BPM_MAX + 1)).toThrow('bpm must be between')
    expect(parseUserMusicKey(null)).toBeNull()
    expect(parseUserMusicKey('')).toBeNull()
    expect(parseUserMusicKey('  Bm  ')).toBe('Bm')
    expect(() => parseUserMusicKey('H')).toThrow('invalid music key')
    expect(() => parseUserMusicKey('c#')).toThrow('invalid music key')
  })
})

describe('sanitizeTrackMetaPatch', () => {
  it('trim하고 빈 선택 필드는 null, 빈 제목은 거부한다', () => {
    expect(
      sanitizeTrackMetaPatch({
        title: '  제목  ',
        artist: '  ',
        album: '',
        bpm: null,
        musicKey: '  '
      })
    ).toEqual({ title: '제목', artist: null, album: null, bpm: null, musicKey: null })
    expect(() => sanitizeTrackMetaPatch({ title: '   ' })).toThrow('title must not be empty')
    expect(sanitizeTrackMetaPatch({})).toEqual({})
    expect(() => sanitizeTrackMetaPatch(null)).toThrow('invalid track edit request')
    expect(() => sanitizeTrackMetaPatch({ bpm: '120' })).toThrow('invalid track edit request')
    expect(() => sanitizeTrackMetaPatch({ bpm: 29 })).toThrow('bpm must be between')
    expect(() => sanitizeTrackMetaPatch({ musicKey: 'Db' })).toThrow('invalid music key')
  })
})

describe('sanitizeTrackCoverAction / sanitizeTrackEditSaveRequest', () => {
  it('keep/remove/replace와 요청 전체를 검증한다', () => {
    expect(sanitizeTrackCoverAction({ type: 'keep' })).toEqual({ type: 'keep' })
    expect(sanitizeTrackCoverAction({ type: 'remove' })).toEqual({ type: 'remove' })
    expect(sanitizeTrackCoverAction({ type: 'replace', path: ' C:\\a.jpg ' })).toEqual({
      type: 'replace',
      path: 'C:\\a.jpg'
    })
    expect(() => sanitizeTrackCoverAction({ type: 'replace', path: '  ' })).toThrow(
      'invalid track edit request'
    )
    expect(() => sanitizeTrackCoverAction({ type: 'swap' })).toThrow('invalid track edit request')

    expect(
      sanitizeTrackEditSaveRequest({
        trackId: '  id-1  ',
        meta: { title: '곡' },
        cover: { type: 'remove' }
      })
    ).toEqual({
      trackId: 'id-1',
      meta: { title: '곡' },
      cover: { type: 'remove' }
    })
    expect(sanitizeTrackEditSaveRequest({ trackId: 'id-1' })).toEqual({
      trackId: 'id-1',
      meta: {},
      cover: { type: 'keep' }
    })
    expect(() => sanitizeTrackEditSaveRequest({ trackId: '' })).toThrow(
      'invalid track edit request'
    )
  })
})

describe('helpers', () => {
  it('변경 없음·검색 키·커버 변경·없는 곡 오류를 판별한다', () => {
    expect(isTrackMetaPatchEmpty({})).toBe(true)
    expect(isTrackMetaPatchEmpty({ title: 'a' })).toBe(false)
    expect(trackEditChangesSearchKeys({ bpm: 120 })).toBe(false)
    expect(trackEditChangesSearchKeys({ artist: null })).toBe(true)
    expect(hasTrackEditCoverChange({ type: 'keep' })).toBe(false)
    expect(hasTrackEditCoverChange({ type: 'remove' })).toBe(true)
    expect(isTrackNotFoundError(new Error('track not found: abc'))).toBe(true)
    expect(isTrackNotFoundError(new Error('title must not be empty'))).toBe(false)
  })
})
