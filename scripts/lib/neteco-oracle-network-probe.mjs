import { stat, readFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { createServer, connect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { randomUUID } from 'node:crypto'

// Operator-owned acceptance probe, not a job hook or an admission grant.
// Root must supervise live HOST TCP4/TCP6/abstract canaries and verify their
// reachability before AND after this invocation. ECONNREFUSED alone proves
// neither isolation nor a listening host canary. Never run network as root.
const report = {
  status: 'failed',
  networkAttempted: false,
  supervisedHostBaselinesRequired: true,
  // Refusal, unreachable and timeout are connectivity observations, not proof
  // of a firewall: an operator must separately supervise reachable canaries.
  evidenceScope: 'observed_tcp_connectivity_only',
  supervisedPrivateBaselinesRequired: true,
  firewallEnforcementAcceptance: false,
  ciAdmission: false,
  checks: {},
  codes: {}
}
const checks = report.checks
const servers = new Set()
const sockets = new Set()
function parseArguments(args) {
  if (args.length !== 6) return null
  const flags = new Map()
  for (let index = 0; index < args.length; index += 2) {
    if (!['--host-netns', '--canary-port', '--abstract-name'].includes(args[index]) || flags.has(args[index]))
      return null
    flags.set(args[index], args[index + 1])
  }
  const inode = flags.get('--host-netns'),
    port = flags.get('--canary-port'),
    name = flags.get('--abstract-name')
  if (!/^[1-9]\d{0,19}$/.test(inode ?? '') || BigInt(inode) > 18446744073709551615n) return null
  if (!/^[1-9]\d{0,4}$/.test(port ?? '') || Number(port) > 65535) return null
  if (!/^neteco-ci-canary-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name ?? ''))
    return null
  return { inode: BigInt(inode), port: Number(port), name }
}

function connection(options, encrypted = false) {
  return new Promise((resolve) => {
    let socket,
      finished = false
    const finish = (connected, code) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket?.destroy()
      sockets.delete(socket)
      resolve({ connected, code })
    }
    // A wall timer also bounds DNS lookup; socket idle timeout alone does not.
    const timer = setTimeout(() => finish(false, 'timeout'), encrypted ? 10000 : 2000)
    try {
      socket = encrypted ? tlsConnect(options) : connect(options)
      sockets.add(socket)
      socket.once(encrypted ? 'secureConnect' : 'connect', () =>
        finish(!encrypted || socket.authorized, encrypted ? 'tls_completed' : 'connected')
      )
      socket.once('error', (error) =>
        finish(
          false,
          ['ECONNREFUSED', 'EACCES', 'EPERM', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOENT'].includes(error.code)
            ? error.code
            : 'connection_error'
        )
      )
    } catch {
      finish(false, 'connection_error')
    }
  })
}

async function localServer(options) {
  const server = createServer((socket) => socket.destroy())
  servers.add(server)
  await new Promise((resolve, reject) => {
    let finished = false
    const finish = (error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (error) reject(new Error('local_listen_failed'))
      else resolve()
    }
    const timer = setTimeout(() => finish(true), 2000)
    server.on('error', () => finish(true))
    server.listen(options, () => finish(false))
  })
  const address = server.address()
  return connection(typeof address === 'string' ? { path: address } : { host: address.address, port: address.port })
}

async function denied(name, options) {
  const result = await connection(options)
  report.codes[name] = result.code
  return (
    !result.connected &&
    ['ECONNREFUSED', 'EACCES', 'EPERM', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOENT', 'timeout'].includes(result.code)
  )
}

async function sandboxIntact() {
  const status = await readFile('/proc/self/status', 'utf8')
  if (status.length > 65536) return false
  const values = {}
  for (const name of ['CapEff', 'NoNewPrivs', 'Seccomp', 'Seccomp_filters']) {
    const rows = status.split('\n').filter((line) => line.startsWith(name + ':'))
    if (rows.length !== 1) return false
    values[name] = rows[0].slice(name.length + 1).trim()
  }
  return (
    values.CapEff === '0000000000000000' &&
    values.NoNewPrivs === '1' &&
    values.Seccomp === '2' &&
    /^[1-9]\d{0,3}$/.test(values.Seccomp_filters)
  )
}

// Fixed code-owned destinations only; no operator URLs, credentials, DNS names
// or HTTP payloads. IPv4-mapped IPv6 must exercise the same prohibited classes.
function privateDestinations(canaryPort) {
  return [
    ['slirpGateway', { host: '10.0.2.2', port: canaryPort }],
    ['slirpDns', { host: '10.0.2.3', port: 53 }],
    ['rfc1918ClassA', { host: '10.0.0.1', port: 443 }],
    ['rfc1918ClassB', { host: '172.16.0.1', port: 443 }],
    ['rfc1918ClassC', { host: '192.168.0.1', port: 443 }],
    ['carrierGradeNat', { host: '100.64.0.1', port: 443 }],
    ['metadata', { host: '169.254.169.254', port: 80 }],
    ['hostPublicAddress', { host: '92.5.3.72', port: 443 }],
    ['ipv6UniqueLocal', { host: 'fd00::1', port: 443 }],
    ['ipv6LinkLocal', { host: 'fe80::1%tap0', port: 443 }],
    ['mappedHostLoopback', { host: '::ffff:127.0.0.1', port: canaryPort }],
    ['mappedGateway', { host: '::ffff:10.0.2.2', port: canaryPort }],
    ['mappedPrivate', { host: '::ffff:10.0.0.1', port: 443 }],
    ['mappedMetadata', { host: '::ffff:169.254.169.254', port: 80 }],
    ['mappedHostPublicAddress', { host: '::ffff:92.5.3.72', port: 443 }]
  ]
}

async function cleanup() {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise((resolve) => {
          if (!server.listening) return resolve()
          server.close(() => resolve())
        })
    )
  )
  servers.clear()
}

