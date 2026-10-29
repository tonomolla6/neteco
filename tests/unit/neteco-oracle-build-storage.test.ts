import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { evaluateBuildStorageBudget } from '../../scripts/lib/neteco-oracle-build-storage.mjs'

const GiB = 1024 ** 3
const script = new URL('../../scripts/lib/neteco-oracle-build-storage.mjs', import.meta.url)
const snapshot = () => ({
  host: { device: 1, totalBlocks: 64 * GiB, availableBlocks: 12 * GiB, blockSize: 1, availableInodes: 100_000 },
  containers: { device: 2, totalBlocks: 16 * GiB, availableBlocks: 6 * GiB, blockSize: 1, availableInodes: 100_000 }
})

it('accepts exact byte and inode boundaries without claiming reservation', () => {
  expect(evaluateBuildStorageBudget(snapshot(), 2)).toEqual({
    status: 'passed',
    code: 'ok',
    estimatedOutputGiB: 2,
    hostAvailableBytes: 12 * GiB,
    containerAvailableBytes: 6 * GiB,
    hostRequiredBytes: 12 * GiB,
    containerRequiredBytes: 6 * GiB,
    minimumFreeInodes: 100_000
  })
})

it.each([
  ['host', 'availableBlocks', 12 * GiB - 1, 'host_space_low'],
  ['host', 'availableInodes', 99_999, 'host_inodes_low'],
  ['containers', 'availableBlocks', 6 * GiB - 1, 'container_space_low'],
  ['containers', 'availableInodes', 99_999, 'container_inodes_low'],
  ['host', 'blockSize', 0, 'invalid_snapshot'],
  ['host', 'availableBlocks', -1, 'invalid_snapshot'],
  ['containers', 'availableInodes', NaN, 'invalid_snapshot'],
  ['containers', 'blockSize', 1.5, 'invalid_snapshot'],
  ['containers', 'device', 1, 'same_filesystem']
] as const)('rejects %s %s boundary %#', (view, field, value, code) => {
  const data = snapshot()
  data[view][field] = value
  expect(evaluateBuildStorageBudget(data, 2)).toMatchObject({ status: 'failed', code })
})

it.each([0, 9, -1, 1.5, '2', NaN, Infinity, undefined])('rejects invalid estimated output %#', (estimate) => {
  expect(evaluateBuildStorageBudget(snapshot(), estimate)).toMatchObject({ status: 'failed', code: 'invalid_estimate' })
})

it('uses block size and protects multiplication and numeric output from overflow', () => {
  const data = snapshot()
  data.host.availableBlocks /= 4096
  data.host.blockSize = 4096
  expect(evaluateBuildStorageBudget(data, 2).hostAvailableBytes).toBe(12 * GiB)
  data.host.availableBlocks = Number.MAX_SAFE_INTEGER
  expect(evaluateBuildStorageBudget(data, 2).code).toBe('invalid_snapshot')
  expect(evaluateBuildStorageBudget(null, 2).code).toBe('invalid_snapshot')
  expect(evaluateBuildStorageBudget({ host: data.host }, 2).code).toBe('invalid_snapshot')
})

it.each([1, 8])('budgets the complete private output estimate %s GiB', (estimate) => {
  const data = snapshot()
  data.host.availableBlocks = Math.max(12, 10 + estimate) * GiB
  data.containers.availableBlocks = (4 + estimate) * GiB
  expect(evaluateBuildStorageBudget(data, estimate)).toMatchObject({
    status: 'passed',
    containerRequiredBytes: (4 + estimate) * GiB
  })
  data.containers.availableBlocks--
  expect(evaluateBuildStorageBudget(data, estimate).code).toBe('container_space_low')
})

it('rejects the legacy 12 GiB host margin when a large backing filesystem needs a 10% reserve', () => {
  const data = snapshot()
  data.host.totalBlocks = 200 * GiB
  expect(evaluateBuildStorageBudget(data, 2)).toMatchObject({
    status: 'failed',
    code: 'host_space_low',
    hostRequiredBytes: 22 * GiB
  })
})

it('charges sparse-volume growth against the host, preserving at least 10 GiB after a large write', () => {
  const data = snapshot()
  data.containers.availableBlocks = 12 * GiB
  expect(evaluateBuildStorageBudget(data, 8)).toMatchObject({
    status: 'failed',
    code: 'host_space_low',
    hostRequiredBytes: 18 * GiB
  })
  data.host.availableBlocks = 18 * GiB
  expect(evaluateBuildStorageBudget(data, 8)).toMatchObject({ status: 'passed' })
})

