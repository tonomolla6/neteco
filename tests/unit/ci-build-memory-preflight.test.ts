import { expect, it, vi } from 'vitest'
import {
  evaluateBuildMemory,
  inspectBuildMemory,
  waitForBuildMemory
} from '../../scripts/ci-build-memory-preflight.mjs'

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

it('rechecks the unchanged admission gate after the operator reclaims transient page cache', async () => {
  const pressure = { ...snapshot(), ancestors: [{ current: 3 * GiB, maximum: 8 * GiB, high: 7 * GiB }] }
  const inspect = vi.fn().mockResolvedValueOnce(pressure).mockResolvedValue(snapshot())
  const pause = vi.fn().mockResolvedValue(undefined)
  expect(await waitForBuildMemory(inspect, pause)).toMatchObject({ pass: true, peakBytes: 5 * GiB })
  expect(inspect).toHaveBeenCalledTimes(2)
  expect(pause).toHaveBeenCalledExactlyOnceWith(1000)
  expect(pressure.ancestors[0]).toEqual({ current: 3 * GiB, maximum: 8 * GiB, high: 7 * GiB })
})

it('fails closed after thirty observations when pressure never clears', async () => {
  const inspect = vi.fn().mockResolvedValue({
    ...snapshot(),
    ancestors: [{ current: 3 * GiB, maximum: 8 * GiB, high: 7 * GiB }]
  })
  const pause = vi.fn().mockResolvedValue(undefined)
  expect(await waitForBuildMemory(inspect, pause)).toMatchObject({ pass: false, code: 'cgroup_pressure_budget_low' })
  expect(inspect).toHaveBeenCalledTimes(30)
  expect(pause).toHaveBeenCalledTimes(29)
  expect(pause.mock.calls.every(([milliseconds]) => milliseconds === 1000)).toBe(true)
})

it('rechecks the host reserve on every observation even after the cgroup recovers', async () => {
  const pressure = { ...snapshot(), ancestors: [{ current: 3 * GiB, maximum: 8 * GiB, high: 7 * GiB }] }
  const inspect = vi
    .fn()
    .mockResolvedValueOnce(pressure)
    .mockResolvedValue({ ...snapshot(), available: 8 * GiB, swapFree: GiB })
  const pause = vi.fn().mockResolvedValue(undefined)
  expect(await waitForBuildMemory(inspect, pause)).toMatchObject({ pass: false, code: 'host_memory_low' })
  expect(inspect).toHaveBeenCalledTimes(30)
})

it('does not wait or admit a missing or invalid probe', async () => {
  const pause = vi.fn().mockResolvedValue(undefined)
  const invalid = vi.fn().mockResolvedValue({ ...snapshot(), ancestors: [] })
  expect(await waitForBuildMemory(invalid, pause)).toMatchObject({ pass: false, code: 'invalid_snapshot' })
  expect(invalid).toHaveBeenCalledTimes(1)
  const missing = vi.fn().mockRejectedValue(new Error('operator probe unavailable'))
  await expect(waitForBuildMemory(missing, pause)).rejects.toThrow('operator probe unavailable')
  expect(missing).toHaveBeenCalledTimes(1)
  expect(pause).not.toHaveBeenCalled()
})

it('starts immediately when the first complete memory inspection passes', async () => {
  const inspect = vi.fn().mockResolvedValue(snapshot())
  const pause = vi.fn().mockResolvedValue(undefined)
  expect(await waitForBuildMemory(inspect, pause)).toMatchObject({ pass: true, code: 'ok' })
  expect(inspect).toHaveBeenCalledTimes(1)
  expect(pause).not.toHaveBeenCalled()
})
