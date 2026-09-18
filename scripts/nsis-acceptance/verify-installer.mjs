import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compareInventories, fileDigest, inventory } from './inventory.mjs'
import { verifyPackage } from '../runtime-lock/package.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** 설치 프로그램을 실행하지 않고 내장 앱 payload의 최종 바이트를 대조한다. */
export async function verifyInstaller({ installer, appDir, reportDir }) {
  const require = createRequire(import.meta.url)
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
  const { getPath7za } = builderRequire('app-builder-lib/out/toolsets/7zip')
  const sevenZip = await getPath7za()
  const outputRoot = resolve(reportDir ?? join(root, 'dist/nsis/acceptance'))
  await mkdir(outputRoot, { recursive: true })
  const work = await mkdtemp(join(outputRoot, 'payload-'))
  const payloadDir = join(work, 'app')
  // electron-builder의 extractAppPackage.nsh는 app-64.7z를 SetCompress off로 삽입한다.
  // NSIS 자체가 아닌 내장 7z 스트림을 찾는다. 추출 결과는 전체 inventory로 대조한다.
  execFileSync(sevenZip, ['x', '-t7z', resolve(installer), `-o${payloadDir}`, '-y'], {
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  })
  const expected = await inventory(resolve(appDir))
  const actual = await inventory(payloadDir)
  const errors = compareInventories(expected, actual)
  const packageResult = await verifyPackage({
    target: 'nsis',
    input: payloadDir,
    locksDir: join(root, 'build/locks')
  })
  errors.push(...packageResult.errors.map((error) => error.message))
  const report = {
    at: new Date().toISOString(),
    installer: basename(installer),
    installerSha256: await fileDigest(installer),
    ok: errors.length === 0,
    fileCount: actual.length,
    errors,
    files: actual,
    installationTested: false
  }
  const reportPath = join(work, 'report.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  if (!report.ok)
    throw new Error(`NSIS payload verification failed (${reportPath}): ${errors.join('; ')}`)
  console.log(`NSIS payload verified: ${actual.length} files; ${reportPath}`)
  return { report, reportPath }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const value = (name) => {
    const index = args.indexOf(name)
    return index < 0 ? undefined : args[index + 1]
  }
  const installer = value('--installer')
  const appDir = value('--app-dir')
  if (!installer || !appDir) {
    console.error(
      'usage: node scripts/nsis-acceptance/verify-installer.mjs --installer <exe> --app-dir <win-unpacked> [--report-dir <directory>]'
    )
    process.exitCode = 2
  } else {
    try {
      await verifyInstaller({ installer, appDir, reportDir: value('--report-dir') })
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
