import { afterEach, expect, it, vi } from 'vitest'
import { transformSync } from 'esbuild'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { handleDeploymentHealth } from '../../workers/runtime/deployment-health'
import { buildCommitDefinitions, readBuildCommit } from '../../scripts/lib/build-commit'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function fixture() {
  const first = vi.fn().mockResolvedValue({ ok: 1 })
  const get = vi.fn().mockResolvedValue(null)
  const prepare = vi.fn(() => ({ first }))
  const env = { DB: { prepare }, CACHE: { get } } as unknown as Pick<CloudflareEnv, 'DB' | 'CACHE'>
  return { env, first, get, prepare }
}
const request = (path = '/api/health/ready', method = 'GET') => new Request('https://neteco.invalid' + path, { method })

it('reports actual D1/KV readiness without writes or provider calls', async () => {
  const f = fixture()
  const response = await handleDeploymentHealth(request(), f.env)
  expect(response!.status).toBe(200)
  expect(await response!.json()).toMatchObject({
    status: 'ready',
    runtime: 'cloudflare',
    dependencies: { database: 'ready', cache: 'ready' }
  })
  expect(f.prepare).toHaveBeenCalledExactlyOnceWith('SELECT 1 AS ok')
  expect(f.get).toHaveBeenCalledExactlyOnceWith('neteco:health:readonly')
})

it.each(['database', 'cache'] as const)('returns a private generic 503 when %s fails', async (dependency) => {
  const f = fixture()
  ;(dependency === 'database' ? f.first : f.get).mockRejectedValue(Error('private token and connection details'))
  const response = await handleDeploymentHealth(request(), f.env)
  expect(response!.status).toBe(503)
  expect(response!.headers.get('cache-control')).toBe('no-store')
  const body = await response!.text()
  expect(body).toContain('unavailable')
  expect(body).not.toMatch(/private|token|connection/)
})

it('bounds stalled dependency reads and clears its deadline after completion', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.first.mockImplementation(() => new Promise(() => {}))
  const response = handleDeploymentHealth(request(), f.env)
  await vi.advanceTimersByTimeAsync(3000)
  expect((await response)!.status).toBe(503)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps liveness independent, supports HEAD and refuses mutation methods', async () => {
  const f = fixture()
  expect((await handleDeploymentHealth(request('/api/health/live', 'HEAD'), f.env))!.status).toBe(200)
  expect(await (await handleDeploymentHealth(request('/api/health/live', 'HEAD'), f.env))!.text()).toBe('')
  const denied = await handleDeploymentHealth(request('/api/health/ready', 'POST'), f.env)
  expect(denied!.status).toBe(405)
  expect(denied!.headers.get('allow')).toBe('GET, HEAD')
  expect(f.prepare).not.toHaveBeenCalled()
  expect(f.get).not.toHaveBeenCalled()
  expect(await handleDeploymentHealth(request('/api/health/other'), f.env)).toBeNull()
})

it('bakes the Git commit with the real compiler instead of trusting a runtime override', () => {
  const sha = 'a'.repeat(40)
  const code = transformSync(readFileSync('workers/runtime/deployment-health.ts', 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    define: buildCommitDefinitions(sha)
  }).code
  const module = { exports: {} as { compiledDeploymentVersion(): string } }
  runInNewContext(code, { module, exports: module.exports, __NETECO_BUILD_COMMIT__: 'b'.repeat(40) })
  expect(module.exports.compiledDeploymentVersion()).toBe(sha)
  expect(code).not.toContain('__NETECO_BUILD_COMMIT__')
  expect(() => buildCommitDefinitions('"; arbitrary code')).toThrow('build_commit_invalid')
  expect(readBuildCommit(process.cwd())).toMatch(/^[0-9a-f]{40}$/)
})
