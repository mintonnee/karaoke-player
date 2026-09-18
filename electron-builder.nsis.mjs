/** Windows x64 사용자별 one-click NSIS 타깃. 런타임 도구는 앱 첫 실행에서 받는다. */
import {
  extraResourcesFor,
  verifyPackagedApp,
  writeRuntimeManifest
} from './electron-builder.manifest.mjs'
import { verifyInstaller } from './scripts/nsis-acceptance/verify-installer.mjs'

let unpackedAppDir
const isDirectoryBuild = process.argv.includes('--dir')

export default {
  extends: 'file:electron-builder.yml',
  directories: { output: 'dist/nsis' },
  artifactName: '${name}-${version}-win-${arch}-setup.${ext}',
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }]
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: false,
    createStartMenuShortcut: true
  },
  extraResources: extraResourcesFor('nsis'),
  beforePack: async () => {
    await writeRuntimeManifest({ target: 'nsis' })
  },
  afterPack: async (context) => {
    unpackedAppDir = await verifyPackagedApp('nsis', context)
  },
  afterAllArtifactBuild: async (result) => {
    if (isDirectoryBuild) return []
    const installer = result.artifactPaths.find((path) => path.toLowerCase().endsWith('-setup.exe'))
    if (!installer || !unpackedAppDir)
      throw new Error('NSIS installer or unpacked app directory missing')
    await verifyInstaller({
      installer,
      appDir: unpackedAppDir,
      reportDir: 'dist/nsis/acceptance'
    })
    return []
  }
}
