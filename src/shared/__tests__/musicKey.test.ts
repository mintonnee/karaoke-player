import { describe, expect, it } from 'vitest'
import { formatKey, formatKeyDisplay, lowConfSuffix, parseKey, transposeKey } from '../musicKey'
import { BPM_LOW_CONF, KEY_LOW_CONF } from '../types'

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

describe('lowConfSuffix', () => {
  it('임계값 미만이면 ? 접미', () => {
    expect(lowConfSuffix(0.04, KEY_LOW_CONF)).toBe('?')
    expect(lowConfSuffix(0.06, KEY_LOW_CONF)).toBe('')
    expect(lowConfSuffix(0.4, BPM_LOW_CONF)).toBe('?')
    expect(lowConfSuffix(0.6, BPM_LOW_CONF)).toBe('')
  })

  it('임계값과 같은 값은 접미 없음 (미만만 불확실)', () => {
    expect(lowConfSuffix(KEY_LOW_CONF, KEY_LOW_CONF)).toBe('')
    expect(lowConfSuffix(BPM_LOW_CONF, BPM_LOW_CONF)).toBe('')
  })

  it('키와 BPM은 임계값이 달라 같은 신뢰도라도 결과가 갈린다', () => {
    expect(lowConfSuffix(0.25, KEY_LOW_CONF)).toBe('')
    expect(lowConfSuffix(0.25, BPM_LOW_CONF)).toBe('?')
  })

  it('사용자 입력 값(conf null)은 접미 없이 표시한다', () => {
    expect(lowConfSuffix(null, KEY_LOW_CONF)).toBe('')
    expect(lowConfSuffix(undefined, BPM_LOW_CONF)).toBe('')
  })
})

describe('formatKeyDisplay', () => {
  it('키 신뢰도는 KEY_LOW_CONF로 판정한다', () => {
    expect(formatKeyDisplay('C#m', 0.02)).toBe('C#m?')
    expect(formatKeyDisplay('C#m', 0.25)).toBe('C#m')
  })

  it('사용자 입력 값(conf null)은 ? 없이 표시한다', () => {
    expect(formatKeyDisplay('C#m', null)).toBe('C#m')
  })

  it('값이 없거나 형식이 틀리면 null이다', () => {
    expect(formatKeyDisplay(null, 0.9)).toBeNull()
    expect(formatKeyDisplay('', 0.9)).toBeNull()
    expect(formatKeyDisplay('H', 0.9)).toBeNull()
  })
})
