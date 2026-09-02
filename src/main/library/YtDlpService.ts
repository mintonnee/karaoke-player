import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { copyFile, mkdir, readdir, rm } from 'fs/promises'
import { basename, extname, join } from 'path'
import { IPC_CHANNELS } from '../../shared/types'
import type {
  ImportFilesResponse,
  ImportRejection,
  Track,
  UrlImportProgressEvent
} from '../../shared/types'

/** yt-dlp 출력 템플릿 (스펙 001 §4.3) */
const OUTPUT_TEMPLATE = '%(title)s [%(id)s].%(ext)s'

/** `-f bestaudio[ext=m4a]` 고정이지만 폴백 탐색은 조금 넓게 본다 */
const AUDIO_EXTS = new Set(['.m4a', '.mp4', '.aac', '.mp3', '.opus', '.webm'])

const THUMBNAIL_EXTS = new Set(['.webp', '.jpg', '.jpeg', '.png'])

/** stderr 보관 상한 (실패 사유 추출용) */
const STDERR_KEEP = 40

export interface YtDlpServiceOptions {
  /** yt-dlp 실행 파일 경로. 테스트에서는 process.execPath */
  command: string
  /** command 뒤에 먼저 붙는 고정 인자. 테스트에서 fake 스크립트 경로 주입용 */
  baseArgs?: string[]
  /** `--js-runtimes deno:<denoPath>` 에 쓰는 동봉 deno.exe 경로 */
  denoPath: string
  /** 요청별 스크래치 디렉토리의 부모 (<userData>/tmp/url-import) */
  scratchRoot: string
  /** <userData>/tracks */
  tracksDir: string
  /** 기존 임포트 파이프라인 (ImportService.importFiles) */
  importFiles: (filePaths: string[]) => Promise<ImportFilesResponse>
  /** 렌더러 브로드캐스트 */
  notify: (channel: string, payload: unknown) => void
  /**
   * 커버 복사 후 트랙의 updatedAt을 갱신한다. CoverArt의 media:// URL이
   * updatedAt을 캐시 키로 쓰므로, 값이 바뀌어야 404였던 <img>가 다시 로드된다.
   */
  touchTrack?: (track: Track) => Track
  onLog?: (line: string) => void
}

/** URL 임포트 활성화 판정 (스펙 001 §4.3 / 기준 6). zip판에만 두 바이너리가 동봉된다 */
export function hasUrlImportBinaries(ytDlpPath: string, denoPath: string): boolean {
  return existsSync(ytDlpPath) && existsSync(denoPath)
}

/** `[download]  45.3% of ...` 줄에서 퍼센트를 뽑는다. 진행 줄이 아니면 null */
export function parseDownloadProgress(line: string): number | null {
  const match = /^\[download\]\s+(\d{1,3}(?:\.\d+)?)%/.exec(line.trim())
  if (!match) return null
  const pct = Number(match[1])
  if (!Number.isFinite(pct)) return null
  return Math.max(0, Math.min(100, pct))
}

/** 스펙 §4.3의 다운로드 커맨드. 테스트/보고에서 인자를 그대로 검증할 수 있게 순수 함수로 둔다 */
export function buildYtDlpArgs(params: {
  denoPath: string
  outputTemplate: string
  url: string
}): string[] {
  return [
    '-f',
    'bestaudio[ext=m4a]',
    '--no-playlist',
    '--write-thumbnail',
    '--no-mtime',
    '--newline',
    '--progress',
    '--print',
    'after_move:filepath',
    '--js-runtimes',
    `deno:${params.denoPath}`,
    '-o',
    params.outputTemplate,
    params.url
  ]
}

interface DownloadOutcome {
  code: number
  /** `--print after_move:filepath` 로 찍힌 줄들 */
  printed: string[]
  stderr: string[]
}

/**
 * YouTube URL → yt-dlp 다운로드 → 기존 importFiles 파이프라인 연결 (스펙 001 §4.3).
 * 요청은 스크래치 디렉토리로 격리하고, 성공·실패 모두 정리한다. 동시 요청은 직렬화한다.
 */
export class YtDlpService {
  private chain: Promise<unknown> = Promise.resolve()
  private readonly running = new Set<ChildProcess>()
  private disposed = false

  constructor(private readonly options: YtDlpServiceOptions) {}

