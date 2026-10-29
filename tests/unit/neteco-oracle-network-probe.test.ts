import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({
  reachable: new Set<string>(),
  connections: [] as Record<string, unknown>[],
  sockets: [] as { destroyed: boolean }[],
  servers: [] as { listening: boolean }[],
  statusReads: 0,
  status: 'CapEff:\t0000000000000000\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t3\n',
  changedStatus: '',
  errorCode: 'EACCES'
}))
vi.mock('node:fs/promises', () => ({
  stat: async () => ({ ino: 200n }),
  readFile: async (path: string) => {
    if (path !== '/proc/self/status') throw new Error('unexpected_test_read')
    transport.statusReads++
    return transport.statusReads > 1 && transport.changedStatus ? transport.changedStatus : transport.status
  }
}))
vi.mock('node:os', () => ({ userInfo: () => ({ username: 'neteco-actions' }) }))
vi.mock('node:net', () => ({
  createServer: () => {
    let address: string | { address: string; port: number }
    const server = {
      listening: false,
      on: () => server,
      listen: (options: { path?: string; host?: string }, callback: () => void) => {
        address = options.path ?? { address: options.host!, port: 48484 }
        server.listening = true
        callback()
      },
      address: () => address,
      close: (callback: () => void) => {
        server.listening = false
        callback()
      }
    }
    transport.servers.push(server)
    return server
  },
  connect: (options: Record<string, unknown>) => {
    transport.connections.push(options)
    const local = options.port === 48484 || String(options.path ?? '').startsWith('\0neteco-ci-probe-')
    const reachable = local || transport.reachable.has(String(options.host))
    const handlers: Record<string, (value?: unknown) => void> = {}
    const socket = {
      destroyed: false,
      once: (name: string, callback: (value?: unknown) => void) => {
        handlers[name] = callback
        return socket
      },
      destroy: () => {
        socket.destroyed = true
      }
    }
    transport.sockets.push(socket)
    queueMicrotask(() => (reachable ? handlers.connect?.() : handlers.error?.({ code: transport.errorCode })))
    return socket
  }
}))
vi.mock('node:tls', () => ({
  connect: () => {
    const handlers: Record<string, () => void> = {}
    const socket = {
      authorized: true,
      destroyed: false,
      once: (name: string, callback: () => void) => {
        handlers[name] = callback
        return socket
      },
      destroy: () => {
        socket.destroyed = true
      }
    }
    transport.sockets.push(socket)
    queueMicrotask(() => handlers.secureConnect?.())
    return socket
  }
}))

const ownNamespace = String(statSync('/proc/self/ns/net', { bigint: true }).ino)
const valid = [
  '--host-netns',
  ownNamespace,
  '--canary-port',
  '45678',
  '--abstract-name',
  'neteco-ci-canary-11111111-1111-4111-8111-111111111111'
]
function probe(args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/lib/neteco-oracle-network-probe.mjs', ...args], {
    cwd: new URL('../../', import.meta.url),
    encoding: 'utf8',
    timeout: 3000
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stderr).toBe('')
  expect(result.stdout.trim().split('\n')).toHaveLength(1)
  const report = JSON.parse(result.stdout)
  expect(report.status).toBe('failed')
  expect(report.networkAttempted).toBe(false)
  expect(JSON.stringify(report)).not.toContain('45678')
  expect(JSON.stringify(report)).not.toContain('11111111-1111')
  return report
}

it.each([
  [],
  valid.slice(0, 4),
  [...valid, '--extra'],
  [...valid, '--canary-port', '1'],
  valid.map((value) => (value === ownNamespace ? '0' : value)),
  valid.map((value) => (value === ownNamespace ? '18446744073709551616' : value)),
  valid.map((value) => (value === ownNamespace ? '1e5' : value)),
  valid.map((value) => (value === '45678' ? '65536' : value)),
  valid.map((value) => (value === '45678' ? '0' : value)),
  valid.map((value) => (value === '45678' ? '045678' : value)),
  valid.map((value) => (value.startsWith('neteco-ci-canary-') ? '/tmp/canary' : value)),
  valid.map((value) => (value.startsWith('neteco-ci-canary-') ? 'neteco-ci-canary-not-a-uuid' : value))
])('rejects malformed operator input without network: %#', (...args) => {
  expect(probe(args).checks.arguments).toBe(false)
})

it('fails closed for root or the same host namespace, without network or echoed canary inputs', () => {
  const report = probe(valid)
  expect(report.checks.arguments).toBe(true)
  if (process.getuid?.() === 0) {
    expect(report.checks.uid).toBe(false)
    expect(report.checks.namespaceSeparated).toBeUndefined()
  } else if (report.checks.uid && report.checks.username && report.checks.node24 && report.checks.linuxArm64) {
    expect(report.checks.namespaceSeparated).toBe(false)
  }
})

const initialArgv = process.argv,
  initialExit = process.exitCode
