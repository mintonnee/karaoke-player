import { describe, expect, it } from 'vitest'
import { dbToGain, normalizeLoop, rmsDb, wrapLoopPosition } from '../audioMath'

/** 진폭 amplitude, 한 주기 length 샘플의 정현파 */
function sine(amplitude: number, length = 256): Float32Array {
  const samples = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * i) / length)
  }
  return samples
}

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

describe('rmsDb', () => {
  it('정현파 RMS는 진폭/√2', () => {
    expect(rmsDb(sine(1))).toBeCloseTo(-3.01, 2)
    expect(Math.abs(rmsDb(sine(1)) - -3.01)).toBeLessThan(0.05)
    expect(Math.abs(rmsDb(sine(0.5)) - -9.03)).toBeLessThan(0.05)
  })

  it('무음과 빈 배열은 floorDb', () => {
    expect(rmsDb(new Float32Array(256))).toBe(-60)
    expect(rmsDb(new Float32Array(0))).toBe(-60)
  })

  it('NaN·비유한값이 섞이면 floorDb', () => {
    const samples = sine(1)
    samples[10] = Number.NaN
    expect(rmsDb(samples)).toBe(-60)
    const infinite = sine(1)
    infinite[20] = Number.POSITIVE_INFINITY
    expect(rmsDb(infinite)).toBe(-60)
  })

  it('0 dBFS 초과는 0으로 클램프', () => {
    const square = new Float32Array(256)
    square.fill(2)
    expect(rmsDb(square)).toBe(0)
  })

  it('floorDb 인자를 적용한다', () => {
    expect(rmsDb(new Float32Array(256), -40)).toBe(-40)
    const quiet = sine(0.0001)
    expect(rmsDb(quiet, -40)).toBe(-40)
    expect(rmsDb(sine(1), -40)).toBeCloseTo(-3.01, 2)
  })
})