  /** 한 번에 하나씩 처리한다. 실패는 throw하지 않고 rejected로 돌려준다 */
  importUrl(url: string): Promise<ImportFilesResponse> {
    const next = this.chain.then(
      () => this.runOne(url),
      () => this.runOne(url)
    )
    this.chain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  /** 앱 종료 시 진행 중인 yt-dlp 프로세스를 죽인다 */
  dispose(): void {
    this.disposed = true
    for (const child of this.running) child.kill()
    this.running.clear()
  }

  private async runOne(url: string): Promise<ImportFilesResponse> {
    if (this.disposed) return reject(url, '앱이 종료 중입니다')
    if (!/^https?:\/\//i.test(url.trim())) {
      return reject(url, 'http(s) URL만 가져올 수 있습니다')
    }

    const id = randomUUID()
    const scratch = join(this.options.scratchRoot, id)
    try {
      await mkdir(scratch, { recursive: true })
      this.emit({ id, url, pct: 0, msg: '다운로드 준비 중' })

      const outcome = await this.download(id, url, scratch)
      if (outcome.code !== 0) {
        return reject(url, describeFailure(outcome))
      }

      const mediaPath = await findMedia(scratch, outcome.printed)
      if (!mediaPath) {
        return reject(url, describeFailure(outcome, '다운로드된 오디오 파일을 찾지 못했습니다'))
      }

      this.emit({ id, url, pct: 100, msg: '라이브러리에 추가 중' })
      const response = await this.options.importFiles([mediaPath])
      const track = response.imported[0]
      if (track) await this.applyThumbnail(scratch, mediaPath, track)

      // 거부 사유의 filePath는 스크래치 경로 대신 사용자가 입력한 URL로 보여준다
      return {
        imported: response.imported,
        rejected: response.rejected.map((r) => ({ filePath: url, reason: r.reason }))
      }
    } catch (error) {
      return reject(url, error instanceof Error ? error.message : String(error))
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private download(id: string, url: string, scratch: string): Promise<DownloadOutcome> {
    const args = [
      ...(this.options.baseArgs ?? []),
      ...buildYtDlpArgs({
        denoPath: this.options.denoPath,
        outputTemplate: join(scratch, OUTPUT_TEMPLATE),
        url
      })
    ]

    return new Promise<DownloadOutcome>((resolve, rejectPromise) => {
      const child = spawn(this.options.command, args, { windowsHide: true })
      this.running.add(child)
      const printed: string[] = []
      const stderr: string[] = []

      readLines(child.stdout, (line) => {
        const pct = parseDownloadProgress(line)
        if (pct !== null) {
          this.emit({ id, url, pct, msg: line.trim().replace(/^\[download\]\s+/, '') })
          return
        }
        const trimmed = line.trim()
        // `--print` 출력은 접두어가 없다. `[youtube] ...` 같은 상태 줄은 버린다
        if (trimmed && !trimmed.startsWith('[')) printed.push(trimmed)
      })
      readLines(child.stderr, (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        stderr.push(trimmed)
        if (stderr.length > STDERR_KEEP) stderr.shift()
        this.log(trimmed)
      })

      child.on('error', (error) => {
        this.running.delete(child)
        rejectPromise(error)
      })
      child.on('close', (code) => {
        this.running.delete(child)
        resolve({ code: code ?? -1, printed, stderr })
      })
    })
  }

  /** 썸네일을 tracks/<id>/cover.jpg 로 복사하고 렌더러에 재렌더를 알린다 */
  private async applyThumbnail(scratch: string, mediaPath: string, track: Track): Promise<void> {
    try {
      const thumbnail = await findThumbnail(scratch, mediaPath)
      if (!thumbnail) return
      const trackDir = join(this.options.tracksDir, track.id)
      await mkdir(trackDir, { recursive: true })
      // 확장자와 무관하게 파일명 고정 — 렌더러 <img>가 매직 바이트로 판별한다
      await copyFile(thumbnail, join(trackDir, 'cover.jpg'))
      const updated = this.options.touchTrack?.(track) ?? track
      this.options.notify(IPC_CHANNELS.trackUpdated, updated)
    } catch (error) {
      this.log(`thumbnail copy failed for ${track.id}: ${String(error)}`)
    }
  }

  private emit(event: UrlImportProgressEvent): void {
    this.options.notify(IPC_CHANNELS.urlImportProgress, event)
  }

  private log(line: string): void {
    ;(this.options.onLog ?? console.error)(`[url-import] ${line}`)
  }
}

function reject(url: string, reason: string): ImportFilesResponse {
  const rejection: ImportRejection = { filePath: url, reason }
  return { imported: [], rejected: [rejection] }
}

/** yt-dlp stderr의 마지막 의미 있는 줄 (ERROR: 우선) */
function describeFailure(outcome: DownloadOutcome, fallback?: string): string {
  const reversed = [...outcome.stderr].reverse()
  const error = reversed.find((line) => line.startsWith('ERROR:'))
  if (error) return error
  if (fallback) return fallback
  const last = reversed.find((line) => !line.startsWith('WARNING:'))
  return last ?? `yt-dlp exited with code ${outcome.code}`
}

async function findMedia(scratch: string, printed: string[]): Promise<string | null> {
  for (let i = printed.length - 1; i >= 0; i -= 1) {
    if (existsSync(printed[i])) return printed[i]
  }
  const entries = await readdir(scratch)
  const audio = entries.find((name) => AUDIO_EXTS.has(extname(name).toLowerCase()))
  return audio ? join(scratch, audio) : null
}

async function findThumbnail(scratch: string, mediaPath: string): Promise<string | null> {
  const stem = basename(mediaPath, extname(mediaPath))
  const entries = await readdir(scratch)
  const thumbnails = entries.filter((name) => THUMBNAIL_EXTS.has(extname(name).toLowerCase()))
  const exact = thumbnails.find((name) => basename(name, extname(name)) === stem)
  const picked = exact ?? thumbnails[0]
  return picked ? join(scratch, picked) : null
}

/** 스트림을 줄 단위로 넘긴다. yt-dlp는 --newline 이어도 \r을 섞어 쓸 수 있다 */
function readLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return
  let buffer = ''
  stream.setEncoding('utf-8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    const parts = buffer.split(/\r\n|\r|\n/)
    buffer = parts.pop() ?? ''
    for (const part of parts) onLine(part)
  })
  stream.on('end', () => {
    if (buffer) onLine(buffer)
    buffer = ''
  })
}
