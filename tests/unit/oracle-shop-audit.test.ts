import { describe, expect, it, vi } from 'vitest'
import { lstat, open } from 'node:fs/promises'
import { runOracleShopAudit, validateOraclePreflight } from '../../scripts/lib/oracle-shop-audit'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) }
})

const hosted = { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }
const trusted = {
  ...hosted,
  RUNNER_ENVIRONMENT: 'self-hosted',
  RUNNER_ARCH: 'ARM64',
  RUNNER_NAME: 'synthetic-oracle',
  PW_TEST_CONNECT_WS_ENDPOINT: 'ws://127.0.0.1:43123/private-browser',
  // Fictional unit fixture only, not an identified or authorized repository.
  NETECO_GITHUB_REPOSITORY: 'example-owned/neteco',
  GITHUB_REPOSITORY: 'example-owned/neteco',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'push'
}
const now = Date.parse('2026-10-08T12:00:00Z')
function evidence() {
  return {
    manifest: {
      version: 1,
      oraclePublicIp: '92.5.3.72',
      repository: 'example-owned/neteco',
      uid: 1001,
      user: 'synthetic-ci',
      runnerName: trusted.RUNNER_NAME,
      machineIdSha256: 'a'.repeat(64),
      workRoot: '/srv/neteco-ci',
      verifiedAt: '2026-10-08T11:00:00Z',
      expiresAt: '2026-10-08T13:00:00Z'
    },
    uid: 1001,
    user: 'synthetic-ci',
    machineIdSha256: 'a'.repeat(64),
    cwd: '/srv/neteco-ci/work/repo',
    temp: '/srv/neteco-ci/temp/job',
    workRoot: '/srv/neteco-ci'
  }
}
function fixture() {
  const close = vi.fn(async () => {}),
    connectBrowser = vi.fn(async (_endpoint: string) => ({ close })),
    execute = vi.fn(async (_env: NodeJS.ProcessEnv) => 0)
  return { close, connectBrowser, execute, preflight: vi.fn(async () => evidence()), arch: 'arm64', now }
}

