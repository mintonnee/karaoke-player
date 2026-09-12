import { DEFAULT_GUIDE_VOCAL_DB, type GuideKind } from '../../../shared/types'

export const SILENCE_DB = Number.NEGATIVE_INFINITY

/** full_mix에서 실제로 출력하는 소스. vocal_only에서는 쓰이지 않는다. */
export type MixSource = 'mr' | 'ar'

export interface MixGainsInput {
  guideKind: GuideKind | null
  source: MixSource
  instDb: number
  guideDb: number
  instMuted: boolean
  guideMuted: boolean
  masterDb: number
  masterMuted: boolean
}

export interface MixerChannelState {
  instDb: number
  vocalDb: number
  instMuted: boolean
  vocalMuted: boolean
  mixSource: MixSource
}

export interface VocalKeyState {
  guideKind: GuideKind | null
  mixSource: MixSource
  vocalMuted: boolean
}

function withMaster(db: number, muted: boolean, masterDb: number): number {
  return muted ? SILENCE_DB : db + masterDb
}

/**
 * 엔진에 넣을 채널 게인(dB). full_mix는 선택하지 않은 소스를 항상 -inf로 두어 MR+AR을 합산하지 않는다.
 */
export function mixGains(input: MixGainsInput): { inst: number; guide: number } {
  if (input.masterMuted) {
    return { inst: SILENCE_DB, guide: SILENCE_DB }
  }
  if (input.guideKind === 'none') {
    return { inst: withMaster(input.instDb, input.instMuted, input.masterDb), guide: SILENCE_DB }
  }

  if (input.guideKind === 'full_mix') {
    if (input.source === 'ar') {
      return { inst: SILENCE_DB, guide: withMaster(input.guideDb, false, input.masterDb) }
    }
    return { inst: withMaster(input.instDb, false, input.masterDb), guide: SILENCE_DB }
  }

  return {
    inst: withMaster(input.instDb, input.instMuted, input.masterDb),
    guide: withMaster(input.guideDb, input.guideMuted, input.masterDb)
  }
}

/** 곡 로드 시 채널 상태. AR 게인·선택이 vocal_only에 누출되지 않도록 종류마다 다시 만든다. */
export function initialMixerState(
  guideKind: GuideKind,
  vocalDefaultDb: number = DEFAULT_GUIDE_VOCAL_DB
): MixerChannelState {
  if (guideKind === 'full_mix') {
    return {
      instDb: 0,
      vocalDb: 0,
      instMuted: false,
      vocalMuted: false,
      mixSource: 'mr'
    }
  }
  return {
    instDb: 0,
    vocalDb: vocalDefaultDb,
    instMuted: false,
    vocalMuted: false,
    mixSource: 'mr'
  }
}

/**
 * V 키 리듀서.
 * vocal_only·트랙 없음: 보컬 뮤트 토글.
 * full_mix: MR↔AR 배타 전환 (뮤트 해제와 섞지 않음).
 */
export function reduceVocalKey(
  state: VocalKeyState
): Pick<VocalKeyState, 'mixSource' | 'vocalMuted'> {
  if (state.guideKind === 'none')
    return { mixSource: state.mixSource, vocalMuted: state.vocalMuted }
  if (state.guideKind === 'full_mix') {
    return {
      mixSource: state.mixSource === 'mr' ? 'ar' : 'mr',
      vocalMuted: state.vocalMuted
    }
  }
  return { mixSource: state.mixSource, vocalMuted: !state.vocalMuted }
}

/** full_mix에서 비선택 채널 페이더/단축키는 소스를 켜지 않도록 무시한다. */
export function channelDbWritable(
  guideKind: GuideKind | null,
  source: MixSource,
  channel: 'inst' | 'guide'
): boolean {
  if (guideKind === 'none') return channel === 'inst'
  if (guideKind !== 'full_mix') return true
  return channel === 'inst' ? source === 'mr' : source === 'ar'
}

function isSilent(db: number): boolean {
  return db === SILENCE_DB
}

/**
 * 배타 전환 시 게인 적용 순서. 이전 소스를 먼저 무음으로 한 뒤 새 소스를 올린다.
 */
export function exclusiveGainApplyOrder(
  prev: { inst: number; guide: number },
  next: { inst: number; guide: number }
): Array<'inst' | 'guide'> {
  const muteGuide = isSilent(next.guide) && !isSilent(prev.guide)
  const muteInst = isSilent(next.inst) && !isSilent(prev.inst)
  if (muteGuide && !muteInst) return ['guide', 'inst']
  return ['inst', 'guide']
}
