/**
 * 한글 친화 검색 매칭.
 * 두벌식 입력 중 미완성 글자(받침 미입력, 받침이 다음 초성으로 넘어가기 전)와
 * 초성 검색을 지원한다. 원리: 양쪽을 자모 열로 분해해 부분 문자열 비교.
 */

const CHO = [
  'ㄱ',
  'ㄲ',
  'ㄴ',
  'ㄷ',
  'ㄸ',
  'ㄹ',
  'ㅁ',
  'ㅂ',
  'ㅃ',
  'ㅅ',
  'ㅆ',
  'ㅇ',
  'ㅈ',
  'ㅉ',
  'ㅊ',
  'ㅋ',
  'ㅌ',
  'ㅍ',
  'ㅎ'
]
// 합성 모음은 분해해 두어 입력 중간 상태("호" → "화")도 접두 일치하게 한다
const JUNG = [
  'ㅏ',
  'ㅐ',
  'ㅑ',
  'ㅒ',
  'ㅓ',
  'ㅔ',
  'ㅕ',
  'ㅖ',
  'ㅗ',
  'ㅗㅏ',
  'ㅗㅐ',
  'ㅗㅣ',
  'ㅛ',
  'ㅜ',
  'ㅜㅓ',
  'ㅜㅔ',
  'ㅜㅣ',
  'ㅠ',
  'ㅡ',
  'ㅡㅣ',
  'ㅣ'
]
const JONG = [
  '',
  'ㄱ',
  'ㄲ',
  'ㄱㅅ',
  'ㄴ',
  'ㄴㅈ',
  'ㄴㅎ',
  'ㄷ',
  'ㄹ',
  'ㄹㄱ',
  'ㄹㅁ',
  'ㄹㅂ',
  'ㄹㅅ',
  'ㄹㅌ',
  'ㄹㅍ',
  'ㄹㅎ',
  'ㅁ',
  'ㅂ',
  'ㅂㅅ',
  'ㅅ',
  'ㅆ',
  'ㅇ',
  'ㅈ',
  'ㅊ',
  'ㅋ',
  'ㅌ',
  'ㅍ',
  'ㅎ'
]

// 질의에 호환 자모로 직접 입력된 합성 모음/겹받침도 같은 규칙으로 분해
const COMPOUND_JAMO: Record<string, string> = {
  ㅘ: 'ㅗㅏ',
  ㅙ: 'ㅗㅐ',
  ㅚ: 'ㅗㅣ',
  ㅝ: 'ㅜㅓ',
  ㅞ: 'ㅜㅔ',
  ㅟ: 'ㅜㅣ',
  ㅢ: 'ㅡㅣ',
  ㄳ: 'ㄱㅅ',
  ㄵ: 'ㄴㅈ',
  ㄶ: 'ㄴㅎ',
  ㄺ: 'ㄹㄱ',
  ㄻ: 'ㄹㅁ',
  ㄼ: 'ㄹㅂ',
  ㄽ: 'ㄹㅅ',
  ㄾ: 'ㄹㅌ',
  ㄿ: 'ㄹㅍ',
  ㅀ: 'ㄹㅎ',
  ㅄ: 'ㅂㅅ'
}

const CONSONANT_ONLY_RE = /^[ㄱ-ㅎ]+$/

function isSyllable(code: number): boolean {
  return code >= 0xac00 && code <= 0xd7a3
}

/** 문자열을 자모 열로 분해한다. 한글 외 문자는 소문자로 그대로 둔다 */
export function toJamo(text: string): string {
  let out = ''
  for (const ch of text.toLowerCase()) {
    const code = ch.charCodeAt(0)
    if (isSyllable(code)) {
      const idx = code - 0xac00
      out += CHO[Math.floor(idx / 588)] + JUNG[Math.floor(idx / 28) % 21] + JONG[idx % 28]
    } else {
      out += COMPOUND_JAMO[ch] ?? ch
    }
  }
  return out
}

/** 각 한글 음절의 초성만 뽑는다 (그 외 문자는 그대로) */
function toChoseong(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    out += isSyllable(code) ? CHO[Math.floor((code - 0xac00) / 588)] : ch
  }
  return out
}

/**
 * 한글 친화 부분 일치.
 * - 자모 분해 비교: "폭마"(폭망 입력 중), "호"(화 입력 중)도 일치
 * - 질의가 자음뿐이면 초성 검색: "ㅍㅁ" → "폭망"
 * - 한글 외 문자는 대소문자 무시 부분 일치
 */
export function hangulIncludes(target: string, query: string): boolean {
  if (query === '') return true
  if (toJamo(target).includes(toJamo(query))) return true
  return CONSONANT_ONLY_RE.test(query) && toChoseong(target).includes(query)
}
