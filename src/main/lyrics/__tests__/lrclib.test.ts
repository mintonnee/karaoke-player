import { describe, expect, it } from 'vitest'
import { chooseSearchResult } from '../lrclib'
import type { LrclibRecord } from '../lrclib'

function record(overrides: Partial<LrclibRecord>): LrclibRecord {
  return {
    id: 1,
    trackName: 't',
    artistName: 'a',
    albumName: 'al',
    duration: 200,
    instrumental: false,
    plainLyrics: null,
    syncedLyrics: null,
    ...overrides
  }
}

describe('chooseSearchResult', () => {
  it('duration 허용 오차 밖 후보는 제외한다', () => {
    const records = [record({ id: 1, duration: 260, syncedLyrics: 'x' })]
    expect(chooseSearchResult(records, 200)).toBeNull()
  })

  it('duration이 가장 근접한 후보를 고른다', () => {
    const records = [
      record({ id: 1, duration: 204, syncedLyrics: 'far' }),
      record({ id: 2, duration: 201, syncedLyrics: 'near' })
    ]
    expect(chooseSearchResult(records, 200)?.id).toBe(2)
  })

  it('근접도가 같으면 syncedLyrics 있는 쪽을 우선한다', () => {
    const records = [
      record({ id: 1, duration: 200, plainLyrics: 'plain only' }),
      record({ id: 2, duration: 200, syncedLyrics: 'synced' })
    ]
    expect(chooseSearchResult(records, 200)?.id).toBe(2)
  })

  it('가사도 instrumental도 아닌 빈 레코드는 제외한다', () => {
    const records = [record({ id: 1, duration: 200 })]
    expect(chooseSearchResult(records, 200)).toBeNull()
  })

  it('instrumental 레코드는 유효 후보다', () => {
    const records = [record({ id: 1, duration: 200, instrumental: true })]
    expect(chooseSearchResult(records, 200)?.instrumental).toBe(true)
  })
})
