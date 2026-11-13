import { expect, it } from 'vitest'
import { evaluateBuildMemory, inspectBuildMemory } from '../../scripts/ci-build-memory-preflight.mjs'

const GiB = 1024 ** 3
const snapshot = () => ({
  available: 12 * GiB,
  swapFree: 2 * GiB,
  ancestors: [{ current: GiB, maximum: 8 * GiB, high: 7 * GiB }]
})

it('admits the 5 GiB compiler peak within existing runner limits and host reserve', () => {
  expect(evaluateBuildMemory(snapshot())).toMatchObject({ pass: true, code: 'ok', peakBytes: 5 * GiB })
})

it.each([
  [{ current: GiB, maximum: 2 * GiB, high: null }, 'cgroup_memory_low'],
  [{ current: GiB, maximum: 8 * GiB, high: 1.5 * GiB }, 'cgroup_pressure_budget_low']
])('rejects a constrained ancestor even when the immediate cgroup is unlimited', (ancestor, code) => {
  const data = snapshot()
  expect(
    evaluateBuildMemory({ ...data, ancestors: [{ current: GiB, maximum: null, high: null }, ancestor] })
  ).toMatchObject({ pass: false, code })
})

it('requires the full host reserve and counts only available memory and free swap', () => {
  expect(evaluateBuildMemory({ ...snapshot(), available: 8 * GiB, swapFree: GiB })).toMatchObject({
    pass: false,
    code: 'host_memory_low'
  })
})

it.each([
  { ...snapshot(), available: NaN },
  { ...snapshot(), swapFree: -1 },
  { ...snapshot(), ancestors: [] },
  { ...snapshot(), ancestors: [{ current: 0, maximum: undefined, high: null }] }
])('rejects missing or invalid resource counters %#', (data) => {
  expect(evaluateBuildMemory(data)).toMatchObject({ pass: false, code: 'invalid_snapshot' })
})

it('reads the visible parent slices instead of trusting the leaf maximum', async () => {
  const files: Record<string, string> = {
    '/proc/meminfo': 'MemAvailable: 12582912 kB\nSwapFree: 2097152 kB\n',
    '/proc/self/cgroup': '0::/builder.slice/compiler\n',
    '/sys/fs/cgroup/builder.slice/compiler/memory.current': '104857600',
    '/sys/fs/cgroup/builder.slice/compiler/memory.max': 'max',
    '/sys/fs/cgroup/builder.slice/compiler/memory.high': 'max',
    '/sys/fs/cgroup/builder.slice/memory.current': String(GiB),
    '/sys/fs/cgroup/builder.slice/memory.max': String(2 * GiB),
    '/sys/fs/cgroup/builder.slice/memory.high': String(1.5 * GiB)
  }
  const read = async (path: string) => {
    if (!(path in files)) throw Error('missing probe')
    return files[path]!
  }
  const data = await inspectBuildMemory(read)
  expect(data.ancestors).toHaveLength(2)
  expect(evaluateBuildMemory(data)).toMatchObject({ pass: false, code: 'cgroup_memory_low' })
  delete files['/sys/fs/cgroup/builder.slice/memory.high']
  await expect(inspectBuildMemory(read)).rejects.toThrow('missing probe')
})

it('uses only the verified operator memory view when ProcSubset hides meminfo', async () => {
  const paths: string[] = []
  const read = async (path: string) => {
    paths.push(path)
    if (path === '/proc/meminfo') throw Error('hidden by ProcSubset')
    if (path === '/run/neteco-ci-resources/meminfo') return 'MemAvailable: 12582912 kB\nSwapFree: 2097152 kB\n'
    if (path === '/proc/self/cgroup') return '0::/runner\n'
    if (path.endsWith('memory.current')) return String(GiB)
    if (path.endsWith('memory.high')) return String(7 * GiB)
    if (path.endsWith('memory.max')) return String(8 * GiB)
    throw Error('unexpected probe')
  }
  let verified = false
  const verify = async () => {
    verified = true
  }
  expect(evaluateBuildMemory(await inspectBuildMemory(read, verify))).toMatchObject({ pass: true })
  expect(verified).toBe(true)
  expect(paths).toContain('/run/neteco-ci-resources/meminfo')
  await expect(
    inspectBuildMemory(read, async () => {
      throw Error('untrusted view')
    })
  ).rejects.toThrow('untrusted view')
})
