export function abortError(id = 'runtime'): Error {
  return Object.assign(new Error(`operation cancelled (${id})`), {
    name: 'AbortError',
    code: 'ABORT_ERR'
  })
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

export async function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  checkAbort(signal)
  if (!signal) return promise
  let onAbort: () => void = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, cancelled])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

let activeDownloads = 0
const queue: Array<() => void> = []

/** Shared by tools, Python and wheels: count actual HTTP transfers, not callers. */
export async function withDownloadSlot<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  checkAbort(signal)
  if (activeDownloads >= 2) {
    let wake!: () => void
    const turn = new Promise<void>((resolve) => {
      wake = resolve
    })
    queue.push(wake)
    try {
      await waitWithSignal(turn, signal)
    } catch (error) {
      const index = queue.indexOf(wake)
      if (index >= 0) queue.splice(index, 1)
      else releaseSlot()
      throw error
    }
  } else activeDownloads++
  try {
    checkAbort(signal)
    return await fn()
  } finally {
    releaseSlot()
  }
}

function releaseSlot(): void {
  const next = queue.shift()
  if (next) next()
  else activeDownloads--
}
