import { describe, expect, it } from 'vitest'
import { formatBpmDisplay } from '../analysisFormat'

describe('formatBpmDisplay', () => {
  it('bpm이 null이면 null이다', () => {
    expect(formatBpmDisplay(null, 0.9)).toBeNull()
    expect(formatBpmDisplay(null, null)).toBeNull()
  })

  it('반올림해 BPM 단위를 붙인다', () => {
    expect(formatBpmDisplay(127.6, 0.9)).toBe('128 BPM')
  })

  it('신뢰도가 임계값 이상이면 접미가 없다', () => {
    expect(formatBpmDisplay(128, 0.9)).toBe('128 BPM')
  })

  it('신뢰도가 임계값 미만이면 ? 접미가 붙는다', () => {
    expect(formatBpmDisplay(128, 0.2)).toBe('128 BPM?')
  })

  it('신뢰도가 null이면 lowConfSuffix 규칙을 따라 접미가 없다 (사용자 입력값)', () => {
    expect(formatBpmDisplay(128, null)).toBe('128 BPM')
  })
})
