import { describe, expect, it } from 'vitest'
import type { ImportFilesResponse } from '../../../shared/types'
import { IMPORT_IN_PROGRESS_REASON, ImportRequestGate } from '../ImportRequestGate'

function ok(): ImportFilesResponse {
  return { imported: [], rejected: [] }
}

describe('ImportRequestGate', () => {
  it('진행 중인 제출이 있으면 다음 IPC 제출을 거부한다', async () => {
    const gate = new ImportRequestGate()
    let release!: (value: ImportFilesResponse) => void
    const first = gate.run(
      () =>
        new Promise<ImportFilesResponse>((resolve) => {
          release = resolve
        })
    )

    const overlapping = await gate.run(async () => ok())
    expect(overlapping.imported).toEqual([])
    expect(overlapping.rejected).toEqual([
      { filePath: '', reason: IMPORT_IN_PROGRESS_REASON, role: 'pair' }
    ])

    release(ok())
    await first
    const after = await gate.run(async () => ok())
    expect(after.rejected).toEqual([])
  })
})
