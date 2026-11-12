import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const GiB = 1024 ** 3
export const BUILD_PEAK_BYTES = 5 * GiB
const HOST_RESERVE_BYTES = 4 * GiB

/** Admission only. Never changes limits, reclaims memory or counts occupied swap. */
export function evaluateBuildMemory(snapshot) {
  const result = {
    pass: false,
    code: 'invalid_snapshot',
    peakBytes: BUILD_PEAK_BYTES,
    reserveBytes: HOST_RESERVE_BYTES
  }
  const counter = (value) => Number.isSafeInteger(value) && value >= 0
  if (
    !snapshot ||
    !counter(snapshot.available) ||
    !counter(snapshot.swapFree) ||
    !Array.isArray(snapshot.ancestors) ||
    !snapshot.ancestors.length
  )
    return result
  if (
    snapshot.ancestors.some(
      (entry) =>
        !entry ||
        !counter(entry.current) ||
        ![entry.maximum, entry.high].every((value) => value === null || counter(value))
    )
  )
    return result
  if (snapshot.available + snapshot.swapFree <= BUILD_PEAK_BYTES + HOST_RESERVE_BYTES)
    return { ...result, code: 'host_memory_low' }
  for (const entry of snapshot.ancestors) {
    for (const [name, value] of [
      ['maximum', entry.maximum],
      ['high', entry.high]
    ]) {
      if (value !== null && value - entry.current < BUILD_PEAK_BYTES)
        return { ...result, code: name === 'high' ? 'cgroup_pressure_budget_low' : 'cgroup_memory_low' }
    }
  }
  return { ...result, pass: true, code: 'ok' }
}

/** @param {(path: string) => Promise<string>} read */
export async function inspectBuildMemory(read = (path) => readFile(path, 'utf8')) {
  const memory = await read('/proc/meminfo')
  const value = (name) => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(memory)
    if (!match) throw new Error('memory_counter_missing')
    return Number(match[1]) * 1024
  }
  const cgroup = /^0::(\/[^\r\n]*)$/m.exec(await read('/proc/self/cgroup'))?.[1]
  if (!cgroup || cgroup.split('/').some((part) => part === '.' || part === '..')) throw new Error('cgroup_v2_required')
  const root = '/sys/fs/cgroup'
  let path = resolve(root + cgroup)
  const ancestors = []
  const limit = (value) => (value.trim() === 'max' ? null : Number(value.trim()))
  // The namespace root is represented by the host memory admission; every
  // visible descendant and its parent slices must fit independently.
  while (path !== root) {
    const [current, maximum, high] = await Promise.all(
      ['memory.current', 'memory.max', 'memory.high'].map((file) => read(path + '/' + file))
    )
    ancestors.push({ current: Number(current.trim()), maximum: limit(maximum), high: limit(high) })
    path = dirname(path)
    if (!path.startsWith(root)) throw new Error('invalid_cgroup_path')
  }
  return { available: value('MemAvailable'), swapFree: value('SwapFree'), ancestors }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = evaluateBuildMemory(await inspectBuildMemory())
    console.log(JSON.stringify(result))
    process.exitCode = result.pass ? 0 : 1
  } catch {
    console.log(JSON.stringify({ pass: false, code: 'memory_probe_unavailable' }))
    process.exitCode = 1
  }
}
