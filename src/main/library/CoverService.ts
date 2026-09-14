import { existsSync } from 'fs'
import { rename, rm, writeFile } from 'fs/promises'
import { extname, join } from 'path'
import { COVER_FILE_NAME, COVER_NONE_MARKER } from '../../shared/trackEdit'
import type { Track } from '../../shared/types'
import type { SidecarManager } from '../sidecar/SidecarManager'
import { COVER_EXTRACT_TMP } from './coverRecovery'
import type { LibraryStore } from './LibraryStore'

const COVER_TIMEOUT_MS = 30_000

export interface CoverServiceOptions {
  store: LibraryStore
  sidecar: SidecarManager
  tracksDir: string
  onLog?: (line: string) => void
  /** 추출 결과를 파일에 반영하기 직전. 테스트에서 사용자 저장을 끼워 넣는다 */
  beforeInstallExtract?: (track: Track) => Promise<void>
}

/**
 * 트랙 원본의 내장 앨범 아트를 사이드카 cover 명령으로 추출해
 * <tracksDir>/<id>/cover.jpg 로 저장한다 (PNG 바이트여도 파일명은 고정 —
 * 렌더러 <img>가 매직 바이트로 판별). 아트가 없으면 cover.none 마커를 남겨
 * 시작 시 백필이 매번 재시도하지 않게 한다.
 */
export class CoverService {
  /** 추출 작업 직렬화 체인 (사이드카 프로세스 동시 spawn 방지) */
  private chain: Promise<void> = Promise.resolve()
  private readonly userGenerations = new Map<string, number>()

  constructor(private readonly options: CoverServiceOptions) {}

  /** 트랙 커버를 추출한다. 실패는 로그만 남기고 삼킨다 */
  refresh(track: Track): void {
    this.chain = this.chain
      .then(() => this.extract(track))
      .catch((error) => this.log(`extract failed for "${track.title}": ${String(error)}`))
  }

  /** 사용자 교체·제거·삭제. 이미 실행 중인 추출이 이 세대 이후 결과를 설치하지 않는다 */
  noteUserCoverChange(trackId: string): void {
    this.userGenerations.set(trackId, (this.userGenerations.get(trackId) ?? 0) + 1)
  }

  /** 추출 체인이 끝날 때까지 기다린다 (테스트) */
  async idle(): Promise<void> {
    await this.chain
  }

  /** 커버도 마커도 없는 기존 트랙을 채운다 (앱 시작 시) */
  backfill(): void {
    for (const track of this.options.store.listTracks()) {
      const dir = join(this.options.tracksDir, track.id)
      if (existsSync(join(dir, COVER_FILE_NAME)) || existsSync(join(dir, COVER_NONE_MARKER))) {
        continue
      }
      this.refresh(track)
    }
  }

  private generation(trackId: string): number {
    return this.userGenerations.get(trackId) ?? 0
  }

  private async extract(track: Track): Promise<void> {
    const dir = join(this.options.tracksDir, track.id)
    const coverPath = join(dir, COVER_FILE_NAME)
    const nonePath = join(dir, COVER_NONE_MARKER)
    if (existsSync(coverPath) || existsSync(nonePath)) return

    const source = join(dir, `source${extname(track.sourcePath)}`)
    if (!existsSync(source)) return

    const gen = this.generation(track.id)
    const tmp = join(dir, COVER_EXTRACT_TMP)
    await rm(tmp, { force: true })
    const result = (await this.options.sidecar.run(
      ['cover', '--input', source, '--out', tmp, '--json'],
      { timeoutMs: COVER_TIMEOUT_MS }
    )) as { cover: string | null }

    await this.options.beforeInstallExtract?.(track)

    if (this.generation(track.id) !== gen || existsSync(coverPath) || existsSync(nonePath)) {
      await rm(tmp, { force: true })
      return
    }
    if (result.cover === null) {
      await rm(tmp, { force: true })
      await writeFile(nonePath, '', 'utf-8')
      return
    }
    if (!existsSync(tmp)) return
    await rename(tmp, coverPath)
  }

  private log(line: string): void {
    ;(this.options.onLog ?? console.error)(`[cover] ${line}`)
  }
}
