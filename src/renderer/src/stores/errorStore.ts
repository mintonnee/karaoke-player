import { create } from 'zustand'
import type { AppErrorReport, AppErrorSource } from '../../../shared/types'

/** 오류 센터가 보관하는 최대 건수. 오래된 것부터 버린다 */
const MAX_ENTRIES = 50

export interface AppErrorEntry extends AppErrorReport {
  id: string
  /** 오류 센터를 한 번이라도 연 뒤의 항목인지 (배지 카운트용) */
  seen: boolean
}

interface ErrorState {
  entries: AppErrorEntry[]
  notificationOpen: boolean
  setNotificationOpen: (open: boolean) => void
  /** 렌더러 쪽 실패를 기록한다. 메인 프로세스 실패는 onAppError 구독으로 들어온다 */
  report: (source: AppErrorSource, message: string, trackId?: string) => void
  markAllSeen: () => void
  remove: (id: string) => void
  clear: () => void
}

let nextId = 0

function push(entries: AppErrorEntry[], report: AppErrorReport, seen: boolean): AppErrorEntry[] {
  nextId += 1
  const entry: AppErrorEntry = { ...report, id: `e${nextId}`, seen }
  return [entry, ...entries].slice(0, MAX_ENTRIES)
}

/**
 * 오류 센터 (사이드 툴바 알림 버튼). 메인/렌더러의 사용자 가시 실패를 한곳에 모아
 * GitHub 이슈 링크로 보낼 수 있게 한다. 세션 단위 — 재시작하면 비워진다.
 */
export const useErrorStore = create<ErrorState>((set) => {
  window.api.onAppError((report) => {
    set((state) => ({ entries: push(state.entries, report, state.notificationOpen) }))
  })

  return {
    entries: [],
    notificationOpen: false,
    setNotificationOpen: (notificationOpen) =>
      set((state) => ({
        notificationOpen,
        entries: notificationOpen
          ? state.entries.map((entry) => (entry.seen ? entry : { ...entry, seen: true }))
          : state.entries
      })),
    report: (source, message, trackId) =>
      set((state) => ({
        entries: push(
          state.entries,
          { source, message, at: new Date().toISOString(), trackId },
          state.notificationOpen
        )
      })),
    markAllSeen: () =>
      set((state) =>
        state.entries.some((e) => !e.seen)
          ? { entries: state.entries.map((e) => (e.seen ? e : { ...e, seen: true })) }
          : state
      ),
    remove: (id) => set((state) => ({ entries: state.entries.filter((e) => e.id !== id) })),
    clear: () => set({ entries: [] })
  }
})

/** 스토어 밖(다른 스토어의 catch)에서 쓰는 단축 함수 */
export function reportError(source: AppErrorSource, message: string, trackId?: string): void {
  useErrorStore.getState().report(source, message, trackId)
}
