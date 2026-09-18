import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('useLibraryStore', () => {
  let store: typeof import('../libraryStore')
  const openTrackFolder = vi.fn().mockResolvedValue(undefined)

  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('window', {
      api: {
        onTrackUpdated: vi.fn(() => () => {}),
        onImportProgress: vi.fn(() => () => {}),
        onUrlImportProgress: vi.fn(() => () => {}),
        onPairImportProgress: vi.fn(() => () => {}),
        listTracks: vi.fn().mockResolvedValue([]),
        openTrackFolder
      }
    })
    store = await import('../libraryStore')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('openTrackFolder는 window.api.openTrackFolder를 호출한다', async () => {
    await store.useLibraryStore.getState().openTrackFolder('track-123')
    expect(openTrackFolder).toHaveBeenCalledWith('track-123')
  })
})
