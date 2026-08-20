import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { listPublishedCategories } from './catalog/categories'
import { listPublishedProducts, type ProductSort } from './catalog/products'

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
    workflows: CanaryCheck
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
    r2: bindingCheck(env.MEDIA, ['get', 'put']),
    workflows: bindingCheck(env.CATALOG_WORKFLOW, ['create', 'get'])
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

export class CanaryWorkflow extends WorkflowEntrypoint<CloudflareEnv, { correlationId: string }> {
  override async run(event: WorkflowEvent<{ correlationId: string }>, step: WorkflowStep) {
    return step.do('validate platform bindings', async () => ({
      ok: true,
      correlationId: event.payload.correlationId,
      environment: this.env.APP_ENV
    }))
  }
}

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/categories') {
      try {
        return Response.json(await listPublishedCategories(env.DB), {
          headers: { 'cache-control': 'public, max-age=60, stale-while-revalidate=300' }
        })
      } catch {
        return Response.json(
          { error: 'catalog_unavailable' },
          { status: 503, headers: { 'cache-control': 'no-store' } }
        )
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/products') {
      try {
        const page = Math.max(Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1, 1)
        const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '24', 10) || 24, 1), 100)
        const requestedSort = url.searchParams.get('sort') ?? 'default'
        const sort: ProductSort = ['name', 'price_asc', 'price_desc'].includes(requestedSort)
          ? (requestedSort as ProductSort)
          : 'default'
        const result = await listPublishedProducts(env.DB, {
          category: url.searchParams.get('category')?.slice(0, 180) || undefined,
          search: url.searchParams.get('q')?.trim().slice(0, 160) || undefined,
          page,
          limit,
          sort
        })
        if (!result) {
          return Response.json(
            { error: 'category_not_found' },
            { status: 404, headers: { 'cache-control': 'no-store' } }
          )
        }
        return Response.json(result, {
          headers: { 'cache-control': 'public, max-age=30, stale-while-revalidate=120' }
        })
      } catch {
        return Response.json(
          { error: 'catalog_unavailable' },
          { status: 503, headers: { 'cache-control': 'no-store' } }
        )
      }
    }
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
