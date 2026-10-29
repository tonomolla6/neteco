import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { resolve, sep } from 'node:path'
import { connect as tcpConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

// Run only in the operator-created sandbox. The operator owns the live,
// loopback-only canary and must keep it listening throughout this probe.
const report = { status: 'failed', networkAttempted: false, checks: {}, limits: {} }
const checks = report.checks
const args = process.argv.slice(2)
const port = Number(args[1])
checks.arguments =
  args.length === 2 &&
  args[0] === '--canary-port' &&
  /^\d+$/.test(args[1]) &&
  Number.isInteger(port) &&
  port > 0 &&
  port <= 65535
checks.uid = process.getuid?.() === 980
checks.username = userInfo().username === 'neteco-actions'
checks.node24 = Number(process.versions.node.split('.')[0]) === 24
checks.linuxArm64 = process.platform === 'linux' && process.arch === 'arm64'

function emit() {
  report.status = Object.values(checks).every((value) => value === true) ? 'passed' : 'failed'
  process.stdout.write(JSON.stringify(report) + '\n')
  process.exitCode = report.status === 'passed' ? 0 : 1
}

async function inaccessible(path, mode) {
  try {
    await access(path, mode)
    return false
  } catch (error) {
    return ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)
  }
}

async function inspectLimits() {
  const membership = await readFile('/proc/self/cgroup', 'utf8')
  const group = membership
    .split('\n')
    .find((line) => line.startsWith('0::'))
    ?.slice(3)
  if (!group || group === '/' || group.split('/').includes('..')) throw new Error('cgroup')
  const root = '/sys/fs/cgroup'
  const directory = resolve(root, '.' + group)
  if (!directory.startsWith(root + sep)) throw new Error('cgroup')
  for (const name of ['cpu.max', 'memory.high', 'memory.max', 'memory.swap.max', 'pids.max']) {
    const value = (await readFile(resolve(directory, name), 'utf8')).trim()
    report.limits[name] = value
    if (name === 'cpu.max') {
      const [quota, period] = value.split(/\s+/).map(Number)
      checks.cpu =
        Number.isSafeInteger(quota) && quota > 0 && Number.isSafeInteger(period) && period > 0 && quota / period <= 1
    } else {
      const maximum = {
        'memory.high': 2 * 1024 ** 3,
        'memory.max': 3 * 1024 ** 3,
        'memory.swap.max': 512 * 1024 ** 2,
        'pids.max': 512
      }[name]
      const number = Number(value)
      checks[name] = /^\d+$/.test(value) && Number.isSafeInteger(number) && number >= 0 && number <= maximum
    }
  }
}

function inspectCanary() {
  return new Promise((resolveResult) => {
    const socket = tcpConnect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (denied, outcome) => {
      if (settled) return
      settled = true
      socket.destroy()
      report.canaryOutcome = outcome
      resolveResult(denied)
    }
    socket.setTimeout(3000, () => finish(true, 'timeout'))
    socket.once('connect', () => finish(false, 'reachable'))
    socket.once('error', (error) =>
      finish(
        ['EACCES', 'EPERM'].includes(error.code),
        ['EACCES', 'EPERM', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error.code)
          ? error.code
          : 'connection_error'
      )
    )
  })
}

function inspectGitHubTls() {
  return new Promise((resolveResult) => {
    const socket = tlsConnect({
      host: 'api.github.com',
      port: 443,
      servername: 'api.github.com',
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2'
    })
    let settled = false
    const finish = (passed) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveResult(passed)
    }
    socket.setTimeout(10000, () => finish(false))
    socket.once('secureConnect', () => finish(socket.authorized))
    socket.once('error', () => finish(false))
  })
}

// Fail closed before any network activity, especially when invoked as root.
if (!Object.values(checks).every((value) => value === true)) {
  emit()
} else {
  try {
    const blocked = [
      ['/root', constants.R_OK],
      ['/home', constants.R_OK],
      ['/var/lib/docker', constants.R_OK],
      ['/run/docker.sock', constants.R_OK | constants.W_OK],
      ['/usr/bin/sudo', constants.X_OK],
      ['/var/lib/sabea-actions-runner', constants.R_OK],
      ['/var/oled/devtono-ci/notifestival', constants.R_OK]
    ]
    for (const [path, mode] of blocked) checks['inaccessible:' + path] = await inaccessible(path, mode)
    await inspectLimits()
    checks.git = /^git version \d+\./.test(
      execFileSync('/usr/bin/git', ['--version'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    )
    if (Object.values(checks).every((value) => value === true)) {
      report.networkAttempted = true
      checks.hostLoopbackDenied = await inspectCanary()
      checks.githubTls = await inspectGitHubTls()
    }
  } catch {
    checks.probeCompleted = false
  }
  emit()
}
