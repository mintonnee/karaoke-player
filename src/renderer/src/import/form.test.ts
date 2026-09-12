import { describe, expect, it } from 'vitest'
import {
  applyAudioTags,
  applyDropToForm,
  applyRejections,
  applySlotDrop,
  assignUnassigned,
  canSubmit,
  canSubmitGeneral,
  canSubmitPair,
  canSubmitUrl,
  classifyDroppedPaths,
  clearSlot,
  emptyImportForm,
  isSupportedAudioPath,
  setSongTitle,
  songMetaFromForm,
  switchImportMethod,
  type ImportFormState
} from './form'

function filledGeneral(): ImportFormState {
  return {
    ...emptyImportForm(),
    method: 'general',
    generalPath: 'C:\\music\\song.mp3',
    errors: { ...emptyImportForm().errors, general: '이전 오류' }
  }
}

function filledPair(): ImportFormState {
  return {
    ...emptyImportForm(),
    method: 'pair',
    mrPath: 'C:\\music\\mr.wav',
    guidePath: 'C:\\music\\guide.wav',
    guideKind: 'vocal_only',
    unassigned: ['C:\\music\\extra.mp3'],
    errors: {
      ...emptyImportForm().errors,
      mr: 'MR 오류',
      guide: '가이드 오류',
      pair: '쌍 오류'
    }
  }
}

function filledUrl(): ImportFormState {
  return {
    ...emptyImportForm(),
    method: 'url',
    url: 'https://youtu.be/dQw4w9WgXcQ',
    errors: { ...emptyImportForm().errors, url: 'URL 오류' }
  }
}

describe('applyAudioTags', () => {
  it('빈 칸을 파일 태그로 채운다', () => {
    const next = applyAudioTags(
      emptyImportForm(),
      { title: '태그 제목', artist: '태그 가수' },
      'general'
    )
    expect(next.title).toBe('태그 제목')
    expect(next.artist).toBe('태그 가수')
    expect(next.titleOrigin).toBe('general')
    expect(next.artistOrigin).toBe('general')
  })

  it('사용자가 적은 값은 덮지 않는다', () => {
    const typed = setSongTitle(emptyImportForm(), '직접 제목')
    const next = applyAudioTags(typed, { title: '태그 제목', artist: '태그 가수' }, 'general')
    expect(next.title).toBe('직접 제목')
    expect(next.artist).toBe('태그 가수')
  })

  it('가이드 태그는 MR 자동값을 덮고, MR은 가이드 값을 덮지 않는다', () => {
    const fromMr = applyAudioTags(emptyImportForm(), { title: 'MR 제목', artist: null }, 'mr')
    const fromGuide = applyAudioTags(
      fromMr,
      { title: '가이드 제목', artist: '가이드 가수' },
      'guide'
    )
    expect(fromGuide.title).toBe('가이드 제목')
    expect(fromGuide.artist).toBe('가이드 가수')
    const mrAgain = applyAudioTags(fromGuide, { title: '다른 MR', artist: '다른 가수' }, 'mr')
    expect(mrAgain.title).toBe('가이드 제목')
    expect(mrAgain.artist).toBe('가이드 가수')
  })

  it('같은 슬롯 파일을 태그 없는 파일로 바꾸면 자동값을 비운다', () => {
    const filled = applyAudioTags(
      emptyImportForm(),
      { title: '태그 제목', artist: '태그 가수' },
      'general'
    )
    const cleared = applyAudioTags(filled, { title: null, artist: null }, 'general')
    expect(cleared.title).toBe('')
    expect(cleared.artist).toBe('')
    expect(cleared.titleOrigin).toBeNull()
  })
})

describe('songMetaFromForm', () => {
  it('둘 다 비면 undefined, 있는 필드만 넘긴다', () => {
    expect(songMetaFromForm({ title: '  ', artist: '', coverPath: null })).toBeUndefined()
    expect(songMetaFromForm({ title: ' 곡 ', artist: ' 가수 ', coverPath: null })).toEqual({
      title: '곡',
      artist: '가수'
    })
    expect(songMetaFromForm({ title: '', artist: '', coverPath: 'C:\\art.png' })).toEqual({
      coverPath: 'C:\\art.png'
    })
  })
})

describe('classifyDroppedPaths', () => {
  it('0개(빈 배열·빈 경로)는 none', () => {
    expect(classifyDroppedPaths([])).toEqual({ kind: 'none' })
    expect(classifyDroppedPaths(['', ''])).toEqual({ kind: 'none' })
  })

  it('이미지 1개는 cover', () => {
    expect(classifyDroppedPaths(['C:\\art.jpg'])).toEqual({
      kind: 'cover',
      path: 'C:\\art.jpg'
    })
    expect(classifyDroppedPaths(['C:\\art.WEBP'])).toEqual({
      kind: 'cover',
      path: 'C:\\art.WEBP'
    })
  })

  it('1개는 general', () => {
    expect(classifyDroppedPaths(['C:\\a.mp3'])).toEqual({
      kind: 'general',
      path: 'C:\\a.mp3'
    })
    expect(classifyDroppedPaths(['', 'C:\\a.mp3'])).toEqual({
      kind: 'general',
      path: 'C:\\a.mp3'
    })
  })

  it('2개는 pair (파일명으로 역할을 추측하지 않는다)', () => {
    expect(classifyDroppedPaths(['vocal.mp3', 'inst.wav'])).toEqual({
      kind: 'pair',
      paths: ['vocal.mp3', 'inst.wav']
    })
  })

  it('3개 이상은 tooMany', () => {
    expect(classifyDroppedPaths(['a.mp3', 'b.wav', 'c.flac'])).toEqual({
      kind: 'tooMany',
      count: 3
    })
    expect(classifyDroppedPaths(['a', 'b', 'c', 'd'])).toEqual({
      kind: 'tooMany',
      count: 4
    })
  })
})

