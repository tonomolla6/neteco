import { randomBytes, randomUUID } from 'node:crypto'
import {
  buildMinimizedWebhookPayload,
  calculateWebhookBackoff,
  signOutboundWebhook,
  type CreateWebhookSubscriptionInput,
  type UpdateWebhookSubscriptionInput,
  type WebhookDelivery,
  type WebhookDeliveryLog,
  type WebhookDeliveryStatus,
  type WebhookSubscription,
  type WebhookTopic
} from '../../shared/outbound-webhooks'

export class WebhooksError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'WebhooksError'
  }
}

function normalizeNow(now?: string): string {
  const value = now ?? new Date().toISOString()
  return value.replace(/\.\d{3}Z$/, 'Z')
}

function generateSecret(): string {
  return randomBytes(24).toString('hex')
}

/**
 * Crea una suscripción a webhooks salientes con URL HTTPS y secreto autogenerado.
 */
export async function createWebhookSubscription(
  db: D1Database,
  input: CreateWebhookSubscriptionInput,
  options: { ownerId: string; now?: string }
): Promise<WebhookSubscription> {
  const now = normalizeNow(options.now)
  const id = randomUUID()

  if (!input.url.startsWith('https://')) {
    throw new WebhooksError('https_required: Webhook destination URL must use HTTPS')
  }

  const primarySecret = generateSecret()
  const topicsJson = JSON.stringify(input.topics)

  await db
    .prepare(
      `INSERT INTO outbound_webhook_subscriptions
       (id, owner_id, url, topics_json, description, status, primary_secret, secondary_secret, secondary_secret_expires_at, secret_rotated_at, version, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, NULL, NULL, NULL, 1, ?7, ?7)`
    )
    .bind(id, options.ownerId, input.url, topicsJson, input.description, primarySecret, now)
    .run()

  return {
    id,
    ownerId: options.ownerId,
    url: input.url,
    topics: input.topics,
    description: input.description,
    status: 'active',
    primarySecret,
    secondarySecret: null,
    secondarySecretExpiresAt: null,
    secretRotatedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now
  }
}

/**
 * Lista las suscripciones de un usuario o del sistema.
 */
