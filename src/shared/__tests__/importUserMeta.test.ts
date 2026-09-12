import { describe, expect, it } from 'vitest'
import { sanitizeImportUserMeta } from '../types'

describe('sanitizeImportUserMeta', () => {
  it('trim하고 빈 필드는 빼며 잘못된 입력은 undefined', () => {
    expect(sanitizeImportUserMeta({ title: '  제목  ', artist: '  ' })).toEqual({ title: '제목' })
    expect(sanitizeImportUserMeta({ title: '', artist: '가수' })).toEqual({ artist: '가수' })
    expect(sanitizeImportUserMeta({ title: '', artist: '', coverPath: ' C:\\a.jpg ' })).toEqual({
      coverPath: 'C:\\a.jpg'
    })
    expect(sanitizeImportUserMeta({ title: '  ', artist: '' })).toBeUndefined()
    expect(sanitizeImportUserMeta(null)).toBeUndefined()
    expect(sanitizeImportUserMeta('제목')).toBeUndefined()
  })
})
