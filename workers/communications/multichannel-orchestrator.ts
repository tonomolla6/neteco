import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import {
  DEFAULT_CHANNEL_PRIORITY,
  type CustomerChannelPreferences,
  type ChannelAttemptResult,
  type MultichannelChannel,
  type MultichannelStatus,
  type OrchestrateMultichannelResult,
  orchestrateMultichannelInputSchema,
  updateChannelPreferencesInputSchema,
  priorityOrderSchema
} from '../../shared/multichannel-orchestration'
import { createAccountNotification } from './account-notifications'

export class MultichannelError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'forbidden'
      | 'conflict'
      | 'not_found'
      | 'duplicate_suppressed'
      | 'opted_out_all_channels'
      | 'all_channels_exhausted'
      | 'unavailable'
  ) {
    super(code)
    this.name = 'MultichannelError'
  }
}

function fail(code: MultichannelError['code']): never {
  throw new MultichannelError(code)
}

export interface ChannelMessage {
  customerId: string
  title: string
  body: string
  metadata?: Record<string, unknown>
}

export interface ChannelTransport {
  send(message: ChannelMessage): Promise<{ success: boolean; messageId?: string; error?: string }>
}

export interface MultichannelTransportAdapters {
  email: {
    send(msg: { customerId: string; subject: string; body: string; metadata?: Record<string, unknown> }): Promise<{
      success: boolean
      messageId?: string
      error?: string
    }>
  }
  sms: {
    send(msg: { customerId: string; text: string; metadata?: Record<string, unknown> }): Promise<{
      success: boolean
      messageId?: string
      error?: string
    }>
  }
  whatsapp: {
    send(msg: { customerId: string; text: string; metadata?: Record<string, unknown> }): Promise<{
      success: boolean
      messageId?: string
      error?: string
    }>
  }
}

export interface MultichannelOptions {
  now?: () => string
  transports?: MultichannelTransportAdapters
}