describe('fail-closed Oracle shop browser audit (synthetic admission evidence only)', () => {
  it.each([
    { target: undefined },
    { target: 'different-owned/neteco' },
    { target: 'invalid/name/extra', current: 'invalid/name/extra' },
    { target: ' example-owned/neteco', current: ' example-owned/neteco' },
    { target: 'PublicHer0/neteco-shop', current: 'PublicHer0/neteco-shop' },
    { target: 'publicher0/neteco-shop', current: 'publicher0/neteco-shop' }
  ])(
    'rejects missing/mismatched targets and the clone reference even with matching evidence: %j',
    async ({ target, current }) => {
      const f = fixture()
      if (current) {
        const e = evidence()
        f.preflight.mockResolvedValue({ ...e, manifest: { ...e.manifest, repository: current } })
      }
      await expect(
        runOracleShopAudit({
          ...f,
          env: { ...trusted, NETECO_GITHUB_REPOSITORY: target, ...(current ? { GITHUB_REPOSITORY: current } : {}) },
          platform: 'linux'
        })
      ).rejects.toThrow()
      expect(f.connectBrowser).not.toHaveBeenCalled()
      expect(f.execute).not.toHaveBeenCalled()
    }
  )
  it.each([
    { uid: 1001, mode: 0o644, link: false, file: true },
    { uid: 0, mode: 0o664, link: false, file: true },
    { uid: 0, mode: 0o646, link: false, file: true },
    { uid: 0, mode: 0o644, link: true, file: true },
    { uid: 0, mode: 0o644, link: false, file: false }
  ])('rejects an untrusted preflight file before reading it: %j', async (stat) => {
    const f = fixture()
    vi.mocked(lstat).mockResolvedValueOnce({
      ...stat,
      isSymbolicLink: () => stat.link,
      isFile: () => stat.file
    } as unknown as Awaited<ReturnType<typeof lstat>>)
    vi.mocked(open).mockClear()
    await expect(runOracleShopAudit({ ...f, preflight: undefined, env: trusted, platform: 'linux' })).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
    expect(f.connectBrowser).not.toHaveBeenCalled()
  })
  it('rejects an untrusted ancestor before opening the preflight file', async () => {
    const f = fixture()
    vi.mocked(lstat)
      .mockResolvedValueOnce({
        uid: 0,
        mode: 0o644,
        isSymbolicLink: () => false,
        isFile: () => true
      } as unknown as Awaited<ReturnType<typeof lstat>>)
      .mockResolvedValueOnce({
        uid: 1001,
        mode: 0o755,
        isSymbolicLink: () => false,
        isDirectory: () => true
      } as unknown as Awaited<ReturnType<typeof lstat>>)
    vi.mocked(open).mockClear()
    await expect(runOracleShopAudit({ ...f, preflight: undefined, env: trusted, platform: 'linux' })).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
    expect(f.connectBrowser).not.toHaveBeenCalled()
  })
  it('rejects an unverified self-hosted runner before launching', async () => {
    const f = fixture()
    f.preflight.mockRejectedValue(new Error('missing root-managed preflight'))
    await expect(runOracleShopAudit({ ...f, env: trusted, platform: 'linux' })).rejects.toThrow()
    expect(f.connectBrowser).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
  })
  it.each([
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'pull_request_target' },
    { GITHUB_REF: 'refs/heads/other' },
    { GITHUB_REPOSITORY: 'fork/neteco-shop' },
    { RUNNER_ARCH: 'X64' }
  ])('rejects unauthorized CI metadata %j', async (override) => {
    const f = fixture()
    await expect(runOracleShopAudit({ ...f, env: { ...trusted, ...override }, platform: 'linux' })).rejects.toThrow()
    expect(f.preflight).not.toHaveBeenCalled()
    expect(f.connectBrowser).not.toHaveBeenCalled()
  })
  it('rejects an actual non-ARM64 process despite its environment label', async () => {
    const f = fixture()
    await expect(runOracleShopAudit({ ...f, env: trusted, platform: 'linux', arch: 'x64' })).rejects.toThrow()
    expect(f.connectBrowser).not.toHaveBeenCalled()
  })
  it.each([
    { uid: 0 },
    { uid: 1002 },
    { user: 'other' },
    { machineIdSha256: 'b'.repeat(64) },
    { cwd: '/root/agent/repo' },
    { temp: '/tmp/job' },
    { temp: '/srv/neteco-ci-evil/job' },
    { workRoot: '/srv/another-root' }
  ])('rejects mismatched local evidence %j', async (override) => {
    const f = fixture()
    f.preflight.mockResolvedValue({ ...evidence(), ...override })
    await expect(runOracleShopAudit({ ...f, env: trusted, platform: 'linux' })).rejects.toThrow()
    expect(f.connectBrowser).not.toHaveBeenCalled()
  })
  it.each([
    { version: 2 },
    { oraclePublicIp: 'other' },
    { repository: 'fork/neteco-shop' },
    { uid: 0 },
    { runnerName: 'other' },
    { workRoot: '/' },
    { verifiedAt: '2026-10-08T12:01:00Z' },
    { expiresAt: '2026-10-08T12:00:00Z' },
    { expiresAt: 'invalid' }
  ])('rejects invalid or expired preflight manifest %j', (override) => {
    const e = evidence()
    expect(() => validateOraclePreflight({ ...e, manifest: { ...e.manifest, ...override } }, trusted, now)).toThrow()
  })
  it('admits trusted manual main events only with matching synthetic evidence', async () => {
    const f = fixture()
    expect(
      await runOracleShopAudit({ ...f, env: { ...trusted, GITHUB_EVENT_NAME: 'workflow_dispatch' }, platform: 'linux' })
    ).toBe(0)
    expect(f.preflight).toHaveBeenCalledOnce()
    expect(f.close).toHaveBeenCalledOnce()
  })
  it.each([hosted, { ...hosted, RUNNER_NAME: 'oracle-looking-name', RUNNER_ARCH: 'ARM64' }])(
    'rejects GitHub-hosted execution before browser launch even with Oracle-looking metadata: %j',
    async (env) => {
      const f = fixture()
      await expect(runOracleShopAudit({ ...f, env, platform: 'linux' })).rejects.toThrow()
      expect(f.connectBrowser).not.toHaveBeenCalled()
      expect(f.execute).not.toHaveBeenCalled()
    }
  )
  it.each([
    {},
    { ...hosted, CI: 'false' },
    { ...hosted, GITHUB_ACTIONS: 'false' },
    { ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' },
    { ...hosted, PW_TEST_CONNECT_WS_ENDPOINT: 'ws://127.0.0.1:43123/existing' }
  ])('fails closed before launching or executing with %j', async (env) => {
    const f = fixture()
    await expect(runOracleShopAudit({ ...f, env, platform: 'linux' })).rejects.toThrow()
    expect(f.connectBrowser).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('does not launch on unsupported platforms', async () => {
    const f = fixture()
    await expect(runOracleShopAudit({ ...f, env: trusted, platform: 'darwin' })).rejects.toThrow()
    expect(f.connectBrowser).not.toHaveBeenCalled()
  })
  it.each([0, 1, 23])(
    'preserves audit exit %i and closes its remote connection before starting the audit',
    async (code) => {
      const f = fixture(),
        env = { ...trusted, SYNTHETIC_SETTING: 'preserved' }
      f.execute.mockResolvedValue(code)
      expect(await runOracleShopAudit({ ...f, env, platform: 'linux' })).toBe(code)
      expect(f.execute).toHaveBeenCalledExactlyOnceWith({
        ...env,
        PW_TEST_CONNECT_WS_ENDPOINT: trusted.PW_TEST_CONNECT_WS_ENDPOINT,
        PW_TEST_CONNECT_EXPOSE_NETWORK: '<loopback>',
        NUXT_TELEMETRY_DISABLED: '1',
        WRANGLER_SEND_METRICS: 'false'
      })
      expect(env.PW_TEST_CONNECT_WS_ENDPOINT).toBe(trusted.PW_TEST_CONNECT_WS_ENDPOINT)
      expect(env).not.toHaveProperty('PW_TEST_CONNECT_EXPOSE_NETWORK')
      expect(f.connectBrowser).toHaveBeenCalledExactlyOnceWith(trusted.PW_TEST_CONNECT_WS_ENDPOINT)
      expect(f.close.mock.invocationCallOrder[0]).toBeLessThan(f.execute.mock.invocationCallOrder[0]!)
      expect(f.close).toHaveBeenCalledOnce()
    }
  )
  it('has already closed its remote probe if the audit cannot start', async () => {
    const f = fixture()
    f.execute.mockRejectedValue(new Error('synthetic child failure'))
    await expect(runOracleShopAudit({ ...f, env: trusted, platform: 'linux' })).rejects.toThrow()
    expect(f.close).toHaveBeenCalledOnce()
  })
  it.each([
    'ws://0.0.0.0:43123/private-browser',
    'ws://example.invalid:43123/private-browser',
    'https://127.0.0.1:43123/private-browser',
    'ws://127.0.0.1:43123/',
    'ws://user:pass@127.0.0.1:43123/private-browser',
    'ws://127.0.0.1:43123/private-browser?token=private',
    'ws://127.0.0.1:43123/private-browser#private',
    'ws://127.0.0.1:43123/private-browser\n',
    'not a URL'
  ])('never passes a non-private endpoint to the child: %s', async (endpoint) => {
    const f = fixture()
    await expect(
      runOracleShopAudit({ ...f, env: { ...trusted, PW_TEST_CONNECT_WS_ENDPOINT: endpoint }, platform: 'linux' })
    ).rejects.toThrow()
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.connectBrowser).not.toHaveBeenCalled()
    expect(f.close).not.toHaveBeenCalled()
  })
  it('rejects a missing remote transport without launching locally or executing the audit', async () => {
    const f = fixture()
    await expect(
      runOracleShopAudit({ ...f, env: { ...trusted, PW_TEST_CONNECT_WS_ENDPOINT: undefined }, platform: 'linux' })
    ).rejects.toThrow()
    expect(f.connectBrowser).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('fails closed when the remote probe fails without executing or falling back', async () => {
    const f = fixture()
    f.connectBrowser.mockRejectedValueOnce(new Error('synthetic remote unavailable'))
    await expect(runOracleShopAudit({ ...f, env: trusted, platform: 'linux' })).rejects.toThrow()
    expect(f.connectBrowser).toHaveBeenCalledOnce()
    expect(f.execute).not.toHaveBeenCalled()
  })
})
