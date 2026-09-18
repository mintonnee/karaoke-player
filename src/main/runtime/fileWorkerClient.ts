import { Worker } from 'node:worker_threads'
import workerPath from './fileWorker?modulePath'
import type { FileJob } from './fileOperations'
import { checkAbort } from './cancellation'

interface Pending {
  resolve: (value: string | boolean | void) => void
  reject: (error: Error) => void
  cleanup: () => void
}

let worker: Worker | undefined
let nextId = 0
const pending = new Map<number, Pending>()

function getWorker(): Worker {
  if (worker) return worker
  const current = new Worker(workerPath)
  worker = current
  const fail = (error: Error): void => {
    if (worker !== current) return
    worker = undefined
    for (const item of pending.values()) {
      item.cleanup()
      item.reject(error)
    }
    pending.clear()
  }
  current.on('message', (message) => {
    if (worker !== current) return
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    item.cleanup()
    if (!pending.size) current.unref()
    if (message.error) item.reject(Object.assign(new Error(message.error.message), message.error))
    else item.resolve(message.result)
  })
  current.on('error', fail)
  current.on('exit', (code) => fail(new Error(`runtime file worker exited (${code})`)))
  current.unref()
  return current
}

/** Cancellation waits for the worker's cleanup before releasing the caller's filesystem lock. */
export async function runFileJob(
  job: FileJob,
  signal?: AbortSignal
): Promise<string | boolean | void> {
  checkAbort(signal)
  const current = getWorker()
  const id = ++nextId
  const cancelled = new Int32Array(new SharedArrayBuffer(4))
  const cancel = (): void => {
    Atomics.store(cancelled, 0, 1)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal?.removeEventListener('abort', cancel)
    }
    pending.set(id, { resolve, reject, cleanup })
    current.ref()
    try {
      current.postMessage({ id, job, cancelled })
    } catch (error) {
      pending.delete(id)
      cleanup()
      if (!pending.size) current.unref()
      reject(error)
    }
  })
}

export async function hashFileInWorker(path: string, signal?: AbortSignal): Promise<string> {
  return (await runFileJob({ kind: 'hash', path }, signal)) as string
}
export async function verifyFileInWorker(
  path: string,
  expected: { sha256: string; size: number; id?: string },
  signal?: AbortSignal
): Promise<void> {
  await runFileJob({ kind: 'verify', path, expected }, signal)
}
export async function artifactMatchesInWorker(
  artifact: import('./schema').Artifact,
  destRoot: string,
  signal?: AbortSignal
): Promise<boolean> {
  return (await runFileJob({ kind: 'matches', artifact, destRoot }, signal)) as boolean
}
