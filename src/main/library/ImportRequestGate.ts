import type { ImportFilesResponse } from '../../shared/types'

export const IMPORT_IN_PROGRESS_REASON = '다른 가져오기가 진행 중입니다'

/**
 * IPC 가져오기 제출 중복 방지 (스펙 004 §4.2).
 * ImportService.importFiles 안에 두면 YtDlpService가 내부에서 다시 호출해 교착한다.
 * 일반 파일은 등록·분리 큐 접수 후 해제하고, 두 파일은 준비·DB가 끝날 때까지 유지한다.
 */
export class ImportRequestGate {
  private busy = false

  get isBusy(): boolean {
    return this.busy
  }

  async run(work: () => Promise<ImportFilesResponse>): Promise<ImportFilesResponse> {
    if (this.busy) {
      return {
        imported: [],
        rejected: [{ filePath: '', reason: IMPORT_IN_PROGRESS_REASON, role: 'pair' }]
      }
    }
    this.busy = true
    try {
      return await work()
    } finally {
      this.busy = false
    }
  }
}
