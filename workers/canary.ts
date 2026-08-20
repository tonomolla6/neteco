export interface CanaryCheck {
  ok: boolean
  detail?: string
}

export interface CanaryHealth {
  ok: boolean
  service: 'neteco-cloudflare-canary'
  checks: {
    d1: CanaryCheck
    durableObjects: CanaryCheck
    kv: CanaryCheck
    queues: CanaryCheck
    r2: CanaryCheck
  }
}

function bindingCheck(value: unknown, methods: string[]): CanaryCheck {
  const binding = value as Record<string, unknown> | undefined
  const ok = !!binding && methods.every((method) => typeof binding[method] === 'function')
  return ok ? { ok } : { ok, detail: 'binding_missing_or_invalid' }
}

export async function inspectCanaryBindings(env: CloudflareEnv): Promise<CanaryHealth> {
  let d1: CanaryCheck
  try {
    const result = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()
    d1 = result?.ok === 1 ? { ok: true } : { ok: false, detail: 'probe_failed' }
  } catch {
    d1 = { ok: false, detail: 'probe_failed' }
  }

  const checks = {
    d1,
    durableObjects: bindingCheck(env.COORDINATOR, ['idFromName', 'get']),
    kv: bindingCheck(env.CACHE, ['get', 'put']),
    queues: bindingCheck(env.ASYNC_JOBS, ['send']),
    r2: bindingCheck(env.MEDIA, ['get', 'put'])
  }

  return {
    ok: Object.values(checks).every((check) => check.ok),
    service: 'neteco-cloudflare-canary',
    checks
  }
}

export class CanaryCoordinator implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: CloudflareEnv
  ) {}

  fetch(): Response {
    return Response.json({ ok: true, id: this.state.id.toString(), environment: this.env.APP_ENV })
  }
}

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.pathname !== '/health') {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }

    const health = await inspectCanaryBindings(env)
    return Response.json(health, {
      status: health.ok ? 200 : 503,
      headers: { 'cache-control': 'no-store' }
    })
  },

  queue(batch: MessageBatch): void {
    batch.ackAll()
  }
} satisfies ExportedHandler<CloudflareEnv>