describe('submit-enabled predicates', () => {
  it('일반 음원은 지원 확장자 경로 1개일 때만 제출 가능', () => {
    expect(canSubmitGeneral(null)).toBe(false)
    expect(canSubmitGeneral('')).toBe(false)
    expect(canSubmitGeneral('C:\\song.txt')).toBe(false)
    expect(canSubmitGeneral('C:\\song.mp3')).toBe(true)
    expect(canSubmitGeneral('C:\\song.WAV')).toBe(true)
    expect(canSubmitGeneral('C:\\a.b.flac')).toBe(true)
    expect(canSubmitGeneral('C:\\song.m4a')).toBe(true)
    expect(isSupportedAudioPath('C:\\song.ogg')).toBe(false)
  })

  it('두 파일은 MR·가이드·종류가 모두 있어야 제출 가능', () => {
    expect(canSubmitPair(null, 'g.wav', 'vocal_only')).toBe(false)
    expect(canSubmitPair('m.wav', null, 'vocal_only')).toBe(false)
    expect(canSubmitPair('m.wav', 'g.wav', null)).toBe(false)
    expect(canSubmitPair('', 'g.wav', 'full_mix')).toBe(false)
    expect(canSubmitPair('m.wav', 'g.wav', 'vocal_only')).toBe(true)
    expect(canSubmitPair('m.wav', 'g.wav', 'full_mix')).toBe(false)
    expect(canSubmitPair('m.wav', null, 'none')).toBe(true)
    expect(canSubmitPair('m.wav', 'g.wav', 'none')).toBe(false)
    expect(canSubmitPair('', null, 'none')).toBe(false)
  })

  it('YouTube는 parseYoutubeVideoUrl이 통과한 URL만 제출 가능', () => {
    expect(canSubmitUrl('')).toBe(false)
    expect(canSubmitUrl('https://example.com/watch?v=abc')).toBe(false)
    expect(canSubmitUrl('https://www.youtube.com/playlist?list=PLxxx')).toBe(false)
    expect(canSubmitUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true)
    expect(canSubmitUrl('  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ')).toBe(true)
  })

  it('빈 폼의 기본 방식은 일반 음원이고 파일 없이는 제출할 수 없다', () => {
    expect(emptyImportForm().method).toBe('general')
    expect(canSubmit(emptyImportForm())).toBe(false)
  })

  it('canSubmit은 선택된 방식의 규칙을 따른다', () => {
    expect(canSubmit(emptyImportForm())).toBe(false)
    expect(canSubmit(filledGeneral())).toBe(true)
    expect(canSubmit({ ...filledGeneral(), generalPath: 'a.txt' })).toBe(false)
    expect(canSubmit(filledPair())).toBe(true)
    expect(canSubmit({ ...filledPair(), guideKind: null })).toBe(false)
    expect(canSubmit(filledUrl())).toBe(true)
    expect(canSubmit({ ...filledUrl(), url: 'not-a-url' })).toBe(false)
  })
})