export async function listWebhookSubscriptions(db: D1Database, ownerId?: string): Promise<WebhookSubscription[]> {
  let query = `SELECT id, owner_id, url, topics_json, description, status, primary_secret, secondary_secret, secondary_secret_expires_at, secret_rotated_at, version, created_at, updated_at FROM outbound_webhook_subscriptions WHERE 1=1`
  const binds: (string | number | boolean | null)[] = []

  if (ownerId) {
    binds.push(ownerId)
    query += ` AND owner_id = ?${binds.length}`
  }

  query += ` ORDER BY created_at DESC`

  const { results } = await db
    .prepare(query)
    .bind(...binds)
    .all<{
      id: string
      owner_id: string
      url: string
      topics_json: string
      description: string
      status: 'active' | 'paused' | 'disabled'
      primary_secret: string
      secondary_secret: string | null
      secondary_secret_expires_at: string | null
      secret_rotated_at: string | null
      version: number
      created_at: string
      updated_at: string
    }>()

  return (results ?? []).map((row) => ({
    id: row.id,
    ownerId: row.owner_id,
    url: row.url,
    topics: JSON.parse(row.topics_json || '[]'),
    description: row.description,
    status: row.status,
    primarySecret: row.primary_secret,
    secondarySecret: row.secondary_secret,
    secondarySecretExpiresAt: row.secondary_secret_expires_at,
    secretRotatedAt: row.secret_rotated_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}

/**
 * Obtiene una suscripción por ID.
 */
export async function getWebhookSubscription(db: D1Database, subscriptionId: string): Promise<WebhookSubscription> {
  const row = await db
    .prepare(
      `SELECT id, owner_id, url, topics_json, description, status, primary_secret, secondary_secret, secondary_secret_expires_at, secret_rotated_at, version, created_at, updated_at
       FROM outbound_webhook_subscriptions
       WHERE id = ?1`
    )
    .bind(subscriptionId)
    .first<{
      id: string
      owner_id: string
      url: string
      topics_json: string
      description: string
      status: 'active' | 'paused' | 'disabled'
      primary_secret: string
      secondary_secret: string | null
      secondary_secret_expires_at: string | null
      secret_rotated_at: string | null
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!row) throw new WebhooksError('subscription_not_found')

  return {
    id: row.id,
    ownerId: row.owner_id,
    url: row.url,
    topics: JSON.parse(row.topics_json || '[]'),
    description: row.description,
    status: row.status,
    primarySecret: row.primary_secret,
    secondarySecret: row.secondary_secret,
    secondarySecretExpiresAt: row.secondary_secret_expires_at,
    secretRotatedAt: row.secret_rotated_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Actualiza una suscripción con protección CAS.
 */
export async function updateWebhookSubscription(
  db: D1Database,
  input: UpdateWebhookSubscriptionInput,
  options: { ownerId?: string; now?: string }
): Promise<WebhookSubscription> {
  const now = normalizeNow(options.now)
  const existing = await getWebhookSubscription(db, input.id)

  if (options.ownerId && existing.ownerId !== options.ownerId) {
    throw new WebhooksError('forbidden')
  }
  if (existing.version !== input.expectedVersion) {
    throw new WebhooksError('concurrency_conflict')
  }

  const nextVersion = existing.version + 1
  const nextUrl = input.url ?? existing.url
  const nextTopics = input.topics ? JSON.stringify(input.topics) : JSON.stringify(existing.topics)
  const nextDescription = input.description ?? existing.description
  const nextStatus = input.status ?? existing.status

  await db
    .prepare(
      `UPDATE outbound_webhook_subscriptions
       SET url = ?1, topics_json = ?2, description = ?3, status = ?4, version = ?5, updated_at = ?6
       WHERE id = ?7 AND version = ?8`
    )
    .bind(nextUrl, nextTopics, nextDescription, nextStatus, nextVersion, now, input.id, existing.version)
    .run()

  return getWebhookSubscription(db, input.id)
}

/**
 * Rota el secreto de una suscripción preservando el anterior con ventana de gracia.
 */
export async function rotateWebhookSubscriptionSecret(
  db: D1Database,
  subscriptionId: string,
  options: {
    ownerId?: string
    now?: string
    gracePeriodSeconds?: number
    expectedVersion: number
  }
): Promise<WebhookSubscription> {
  const now = normalizeNow(options.now)
  const existing = await getWebhookSubscription(db, subscriptionId)

  if (options.ownerId && existing.ownerId !== options.ownerId) {
    throw new WebhooksError('forbidden')
  }
  if (existing.version !== options.expectedVersion) {
    throw new WebhooksError('concurrency_conflict')
  }

  const graceSeconds = options.gracePeriodSeconds ?? 86400
  const expiresAt = new Date(Date.parse(now) + graceSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const newPrimarySecret = generateSecret()
  const nextVersion = existing.version + 1

  await db
    .prepare(
      `UPDATE outbound_webhook_subscriptions
       SET primary_secret = ?1, secondary_secret = ?2, secondary_secret_expires_at = ?3, secret_rotated_at = ?4, version = ?5, updated_at = ?4
       WHERE id = ?6 AND version = ?7`
    )
    .bind(newPrimarySecret, existing.primarySecret, expiresAt, now, nextVersion, subscriptionId, existing.version)
    .run()

  return getWebhookSubscription(db, subscriptionId)
}

/**
 * Encola un evento saliente para todas las suscripciones activas registradas en ese topic.
 */
export async function queueWebhookEvent(
  db: D1Database,
  event: {
    topic: WebhookTopic
    eventId: string
    payload: Record<string, unknown>
    payloadVersion?: 'v1' | '2026-10-01'
  },
  nowStr?: string
): Promise<number> {
  const now = normalizeNow(nowStr)
  const subscriptions = await listWebhookSubscriptions(db)
  const activeSubs = subscriptions.filter((s) => s.status === 'active' && s.topics.includes(event.topic))

  const payloadVersion = event.payloadVersion ?? 'v1'
  const minimized = buildMinimizedWebhookPayload(event.topic, event.payload, payloadVersion, now)
  const minimizedJson = JSON.stringify(minimized)

  let enqueued = 0
  for (const sub of activeSubs) {
    const deliveryId = randomUUID()
    await db
      .prepare(
        `INSERT INTO outbound_webhook_deliveries
         (id, subscription_id, event_id, topic, payload_version, minimized_payload_json, status, attempts, max_attempts, next_attempt_at, delivered_at, last_http_status, last_error, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, 5, ?7, NULL, NULL, NULL, 1, ?7, ?7)`
      )
      .bind(deliveryId, sub.id, event.eventId, event.topic, payloadVersion, minimizedJson, now)
      .run()
    enqueued++
  }

  return enqueued
}

/**
 * Lista entregas de webhooks con filtros por estado o suscripción.
 */
export async function listWebhookDeliveries(
  db: D1Database,
  filter?: { subscriptionId?: string; status?: WebhookDeliveryStatus; limit?: number }
): Promise<WebhookDelivery[]> {
  let query = `SELECT id, subscription_id, event_id, topic, payload_version, minimized_payload_json, status, attempts, max_attempts, next_attempt_at, delivered_at, last_http_status, last_error, version, created_at, updated_at FROM outbound_webhook_deliveries WHERE 1=1`
  const binds: (string | number | boolean | null)[] = []

  if (filter?.subscriptionId) {
    binds.push(filter.subscriptionId)
    query += ` AND subscription_id = ?${binds.length}`
  }
  if (filter?.status) {
    binds.push(filter.status)
    query += ` AND status = ?${binds.length}`
  }

  query += ` ORDER BY created_at DESC LIMIT ${filter?.limit ?? 50}`

  const { results } = await db
    .prepare(query)
    .bind(...binds)
    .all<{
      id: string
      subscription_id: string
      event_id: string
      topic: WebhookTopic
      payload_version: string
      minimized_payload_json: string
      status: WebhookDeliveryStatus
      attempts: number
      max_attempts: number
      next_attempt_at: string
      delivered_at: string | null
      last_http_status: number | null
      last_error: string | null
      version: number
      created_at: string
      updated_at: string
    }>()

  return (results ?? []).map((row) => ({
    id: row.id,
    subscriptionId: row.subscription_id,
    eventId: row.event_id,
    topic: row.topic,
    payloadVersion: row.payload_version,
    minimizedPayload: JSON.parse(row.minimized_payload_json || '{}'),
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    deliveredAt: row.delivered_at,
    lastHttpStatus: row.last_http_status,
    lastError: row.last_error,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}

/**
 * Despacha un lote de entregas pendientes o en reintento.
 */
export async function dispatchWebhookDeliveriesBatch(
  db: D1Database,
  options: {
    fetchImpl?: typeof fetch
    now?: string
    batchSize?: number
  }
): Promise<{ processed: number; delivered: number; retried: number; deadLettered: number }> {
  const now = normalizeNow(options.now)
  const fetchFn = options.fetchImpl ?? fetch
  const batchSize = options.batchSize ?? 10

  const { results } = await db
    .prepare(
      `SELECT d.id, d.subscription_id, d.event_id, d.topic, d.payload_version, d.minimized_payload_json, d.status, d.attempts, d.max_attempts, d.version,
              s.url, s.primary_secret
       FROM outbound_webhook_deliveries d
       JOIN outbound_webhook_subscriptions s ON s.id = d.subscription_id
       WHERE d.status IN ('pending', 'retrying') AND d.next_attempt_at <= ?1
       ORDER BY d.next_attempt_at ASC
       LIMIT ?2`
    )
    .bind(now, batchSize)
    .all<{
      id: string
      subscription_id: string
      event_id: string
      topic: WebhookTopic
      payload_version: string
      minimized_payload_json: string
      status: WebhookDeliveryStatus
      attempts: number
      max_attempts: number
      version: number
      url: string
      primary_secret: string
    }>()

  const batch = results ?? []
  let delivered = 0
  let retried = 0
  let deadLettered = 0

  for (const item of batch) {
    const attemptNumber = item.attempts + 1
    const payloadStr = item.minimized_payload_json
    const signature = signOutboundWebhook(payloadStr, item.primary_secret)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Neteco-Signature': signature,
      'X-Neteco-Delivery-Id': item.id,
      'X-Neteco-Event': item.topic,
      'X-Neteco-Timestamp': now,
      'X-Neteco-Version': item.payload_version,
      'User-Agent': 'Neteco-Webhooks/1.0'
    }

    let httpStatus = 0
    let errorMessage: string | null = null
    let responseSnippet: string | null = null
    const startTime = Date.now()

    try {
      const response = await fetchFn(item.url, {
        method: 'POST',
        headers,
        body: payloadStr
      })
      httpStatus = response.status
      const text = await response.text()
      responseSnippet = text.slice(0, 500)
    } catch (err: unknown) {
      errorMessage = err instanceof Error ? err.message : 'Network dispatch failure'
    }

    const latencyMs = Math.max(1, Date.now() - startTime)

    // Registrar log de intento
    const logId = randomUUID()
    await db
      .prepare(
        `INSERT INTO outbound_webhook_delivery_logs
         (id, delivery_id, attempt_number, target_url, http_status, latency_ms, error_message, request_headers_json, response_snippet, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      )
      .bind(
        logId,
        item.id,
        attemptNumber,
        item.url,
        httpStatus,
        latencyMs,
        errorMessage,
        JSON.stringify(headers),
        responseSnippet,
        now
      )
      .run()

    // Decidir nuevo estado
    const nextVersion = item.version + 1

    if (httpStatus >= 200 && httpStatus < 300) {
      // Éxito
      await db
        .prepare(
          `UPDATE outbound_webhook_deliveries
           SET status = 'delivered', attempts = ?1, delivered_at = ?2, last_http_status = ?3, last_error = NULL, version = ?4, updated_at = ?2
           WHERE id = ?5 AND version = ?6`
        )
        .bind(attemptNumber, now, httpStatus, nextVersion, item.id, item.version)
        .run()
      delivered++
    } else if (httpStatus === 410 || attemptNumber >= item.max_attempts) {
      // 410 Gone o máximo de reintentos superado -> DLQ (dead_letter)
      const errorReason =
        httpStatus === 410
          ? 'HTTP 410 Gone: endpoint permanently unavailable'
          : (errorMessage ?? `HTTP ${httpStatus} error`)
      await db
        .prepare(
          `UPDATE outbound_webhook_deliveries
           SET status = 'dead_letter', attempts = ?1, last_http_status = ?2, last_error = ?3, version = ?4, updated_at = ?5
           WHERE id = ?6 AND version = ?7`
        )
        .bind(attemptNumber, httpStatus, errorReason, nextVersion, now, item.id, item.version)
        .run()
      deadLettered++
    } else {
      // Fallo transitorio -> retrying con backoff exponencial
      const backoffSec = calculateWebhookBackoff(attemptNumber)
      const nextAttemptAt = new Date(Date.parse(now) + backoffSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      await db
        .prepare(
          `UPDATE outbound_webhook_deliveries
           SET status = 'retrying', attempts = ?1, next_attempt_at = ?2, last_http_status = ?3, last_error = ?4, version = ?5, updated_at = ?6
           WHERE id = ?7 AND version = ?8`
        )
        .bind(
          attemptNumber,
          nextAttemptAt,
          httpStatus,
          errorMessage ?? `HTTP ${httpStatus} error`,
          nextVersion,
          now,
          item.id,
          item.version
        )
        .run()
      retried++
    }
  }

  return {
    processed: batch.length,
    delivered,
    retried,
    deadLettered
  }
}

/**
 * Consulta el historial de logs de intentos de una entrega.
 */
export async function getWebhookDeliveryLogs(db: D1Database, deliveryId: string): Promise<WebhookDeliveryLog[]> {
  const { results } = await db
    .prepare(
      `SELECT id, delivery_id, attempt_number, target_url, http_status, latency_ms, error_message, request_headers_json, response_snippet, created_at
       FROM outbound_webhook_delivery_logs
       WHERE delivery_id = ?1
       ORDER BY attempt_number ASC`
    )
    .bind(deliveryId)
    .all<{
      id: string
      delivery_id: string
      attempt_number: number
      target_url: string
      http_status: number
      latency_ms: number
      error_message: string | null
      request_headers_json: string
      response_snippet: string | null
      created_at: string
    }>()

  return (results ?? []).map((row) => ({
    id: row.id,
    deliveryId: row.delivery_id,
    attemptNumber: row.attempt_number,
    targetUrl: row.target_url,
    httpStatus: row.http_status,
    latencyMs: row.latency_ms,
    errorMessage: row.error_message,
    requestHeaders: JSON.parse(row.request_headers_json || '{}'),
    responseSnippet: row.response_snippet,
    createdAt: row.created_at
  }))
}

/**
 * Reintenta una entrega muerta desde la Dead-Letter Queue (DLQ).
 */
export async function replayDeadLetterDelivery(
  db: D1Database,
  deliveryId: string,
  options: { actorId: string; now?: string }
): Promise<WebhookDelivery> {
  const now = normalizeNow(options.now)
  const existing = await db
    .prepare(
      `SELECT id, subscription_id, event_id, topic, payload_version, minimized_payload_json, status, attempts, max_attempts, next_attempt_at, delivered_at, last_http_status, last_error, version, created_at, updated_at
       FROM outbound_webhook_deliveries
       WHERE id = ?1`
    )
    .bind(deliveryId)
    .first<{
      id: string
      subscription_id: string
      event_id: string
      topic: WebhookTopic
      payload_version: string
      minimized_payload_json: string
      status: WebhookDeliveryStatus
      attempts: number
      max_attempts: number
      next_attempt_at: string
      delivered_at: string | null
      last_http_status: number | null
      last_error: string | null
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!existing) throw new WebhooksError('delivery_not_found')
  if (existing.status !== 'dead_letter') throw new WebhooksError('not_in_dlq')

  const nextVersion = existing.version + 1
  const newMaxAttempts = existing.attempts + 3 // Añadir 3 reintentos para la recuperación

  await db
    .prepare(
      `UPDATE outbound_webhook_deliveries
       SET status = 'pending', next_attempt_at = ?1, max_attempts = ?2, version = ?3, updated_at = ?1
       WHERE id = ?4 AND version = ?5`
    )
    .bind(now, newMaxAttempts, nextVersion, deliveryId, existing.version)
    .run()

  return {
    id: existing.id,
    subscriptionId: existing.subscription_id,
    eventId: existing.event_id,
    topic: existing.topic,
    payloadVersion: existing.payload_version,
    minimizedPayload: JSON.parse(existing.minimized_payload_json || '{}'),
    status: 'pending',
    attempts: existing.attempts,
    maxAttempts: newMaxAttempts,
    nextAttemptAt: now,
    deliveredAt: existing.delivered_at,
    lastHttpStatus: existing.last_http_status,
    lastError: existing.last_error,
    version: nextVersion,
    createdAt: existing.created_at,
    updatedAt: now
  }
}
