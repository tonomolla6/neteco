import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

function probe(args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/lib/neteco-oracle-isolation-probe.mjs', ...args], {
    cwd: new URL('../../', import.meta.url),
    encoding: 'utf8',
    timeout: 3000
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  const report = JSON.parse(result.stdout)
  expect(report.status).toBe('failed')
  expect(report.networkAttempted).toBe(false)
  return report
}

it('rejects malformed operator arguments before network probes on any UID', () => {
  expect(probe(['--canary-port', '0']).checks.arguments).toBe(false)
})

it('rejects unknown flags before network probes on any UID', () => {
  expect(probe(['--other-port', '65535']).checks.arguments).toBe(false)
})
