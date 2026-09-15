#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatErrors } from './schema.mjs'
import { verifyLocks, assertLocksUnchanged } from './verify.mjs'
import { proposeLocks } from './propose.mjs'
import { verifyPackage } from './package.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function argValue(args, name) {
  const idx = args.indexOf(name)
  if (idx < 0) return null
  return args[idx + 1] ?? null
}

function fail(errors, extra) {
  const list = Array.isArray(errors) ? errors : [errors]
  if (list.length) console.error(formatErrors(list))
  if (extra) console.error(extra)
  process.exit(1)
}

const [command, ...args] = process.argv.slice(2)

if (command === 'verify') {
  const result = verifyLocks({ root })
  const mutated = assertLocksUnchanged(result.snapshots)
  if (!result.ok || mutated.length) {
    fail([...result.errors, ...mutated])
  }
  console.log(`verify ok (${result.snapshots.length} lock files, uv ${result.uvLockDigest})`)
  process.exit(0)
}

if (command === 'propose') {
  const output = argValue(args, '--output')
  if (!output)
    fail([], 'usage: node scripts/runtime-lock/cli.mjs propose --output dist/lock-candidate')
  const result = proposeLocks({ root, output: resolve(output) })
  console.log(`wrote candidate to ${result.output}`)
  process.exit(0)
}

if (command === 'verify-package') {
  const target = argValue(args, '--target')
  const input = argValue(args, '--input')
  if ((target !== 'zip' && target !== 'appx') || !input) {
    fail(
      [],
      'usage: node scripts/runtime-lock/cli.mjs verify-package --target zip|appx --input <dir>'
    )
  }
  const result = verifyPackage({
    target,
    input: resolve(input),
    locksDir: resolve(root, 'build', 'locks')
  })
  if (!result.ok) fail(result.errors)
  console.log(`verify-package ok target=${target}`)
  process.exit(0)
}

console.error('usage: node scripts/runtime-lock/cli.mjs <verify|propose|verify-package> ...')
process.exit(2)
