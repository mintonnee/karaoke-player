import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { evaluateParityFixture, type ParityFixture } from '../../runtime'

const PARITY_ROOT = join(
  process.cwd(),
  'scripts',
  '__tests__',
  'runtime-lock',
  'fixtures',
  'parity'
)

function loadCases(kind: 'accept' | 'reject'): Array<{ name: string; data: ParityFixture }> {
  const base = join(PARITY_ROOT, kind)
  return readdirSync(base)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({
      name,
      data: JSON.parse(readFileSync(join(base, name), 'utf8')) as ParityFixture
    }))
}

describe('runtime-lock parity fixtures', () => {
  for (const { name, data } of loadCases('accept')) {
    it(`accept ${name}`, () => {
      const errors = evaluateParityFixture(data)
      expect(errors, errors.map((e) => `${e.code} ${e.message}`).join('\n')).toEqual([])
      expect(data.expected.accept).toBe(true)
    })
  }

  for (const { name, data } of loadCases('reject')) {
    it(`reject ${name} with ${data.expected.reasonCode}`, () => {
      const errors = evaluateParityFixture(data)
      expect(errors.length).toBeGreaterThan(0)
      expect(
        errors.some((e) => e.code === data.expected.reasonCode),
        `expected ${data.expected.reasonCode} got ${errors.map((e) => e.code).join(',')}`
      ).toBe(true)
    })
  }
})
