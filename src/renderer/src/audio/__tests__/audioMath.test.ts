import { describe, expect, it } from 'vitest'
import { dbToGain, normalizeLoop, wrapLoopPosition } from '../audioMath'

describe('dbToGain', () => {
  it('0 dB는 1, -20 dB는 0.1', () => {
    expect(dbToGain(0)).toBe(1)
    expect(dbToGain(-20)).toBeCloseTo(0.1, 10)
    expect(dbToGain(-6)).toBeCloseTo(0.5012, 3)
  })

  it('-Infinity는 무음(0)', () => {
    expect(dbToGain(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})

describe('wrapLoopPosition', () => {
  const loop = { start: 10, end: 20 }

  it('루프가 없으면 그대로 반환', () => {
    expect(wrapLoopPosition(35, null)).toBe(35)
  })

  it('loop end 이전에는 그대로 반환', () => {
    expect(wrapLoopPosition(15, loop)).toBe(15)
    expect(wrapLoopPosition(20, loop)).toBe(20)
  })

  it('loop end를 지나면 구간 안으로 되감는다', () => {
    expect(wrapLoopPosition(21, loop)).toBe(11)
    expect(wrapLoopPosition(30, loop)).toBe(10)
    expect(wrapLoopPosition(45, loop)).toBe(15)
  })

  it('길이 0 루프는 되감지 않는다', () => {
    expect(wrapLoopPosition(25, { start: 10, end: 10 })).toBe(25)
  })
})

describe('normalizeLoop', () => {
  it('역방향 드래그를 정방향으로 뒤집는다', () => {
    expect(normalizeLoop(20, 10, 60)).toEqual({ start: 10, end: 20 })
  })

  it('[0, duration]으로 클램프한다', () => {
    expect(normalizeLoop(-5, 70, 60)).toEqual({ start: 0, end: 60 })
  })

  it('최소 길이 미만이면 null', () => {
    expect(normalizeLoop(10, 10.2, 60)).toBeNull()
  })
})
