import { describe, expect, it } from 'vitest'
import { DEFAULT_GUIDE_VOCAL_DB } from '../../../../shared/types'
import {
  SILENCE_DB,
  channelDbWritable,
  exclusiveGainApplyOrder,
  initialMixerState,
  mixGains,
  reduceVocalKey,
  type MixGainsInput
} from '../mixGains'

const vocalOnly: MixGainsInput = {
  guideKind: 'vocal_only',
  source: 'mr',
  instDb: 0,
  guideDb: DEFAULT_GUIDE_VOCAL_DB,
  instMuted: false,
  guideMuted: false,
  masterDb: 0,
  masterMuted: false
}

const fullMixMr: MixGainsInput = {
  guideKind: 'full_mix',
  source: 'mr',
  instDb: 0,
  guideDb: 0,
  instMuted: false,
  guideMuted: false,
  masterDb: 0,
  masterMuted: false
}

it('none keeps guide silent and ignores guide volume and V actions', () => {
  expect(mixGains({ ...vocalOnly, guideKind: 'none', guideDb: 0, source: 'ar' })).toEqual({
    inst: 0,
    guide: SILENCE_DB
  })
  expect(channelDbWritable('none', 'mr', 'guide')).toBe(false)
  expect(channelDbWritable('none', 'mr', 'inst')).toBe(true)
  expect(reduceVocalKey({ guideKind: 'none', mixSource: 'mr', vocalMuted: false })).toEqual({
    mixSource: 'mr',
    vocalMuted: false
  })
})

describe('mixGains vocal_only', () => {
  it('반주 0 dB와 기본 보컬 -20 dB를 함께 섞는다', () => {
    expect(mixGains(vocalOnly)).toEqual({ inst: 0, guide: DEFAULT_GUIDE_VOCAL_DB })
  })

  it('채널 뮤트와 마스터를 반영한다', () => {
    expect(mixGains({ ...vocalOnly, instMuted: true })).toEqual({
      inst: SILENCE_DB,
      guide: DEFAULT_GUIDE_VOCAL_DB
    })
    expect(mixGains({ ...vocalOnly, guideMuted: true })).toEqual({
      inst: 0,
      guide: SILENCE_DB
    })
    expect(mixGains({ ...vocalOnly, masterDb: -6 })).toEqual({
      inst: -6,
      guide: DEFAULT_GUIDE_VOCAL_DB - 6
    })
    expect(mixGains({ ...vocalOnly, masterMuted: true, masterDb: -6 })).toEqual({
      inst: SILENCE_DB,
      guide: SILENCE_DB
    })
  })
})

describe('mixGains full_mix', () => {
  it('MR 선택 시 guide는 guideDb와 무관하게 -inf', () => {
    expect(mixGains({ ...fullMixMr, guideDb: 0 })).toEqual({ inst: 0, guide: SILENCE_DB })
    expect(mixGains({ ...fullMixMr, guideDb: -12, guideMuted: false })).toEqual({
      inst: 0,
      guide: SILENCE_DB
    })
  })

  it('AR 선택 시 inst는 instDb와 무관하게 -inf', () => {
    expect(mixGains({ ...fullMixMr, source: 'ar', instDb: 0 })).toEqual({
      inst: SILENCE_DB,
      guide: 0
    })
    expect(mixGains({ ...fullMixMr, source: 'ar', instDb: -8, guideDb: -3 })).toEqual({
      inst: SILENCE_DB,
      guide: -3
    })
  })

  it('마스터 뮤트는 선택 소스도 무음으로 두고, 채널 뮤트는 무시한다', () => {
    expect(mixGains({ ...fullMixMr, instMuted: true, guideMuted: true })).toEqual({
      inst: 0,
      guide: SILENCE_DB
    })
    expect(mixGains({ ...fullMixMr, source: 'ar', masterMuted: true, guideDb: 0 })).toEqual({
      inst: SILENCE_DB,
      guide: SILENCE_DB
    })
    expect(mixGains({ ...fullMixMr, source: 'ar', masterDb: -10 })).toEqual({
      inst: SILENCE_DB,
      guide: -10
    })
  })
})