const args = parseArguments(process.argv.slice(2))
let probeNamespace
checks.arguments = args !== null
checks.uid = process.getuid?.() === 980
try {
  checks.username = userInfo().username === 'neteco-actions'
} catch {
  checks.username = false
}
checks.node24 = process.versions.node.split('.')[0] === '24'
checks.linuxArm64 = process.platform === 'linux' && process.arch === 'arm64'
try {
  if (Object.values(checks).every((value) => value === true)) {
    probeNamespace = (await stat('/proc/self/ns/net', { bigint: true })).ino
    checks.namespaceSeparated = probeNamespace !== args.inode
    checks.sandboxBefore = await sandboxIntact()
    if (checks.namespaceSeparated && checks.sandboxBefore) {
      report.networkAttempted = true
      checks.localIPv4 = (await localServer({ host: '127.0.0.1', port: 0 })).connected
      checks.localIPv6 = (await localServer({ host: '::1', port: 0, ipv6Only: true })).connected
      checks.localAbstract = (await localServer({ path: '\0neteco-ci-probe-' + randomUUID() })).connected
      checks.hostIPv4Denied = await denied('hostIPv4', { host: '127.0.0.1', port: args.port })
      checks.hostIPv6Denied = await denied('hostIPv6', { host: '::1', port: args.port })
      checks.hostAbstractDenied = await denied('hostAbstract', { path: '\0' + args.name })
      for (const [name, destination] of privateDestinations(args.port))
        checks[name + 'NotConnected'] = await denied(name, destination)
      checks.githubTls = (
        await connection(
          {
            host: 'api.github.com',
            port: 443,
            servername: 'api.github.com',
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2'
          },
          true
        )
      ).connected
    }
  }
} catch {
  checks.probeCompleted = false
} finally {
  await cleanup()
  if (report.networkAttempted) {
    try {
      checks.sandboxAfter = await sandboxIntact()
      checks.namespaceStable = (await stat('/proc/self/ns/net', { bigint: true })).ino === probeNamespace
      checks.identityStable = process.getuid?.() === 980 && userInfo().username === 'neteco-actions'
    } catch {
      checks.sandboxAfter = false
    }
  }
}
report.status = Object.values(checks).every((value) => value === true) ? 'passed' : 'failed'
process.stdout.write(JSON.stringify(report) + '\n')
process.exitCode = report.status === 'passed' ? 0 : 1
