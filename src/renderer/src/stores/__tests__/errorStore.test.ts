import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppErrorReport } from '../../../../shared/types'

describe('notification error history', () => {
  let store: typeof import('../errorStore')
  let receive: (report: AppErrorReport) => void

  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('window', {
      api: {
        onAppError: vi.fn((callback: typeof receive) => {
          receive = callback
          return () => {}
        })
      }
    })
    store = await import('../errorStore')
  })

  afterEach(() => vi.unstubAllGlobals())

  it('marks existing errors seen on open and both incoming paths seen while open', () => {
    const errors = store.useErrorStore
    store.reportError('player', '재생 실패', 'track-1')
    receive({ source: 'analyze', message: '분석 실패', at: '2026-09-17', trackId: 'track-2' })
    expect(errors.getState().entries.every((entry) => !entry.seen)).toBe(true)
    errors.getState().setNotificationOpen(true)
    store.reportError('runtime', '환경 준비 실패')
    receive({ source: 'lyrics', message: '가사 실패', at: '2026-09-17' })
    expect(errors.getState().entries).toHaveLength(4)
    expect(errors.getState().entries.every((entry) => entry.seen)).toBe(true)
    errors.getState().setNotificationOpen(false)
    store.reportError('player', '다시 재생 실패')
    receive({ source: 'jobs', message: '작업 실패', at: '2026-09-17' })
    expect(errors.getState().entries.filter((entry) => !entry.seen)).toHaveLength(2)
    expect(errors.getState().entries.find((entry) => entry.trackId === 'track-1')).toMatchObject({
      source: 'player',
      message: '재생 실패',
      seen: true
    })
  })

  it('markAllSeen remains a one-shot action without opening the notification center', () => {
    store.reportError('runtime', '실패')
    store.useErrorStore.getState().markAllSeen()
    store.reportError('runtime', '새 실패')
    expect(store.useErrorStore.getState().notificationOpen).toBe(false)
    expect(store.useErrorStore.getState().entries.map((entry) => entry.seen)).toEqual([false, true])
  })

  it('keeps only the latest 50 entries across main and renderer error paths', () => {
    for (let index = 0; index < 60; index += 1) {
      if (index % 2 === 0) store.reportError('player', `error-${index}`)
      else receive({ source: 'analyze', message: `error-${index}`, at: '2026-09-17' })
    }
    const entries = store.useErrorStore.getState().entries
    expect(entries).toHaveLength(50)
    expect(entries[0].message).toBe('error-59')
    expect(entries[49].message).toBe('error-10')
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(50)
  })

  it('removes only the selected entry and preserves open-state behavior after clearing', () => {
    const errors = store.useErrorStore
    store.reportError('player', '첫 실패')
    store.reportError('player', '두 번째 실패')
    const kept = errors.getState().entries[0]
    errors.getState().remove(errors.getState().entries[1].id)
    expect(errors.getState().entries).toEqual([kept])
    errors.getState().setNotificationOpen(true)
    errors.getState().clear()
    store.reportError('runtime', '다음 실패')
    expect(errors.getState().entries).toHaveLength(1)
    expect(errors.getState().entries[0].seen).toBe(true)
    expect(errors.getState().notificationOpen).toBe(true)
  })
})
