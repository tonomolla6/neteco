import { lstat, readFile, readdir, realpath, statfs } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const GiB = 1024 ** 3
const INSTALLED = '/usr/local/libexec/neteco-ci/build-storage.mjs'
const CONFIG = '/etc/neteco-ci/storage.json'
const HOST = '/run/neteco-ci-storage/host'
const CONTAINERS = '/run/neteco-ci-storage/containers'
const safeInteger = (value) => Number.isSafeInteger(value) && value >= 0
const estimateValid = (value) => Number.isInteger(value) && value >= 1 && value <= 8

function report(code, estimate, host = null, containers = null, requiredHost = null, requiredContainers = null) {
  return {
    status: code === 'ok' ? 'passed' : 'failed',
    code,
    estimatedOutputGiB: estimateValid(estimate) ? estimate : null,
    hostAvailableBytes: host,
    containerAvailableBytes: containers,
    hostRequiredBytes: requiredHost,
    containerRequiredBytes: requiredContainers,
    minimumFreeInodes: 100_000
  }
}

// A point-in-time budget only: no reservation, mutation, Docker API or cleanup.
export function evaluateBuildStorageBudget(snapshots, estimatedOutputGiB) {
  if (!estimateValid(estimatedOutputGiB)) return report('invalid_estimate', estimatedOutputGiB)
  const views = [snapshots?.host, snapshots?.containers]
  if (
    views.some(
      (view) =>
        !view ||
        typeof view !== 'object' ||
        Array.isArray(view) ||
        !['device', 'totalBlocks', 'availableBlocks', 'blockSize', 'availableInodes'].every((key) =>
          safeInteger(view[key])
        ) ||
        view.device === 0 ||
        view.totalBlocks === 0 ||
        view.availableBlocks > view.totalBlocks ||
        view.blockSize === 0 ||
        BigInt(view.totalBlocks) * BigInt(view.blockSize) > BigInt(Number.MAX_SAFE_INTEGER) ||
        BigInt(view.availableBlocks) * BigInt(view.blockSize) > BigInt(Number.MAX_SAFE_INTEGER)
    )
  )
    return report('invalid_snapshot', estimatedOutputGiB)
  const [host, containers] = views
  const hostBytes = host.availableBlocks * host.blockSize
  const containerBytes = containers.availableBlocks * containers.blockSize
  const growth = estimatedOutputGiB * GiB
  // A trimmed loop image is sparse: new private-volume writes may also allocate
  // host blocks. Budget the full estimate on both filesystems, never count the
  // loop's free space as additional host capacity. Preserve stricter legacy
  // gates and round the 10% reserve upwards without floating-point loss.
  const tenth = (view) => Number((BigInt(view.totalBlocks) * BigInt(view.blockSize) + 9n) / 10n)
  const requiredHost = Math.max(12 * GiB, growth + Math.max(10 * GiB, tenth(host)))
  const requiredContainers = growth + Math.max(4 * GiB, tenth(containers))
  let code = 'ok'
  if (host.device === containers.device) code = 'same_filesystem'
  else if (hostBytes < requiredHost) code = 'host_space_low'
  else if (host.availableInodes < 100_000) code = 'host_inodes_low'
  else if (containerBytes < requiredContainers) code = 'container_space_low'
  else if (containers.availableInodes < 100_000) code = 'container_inodes_low'
  return report(code, estimatedOutputGiB, hostBytes, containerBytes, requiredHost, requiredContainers)
}

