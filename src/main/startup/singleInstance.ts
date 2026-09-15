import type { SingleInstanceApp } from './types'

/** 잠금을 얻지 못하면 즉시 종료한다. DB는 열지 않는다. */
export function ensureSingleInstance(
  app: SingleInstanceApp,
  onSecondInstance?: () => void
): boolean {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return false
  }
  if (onSecondInstance) {
    app.on('second-instance', onSecondInstance)
  }
  return true
}

export function quitStartupApp(app: { quit: () => void; exit?: (code?: number) => void }): void {
  app.quit()
  // 창이 없는 실패 경로에서 quit만으로 프로세스가 남을 수 있다
  app.exit?.(0)
}
