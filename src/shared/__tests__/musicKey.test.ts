import { describe, expect, it } from 'vitest'
import { formatKey, formatKeyDisplay, lowConfSuffix, parseKey, transposeKey } from '../musicKey'
import { BPM_LOW_CONF } from '../types'

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

describe('parseKey / formatKey', () => {
  it('12음 × 장/단조를 왕복한다', () => {
    for (const [root, name] of KEY_NAMES.entries()) {
      for (const suffix of ['', 'm']) {
        const key = name + suffix
        const parsed = parseKey(key)
        expect(parsed).toEqual({ root, minor: suffix === 'm' })
        expect(formatKey(parsed!)).toBe(key)
      }
    }
  })

  it('형식에 맞지 않는 입력은 null이다', () => {
    expect(parseKey(null)).toBeNull()
    expect(parseKey(undefined)).toBeNull()
    expect(parseKey('')).toBeNull()
    expect(parseKey('H')).toBeNull()
    expect(parseKey('c#')).toBeNull()
    expect(parseKey('Db')).toBeNull()
    expect(parseKey('C#maj')).toBeNull()
    expect(parseKey(' C')).toBeNull()
  })
})

describe('transposeKey', () => {
  it('스펙 §2 기준 5의 예시를 만족한다', () => {
    expect(transposeKey('C#m', 2)).toBe('D#m')
    expect(transposeKey('C#m', -3)).toBe('A#m')
    expect(transposeKey('C#m', 6)).toBe('Gm')
    expect(transposeKey('C#m', 0)).toBe('C#m')
  })

  it('옥타브 경계를 넘어 순환한다', () => {
    expect(transposeKey('B', 1)).toBe('C')
    expect(transposeKey('C', -1)).toBe('B')
    expect(transposeKey('Bm', 1)).toBe('Cm')
    expect(transposeKey('Cm', -1)).toBe('Bm')
  })

  it('±6 경계에서 12음 모두 올바르게 이동한다', () => {
    for (const [root, name] of KEY_NAMES.entries()) {
      expect(transposeKey(name, 6)).toBe(KEY_NAMES[(root + 6) % 12])
      expect(transposeKey(name + 'm', -6)).toBe(KEY_NAMES[(root + 6) % 12] + 'm')
    }
  })

  it('장/단조 구분은 변조에도 유지된다', () => {
    expect(transposeKey('A', 3)).toBe('C')
    expect(transposeKey('Am', 3)).toBe('Cm')
  })

  it('파싱 실패·null 입력은 null이다', () => {
    expect(transposeKey(null, 2)).toBeNull()
    expect(transposeKey(undefined, 2)).toBeNull()
    expect(transposeKey('', 2)).toBeNull()
    expect(transposeKey('H', 2)).toBeNull()
    expect(transposeKey('c#', 2)).toBeNull()
    expect(transposeKey('Db', 2)).toBeNull()
  })
})

describe('lowConfSuffix (BPM 표시용)', () => {
  it('임계값 미만이면 ? 접미', () => {
    expect(lowConfSuffix(0.4, BPM_LOW_CONF)).toBe('?')
    expect(lowConfSuffix(0.6, BPM_LOW_CONF)).toBe('')
  })

  it('임계값과 같은 값은 접미 없음 (미만만 불확실)', () => {
    expect(lowConfSuffix(BPM_LOW_CONF, BPM_LOW_CONF)).toBe('')
  })

  it('사용자 입력 값(conf null)은 접미 없이 표시한다', () => {
    expect(lowConfSuffix(null, BPM_LOW_CONF)).toBe('')
    expect(lowConfSuffix(undefined, BPM_LOW_CONF)).toBe('')
  })
})

describe('formatKeyDisplay', () => {
  it('키에는 신뢰도와 무관하게 ?를 붙이지 않는다 (스펙 002 §1 v2)', () => {
    expect(formatKeyDisplay('C#m')).toBe('C#m')
    expect(formatKeyDisplay('F')).toBe('F')
  })

  it('정규 표기로 정규화한다', () => {
    expect(formatKeyDisplay('B#')).toBe('C')
    expect(formatKeyDisplay('E#m')).toBe('Fm')
  })

  it('값이 없거나 형식이 틀리면 null이다', () => {
    expect(formatKeyDisplay(null)).toBeNull()
    expect(formatKeyDisplay('')).toBeNull()
    expect(formatKeyDisplay('H')).toBeNull()
  })
})