function currentUtc(options?: MultichannelOptions): string {
  return options?.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function canonicalPayloadHash(payload: Record<string, unknown>): Promise<string> {
  return sha256Hex(canonicalJson(payload))
}

export async function readCustomerChannelPreferences(
  db: D1Database,
  customerId: string
): Promise<CustomerChannelPreferences> {
  if (!z.string().uuid().safeParse(customerId).success) {
    fail('invalid_input')
  }

  const row = await db
    .prepare('SELECT * FROM customer_channel_preferences WHERE customer_id = ?')
    .bind(customerId)
    .first<{
      customer_id: string
      priority_order: string
      email_enabled: number
      sms_enabled: number
      whatsapp_enabled: number
      version: number
      updated_at: string
      command_id: string
    }>()

  if (!row) {
    return {
      customerId,
      priorityOrder: [...DEFAULT_CHANNEL_PRIORITY],
      emailEnabled: true,
      smsEnabled: true,
      whatsappEnabled: true,
      version: 0,
      updatedAt: '2026-01-01T00:00:00Z',
      commandId: '00000000-0000-0000-0000-000000000000'
    }
  }

  return {
    customerId: row.customer_id,
    priorityOrder: priorityOrderSchema.parse(JSON.parse(row.priority_order)),
    emailEnabled: row.email_enabled === 1,
    smsEnabled: row.sms_enabled === 1,
    whatsappEnabled: row.whatsapp_enabled === 1,
    version: row.version,
    updatedAt: row.updated_at,
    commandId: row.command_id
  }
}

export async function updateCustomerChannelPreferences(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  customerId: string,
  commandId: string,
  rawInput: unknown,
  options?: MultichannelOptions
): Promise<CustomerChannelPreferences> {
  if (!claims) fail('unauthenticated')
  if (!z.string().uuid().safeParse(customerId).success || !z.string().uuid().safeParse(commandId).success) {
    fail('invalid_input')
  }

  const parsed = updateChannelPreferencesInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data

  const current = await readCustomerChannelPreferences(db, customerId)
  if (input.expectedVersion !== current.version) {
    fail('conflict')
  }

  const now = currentUtc(options)
  const appliedVersion = input.expectedVersion + 1
  const priorityOrder = input.priorityOrder ?? current.priorityOrder
  const emailEnabled = input.emailEnabled !== undefined ? input.emailEnabled : current.emailEnabled
  const smsEnabled = input.smsEnabled !== undefined ? input.smsEnabled : current.smsEnabled
  const whatsappEnabled = input.whatsappEnabled !== undefined ? input.whatsappEnabled : current.whatsappEnabled

  const hash = await canonicalPayloadHash({
    commandId,
    customerId,
    actorId: claims.identityId,
    expectedVersion: input.expectedVersion,
    appliedVersion,
    priorityOrder,
    emailEnabled,
    smsEnabled,
    whatsappEnabled,
    now
  })

  // Check idempotency
  const existingCmd = await db
    .prepare('SELECT * FROM customer_channel_preference_commands WHERE command_id = ?')
    .bind(commandId)
    .first<{ command_id: string; payload_hash: string }>()

  if (existingCmd) {
    if (existingCmd.payload_hash !== hash) fail('conflict')
    return readCustomerChannelPreferences(db, customerId)
  }

  const batch = [
    db
      .prepare(
        `INSERT INTO customer_channel_preference_commands(
          command_id, customer_id, actor_id, expected_version, applied_version,
          priority_order, email_enabled, sms_enabled, whatsapp_enabled, payload_hash, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        customerId,
        claims.identityId,
        input.expectedVersion,
        appliedVersion,
        JSON.stringify(priorityOrder),
        emailEnabled ? 1 : 0,
        smsEnabled ? 1 : 0,
        whatsappEnabled ? 1 : 0,
        hash,
        now
      ),
    db
      .prepare(
        `INSERT INTO customer_channel_preferences(
          customer_id, priority_order, email_enabled, sms_enabled, whatsapp_enabled,
          version, updated_at, command_id
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(customer_id) DO UPDATE SET
          priority_order = excluded.priority_order,
          email_enabled = excluded.email_enabled,
          sms_enabled = excluded.sms_enabled,
          whatsapp_enabled = excluded.whatsapp_enabled,
          version = excluded.version,
          updated_at = excluded.updated_at,
          command_id = excluded.command_id`
      )
      .bind(
        customerId,
        JSON.stringify(priorityOrder),
        emailEnabled ? 1 : 0,
        smsEnabled ? 1 : 0,
        whatsappEnabled ? 1 : 0,
        appliedVersion,
        now,
        commandId
      )
  ]

  await db.batch(batch)
  return readCustomerChannelPreferences(db, customerId)
}

export async function orchestrateMultichannelDelivery(
  db: D1Database,
  commandId: string,
  rawInput: unknown,
  options?: MultichannelOptions
): Promise<OrchestrateMultichannelResult> {
  if (!z.string().uuid().safeParse(commandId).success) fail('invalid_input')
  const parsed = orchestrateMultichannelInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data
  const now = currentUtc(options)

  // 1. Cross-channel deduplication check
  const existing = await db
    .prepare('SELECT * FROM multichannel_orchestration_commands WHERE customer_id = ? AND dedup_key = ?')
    .bind(input.customerId, input.dedupKey)
    .first<{
      command_id: string
      customer_id: string
      dedup_key: string
      category: 'pedido' | 'factura' | 'stock' | 'soporte'
      event_type: string
      selected_channel: MultichannelChannel | null
      priority_order: string
      status: MultichannelStatus
      cause: string
      results: string
      mandatory: number
      payload_hash: string
      created_at: string
    }>()

  if (existing) {
    return {
      commandId: existing.command_id,
      customerId: existing.customer_id,
      dedupKey: existing.dedup_key,
      category: existing.category,
      eventType: existing.event_type,
      selectedChannel: existing.selected_channel,
      priorityOrder: JSON.parse(existing.priority_order),
      status: existing.status,
      cause: 'duplicate_suppressed',
      results: JSON.parse(existing.results),
      mandatory: existing.mandatory === 1,
      inAppNotificationId: null,
      createdAt: existing.created_at
    }
  }

  // 2. Read preferences and priority
  const prefs = await readCustomerChannelPreferences(db, input.customerId)
  const priorityOrder: MultichannelChannel[] = input.overridePriority ?? prefs.priorityOrder

  const results: ChannelAttemptResult[] = []
  let selectedChannel: MultichannelChannel | null = null
  let finalStatus: MultichannelStatus
  let finalCause: string

  const transports = options?.transports ?? {
    email: { send: async () => ({ success: true, messageId: 'fake-default-email' }) },
    sms: { send: async () => ({ success: true, messageId: 'fake-default-sms' }) },
    whatsapp: { send: async () => ({ success: true, messageId: 'fake-default-whatsapp' }) }
  }

  // 3. Prioritized cascade
  for (const [i, channel] of priorityOrder.entries()) {
    let isChannelEnabled = false
    if (channel === 'email') isChannelEnabled = prefs.emailEnabled
    else if (channel === 'sms') isChannelEnabled = prefs.smsEnabled
    else if (channel === 'whatsapp') isChannelEnabled = prefs.whatsappEnabled

    // Mandatory notice handling: if customer opted out of all channels, mandatory falls back to canonical email
    const isMandatoryFallback = input.mandatory && !isChannelEnabled && channel === 'email'

    if (!isChannelEnabled && !isMandatoryFallback) {
      results.push({
        channel,
        status: 'skipped',
        cause: 'preference_opt_out',
        timestamp: now
      })
      continue
    }

    // Attempt delivery on this channel
    try {
      let dispatchResult: { success: boolean; messageId?: string; error?: string }
      if (channel === 'email') {
        dispatchResult = await transports.email.send({
          customerId: input.customerId,
          subject: input.title,
          body: input.body,
          metadata: input.metadata
        })
      } else if (channel === 'sms') {
        dispatchResult = await transports.sms.send({
          customerId: input.customerId,
          text: `${input.title}: ${input.body}`,
          metadata: input.metadata
        })
      } else {
        dispatchResult = await transports.whatsapp.send({
          customerId: input.customerId,
          text: `${input.title}: ${input.body}`,
          metadata: input.metadata
        })
      }

      if (dispatchResult.success) {
        selectedChannel = channel
        results.push({
          channel,
          status: 'delivered',
          cause: isMandatoryFallback ? 'mandatory_legal_fallback' : 'primary_channel_dispatched',
          providerMessageId: dispatchResult.messageId,
          timestamp: now
        })

        // Cross-channel deduplication: suppress all subsequent channels in the priority order
        for (const suppressedChannel of priorityOrder.slice(i + 1)) {
          results.push({
            channel: suppressedChannel,
            status: 'suppressed',
            cause: 'delivered_primary_channel',
            timestamp: now
          })
        }
        break
      } else {
        results.push({
          channel,
          status: 'failed',
          cause: 'channel_fallback',
          detail: dispatchResult.error ?? 'dispatch_failed',
          timestamp: now
        })
      }
    } catch (err) {
      results.push({
        channel,
        status: 'failed',
        cause: 'channel_fallback',
        detail: err instanceof Error ? err.message : 'exception',
        timestamp: now
      })
    }
  }

  // 4. Conclude status and cause
  if (selectedChannel) {
    finalStatus = 'delivered'
    const deliveredAttempt = results.find((r) => r.channel === selectedChannel)
    if (deliveredAttempt?.cause === 'mandatory_legal_fallback') {
      finalCause = 'mandatory_legal_fallback'
    } else {
      const priorAttempts = results.filter((r) => r.channel !== selectedChannel)
      const hadFailures = priorAttempts.some((r) => r.status === 'failed')
      finalCause = hadFailures ? 'channel_fallback' : 'primary_channel_dispatched'
    }
  } else {
    const allOptedOut = results.every((r) => r.status === 'skipped' && r.cause === 'preference_opt_out')
    if (allOptedOut) {
      finalStatus = 'skipped'
      finalCause = 'opted_out_all_channels'
    } else {
      finalStatus = 'failed'
      finalCause = 'all_channels_exhausted'
    }
  }

  // 5. In-app notification center ingestion
  let inAppNotificationId: string | null = null
  if (input.inAppCenter) {
    const createdNotif = await createAccountNotification(
      db,
      crypto.randomUUID(),
      {
        customerId: input.customerId,
        category: input.category,
        title: input.title,
        body: input.body,
        link: input.link,
        mandatory: input.mandatory,
        metadata: {
          ...input.metadata,
          dispatchedChannel: selectedChannel,
          orchestrationStatus: finalStatus,
          results
        },
        dedupKey: input.dedupKey
      },
      options
    )
    inAppNotificationId = createdNotif.id
  }

  // 6. Record durable immutable orchestration audit log
  const hash = await canonicalPayloadHash({
    commandId,
    customerId: input.customerId,
    dedupKey: input.dedupKey,
    category: input.category,
    eventType: input.eventType,
    selectedChannel,
    priorityOrder,
    status: finalStatus,
    cause: finalCause,
    results,
    mandatory: input.mandatory,
    now
  })

  await db
    .prepare(
      `INSERT INTO multichannel_orchestration_commands(
        command_id, customer_id, dedup_key, category, event_type, selected_channel,
        priority_order, status, cause, results, mandatory, payload_hash, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      commandId,
      input.customerId,
      input.dedupKey,
      input.category,
      input.eventType,
      selectedChannel,
      JSON.stringify(priorityOrder),
      finalStatus,
      finalCause,
      JSON.stringify(results),
      input.mandatory ? 1 : 0,
      hash,
      now
    )
    .run()

  return {
    commandId,
    customerId: input.customerId,
    dedupKey: input.dedupKey,
    category: input.category,
    eventType: input.eventType,
    selectedChannel,
    priorityOrder,
    status: finalStatus,
    cause: finalCause,
    results,
    mandatory: input.mandatory,
    inAppNotificationId,
    createdAt: now
  }
}
