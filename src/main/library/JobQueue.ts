type Job = () => Promise<void>

/**
 * 분리/정렬 작업 직렬화 큐 (§4 JobQueue). 동시 실행 1개.
 * 잡 내부에서 오류를 처리하는 것이 원칙이고, 새어 나온 오류는 onJobError로 보고만 한다.
 */
export class JobQueue {
  private readonly queue: Job[] = []
  private running = false

  constructor(private readonly onJobError: (error: unknown) => void = console.error) {}

  enqueue(job: Job): void {
    this.queue.push(job)
    void this.pump()
  }

  /**
   * 결과를 기다리는 작업. 실패는 호출자에게만 전달하고 onJobError는 부르지 않는다.
   * 대기 시간에는 워커 타임아웃을 걸지 않는다 (스펙 011 §4.2).
   */
  enqueueAndWait<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.enqueue(async () => {
        try {
          resolve(await job())
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  /** 실행 대기 중인 잡 수 (실행 중인 잡 제외) */
  get pending(): number {
    return this.queue.length
  }

  get isRunning(): boolean {
    return this.running
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      let job: Job | undefined
      while ((job = this.queue.shift()) !== undefined) {
        try {
          await job()
        } catch (error) {
          this.onJobError(error)
        }
      }
    } finally {
      this.running = false
    }
  }
}
