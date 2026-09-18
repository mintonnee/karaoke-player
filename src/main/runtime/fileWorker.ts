import { parentPort } from 'node:worker_threads'
import { executeFileJob, type FileJob } from './fileOperations'
import { abortError } from './cancellation'

parentPort!.on(
  'message',
  ({ id, job, cancelled }: { id: number; job: FileJob; cancelled: Int32Array }) => {
    const check = (): void => {
      if (Atomics.load(cancelled, 0)) throw abortError()
    }
    try {
      const result = executeFileJob(job, check)
      check()
      parentPort!.postMessage({ id, result })
    } catch (cause) {
      const error = cause as Error & { code?: string; id?: string; path?: string }
      parentPort!.postMessage({
        id,
        error: {
          message: error.message,
          name: error.name,
          code: error.code,
          id: error.id,
          path: error.path
        }
      })
    }
  }
)
