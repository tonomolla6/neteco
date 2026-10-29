import { handleAnalyticsHttp, ownsAnalyticsNamespace, type AnalyticsHttpDependencies } from '../analytics/http'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { configuredAnalyticsMeasurement, type AnalyticsRuntimeEnv } from './analytics-config'

function unavailable() {
  return Response.json(
    { error: { code: 'service_unavailable' } },
    {
      status: 503,
      headers: {
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow, noarchive'
      }
    }
  )
}

/** Own the namespace before Nitro/legacy Node, including disabled aliases. */
export async function handleConfiguredAnalyticsHttp(
  request: Request,
  env: AnalyticsRuntimeEnv,
  options: { now?: () => string } = {}
): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (!ownsAnalyticsNamespace(path)) return null
  try {
    const administrative = /^\/api\/admin\/analytics(?:[/\\%]|$)/i.test(path)
    const measurement = configuredAnalyticsMeasurement(env, { ...options, administrative })
    const deps: AnalyticsHttpDependencies = {
      get database() {
        return measurement.database
      },
      get origin() {
        return measurement.origin
      },
      get environment() {
        return measurement.environment
      },
      get enabled() {
        return measurement.enabled
      },
      get policy() {
        return measurement.policy
      },
      get sessionPepper() {
        return measurement.sessionPepper
      },
      get sessionCookieConfiguration() {
        return env.AUTH_ENABLED === 'true' ? { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 } : null
      },
      ...(options.now ? { now: options.now } : {}),
      edgeGate: (incoming, area) => {
        const limiter = area === 'admin' ? env.ADMIN_EDGE_LIMIT : env.ANALYTICS_EDGE_LIMIT
        if (!limiter) return Promise.resolve('unavailable' as const)
        return checkAdministrativeEdgeLimit(
          incoming,
          limiter,
          env.AUTH_RATE_LIMIT_PEPPER,
          area === 'admin' ? 'admin-analytics' : 'client-analytics'
        )
      }
    }
    return (await handleAnalyticsHttp(request, deps)) ?? unavailable()
  } catch {
    return unavailable()
  }
}