afterEach(() => {
  process.argv = initialArgv
  process.exitCode = initialExit
  vi.restoreAllMocks()
})
async function sourceProbe(
  options: { reachable?: string; status?: string; changedStatus?: string; errorCode?: string } = {}
) {
  vi.resetModules()
  transport.reachable.clear()
  transport.connections.length = 0
  transport.sockets.length = 0
  transport.servers.length = 0
  transport.statusReads = 0
  if (options.reachable) transport.reachable.add(options.reachable)
  transport.status = options.status ?? 'CapEff:\t0000000000000000\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t3\n'
  transport.changedStatus = options.changedStatus ?? ''
  transport.errorCode = options.errorCode ?? 'EACCES'
  vi.spyOn(process, 'getuid').mockReturnValue(980)
  const output: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
    output.push(String(value))
    return true
  })
  process.argv = [process.execPath, 'operator-probe', ...valid]
  await import('../../scripts/lib/neteco-oracle-network-probe.mjs')
  expect(output).toHaveLength(1)
  return JSON.parse(output[0]!)
}
describe('network probe source with explicit transport doubles, NOT installed-runner acceptance', () => {
  it('cannot pass when the metadata address is reachable despite isolated loopback canaries', async () => {
    const report = await sourceProbe({ reachable: '169.254.169.254' })
    expect(report.status).toBe('failed')
    expect(transport.connections.some((item) => item.host === '169.254.169.254')).toBe(true)
  })
  it('cannot perform any network when no-new-privileges protection was relaxed', async () => {
    const report = await sourceProbe({
      status: 'CapEff:\t0000000000000000\nNoNewPrivs:\t0\nSeccomp:\t2\nSeccomp_filters:\t3\n'
    })
    expect(report.status).toBe('failed')
    expect(report.networkAttempted).toBe(false)
    expect(transport.connections).toHaveLength(0)
  })
  it('cannot pass when sandbox protection changes during the probe', async () => {
    const report = await sourceProbe({
      changedStatus: 'CapEff:\t0000000000000001\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t3\n'
    })
    expect(report.status).toBe('failed')
    expect(transport.sockets.every((socket) => socket.destroyed)).toBe(true)
    expect(transport.servers.every((server) => !server.listening)).toBe(true)
  })
  it.each([
    '10.0.2.2',
    '10.0.2.3',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.1',
    '100.64.0.1',
    '92.5.3.72',
    'fd00::1',
    'fe80::1%tap0',
    '::ffff:127.0.0.1',
    '::ffff:10.0.2.2',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:92.5.3.72'
  ])('fails when the prohibited class represented by %s is reachable', async (host) => {
    const report = await sourceProbe({ reachable: host })
    expect(report.status).toBe('failed')
    expect(transport.connections.some((item) => item.host === host)).toBe(true)
  })
  it.each([
    'CapEff:\t0000000000000001\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t3\n',
    'CapEff:\t0000000000000000\nNoNewPrivs:\t1\nSeccomp:\t0\nSeccomp_filters:\t0\n',
    'CapEff:\t0000000000000000\nNoNewPrivs:\t1\nSeccomp:\t2\n',
    'CapEff:\t0000000000000000\nNoNewPrivs:\t1\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t3\n'
  ])('rejects a weakened or malformed sandbox before sockets are created: %#', async (status) => {
    const report = await sourceProbe({ status })
    expect(report.status).toBe('failed')
    expect(report.networkAttempted).toBe(false)
    expect(transport.connections).toHaveLength(0)
  })
  it('records refusals as connectivity observations, never firewall or CI acceptance, and closes every own handle', async () => {
    const report = await sourceProbe({ errorCode: 'ECONNREFUSED' })
    expect(report.status).toBe('passed')
    expect(report.evidenceScope).toBe('observed_tcp_connectivity_only')
    expect(report.supervisedHostBaselinesRequired).toBe(true)
    expect(report.supervisedPrivateBaselinesRequired).toBe(true)
    expect(report.firewallEnforcementAcceptance).toBe(false)
    expect(report.ciAdmission).toBe(false)
    expect(report.codes.metadata).toBe('ECONNREFUSED')
    expect(report.checks.metadataNotConnected).toBe(true)
    expect(transport.connections).toHaveLength(21)
    expect(transport.sockets.every((socket) => socket.destroyed)).toBe(true)
    expect(transport.servers.every((server) => !server.listening)).toBe(true)
    expect(JSON.stringify(report)).not.toMatch(/169\.254|92\.5\.3|45678|11111111-1111/)
  })
  it('does not turn unexpected socket errors into successful negative evidence', async () => {
    const report = await sourceProbe({ errorCode: 'EMFILE' })
    expect(report.status).toBe('failed')
    expect(report.codes.metadata).toBe('connection_error')
    expect(report.checks.metadataNotConnected).toBe(false)
  })
})
