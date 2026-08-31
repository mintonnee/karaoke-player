import { describe, expect, it } from 'vitest'
import { currentLineIndex, lineProgress, parseLrc } from '../lrc'

describe('parseLrc', () => {
  it('기본 [mm:ss.xx] 줄을 파싱한다', () => {
    const lines = parseLrc('[00:12.50] 첫 줄\n[01:03.25] 둘째 줄')
    expect(lines).toEqual([
      { time: 12.5, text: '첫 줄' },
      { time: 63.25, text: '둘째 줄' }
    ])
  })

  it('한 줄의 여러 타임스탬프를 전개한다 (후렴 반복)', () => {
    const lines = parseLrc('[00:10.00][00:50.00]후렴 가사')
    expect(lines).toEqual([
      { time: 10, text: '후렴 가사' },
      { time: 50, text: '후렴 가사' }
    ])
  })

  it('메타 태그는 무시하고 offset은 적용한다', () => {
    const lines = parseLrc('[ar:Eve]\n[offset:+500]\n[00:10.00] 가사')
    expect(lines).toEqual([{ time: 10.5, text: '가사' }])
  })

  it('빈 텍스트 줄(간주)은 유지한다', () => {
    const lines = parseLrc('[00:10.00] 가사\n[00:20.00]')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toEqual({ time: 20, text: '' })
  })

  it('자릿수 편차([m:ss.xxx], [mm:ss:xx])를 허용하고 시간순 정렬한다', () => {
    const lines = parseLrc('[1:05.123] 뒤\n[0:59:10] 앞')
    expect(lines[0].text).toBe('앞')
    expect(lines[0].time).toBeCloseTo(59.1, 5)
    expect(lines[1].time).toBeCloseTo(65.123, 5)
  })

  it('타임스탬프 없는 줄과 빈 입력을 무시한다', () => {
    expect(parseLrc('그냥 텍스트\n\n')).toEqual([])
  })
})

describe('currentLineIndex', () => {
  const lines = parseLrc('[00:10.00] a\n[00:20.00] b\n[00:30.00] c')

  it('첫 줄 이전이면 -1', () => {
    expect(currentLineIndex(lines, 5)).toBe(-1)
  })

  it('구간에 맞는 인덱스를 반환한다', () => {
    expect(currentLineIndex(lines, 10)).toBe(0)
    expect(currentLineIndex(lines, 19.9)).toBe(0)
    expect(currentLineIndex(lines, 25)).toBe(1)
    expect(currentLineIndex(lines, 99)).toBe(2)
  })
})

describe('lineProgress', () => {
  const lines = parseLrc('[00:10.00] a\n[00:20.00] b')

  it('다음 줄 시각에 비례한 진행률을 반환한다', () => {
    expect(lineProgress(lines, 0, 15, 60)).toBeCloseTo(0.5)
    expect(lineProgress(lines, 0, 10, 60)).toBe(0)
    expect(lineProgress(lines, 0, 25, 60)).toBe(1)
  })

  it('마지막 줄은 곡 길이를 끝으로 삼는다', () => {
    expect(lineProgress(lines, 1, 40, 60)).toBeCloseTo(0.5)
  })

  it('범위 밖 인덱스는 0', () => {
    expect(lineProgress(lines, -1, 15, 60)).toBe(0)
  })
})
