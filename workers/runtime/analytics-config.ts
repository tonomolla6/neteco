import { analyticsMeasurementPolicySchema } from '../../shared/analytics-measurement'
import type { AnalyticsMeasurementDependencies } from '../analytics/authority'
import { operationFlag, operationsEnvironment } from './operations-config'

/** Optional configuration never grants consent or creates an approved policy. */
export type AnalyticsRuntimeEnv = CloudflareEnv & {
  ANALYTICS_ENABLED?: unknown
  ANALYTICS_PROJECTION_ENABLED?: unknown
  ANALYTICS_RETENTION_ENABLED?: unknown
  ANALYTICS_POLICY?: unknown
  ANALYTICS_SESSION_PEPPER?: unknown
  ANALYTICS_EDGE_LIMIT?: RateLimit
}

function approvedPolicy(raw: unknown) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 4096)
    throw new Error('analytics_configuration_invalid')
  try {
    return analyticsMeasurementPolicySchema.parse(JSON.parse(raw) as unknown)
  } catch {
    throw new Error('analytics_configuration_invalid')
  }
}

function sessionPepper(env: AnalyticsRuntimeEnv): Uint8Array | undefined {
  const raw = env.ANALYTICS_SESSION_PEPPER
  if (
    typeof raw !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(raw) ||
    raw === env.NEWSLETTER_HMAC_KEY ||
    raw === env.AUTH_RATE_LIMIT_PEPPER ||
    raw === env.AUTH_TOKEN_PEPPER ||
    raw === env.NUXT_SESSION_PASSWORD
  )
    return undefined
  try {
    const bytes = Uint8Array.from(atob(raw.replaceAll('-', '+').replaceAll('_', '/') + '='), (char) =>
      char.charCodeAt(0)
    )
    return bytes.length === 32 && bytes.some((byte) => byte !== 0) ? bytes : undefined
  } catch {
    return undefined
  }
}

/** Accessors retain live opt-in/policy/environment authority across awaits.
 * D1 and the dedicated pseudonym key are not inspected merely to construct
 * disabled dependencies. Retention remains independently authorised while
 * collection is OFF; it may delete only expired client telemetry. */
export function configuredAnalyticsMeasurement(
  env: AnalyticsRuntimeEnv,
  options: { administrative?: boolean; now?: () => string } = {}
): AnalyticsMeasurementDependencies {
  return {
    get database() {
      return env.DB
    },
    get origin() {
      return env.AUTH_ORIGIN
    },
    get environment() {
      return operationsEnvironment(env.APP_ENV)
    },
    get enabled() {
      return operationFlag(env.ANALYTICS_ENABLED) && (!options.administrative || env.AUTH_ENABLED === 'true')
    },
    get policy() {
      if (!operationFlag(env.ANALYTICS_ENABLED) && !operationFlag(env.ANALYTICS_RETENTION_ENABLED)) return null
      return approvedPolicy(env.ANALYTICS_POLICY)
    },
    get sessionPepper() {
      return sessionPepper(env)
    },
    ...(options.now ? { now: options.now } : {})
  }
}
