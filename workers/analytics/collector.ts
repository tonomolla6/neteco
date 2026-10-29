import { z } from 'zod'
import { analyticsConsent } from '../../server/utils/analytics'
import { clientAnalyticsPropertiesContainLikelyPii } from '../../shared/promotional-analytics'
import { clientAnalyticsEventSchema, analyticsHashSchema } from '../../shared/analytics-measurement'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  AnalyticsMeasurementError,
  analyticsAssertEnabled,
  analyticsAssertCurrentConfiguration,
  analyticsAssertUnchanged,
  analyticsClock,
  analyticsChecked,
  analyticsDatabase,
  analyticsHash,
  analyticsPolicyFingerprint,
  analyticsStableJson,
  type AnalyticsMeasurementDependencies
} from './authority'

export interface AnalyticsCookieInstruction {
  name: 'neteco-analytics-id'
  value: string
  maxAgeSeconds: number
}
export type AnalyticsCollectionResult = {
  accepted: boolean
  reason: 'accepted' | 'disabled' | 'consent_required' | 'bot_excluded' | 'event_excluded'
  cookie: AnalyticsCookieInstruction | null
}
export function withdrawAnalyticsSession(): AnalyticsCookieInstruction {
  return { name: 'neteco-analytics-id', value: '', maxAgeSeconds: 0 }
}
const PRIVATE_PATH =
  /^\/(?:admin|cuenta|auth|pedido|pedidos|carrito|checkout|login|registro|recuperar-clave|restablecer-clave|verificar-email|newsletter|api)(?:\/|$)/i
const PUBLIC_PATH =
  /^\/(?:$|catalogo\/?$|buscar\/?$|categoria\/|producto\/|contenido\/|recursos(?:$|\/(?=[a-z0-9-]{1,160}$)[a-z0-9]+(?:-[a-z0-9]+)*$)|ayuda\/?$|contacto\/?$|envios\/?$|formas-de-pago\/?$|devoluciones\/?$|accesibilidad\/?$|privacidad\/?$|cookies\/?$|terminos\/?$)/

export async function collectClientAnalytics(
  deps: AnalyticsMeasurementDependencies,
  input: { event: unknown; consentCookie?: string; anonymousCookie?: string; userAgent?: string }
): Promise<AnalyticsCollectionResult> {
  const excluded = (reason: AnalyticsCollectionResult['reason']): AnalyticsCollectionResult => ({
    accepted: false,
    reason,
    cookie: null
  })
  // Do not inspect input, crypto, configuration or D1 while OFF.
  if (deps.enabled !== true) return excluded('disabled')
  if (!analyticsConsent(input.consentCookie)) return excluded('consent_required')
  const policy = analyticsAssertEnabled(deps),
    origin = deps.origin
  if (/bot|crawl|spider|lighthouse|pagespeed/i.test((input.userAgent ?? '').slice(0, 1024)))
    return excluded('bot_excluded')
  let event: z.infer<typeof clientAnalyticsEventSchema>
  try {
    event = clientAnalyticsEventSchema.parse(catalogPolicyOwnJson(input.event))
  } catch {
    throw new AnalyticsMeasurementError('invalid_input')
  }
  if (clientAnalyticsPropertiesContainLikelyPii(event)) throw new AnalyticsMeasurementError('prohibited_data')
  const at = analyticsClock(deps)
  if (Math.abs(Date.parse(event.occurredAt) - Date.parse(at)) > 86400000)
    throw new AnalyticsMeasurementError('invalid_timestamp')
  if (
    'path' in event.properties &&
    (PRIVATE_PATH.test(event.properties.path) || !PUBLIC_PATH.test(event.properties.path))
  )
    return excluded('event_excluded')
  const pepper = deps.sessionPepper
  if (!(pepper instanceof Uint8Array) || pepper.byteLength !== 32 || !pepper.some((byte) => byte !== 0))
    throw new AnalyticsMeasurementError('configuration_unavailable')
  const parsedId = catalogPolicyUuidSchema.safeParse(input.anonymousCookie)
  const id = parsedId.success ? parsedId.data : crypto.randomUUID()
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  const sessionHash = Array.from(
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`neteco:analytics:anonymous:v1:${policy.environment}:${origin}:${id}`)
      )
    ),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('')
  // Preserve the accepted Node input contract, but never persist the free-form
  // search query, URL query, token, IP address, user agent or raw cookie UUID.
  const properties =
    event.name === 'search_completed' ? { resultCount: event.properties.resultCount } : event.properties
  const occurredAt = new Date(event.occurredAt).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const payloadHash = await analyticsHash(
    analyticsStableJson({
      name: event.name,
      taxonomyVersion: 'v1',
      sessionHash,
      environment: policy.environment,
      properties,
      occurredAt
    })
  )
  // The existing Node UUID contract accepts uppercase hexadecimal too. UUID
  // casing is not a new event identity or a reason to relax the D1 key check.
  const eventId = event.eventId.toLowerCase()
  const policyFingerprint = await analyticsPolicyFingerprint(policy)
  const expiresAt = new Date(Date.parse(occurredAt) + policy.retentionDays * 86400000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
  await analyticsAssertUnchanged(deps, policyFingerprint)
  analyticsAssertCurrentConfiguration(deps, policy, origin)
  const database = analyticsDatabase(deps)
  // Server-owned table names only; never interpolate client-controlled SQL.
  const table =
    event.name === 'promotional_impression' || event.name === 'promotional_click'
      ? 'analytics_promotional_events'
      : 'analytics_client_events'
  try {
    const results = await database.batch([
      database
        .prepare(
          `INSERT INTO ${table}(event_id,name,session_hash,environment,policy_reference,policy_version,policy_fingerprint,properties_json,payload_hash,occurred_at,received_at,expires_at)
 SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12
 WHERE NOT EXISTS(SELECT 1 FROM analytics_browser_events WHERE event_id=?1)`
        )
        .bind(
          eventId,
          event.name,
          sessionHash,
          policy.environment,
          policy.reference,
          policy.version,
          policyFingerprint,
          JSON.stringify(properties),
          payloadHash,
          occurredAt,
          at,
          expiresAt
        ),
      database
        .prepare(
          'SELECT payload_hash AS payloadHash,session_hash AS sessionHash,environment FROM analytics_browser_events WHERE event_id=?'
        )
        .bind(eventId)
    ])
    const rows = analyticsChecked(
      z.array(z.object({ success: z.literal(true), results: z.array(z.unknown()) }).passthrough()).length(2),
      results
    )
    const record = analyticsChecked(
      z
        .object({ payloadHash: analyticsHashSchema, sessionHash: analyticsHashSchema, environment: z.string() })
        .strict(),
      rows[1]!.results[0]
    )
    if (
      record.payloadHash !== payloadHash ||
      record.sessionHash !== sessionHash ||
      record.environment !== policy.environment
    )
      throw new AnalyticsMeasurementError('idempotency_conflict')
    await analyticsAssertUnchanged(deps, policyFingerprint)
    analyticsAssertCurrentConfiguration(deps, policy, origin)
  } catch (error) {
    if (error instanceof AnalyticsMeasurementError) throw error
    throw new AnalyticsMeasurementError('service_unavailable')
  }
  return {
    accepted: true,
    reason: 'accepted',
    cookie: parsedId.success
      ? null
      : { name: 'neteco-analytics-id', value: id, maxAgeSeconds: Math.min(policy.retentionDays * 86400, 180 * 86400) }
  }
}