it('keeps a large private volume 10% free after the estimated output, not only the legacy 4 GiB', () => {
  const data = snapshot()
  data.host.availableBlocks = 24 * GiB
  data.containers.totalBlocks = 100 * GiB
  expect(evaluateBuildStorageBudget(data, 2)).toMatchObject({
    status: 'failed',
    code: 'container_space_low',
    containerRequiredBytes: 12 * GiB
  })
  data.containers.availableBlocks = 12 * GiB
  expect(evaluateBuildStorageBudget(data, 2)).toMatchObject({ status: 'passed' })
})

it.each(['host', 'containers'] as const)('rounds the %s 10% reserve upwards at the exact byte boundary', (view) => {
  const data = snapshot()
  data.host.availableBlocks = 30 * GiB
  data.containers.totalBlocks = 64 * GiB
  data.containers.availableBlocks = 20 * GiB
  data[view].totalBlocks = 200 * GiB + 1
  data[view].availableBlocks = 22 * GiB
  expect(evaluateBuildStorageBudget(data, 2).code).toBe(view === 'host' ? 'host_space_low' : 'container_space_low')
  data[view].availableBlocks++
  expect(evaluateBuildStorageBudget(data, 2).status).toBe('passed')
})

it.each(['host', 'containers'] as const)(
  'rejects unknown or impossible %s capacity before admitting writes',
  (view) => {
    for (const totalBlocks of [undefined, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const data = snapshot()
      Object.assign(data[view], { totalBlocks })
      expect(evaluateBuildStorageBudget(data, 2)).toMatchObject({ status: 'failed', code: 'invalid_snapshot' })
    }
    const data = snapshot()
    data[view].totalBlocks = data[view].availableBlocks - 1
    expect(evaluateBuildStorageBudget(data, 2).code).toBe('invalid_snapshot')
    data[view].totalBlocks = Number.MAX_SAFE_INTEGER
    data[view].blockSize = 4096
    expect(evaluateBuildStorageBudget(data, 2).code).toBe('invalid_snapshot')
  }
)

function denied(args: string[], code: string, overrides: Record<string, string> = {}, stdin?: string) {
  const result = spawnSync(
    process.execPath,
    stdin === undefined ? [script.pathname, ...args] : ['--input-type=module', '-', ...args],
    {
      cwd: tmpdir(),
      env: overrides,
      input: stdin,
      encoding: 'utf8',
      timeout: 3000
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stderr).toBe('')
  expect(result.stdout.trim().split('\n')).toHaveLength(1)
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: 'failed',
    code,
    hostAvailableBytes: null,
    containerAvailableBytes: null
  })
  expect(result.stdout).not.toMatch(/\/root|sensitive-marker|stack/i)
}

it.each([
  [],
  ['--help'],
  ['--estimated-output-gib', '0'],
  ['--estimated-output-gib', '9'],
  ['--estimated-output-gib', '02'],
  ['--estimated-output-gib', '2', '--config', '/sensitive-marker']
])('rejects malformed arguments before configuration or filesystem inspection %#', (...args) =>
  denied(args, 'invalid_arguments')
)

it('rejects the real checkout source and stdin source even with spoofed identity', () => {
  const env = { UID: '980', USER: 'neteco-actions', OS_RELEASE: 'ubuntu24.04' }
  denied(['--estimated-output-gib', '2'], 'untrusted_installation', env)
  denied(['--estimated-output-gib', '2'], 'untrusted_installation', env, readFileSync(script, 'utf8'))
})

it.each(['NETECO_BUILD_STORAGE_CONFIG', 'NETECO_STORAGE_HOST_VIEW', 'NETECO_STORAGE_CONTAINER_VIEW'])(
  'rejects path override %s before installation/filesystem checks',
  (name) => {
    denied(['--estimated-output-gib', '2'], 'environment_override', { [name]: '/sensitive-marker' })
  }
)

it('is import-safe with no output or CLI side effects', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(script.href)}); console.log('loaded')`],
    {
      cwd: tmpdir(),
      env: {},
      encoding: 'utf8',
      timeout: 3000
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('loaded\n')
  expect(result.stderr).toBe('')
})

it.each(['stdin-without-dash', 'eval'])(
  'rejects %s source execution with a denial JSON rather than a silent zero exit',
  (mode) => {
    const source = readFileSync(script, 'utf8')
    const result = spawnSync(
      process.execPath,
      mode === 'eval' ? ['--input-type=module', '--eval', source] : ['--input-type=module'],
      {
        cwd: tmpdir(),
        env: {},
        input: mode === 'eval' ? undefined : source,
        encoding: 'utf8',
        timeout: 3000
      }
    )
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('')
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'failed',
      code: 'invalid_arguments',
      hostAvailableBytes: null,
      containerAvailableBytes: null
    })
    expect(result.stdout).not.toMatch(/\/root|stack/i)
  }
)
