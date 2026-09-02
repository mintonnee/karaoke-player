/**
 * 조성 표기 파싱·변조 헬퍼 (스펙 002 §4.3).
 * 표기는 샤프 통일 12음 + 단조 'm' 접미(예: 'C#m'). 이명동음(Db 등)은 쓰지 않는다.
 */
import { KEY_LOW_CONF, MUSIC_KEY_RE } from './types'

export interface ParsedKey {
  /** 피치 클래스 0..11 (C = 0) */
  root: number
  minor: boolean
}

/** root 인덱스 → 표기. 배열 순서가 곧 반음 간격이라 변조가 정수 덧셈으로 끝난다 */
const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const NATURAL_ROOT: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/** 음수 semitones에도 0..11로 접는다 */
function wrap(root: number): number {
  return ((root % 12) + 12) % 12
}

export function parseKey(key: string | null | undefined): ParsedKey | null {
  if (!key || !MUSIC_KEY_RE.test(key)) return null
  const minor = key.endsWith('m')
  const base = minor ? key.slice(0, -1) : key
  const natural = NATURAL_ROOT[base[0]]
  if (natural === undefined) return null
  return { root: wrap(natural + (base.endsWith('#') ? 1 : 0)), minor }
}

export function formatKey(key: ParsedKey): string {
  return KEY_NAMES[wrap(key.root)] + (key.minor ? 'm' : '')
}

/** 원키에 반음 수를 더한 키. 파싱 실패·null이면 null */
export function transposeKey(key: string | null | undefined, semitones: number): string | null {
  const parsed = parseKey(key)
  if (!parsed) return null
  return formatKey({ root: wrap(parsed.root + semitones), minor: parsed.minor })
}

/**
 * 신뢰도가 임계값 미만이면 '?' 접미 (스펙 002 §4.3).
 * 키(KEY_LOW_CONF)와 BPM(BPM_LOW_CONF)은 신뢰도 분포가 달라 임계값을 호출자가 넘긴다.
 * conf === null은 사용자가 직접 입력한 값이라 접미를 붙이지 않는다.
 */
export function lowConfSuffix(conf: number | null | undefined, threshold: number): string {
  return conf !== null && conf !== undefined && conf < threshold ? '?' : ''
}

/** 라이브러리·트랜스포트 공통 키 표시 문자열. 값이 없거나 형식이 틀리면 null */
export function formatKeyDisplay(
  key: string | null | undefined,
  conf: number | null | undefined
): string | null {
  const parsed = parseKey(key)
  if (!parsed) return null
  return formatKey(parsed) + lowConfSuffix(conf, KEY_LOW_CONF)
}
