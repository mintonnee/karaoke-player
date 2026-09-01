import { describe, expect, it } from 'vitest'
import { hangulIncludes, toJamo } from '../hangul'

describe('toJamo', () => {
  it('음절을 초성·중성·종성 자모로 분해한다', () => {
    expect(toJamo('폭망')).toBe('ㅍㅗㄱㅁㅏㅇ')
  })

  it('합성 모음과 겹받침을 분해한다', () => {
    expect(toJamo('화')).toBe('ㅎㅗㅏ')
    expect(toJamo('닭')).toBe('ㄷㅏㄹㄱ')
  })

  it('한글 외 문자는 소문자로 유지한다', () => {
    expect(toJamo('Flamingo 1')).toBe('flamingo 1')
  })
})

describe('hangulIncludes', () => {
  it('완성된 부분 문자열은 그대로 일치한다', () => {
    expect(hangulIncludes('폭망 (I Like You)', '폭망')).toBe(true)
  })

  it('받침 입력 전 미완성 글자도 일치한다', () => {
    expect(hangulIncludes('폭망', '폭마')).toBe(true)
    expect(hangulIncludes('폭망', '포')).toBe(true)
  })

  it('합성 모음 입력 중간 상태도 일치한다', () => {
    expect(hangulIncludes('화양연화', '호')).toBe(true)
  })

  it('겹받침 입력 중간 상태도 일치한다', () => {
    expect(hangulIncludes('닭갈비', '달')).toBe(true)
  })

  it('초성만으로 검색한다', () => {
    expect(hangulIncludes('폭망', 'ㅍㅁ')).toBe(true)
    expect(hangulIncludes('엔플라잉', 'ㅇㅍㄹㅇ')).toBe(true)
    expect(hangulIncludes('폭망', 'ㅁㅍ')).toBe(false)
  })

  it('라틴 문자는 대소문자를 무시한다', () => {
    expect(hangulIncludes('Flamingo', 'flam')).toBe(true)
    expect(hangulIncludes('flamingo', 'FLA')).toBe(true)
  })

  it('한글 외 문자열은 그대로 부분 일치한다', () => {
    expect(hangulIncludes('ヨルシカ - 千鳥', 'ヨル')).toBe(true)
  })

  it('일치하지 않으면 false', () => {
    expect(hangulIncludes('폭망', '망폭')).toBe(false)
    expect(hangulIncludes('폭망', '폭명')).toBe(false)
  })

  it('빈 질의는 항상 일치한다', () => {
    expect(hangulIncludes('아무거나', '')).toBe(true)
  })
})
