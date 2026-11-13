declare const __NETECO_BUILD_COMMIT__: string

/** Set by Wrangler's compiler, never by an incoming request or mutable binding. */
export function compiledDeploymentVersion() {
  return typeof __NETECO_BUILD_COMMIT__ === 'string' && /^[0-9a-f]{40}$/.test(__NETECO_BUILD_COMMIT__)
    ? __NETECO_BUILD_COMMIT__
    : 'dev'
}

export async function handleDeploymentHealth(request: Request, env: Pick<CloudflareEnv, 'DB' | 'CACHE'>) {
  const path = new URL(request.url).pathname
  if (path !== '/api/health/live' && path !== '/api/health/ready') return null
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-type': 'application/json'
  }
  const response = (body: unknown, status = 200) =>
    new Response(request.method === 'HEAD' ? null : JSON.stringify(body), { status, headers })
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } })
  const common = { service: 'neteco', runtime: 'cloudflare', version: compiledDeploymentVersion() }
  if (path === '/api/health/live') return response({ status: 'ok', ...common })
  const probe = async (read: () => Promise<boolean>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        read(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 3000)
        })
      ])
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }
  const [database, cache] = await Promise.all([
    probe(async () => (await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>())?.ok === 1),
    probe(async () => {
      await env.CACHE.get('neteco:health:readonly')
      return true
    })
  ])
  const ready = database && cache
  return response(
    {
      status: ready ? 'ready' : 'unavailable',
      ...common,
      dependencies: { database: database ? 'ready' : 'unavailable', cache: cache ? 'ready' : 'unavailable' }
    },
    ready ? 200 : 503
  )
}
