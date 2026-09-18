import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Vitest does not implement electron-vite's ?modulePath. Run the real bundled
// worker in tests as well, rather than mocking heavy work onto the main thread.
const require = createRequire(import.meta.url)
const { buildSync } = createRequire(require.resolve('vite'))('esbuild')
let workerBundle: string | undefined

export default defineConfig({
  plugins: [
    {
      name: 'runtime-worker-test-bundle',
      enforce: 'pre',
      resolveId(id) {
        if (id.endsWith('/fileWorker?modulePath')) return '\0runtime-worker-path'
        return undefined
      },
      load(id) {
        if (id !== '\0runtime-worker-path') return
        if (!workerBundle) {
          workerBundle = join(mkdtempSync(join(tmpdir(), 'karaoke-worker-test-')), 'worker.cjs')
          buildSync({
            entryPoints: [resolve('src/main/runtime/fileWorker.ts')],
            outfile: workerBundle,
            bundle: true,
            platform: 'node',
            format: 'cjs'
          })
        }
        return `export default ${JSON.stringify(workerBundle)}`
      }
    }
  ],
  test: {
    environment: 'node',
    include: [
      'src/main/**/*.test.ts',
      'src/renderer/**/*.test.ts',
      'src/shared/**/*.test.ts',
      'tests/youtube-preview/**/*.test.ts'
    ]
  }
})
