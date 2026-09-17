import { describe, expect, it } from 'vitest'
import {
  lyricGestureFromDrag,
  lyricIndexAtY,
  takeLyricDrag,
  type LyricDragSel
} from './lyricsGesture'

const lines = [{ time: 1.2 }, { time: 5 }, { time: 9.5 }, { time: 14 }]

describe('lyricGestureFromDrag', () => {
  it('한 줄이면 그 줄 시작으로 시크한다', () => {
    expect(lyricGestureFromDrag({ start: 2, end: 2 }, lines, 30)).toEqual({
      type: 'seek',
      time: 9.5
    })
  })

  it('여러 줄이면 시작 줄부터 다음 줄 직전까지 루프다', () => {
    expect(lyricGestureFromDrag({ start: 0, end: 2 }, lines, 30)).toEqual({
      type: 'loop',
      range: { start: 1.2, end: 14 }
    })
  })

  it('끝 줄이 마지막이면 루프 끝을 duration으로 잡는다', () => {
    expect(lyricGestureFromDrag({ start: 2, end: 3 }, lines, 30)).toEqual({
      type: 'loop',
      range: { start: 9.5, end: 30 }
    })
  })

  it('역방향 드래그도 같은 구간으로 정규화한다', () => {
    expect(lyricGestureFromDrag({ start: 2, end: 0 }, lines, 30)).toEqual(
      lyricGestureFromDrag({ start: 0, end: 2 }, lines, 30)
    )
  })

  it('가사가 없으면 null', () => {
    expect(lyricGestureFromDrag({ start: 0, end: 0 }, [], 30)).toBeNull()
  })
})

describe('takeLyricDrag', () => {
  it('같은 제스처의 두 번째 pointerup은 무시한다', () => {
    const slot: { current: LyricDragSel | null } = { current: { start: 1, end: 1 } }
    expect(takeLyricDrag(slot, lines, 30)).toEqual({ type: 'seek', time: 5 })
    expect(takeLyricDrag(slot, lines, 30)).toBeNull()
    expect(slot.current).toBeNull()
  })
})

describe('lyricIndexAtY', () => {
  const bands = [
    { top: 10, bottom: 40 },
    { top: 40, bottom: 70 },
    { top: 70, bottom: 100 }
  ]

  it('줄 안이면 그 인덱스를 반환한다', () => {
    expect(lyricIndexAtY(25, bands)).toBe(0)
    expect(lyricIndexAtY(55, bands)).toBe(1)
    expect(lyricIndexAtY(100, bands)).toBe(2)
  })

  it('줄 밖이면 null (클릭 시작은 줄 위에서만)', () => {
    expect(lyricIndexAtY(5, bands)).toBeNull()
    expect(lyricIndexAtY(120, bands)).toBeNull()
  })

  it('clamp면 리스트 밖도 첫/마지막 줄로 붙인다', () => {
    expect(lyricIndexAtY(5, bands, true)).toBe(0)
    expect(lyricIndexAtY(120, bands, true)).toBe(2)
  })

  it('밴드가 없으면 null', () => {
    expect(lyricIndexAtY(25, [])).toBeNull()
  })
})