describe('initialMixerState', () => {
  it('vocal_only는 기본 보컬 게인과 믹스 모드', () => {
    expect(initialMixerState('vocal_only')).toEqual({
      instDb: 0,
      vocalDb: DEFAULT_GUIDE_VOCAL_DB,
      instMuted: false,
      vocalMuted: false,
      mixSource: 'mr'
    })
    expect(initialMixerState('vocal_only', -18).vocalDb).toBe(-18)
  })

  it('full_mix는 AR 0 dB·MR 선택이며 vocal_only -20과 분리된다', () => {
    expect(initialMixerState('full_mix')).toEqual({
      instDb: 0,
      vocalDb: 0,
      instMuted: false,
      vocalMuted: false,
      mixSource: 'mr'
    })
  })

  it('종류를 바꿔 다시 만들면 이전 게인·선택이 남지 않는다', () => {
    const ar = initialMixerState('full_mix')
    const afterArAdjust = { ...ar, vocalDb: -5, mixSource: 'ar' as const }
    expect(initialMixerState('vocal_only')).toEqual({
      instDb: 0,
      vocalDb: DEFAULT_GUIDE_VOCAL_DB,
      instMuted: false,
      vocalMuted: false,
      mixSource: 'mr'
    })
    expect(afterArAdjust.vocalDb).not.toBe(initialMixerState('vocal_only').vocalDb)
    expect(initialMixerState('full_mix').mixSource).toBe('mr')
    expect(initialMixerState('full_mix').vocalDb).toBe(0)
  })
})

describe('reduceVocalKey', () => {
  it('vocal_only·트랙 없음은 보컬 뮤트만 토글한다', () => {
    expect(reduceVocalKey({ guideKind: 'vocal_only', mixSource: 'mr', vocalMuted: false })).toEqual(
      { mixSource: 'mr', vocalMuted: true }
    )
    expect(reduceVocalKey({ guideKind: null, mixSource: 'mr', vocalMuted: true })).toEqual({
      mixSource: 'mr',
      vocalMuted: false
    })
  })

  it('full_mix는 소스를 배타 전환하고 뮤트를 풀지 않는다', () => {
    const toAr = reduceVocalKey({ guideKind: 'full_mix', mixSource: 'mr', vocalMuted: false })
    expect(toAr).toEqual({ mixSource: 'ar', vocalMuted: false })
    expect(
      mixGains({
        ...fullMixMr,
        source: toAr.mixSource,
        guideMuted: toAr.vocalMuted
      })
    ).toEqual({ inst: SILENCE_DB, guide: 0 })

    const toMr = reduceVocalKey({ guideKind: 'full_mix', mixSource: 'ar', vocalMuted: true })
    expect(toMr).toEqual({ mixSource: 'mr', vocalMuted: true })
    expect(
      mixGains({
        ...fullMixMr,
        source: toMr.mixSource,
        guideMuted: toMr.vocalMuted
      })
    ).toEqual({ inst: 0, guide: SILENCE_DB })
  })
})

describe('channelDbWritable', () => {
  it('full_mix 비선택 채널은 쓰지 않는다', () => {
    expect(channelDbWritable('full_mix', 'mr', 'inst')).toBe(true)
    expect(channelDbWritable('full_mix', 'mr', 'guide')).toBe(false)
    expect(channelDbWritable('full_mix', 'ar', 'inst')).toBe(false)
    expect(channelDbWritable('full_mix', 'ar', 'guide')).toBe(true)
    expect(channelDbWritable('vocal_only', 'mr', 'guide')).toBe(true)
  })
})

describe('exclusiveGainApplyOrder', () => {
  it('MR→AR은 inst를 먼저 무음으로, AR→MR은 guide를 먼저 무음으로', () => {
    expect(
      exclusiveGainApplyOrder({ inst: 0, guide: SILENCE_DB }, { inst: SILENCE_DB, guide: 0 })
    ).toEqual(['inst', 'guide'])
    expect(
      exclusiveGainApplyOrder({ inst: SILENCE_DB, guide: 0 }, { inst: 0, guide: SILENCE_DB })
    ).toEqual(['guide', 'inst'])
  })
})
