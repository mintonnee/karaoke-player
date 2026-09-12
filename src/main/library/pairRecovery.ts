import { existsSync } from 'fs'
import { readdir, rm } from 'fs/promises'
import { join } from 'path'

/** tracks 아래 두 파일 작업 전용 임시 루트. 사용자 입력 파일은 두지 않는다 */
export const PAIR_TMP_DIRNAME = '.pair-tmp'

/** 미완료 pair 작업을 식별하는 마커. DB 커밋 성공 후 제거한다 */
export const PAIR_JOB_MARKER = 'pair-job.json'

export interface PairJobRecord {
  version: 1
  jobId: string
  trackId: string
  guideKind: 'vocal_only' | 'full_mix' | 'none'
  mrPath: string
  guidePath: string | null
  createdAt: string
}

/**
 * 앱 시작 시 미완료 두 파일 가져오기 산출물을 지운다 (스펙 004 §4.4).
 * DB에 완료 행이 있으면 디렉토리를 보존하고, 마커만 있거나 .pair-tmp 잔여는 삭제한다.
 * 일반 곡·사용자 입력 파일은 건드리지 않는다.
 */
export async function recoverIncompletePairImports(
  tracksDir: string,
  store: { getTrack(id: string): { id: string } | undefined }
): Promise<number> {
  if (!existsSync(tracksDir)) return 0

  let cleaned = 0
  const tmpRoot = join(tracksDir, PAIR_TMP_DIRNAME)
  if (existsSync(tmpRoot)) {
    const jobs = await readdir(tmpRoot, { withFileTypes: true })
    for (const entry of jobs) {
      await rm(join(tmpRoot, entry.name), { recursive: true, force: true })
      cleaned += 1
    }
    await rm(tmpRoot, { recursive: true, force: true })
  }

  const entries = await readdir(tracksDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === PAIR_TMP_DIRNAME) continue
    const dir = join(tracksDir, entry.name)
    if (!existsSync(join(dir, PAIR_JOB_MARKER))) continue
    if (store.getTrack(entry.name)) continue
    await rm(dir, { recursive: true, force: true })
    cleaned += 1
  }
  return cleaned
}
