import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

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

async function verifyOperatorMemoryView() {
  const path = '/run/neteco-ci-resources/meminfo'
  if (!(await lstat(path)).isFile() || (await realpath(path)) !== path) throw new Error('untrusted_memory_view')
  for (let current = path; ; current = dirname(current)) {
    const entry = await lstat(current)
    if (
      entry.isSymbolicLink() ||
      entry.uid !== 0 ||
      (entry.mode & 0o022) !== 0 ||
      (current !== path && !entry.isDirectory())
    )
      throw new Error('untrusted_memory_view')
    if (current === '/') return
  }
}

/** @param {(path: string) => Promise<string>} read */
export async function inspectBuildMemory(
  read = (path) => readFile(path, 'utf8'),
  verifyHostView = verifyOperatorMemoryView
) {
  let memory
  try {
    memory = await read('/proc/meminfo')
  } catch {
    // Reuse the operator's existing live, read-only bind; keep ProcSubset=pid.
    await verifyHostView()
    memory = await read('/run/neteco-ci-resources/meminfo')
  }
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

/**
 * Cache restoration can temporarily consume the runner's pressure budget. Let
 * the existing operator reclaim service run, then inspect every gate again.
 * At most 29 seconds of waiting; no reclaim, limits or estimates are changed.
 */
export async function waitForBuildMemory(inspect = inspectBuildMemory, pause = delay) {
  for (let observation = 0; observation < 30; observation++) {
    const result = evaluateBuildMemory(await inspect())
    if (result.pass || result.code === 'invalid_snapshot' || observation === 29) return result
    await pause(1000)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await waitForBuildMemory()
    console.log(JSON.stringify(result))
    process.exitCode = result.pass ? 0 : 1
  } catch {
    console.log(JSON.stringify({ pass: false, code: 'memory_probe_unavailable' }))
    process.exitCode = 1
  }
}
