import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import type { Track } from '../../shared/types'
import type { SidecarManager } from '../sidecar/SidecarManager'
import type { LibraryStore } from './LibraryStore'

/** 가나 또는 한자가 있으면 발음 키 생성 대상 (sidecar pronounce와 같은 기준) */
const JA_RE = /[ぁ-ゟ゠-ヿ一-鿿々]/

const PRONOUNCE_TIMEOUT_MS = 60_000

interface PronounceLine {
  text: string
  hint: string
}

export interface SearchKeyServiceOptions {
  store: LibraryStore
  sidecar: SidecarManager
  /** pronounce 입출력 임시 파일 디렉토리 */
  workDir: string
  onLog?: (line: string) => void
  /** 검색 키 기록 직전. 테스트에서 최신 메타 저장을 끼워 넣는다 */
  beforeSetSearchKeys?: (track: Track) => Promise<void>
}

/**
 * 일본어 메타(제목/아티스트/앨범)의 한글 발음을 사이드카 pronounce로 미리 생성해
 * tracks.search_keys에 저장한다. 검색(LibraryStore.listTracks)의 자모 매칭 대상이 되어
 * "요루시카"로 ヨルシカ를 찾을 수 있다.
 * 사이드카 호출은 느리므로 임포트/메타 수정/시작 시 백필에서만 실행하고 직렬화한다.
 */
export class SearchKeyService {
  /** 생성 작업 직렬화 체인 (사이드카 프로세스 동시 spawn 방지) */
  private chain: Promise<void> = Promise.resolve()
  private readonly generations = new Map<string, number>()

  constructor(private readonly options: SearchKeyServiceOptions) {}

  /** 트랙 메타의 발음 키를 (재)생성한다. 실패는 로그만 남기고 삼킨다 */
  refresh(track: Track): void {
    const gen = (this.generations.get(track.id) ?? 0) + 1
    this.generations.set(track.id, gen)
    this.chain = this.chain
      .then(() => this.generate(track, gen))
      .catch((error) => this.log(`generate failed for "${track.title}": ${String(error)}`))
  }

  /** 생성 체인이 끝날 때까지 기다린다 (테스트) */
  async idle(): Promise<void> {
    await this.chain
  }

  /** 검색 키가 없는 기존 일본어 트랙을 채운다 (앱 시작 시) */
  backfill(): void {
    for (const track of this.options.store.listTracksWithoutSearchKeys()) {
      if (this.hasJa(track)) this.refresh(track)
    }
  }

  private async generate(track: Track, gen: number): Promise<void> {
    if (this.generations.get(track.id) !== gen) return
    if (!this.hasJa(track)) {
      // 메타가 일본어에서 다른 언어로 수정된 경우 기존 키를 비운다
      await this.commitKeys(track, gen, '')
      return
    }

    await mkdir(this.options.workDir, { recursive: true })
    const input = join(this.options.workDir, `search-keys-${track.id}.txt`)
    const output = join(this.options.workDir, `search-keys-${track.id}.json`)
    await writeFile(input, [track.title, track.artist ?? '', track.album ?? ''].join('\n'), 'utf-8')
    try {
      const result = (await this.options.sidecar.run(
        ['pronounce', '--lyrics', input, '--out', output, '--json'],
        { timeoutMs: PRONOUNCE_TIMEOUT_MS }
      )) as { lines: PronounceLine[] }
      const keys = result.lines
        .map((line) => line.hint)
        .filter((hint) => hint !== '')
        .join('\n')
      await this.commitKeys(track, gen, keys)
      if (this.generations.get(track.id) === gen) {
        this.log(`generated for "${track.title}": ${keys.replaceAll('\n', ' / ')}`)
      }
    } finally {
      void rm(input, { force: true })
      void rm(output, { force: true })
    }
  }

  private async commitKeys(track: Track, gen: number, keys: string): Promise<void> {
    await this.options.beforeSetSearchKeys?.(track)
    if (this.generations.get(track.id) !== gen) return
    if (!this.options.store.getTrack(track.id)) return
    this.options.store.setSearchKeys(track.id, keys)
  }

  private hasJa(track: Track): boolean {
    return JA_RE.test(`${track.title}${track.artist ?? ''}${track.album ?? ''}`)
  }

  private log(line: string): void {
    ;(this.options.onLog ?? console.error)(`[search-keys] ${line}`)
  }
}