async function rootManaged(path, file = false) {
  const first = await lstat(path)
  if (file ? !first.isFile() : !first.isDirectory()) throw new Error('untrusted_operator_path')
  for (let current = path; ; current = dirname(current)) {
    const entry = await lstat(current)
    if (
      entry.isSymbolicLink() ||
      entry.uid !== 0 ||
      (entry.mode & 0o022) !== 0 ||
      (current !== path && !entry.isDirectory())
    )
      throw new Error('untrusted_operator_path')
    if (current === '/') break
  }
  if ((await realpath(path)) !== path) throw new Error('untrusted_operator_path')
  return first
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--estimated-output-gib' || !/^[1-8]$/.test(args[1])) {
    return report('invalid_arguments')
  }
  const estimate = Number(args[1])
  if (Object.keys(process.env).some((key) => /^(?:NETECO_BUILD_STORAGE|NETECO_STORAGE)(?:_|$)/.test(key))) {
    return report('environment_override', estimate)
  }
  // Reject untrusted invocation before filesystem/identity/configuration reads.
  if (process.argv[1] !== INSTALLED || import.meta.url !== pathToFileURL(INSTALLED).href) {
    return report('untrusted_installation', estimate)
  }
  if (
    process.execArgv.length !== 0 ||
    (process.env.NODE_OPTIONS !== undefined && process.env.NODE_OPTIONS !== '--max-old-space-size=2048')
  ) {
    return report('environment_override', estimate)
  }
  let code = 'untrusted_installation'
  try {
    await rootManaged(INSTALLED, true)
    code = 'identity_denied'
    if (
      process.getuid?.() !== 980 ||
      process.geteuid?.() !== 980 ||
      userInfo().username !== 'neteco-actions' ||
      process.platform !== 'linux' ||
      process.arch !== 'arm64' ||
      Number(process.versions.node.split('.')[0]) !== 24
    )
      return report(code, estimate)
    const os = await readFile('/etc/os-release', 'utf8')
    if (
      !/^ID=(?:ubuntu|"ubuntu")$/m.test(os) ||
      !/^VERSION_ID=(?:24\.04|"24\.04")$/m.test(os) ||
      (await readFile('/proc/self/cgroup', 'utf8')).trim() !== '0::/system.slice/devtono-neteco-actions-runner.service'
    ) {
      return report(code, estimate)
    }
    code = 'invalid_operator_config'
    const configStat = await rootManaged(CONFIG, true)
    if (configStat.size > 8192) return report(code, estimate)
    const config = JSON.parse(await readFile(CONFIG, 'utf8'))
    if (
      !config ||
      Array.isArray(config) ||
      config.version !== 1 ||
      Object.keys(config).sort().join(',') !== 'containerDevice,hostDevice,version' ||
      !safeInteger(config.hostDevice) ||
      config.hostDevice === 0 ||
      !safeInteger(config.containerDevice) ||
      config.containerDevice === 0 ||
      config.hostDevice === config.containerDevice
    )
      return report(code, estimate)
    code = 'invalid_storage_view'
    const mountinfo = await readFile('/proc/self/mountinfo', 'utf8')
    const snapshots = []
    for (const [path, expectedDevice] of [
      [HOST, config.hostDevice],
      [CONTAINERS, config.containerDevice]
    ]) {
      const entry = await rootManaged(path)
      if (entry.dev !== expectedDevice || (await readdir(path)).length !== 0) return report(code, estimate)
      const mounts = mountinfo
        .split('\n')
        .map((line) => line.split(' '))
        .filter((fields) => fields[4] === path)
      if (!mounts.length || mounts.some((fields) => !fields[5].split(',').includes('ro'))) return report(code, estimate)
      const fs = await statfs(path, { bigint: true })
      snapshots.push({
        device: entry.dev,
        totalBlocks: Number(fs.blocks),
        availableBlocks: Number(fs.bavail),
        blockSize: Number(fs.bsize),
        availableInodes: Number(fs.ffree)
      })
    }
    return evaluateBuildStorageBudget({ host: snapshots[0], containers: snapshots[1] }, estimate)
  } catch {
    return report(code, estimate)
  }
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
// Node uses this URL for both eval and stdin, including stdin without `-`.
// A normal import retains the module's file URL and never runs the CLI.
const evaluatedSource = import.meta.url.endsWith('/[eval1]')
if (direct || evaluatedSource) {
  const result = await main()
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exitCode = result.status === 'passed' ? 0 : 1
}