describe('method-switch clearing', () => {
  it('두 파일 방식으로 바꾸면 가이드 종류는 보컬만 있는 파일이 기본이다', () => {
    expect(switchImportMethod(emptyImportForm(), 'pair').guideKind).toBe('vocal_only')
  })

  it('일반 → 두 파일로 바꾸면 일반 경로와 오류를 비운다', () => {
    const next = switchImportMethod(filledGeneral(), 'pair')
    expect(next.method).toBe('pair')
    expect(next.generalPath).toBeNull()
    expect(next.errors.general).toBeNull()
    expect(next.mrPath).toBeNull()
    expect(next.guidePath).toBeNull()
    expect(next.guideKind).toBe('vocal_only')
  })

  it('두 파일 → URL로 바꾸면 슬롯·미지정·종류·오류를 비운다', () => {
    const next = switchImportMethod(filledPair(), 'url')
    expect(next.method).toBe('url')
    expect(next.mrPath).toBeNull()
    expect(next.guidePath).toBeNull()
    expect(next.guideKind).toBeNull()
    expect(next.unassigned).toEqual([])
    expect(next.errors.mr).toBeNull()
    expect(next.errors.guide).toBeNull()
    expect(next.errors.pair).toBeNull()
    expect(next.url).toBe('')
  })

  it('URL → 일반으로 바꾸면 URL 입력과 오류를 비운다', () => {
    const next = switchImportMethod(filledUrl(), 'general')
    expect(next.method).toBe('general')
    expect(next.url).toBe('')
    expect(next.errors.url).toBeNull()
    expect(next.generalPath).toBeNull()
  })

  it('방식 변경과 드롭은 제목·아티스트·커버를 유지한다', () => {
    const withMeta = {
      ...filledGeneral(),
      title: '직접 제목',
      artist: '직접 가수',
      coverPath: 'C:\\art.png'
    }
    const switched = switchImportMethod(withMeta, 'pair')
    expect(switched.title).toBe('직접 제목')
    expect(switched.artist).toBe('직접 가수')
    expect(switched.coverPath).toBe('C:\\art.png')
    expect(switched.generalPath).toBeNull()

    const dropped = applyDropToForm(withMeta, ['a.mp3', 'b.wav'])
    expect(dropped.method).toBe('pair')
    expect(dropped.title).toBe('직접 제목')
    expect(dropped.artist).toBe('직접 가수')
  })

  it('같은 방식이면 입력을 유지한다', () => {
    const general = filledGeneral()
    expect(switchImportMethod(general, 'general')).toBe(general)
    const pair = filledPair()
    expect(switchImportMethod(pair, 'pair')).toBe(pair)
  })

  it('null로 바꾸면 입력을 비우고 방식만 해제한다', () => {
    const next = switchImportMethod(filledPair(), null)
    expect(next.method).toBeNull()
    expect(next.mrPath).toBeNull()
    expect(next.guidePath).toBeNull()
    expect(next.generalPath).toBeNull()
  })
})

describe('applyDropToForm', () => {
  it('1개 드롭은 일반 음원 슬롯을 채운다', () => {
    const next = applyDropToForm(emptyImportForm(), ['C:\\song.mp3'])
    expect(next.method).toBe('general')
    expect(next.generalPath).toBe('C:\\song.mp3')
    expect(next.errors.general).toBeNull()
  })

  it('2개 드롭은 두 파일 방식의 미지정 목록에 넣고 슬롯은 비운다', () => {
    const next = applyDropToForm(filledGeneral(), ['a.mp3', 'b.wav'])
    expect(next.method).toBe('pair')
    expect(next.unassigned).toEqual(['a.mp3', 'b.wav'])
    expect(next.mrPath).toBeNull()
    expect(next.guidePath).toBeNull()
    expect(next.guideKind).toBe('vocal_only')
    expect(next.generalPath).toBeNull()
  })

  it('3개 이상은 개수 오류만 남기고 기존 입력을 유지한다', () => {
    const prev = filledPair()
    const next = applyDropToForm(prev, ['a.mp3', 'b.wav', 'c.flac'])
    expect(next.method).toBe('pair')
    expect(next.mrPath).toBe(prev.mrPath)
    expect(next.guidePath).toBe(prev.guidePath)
    expect(next.unassigned).toEqual(prev.unassigned)
    expect(next.errors.count).toContain('3개')
  })
})

describe('slot drop and unassigned assign', () => {
  it('슬롯 드롭은 파일 1개만 허용한다', () => {
    const tooMany = applySlotDrop(emptyImportForm(), 'mr', ['a.mp3', 'b.wav'])
    expect(tooMany.mrPath).toBeNull()
    expect(tooMany.errors.mr).toContain('1개')

    const one = applySlotDrop(emptyImportForm(), 'guide', ['g.wav'])
    expect(one.method).toBe('pair')
    expect(one.guidePath).toBe('g.wav')
    expect(one.errors.guide).toBeNull()
  })

  it('미지정 목록에서 배정하면 슬롯을 채우고 이전 슬롯 값은 목록으로 되돌린다', () => {
    const start: ImportFormState = {
      ...emptyImportForm(),
      method: 'pair',
      mrPath: 'old-mr.wav',
      unassigned: ['new-mr.mp3', 'guide.wav']
    }
    const assigned = assignUnassigned(start, 'new-mr.mp3', 'mr')
    expect(assigned.mrPath).toBe('new-mr.mp3')
    expect(assigned.unassigned).toEqual(['guide.wav', 'old-mr.wav'])
  })

  it('슬롯을 비우면 두 파일 방식에서는 미지정 목록으로 되돌린다', () => {
    const cleared = clearSlot(filledPair(), 'guide')
    expect(cleared.guidePath).toBeNull()
    expect(cleared.unassigned).toContain('C:\\music\\guide.wav')
  })
})

describe('applyRejections', () => {
  it('role에 따라 해당 슬롯 오류를 채운다', () => {
    const next = applyRejections(filledPair(), [
      { filePath: 'mr.wav', reason: '손상', role: 'mr' },
      { filePath: 'g.wav', reason: '길이', role: 'pair' }
    ])
    expect(next.mrPath).toBe(filledPair().mrPath)
    expect(next.errors.mr).toBe('손상')
    expect(next.errors.pair).toBe('길이')
  })
})
