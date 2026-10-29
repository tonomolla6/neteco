import { projectAnalyticsCommerceFacts } from '../analytics/commerce-projection'
import { dispatchAnalyticsRetention } from '../analytics/retention'
import { configuredAnalyticsMeasurement, type AnalyticsRuntimeEnv } from './analytics-config'
import { operationFlag } from './operations-config'

/** Bounded local read-model work only; no provider calls or financial writes.
 * Privacy maintenance is independent of acquisition/projection. Report unknown
 * outcomes as unavailable rather than inventing a successful zero count. */
export async function dispatchConfiguredAnalytics(env: AnalyticsRuntimeEnv, now?: () => string) {
  const measurement = configuredAnalyticsMeasurement(env, { now })
  const projection = await (async () => {
    try {
      if (!operationFlag(env.ANALYTICS_PROJECTION_ENABLED)) return { enabled: false } as const
      return {
        status: 'available' as const,
        ...(await projectAnalyticsCommerceFacts(measurement, { limit: 100, maxPages: 2 }))
      }
    } catch {
      return { enabled: true, status: 'unavailable' } as const
    }
  })()
  const retention = await (async () => {
    try {
      if (!operationFlag(env.ANALYTICS_RETENTION_ENABLED)) return { enabled: false } as const
      return {
        status: 'available' as const,
        ...(await dispatchAnalyticsRetention(measurement, {
          enabled: true,
          limit: 100,
          maxBatches: 2,
          quota: { windowSeconds: 3600, maximumRequestedEvents: 1000 }
        }))
      }
    } catch {
      return { enabled: true, status: 'unavailable' } as const
    }
  })()
  return { projection, retention }
}
