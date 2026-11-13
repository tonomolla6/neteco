import { connect as connectSocket, type Socket } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PRIVATE_BROWSER_ENDPOINT = 'ws://127.0.0.1:8997/neteco-ci-browser'
export const PRIVATE_BROWSER_SOCKET = '/var/lib/neteco-ci/browser-transport/browser.sock'
interface ShellOptions {
  env?: NodeJS.ProcessEnv
  platform?: string
  arch?: string
  connect?: () => Socket
  spawn?: (script: string, env: NodeJS.ProcessEnv) => ChildProcess
  signals?: Pick<EventEmitter, 'on' | 'off'>
}

/** The root-managed socket starts only a fixed SSH transport. This command and
 * every test still run as the isolated runner user, without credentials or sudo. */
export async function runRemoteBrowserShell(script: string, options: ShellOptions = {}): Promise<number> {
  const env = options.env ?? process.env
  const target = env.NETECO_GITHUB_REPOSITORY
  const temp = env.RUNNER_TEMP ?? ''
  const path = relative(temp, script)
  if (
    env.CI !== 'true' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_ENVIRONMENT !== 'self-hosted' ||
    env.RUNNER_ARCH !== 'ARM64' ||
    (options.platform ?? process.platform) !== 'linux' ||
    (options.arch ?? process.arch) !== 'arm64' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '') ||
    !target ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(target) ||
    target.toLowerCase() === 'publicher0/neteco-shop' ||
    target !== env.GITHUB_REPOSITORY ||
    env.PW_TEST_CONNECT_WS_ENDPOINT !== PRIVATE_BROWSER_ENDPOINT ||
    !isAbsolute(temp) ||
    !isAbsolute(script) ||
    !path ||
    path.startsWith('..') ||
    isAbsolute(path) ||
    // GitHub omits the extension for custom shell executables. Its script is
    // still a generated UUID directly inside RUNNER_TEMP, not an arbitrary path.
    (!script.endsWith('.sh') && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(path))
  )
    throw new Error('remote_browser_shell_unauthorized')

  const socket = (options.connect ?? (() => connectSocket(PRIVATE_BROWSER_SOCKET)))()
  let child: ChildProcess | undefined,
    lost = false,
    closing = false,
    interrupted: NodeJS.Signals | undefined
  const signals = options.signals ?? process
  const lostLease = () => {
    if (!closing) {
      lost = true
      child?.kill('SIGTERM')
    }
  }
  const interrupt = () => {
    interrupted = 'SIGINT'
    child?.kill('SIGINT')
  }
  const terminate = () => {
    interrupted = 'SIGTERM'
    child?.kill('SIGTERM')
  }
  socket.on('close', lostLease)
  socket.on('error', lostLease)
  try {
    await new Promise<void>((ready, reject) => {
      let buffer = ''
      const timeout = setTimeout(fail, 10_000)
      function cleanup() {
        clearTimeout(timeout)
        socket.off('data', data)
        socket.off('close', fail)
        socket.off('error', fail)
      }
      function fail() {
        cleanup()
        reject(new Error('remote_browser_lease_unavailable'))
      }
      function data(chunk: Buffer | string) {
        buffer += String(chunk)
        if (buffer.length > 16_384) return fail()
        const announcement = buffer.match(/(?:^|\n)Listening on (\S+)\r?\n/)
        if (!announcement) return
        if (announcement[1] !== PRIVATE_BROWSER_ENDPOINT) return fail()
        cleanup()
        ready()
      }
      socket.on('data', data)
      socket.on('close', fail)
      socket.on('error', fail)
    })
    if (lost) throw new Error('remote_browser_lease_lost')
    child = (
      options.spawn ??
      ((script, env) =>
        spawn('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', script], { env, stdio: 'inherit' }))
    )(script, {
      ...env,
      PW_TEST_CONNECT_EXPOSE_NETWORK: '<loopback>'
    })
    signals.on('SIGINT', interrupt)
    signals.on('SIGTERM', terminate)
    const status = await new Promise<number>((done, reject) => {
      child!.once('error', () => reject(new Error('remote_browser_command_unavailable')))
      child!.once('exit', (code, signal) => done(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)))
    })
    if (lost) throw new Error('remote_browser_lease_lost')
    if (interrupted) return interrupted === 'SIGINT' ? 130 : 143
    return status
  } finally {
    closing = true
    signals.off('SIGINT', interrupt)
    signals.off('SIGTERM', terminate)
    socket.off('close', lostLease)
    socket.off('error', lostLease)
    socket.destroy()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 3) {
    process.stderr.write('remote_browser_shell_invalid_arguments\n')
    process.exitCode = 1
  } else {
    try {
      process.exitCode = await runRemoteBrowserShell(process.argv[2]!)
    } catch {
      process.stderr.write('remote_browser_shell_failed: private operator transport or check unavailable\n')
      process.exitCode = 1
    }
  }
}
