import { spawn } from 'child_process'

/** §4.2 사이드카 프로토콜: stdout 한 줄 = JSON 하나 */
export interface SidecarProgressEvent {
  type: 'progress'
  stage: string
  pct: number
  msg?: string
}

interface SidecarDoneEvent {
  type: 'done'
  result: unknown
}

interface SidecarErrorEvent {
  type: 'error'
  code: string
  msg: string
}

type SidecarEvent = SidecarProgressEvent | SidecarDoneEvent | SidecarErrorEvent

export class SidecarError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'SidecarError'
  }
}

export interface SidecarRunOptions {
  onProgress?: (event: SidecarProgressEvent) => void
  /** 초과 시 프로세스를 종료하고 TIMEOUT으로 reject */
  timeoutMs?: number
  /** abort 시 SIGTERM을 보내고 CANCELLED로 reject */
  signal?: AbortSignal
}

export interface SidecarManagerOptions {
  /** 실행 파일. 기본은 uv */
  command: string
  /** 워커 명령 앞에 붙는 인자. 예: ['run', '--project', <sidecarDir>, 'karaoke_worker'] */
  baseArgs: string[]
  /** stderr 로그 sink. 기본은 console.error */
  onLog?: (line: string) => void
}

const STDERR_TAIL_LINES = 20

/**
 * Python 사이드카 프로세스 실행기.
 * spawn → stdout JSONL 파싱 → done.result resolve. 취소/타임아웃 시 SIGTERM.
 */
export class SidecarManager {
  constructor(private readonly options: SidecarManagerOptions) {}

  run(workerArgs: string[], runOptions: SidecarRunOptions = {}): Promise<unknown> {
    const { onProgress, timeoutMs, signal } = runOptions

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new SidecarError('CANCELLED', 'cancelled before start'))
        return
      }

      const child = spawn(this.options.command, [...this.options.baseArgs, ...workerArgs], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })

      let settled = false
      let doneResult: unknown
      let hasDone = false
      let protocolError: SidecarError | null = null
      let stdoutBuffer = ''
      let stderrBuffer = ''
      const stderrTail: string[] = []
      let timer: NodeJS.Timeout | undefined

      const log = this.options.onLog ?? ((line: string) => console.error(`[sidecar] ${line}`))

      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        fn()
      }

      const killAndReject = (error: SidecarError): void => {
        settle(() => {
          child.kill('SIGTERM')
          reject(error)
        })
      }

      const onAbort = (): void => killAndReject(new SidecarError('CANCELLED', 'cancelled'))
      signal?.addEventListener('abort', onAbort, { once: true })

      if (timeoutMs !== undefined) {
        timer = setTimeout(
          () => killAndReject(new SidecarError('TIMEOUT', `timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      }

      const handleLine = (line: string): void => {
        const trimmed = line.trim()
        if (trimmed === '') return
        let event: SidecarEvent
        try {
          event = JSON.parse(trimmed) as SidecarEvent
        } catch {
          log(`malformed stdout line: ${trimmed}`)
          return
        }
        if (event.type === 'progress') {
          onProgress?.(event)
        } else if (event.type === 'done') {
          hasDone = true
          doneResult = event.result
        } else if (event.type === 'error') {
          protocolError = new SidecarError(event.code, event.msg)
        }
      }

      child.stdout.setEncoding('utf-8')
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        lines.forEach(handleLine)
      })

      child.stderr.setEncoding('utf-8')
      child.stderr.on('data', (chunk: string) => {
        stderrBuffer += chunk
        const lines = stderrBuffer.split('\n')
        stderrBuffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim() === '') continue
          log(line)
          stderrTail.push(line)
          if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift()
        }
      })

      child.on('error', (error) => {
        settle(() => reject(new SidecarError('SPAWN_FAILED', error.message)))
      })

      child.on('close', (code) => {
        settle(() => {
          if (stdoutBuffer !== '') handleLine(stdoutBuffer)
          if (protocolError) {
            reject(protocolError)
          } else if (hasDone) {
            resolve(doneResult)
          } else {
            const tail = stderrTail.join('\n')
            reject(
              new SidecarError(
                'NO_RESULT',
                `worker exited with code ${code} without done/error event${tail ? `\n${tail}` : ''}`
              )
            )
          }
        })
      })
    })
  }
}

/** dev 환경: uv 프로젝트(sidecar/)를 통해 karaoke_worker를 실행한다 */
export function createUvSidecarManager(
  sidecarDir: string,
  onLog?: (line: string) => void
): SidecarManager {
  return new SidecarManager({
    command: 'uv',
    baseArgs: ['run', '--project', sidecarDir, 'karaoke_worker'],
    onLog
  })
}
