import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { runRemoteBrowserShell } from '../../scripts/lib/remote-browser-shell'

type ShellOptions = NonNullable<Parameters<typeof runRemoteBrowserShell>[1]>
type Socket = ReturnType<NonNullable<ShellOptions['connect']>>

const endpoint = 'ws://127.0.0.1:8997/neteco-ci-browser'
const env = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'self-hosted',
  RUNNER_ARCH: 'ARM64',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'push',
  NETECO_GITHUB_REPOSITORY: 'example-owned/neteco',
  GITHUB_REPOSITORY: 'example-owned/neteco',
  RUNNER_TEMP: '/srv/runner/temp',
  PW_TEST_CONNECT_WS_ENDPOINT: endpoint
}
function fixture(options: { status?: number; ready?: string; disconnect?: boolean; unavailable?: boolean } = {}) {
  const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() })
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) })
  const connect = vi.fn(() => {
    queueMicrotask(() => {
      if (options.unavailable) socket.emit('error', new Error('private details must not escape'))
      else {
        socket.emit('data', Buffer.from('resource gate PASS\nListen'))
        socket.emit('data', Buffer.from(options.ready ?? `ing on ${endpoint}\n`))
      }
    })
    return socket as unknown as Socket
  })
  const spawn = vi.fn(() => {
    queueMicrotask(() => {
      if (options.disconnect) socket.emit('close')
      child.emit('exit', options.status ?? 0, null)
    })
    return child as unknown as ChildProcess
  })
  const signals = new EventEmitter()
  return {
    socket,
    child,
    connect,
    spawn,
    signals,
    options: { env, platform: 'linux', arch: 'arm64', connect, spawn, signals }
  }
}

describe('private Oracle browser shell lease', () => {
  it('starts the blocking shell only after the private provider is ready and releases the lease', async () => {
    const f = fixture()
    expect(await runRemoteBrowserShell('/srv/runner/temp/step.sh', f.options)).toBe(0)
    expect(f.spawn).toHaveBeenCalledExactlyOnceWith(
      '/srv/runner/temp/step.sh',
      expect.objectContaining({ PW_TEST_CONNECT_WS_ENDPOINT: endpoint })
    )
    expect(f.socket.destroy).toHaveBeenCalledOnce()
    expect(f.signals.listenerCount('SIGTERM')).toBe(0)
  })
  it('preserves a failed check rather than approving its promotion', async () => {
    const f = fixture({ status: 23 })
    expect(await runRemoteBrowserShell('/srv/runner/temp/step.sh', f.options)).toBe(23)
    expect(f.socket.destroy).toHaveBeenCalledOnce()
  })
  it('fails closed without exposing provider errors if the operator service is unavailable', async () => {
    const f = fixture({ unavailable: true })
    await expect(runRemoteBrowserShell('/srv/runner/temp/step.sh', f.options)).rejects.toThrow(
      'remote_browser_lease_unavailable'
    )
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.socket.destroy).toHaveBeenCalledOnce()
  })
  it('kills its own command and fails if the lease disappears during a check', async () => {
    const f = fixture({ disconnect: true })
    await expect(runRemoteBrowserShell('/srv/runner/temp/step.sh', f.options)).rejects.toThrow(
      'remote_browser_lease_lost'
    )
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(f.socket.destroy).toHaveBeenCalledOnce()
  })
  it('does not accept a provider announcing another endpoint', async () => {
    const f = fixture({ ready: 'ing on ws://elsewhere.invalid:8997/browser\n' })
    await expect(runRemoteBrowserShell('/srv/runner/temp/step.sh', f.options)).rejects.toThrow(
      'remote_browser_lease_unavailable'
    )
    expect(f.spawn).not.toHaveBeenCalled()
  })
  it('keeps cancellation nonzero even if its command handles the signal and exits zero', async () => {
    const f = fixture()
    f.spawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        f.signals.emit('SIGTERM')
        f.child.emit('exit', 0, null)
      })
      return f.child as unknown as ChildProcess
    })
    expect(await runRemoteBrowserShell('/srv/runner/temp/step.sh', f.options)).toBe(143)
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(f.socket.destroy).toHaveBeenCalledOnce()
  })
  it.each([
    { CI: 'false' },
    { GITHUB_ACTIONS: 'false' },
    { RUNNER_ENVIRONMENT: 'github-hosted' },
    { RUNNER_ARCH: 'X64' },
    { GITHUB_REF: 'refs/heads/other' },
    { GITHUB_EVENT_NAME: 'pull_request_target' },
    { GITHUB_REPOSITORY: 'fork/neteco' },
    { NETECO_GITHUB_REPOSITORY: 'PublicHer0/neteco-shop', GITHUB_REPOSITORY: 'PublicHer0/neteco-shop' },
    { PW_TEST_CONNECT_WS_ENDPOINT: 'ws://remote.invalid:8997/browser' },
    { RUNNER_TEMP: '/srv/other' }
  ])('rejects an unauthorized job before requesting privileged transport: %j', async (override) => {
    const f = fixture()
    await expect(
      runRemoteBrowserShell('/srv/runner/temp/step.sh', { ...f.options, env: { ...env, ...override } })
    ).rejects.toThrow()
    expect(f.connect).not.toHaveBeenCalled()
    expect(f.spawn).not.toHaveBeenCalled()
  })
  it.each([{ platform: 'darwin' }, { arch: 'x64' }])('requires the real Oracle platform: %j', async (override) => {
    const f = fixture()
    await expect(runRemoteBrowserShell('/srv/runner/temp/step.sh', { ...f.options, ...override })).rejects.toThrow()
    expect(f.connect).not.toHaveBeenCalled()
  })
})
