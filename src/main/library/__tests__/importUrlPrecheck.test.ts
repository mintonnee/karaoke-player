import { describe, expect, it } from 'vitest'
import { URL_IMPORT_DISABLED_REASON, precheckImportUrl } from '../importUrlPrecheck'

describe('precheckImportUrl', () => {
  it('urlImport=false면 IPC에서 거부한다', () => {
    const result = precheckImportUrl('https://youtu.be/dQw4w9WgXcQ', false)
    expect(result).toEqual({
      action: 'reject',
      response: {
        imported: [],
        rejected: [{ filePath: 'https://youtu.be/dQw4w9WgXcQ', reason: URL_IMPORT_DISABLED_REASON }]
      }
    })
  })

  it('잘못된 URL은 spawn 전에 거부한다', () => {
    const result = precheckImportUrl('https://example.com/watch?v=abc', true)
    expect(result.action).toBe('reject')
    if (result.action === 'reject') {
      expect(result.response.rejected[0].reason).toContain('YouTube')
    }
  })

  it('허용 URL은 정규화한 href로 진행한다', () => {
    const result = precheckImportUrl('  https://youtu.be/dQw4w9WgXcQ  ', true)
    expect(result).toEqual({
      action: 'proceed',
      url: 'https://youtu.be/dQw4w9WgXcQ'
    })
  })
})
