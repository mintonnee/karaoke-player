import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import { extname, join } from 'path'
import type { Track } from '../../shared/types'
import type { SidecarManager } from '../sidecar/SidecarManager'
import type { LibraryStore } from './LibraryStore'

const COVER_TIMEOUT_MS = 30_000

export interface CoverServiceOptions {
  store: LibraryStore
  sidecar: SidecarManager
  tracksDir: string
  onLog?: (line: string) => void
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

  constructor(private readonly options: CoverServiceOptions) {}

  /** 트랙 커버를 추출한다. 실패는 로그만 남기고 삼킨다 */
  refresh(track: Track): void {
    this.chain = this.chain
      .then(() => this.extract(track))
      .catch((error) => this.log(`extract failed for "${track.title}": ${String(error)}`))
  }

  /** 커버도 마커도 없는 기존 트랙을 채운다 (앱 시작 시) */
  backfill(): void {
    for (const track of this.options.store.listTracks()) {
      const dir = join(this.options.tracksDir, track.id)
      if (existsSync(join(dir, 'cover.jpg')) || existsSync(join(dir, 'cover.none'))) continue
      this.refresh(track)
    }
  }

  private async extract(track: Track): Promise<void> {
    const dir = join(this.options.tracksDir, track.id)
    const source = join(dir, `source${extname(track.sourcePath)}`)
    if (!existsSync(source)) return

    const result = (await this.options.sidecar.run(
      ['cover', '--input', source, '--out', join(dir, 'cover.jpg'), '--json'],
      { timeoutMs: COVER_TIMEOUT_MS }
    )) as { cover: string | null }
    if (result.cover === null) {
      await writeFile(join(dir, 'cover.none'), '', 'utf-8')
    }
  }

  private log(line: string): void {
    ;(this.options.onLog ?? console.error)(`[cover] ${line}`)
  }
}
