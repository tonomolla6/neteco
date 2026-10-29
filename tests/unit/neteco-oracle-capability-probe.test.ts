import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'

const script = new URL('../../scripts/lib/neteco-oracle-capability-probe.mjs', import.meta.url)
function probe(args: string[], overrides: Record<string, string> = {}, cwd = tmpdir()) {
  const result = spawnSync(process.execPath, [script.pathname, ...args], {
    cwd,
    env: { ...process.env, ...overrides },
    encoding: 'utf8',
    timeout: 3000
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stderr).toBe('')
  const lines = result.stdout.trim().split('\n')
  expect(lines).toHaveLength(1)
  const report = JSON.parse(lines[0]!)
  expect(report.status).toBe('failed')
  expect(report.dependenciesLoaded).toBe(false)
  expect(report.networkAttempted).toBe(false)
  expect(report.browserAttempted).toBe(false)
  expect(report.productionAcceptance).toBe(false)
  expect(result.stdout).not.toContain('/root')
  expect(result.stdout).not.toContain('sensitive-test-marker')
  return report
}

it.each([
  ['--help'],
  ['--root', '/root'],
  ['--browser', 'chromium'],
  ['--skip-identity'],
  ['--node-version', '24.18.1']
])('rejects every CLI override before loading project dependencies: %#', (...args) => {
  expect(probe(args).checks.arguments).toBe(false)
})

it('rejects the repository source before identity admission, dependency loading or networking on every UID', () => {
  const report = probe([], {}, new URL('../../', import.meta.url).pathname)
  expect(report.checks.arguments).toBe(true)
  expect(report.code).toBe('untrusted_probe')
  expect(report.checks.trustedProbe).toBe(false)
  expect(report.checks.uid).toBeUndefined()
})

it('does not admit spoofed host identity, OS, Node version, repository or browser endpoint environment', () => {
  const report = probe([], {
    UID: '980',
    USER: 'neteco-actions',
    LOGNAME: 'neteco-actions',
    NODE_VERSION: '24.18.1',
    OS_RELEASE: 'ubuntu24.04',
    NETECO_CAPABILITY_ROOT: '/root/sensitive-test-marker',
    PLAYWRIGHT_WS_ENDPOINT: 'ws://sensitive-test-marker.invalid',
    CI: 'true'
  })
  expect(report.code).toBe('untrusted_probe')
  expect(report.checks.uid).toBeUndefined()
  expect(report.checks.noOverrides).toBe(false)
})

it.each(['/ms-playwright', '/root/sensitive-test-marker', '/var/lib/neteco-ci/cache/ms-playwright'])(
  'only accepts the operator writable browser-cache value without admitting repository code: %s',
  (cache) => {
    const report = probe([], { PLAYWRIGHT_BROWSERS_PATH: cache })
    expect(report.code).toBe('untrusted_probe')
    expect(report.checks.noOverrides).toBe(cache === '/var/lib/neteco-ci/cache/ms-playwright')
  }
)

it('rejects a real UID 980 stdin source copy before any privileged admission or project imports', () => {
  const source = readFileSync(script, 'utf8')
  const options = process.getuid?.() === 0 ? { uid: 980, gid: 979 } : {}
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    ...options,
    cwd: tmpdir(),
    encoding: 'utf8',
    timeout: 3000,
    input: `if (process.getuid() !== 980) throw new Error('unexpected_identity');\n${source}`
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stderr).toBe('')
  const report = JSON.parse(result.stdout)
  expect(report.code).toBe('untrusted_probe')
  expect(report.checks.arguments).toBe(true)
  expect(report.checks.trustedProbe).toBe(false)
  expect(report.checks.uid).toBeUndefined()
  expect(report.dependenciesLoaded).toBe(false)
  expect(report.networkAttempted).toBe(false)
  expect(report.browserAttempted).toBe(false)
})
