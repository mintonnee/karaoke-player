/**
 * BPM 표시 공용 헬퍼 (스펙 003 §4.3). 원래 `App.tsx`의 지역 함수였던 것을 승격해
 * 라이브러리 행과 트랜스포트 BPM 칩이 같은 함수를 쓰게 한다.
 */
import { lowConfSuffix } from './musicKey'
import { BPM_LOW_CONF } from './types'

/** 메타 줄·트랜스포트 칩 공용 BPM 표기. 신뢰도가 낮으면 '?' 접미 (스펙 002 §4.3) */
export function formatBpmDisplay(bpm: number | null, conf: number | null): string | null {
  if (bpm === null) return null
  return `${Math.round(bpm)} BPM${lowConfSuffix(conf, BPM_LOW_CONF)}`
}
