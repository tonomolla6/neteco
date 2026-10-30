import { z } from 'zod'
import type { VerifiedSessionClaims } from './authorization'
import { canonicalPayloadHash } from './cart'
import { checkAdminAuthority, isConstraintFailure, isUuid, serverNow } from './admin-command-authority'
import { sellableExpression } from './inventory'
import { effectiveGrossCentsExpression, parameterizeEffectivePricingSql } from './pricing'
import {
  ChannelFeedError,
  channelFeedTransformSchema,
  channelSchema,
  transformFeedItem,
  type ChannelFeed,
  type ChannelFeedTransform,
  type FeedExclusion,
  type FeedSourceRow,
  type ChannelFeedItem
} from '../../shared/channel-feeds'

interface Options {
  now?: () => string
}

const MAX_FEED_ROWS = 5000

const publishInputSchema = z
  .object({ expectedLatestVersion: z.number().int().min(0).max(1_000_000), config: z.unknown() })
  .strict()
const activateInputSchema = z
  .object({
    version: z.number().int().min(1).max(1_000_000),
    expectedActiveVersion: z.number().int().min(0).max(1_000_000)
  })
  .strict()

function parseChannel(value: unknown) {
  const parsed = channelSchema.safeParse(value)
  if (!parsed.success) throw new ChannelFeedError('invalid_input')
  return parsed.data
}

async function requireAdmin(database: D1Database, claims: VerifiedSessionClaims | null, now: string) {
  const authority = await checkAdminAuthority(database, claims, now)
  if (!authority.ok) throw new ChannelFeedError(authority.code)
  return authority.actorId
}

export interface PublishedTransform {
  commandId: string
  channel: string
  version: number
  configHash: string
  createdAt: string
}

export async function publishChannelTransform(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  commandId: string,
  channelInput: unknown,
  rawInput: unknown,
  options?: Options
): Promise<PublishedTransform> {
  const channel = parseChannel(channelInput)
  if (!isUuid(commandId)) throw new ChannelFeedError('invalid_input')
  const input = publishInputSchema.safeParse(rawInput)
  if (!input.success) throw new ChannelFeedError('invalid_input')
  const config = channelFeedTransformSchema.safeParse(input.data.config ?? {})
  if (!config.success) throw new ChannelFeedError('invalid_input')

  const now = serverNow(options?.now)
  const actorId = await requireAdmin(database, claims, now)
  const configHash = await canonicalPayloadHash(config.data)
  const expected = input.data.expectedLatestVersion

  const existing = await database
    .prepare(
      `SELECT channel, version, config_hash AS configHash, actor_id AS actorId, created_at AS createdAt
       FROM channel_feed_transform_versions WHERE command_id = ?1`
    )
    .bind(commandId)
    .first<{ channel: string; version: number; configHash: string; actorId: string; createdAt: string }>()
  if (existing) {
    if (
      existing.channel !== channel ||
      existing.configHash !== configHash ||
      existing.actorId !== actorId ||
      existing.version !== expected + 1
    )
      throw new ChannelFeedError('conflict')
    return { commandId, channel, version: existing.version, configHash, createdAt: existing.createdAt }
  }

  const latest = await database
    .prepare('SELECT COALESCE(max(version), 0) AS latest FROM channel_feed_transform_versions WHERE channel = ?1')
    .bind(channel)
    .first<{ latest: number }>()
  if ((latest?.latest ?? 0) !== expected) throw new ChannelFeedError('conflict')

  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO channel_feed_transform_versions(channel, version, config_json, config_hash, command_id, actor_id, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
        )
        .bind(channel, expected + 1, JSON.stringify(config.data), configHash, commandId, actorId, now)
    ])
  } catch (error) {
    if (isConstraintFailure(error, 'conflict', 'UNIQUE', 'PRIMARY KEY')) throw new ChannelFeedError('conflict')
    throw error
  }
  return { commandId, channel, version: expected + 1, configHash, createdAt: now }
}

export interface ChannelActivation {
  commandId: string
  channel: string
  fromVersion: number
  toVersion: number
  createdAt: string
}

export async function activateChannelTransform(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  commandId: string,
  channelInput: unknown,
  rawInput: unknown,
  options?: Options
): Promise<ChannelActivation> {
  const channel = parseChannel(channelInput)
  if (!isUuid(commandId)) throw new ChannelFeedError('invalid_input')
  const parsed = activateInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new ChannelFeedError('invalid_input')
  const { version, expectedActiveVersion } = parsed.data

  const now = serverNow(options?.now)
  const actorId = await requireAdmin(database, claims, now)
  const payloadHash = await canonicalPayloadHash({ channel, actorId, version, expectedActiveVersion })

  const existing = await database
    .prepare(
      `SELECT channel, from_version AS fromVersion, to_version AS toVersion, payload_hash AS payloadHash, created_at AS createdAt
       FROM channel_feed_activations WHERE command_id = ?1`
    )
    .bind(commandId)
    .first<ChannelActivation & { payloadHash: string }>()
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new ChannelFeedError('conflict')
    return {
      commandId,
      channel,
      fromVersion: existing.fromVersion,
      toVersion: existing.toVersion,
      createdAt: existing.createdAt
    }
  }

  const target = await database
    .prepare('SELECT 1 AS present FROM channel_feed_transform_versions WHERE channel = ?1 AND version = ?2')
    .bind(channel, version)
    .first()
  if (!target) throw new ChannelFeedError('not_found')
  const active = await database
    .prepare('SELECT version FROM channel_feed_active_transforms WHERE channel = ?1')
    .bind(channel)
    .first<{ version: number }>()
  if ((active?.version ?? 0) !== expectedActiveVersion) throw new ChannelFeedError('conflict')

  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO channel_feed_activations(command_id, channel, from_version, to_version, seq, actor_id, payload_hash, created_at)
           VALUES (?1, ?2, ?3, ?4, COALESCE((SELECT max(seq) FROM channel_feed_activations WHERE channel = ?2), 0) + 1, ?5, ?6, ?7)`
        )
        .bind(commandId, channel, expectedActiveVersion, version, actorId, payloadHash, now),
      database
        .prepare(
          `INSERT INTO channel_feed_active_transforms(channel, version, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(channel) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`
        )
        .bind(channel, version, now)
    ])
  } catch (error) {
    if (isConstraintFailure(error, 'allocation_exceeded')) throw new ChannelFeedError('allocation_exceeded')
    if (isConstraintFailure(error, 'conflict', 'UNIQUE', 'PRIMARY KEY')) throw new ChannelFeedError('conflict')
    throw error
  }
  return { commandId, channel, fromVersion: expectedActiveVersion, toVersion: version, createdAt: now }
}

export async function listChannelTransforms(database: D1Database, channelInput: unknown) {
  const channel = parseChannel(channelInput)
  const [versions, active] = await Promise.all([
    database
      .prepare(
        `SELECT version, config_json AS configJson, config_hash AS configHash, created_at AS createdAt
         FROM channel_feed_transform_versions WHERE channel = ?1 ORDER BY version`
      )
      .bind(channel)
      .all<{ version: number; configJson: string; configHash: string; createdAt: string }>(),
    database
      .prepare('SELECT version FROM channel_feed_active_transforms WHERE channel = ?1')
      .bind(channel)
      .first<{ version: number }>()
  ])
  return {
    channel,
    activeVersion: active?.version ?? 0,
    versions: versions.results.map((row) => ({
      version: row.version,
      config: JSON.parse(row.configJson) as ChannelFeedTransform,
      configHash: row.configHash,
      createdAt: row.createdAt
    }))
  }
}

const SOURCE_SQL = `
  SELECT v.id AS variantId, v.sku, v.gtin, p.name AS productName, p.slug,
         COALESCE(br.name, 'NETECO') AS brand,
         ${effectiveGrossCentsExpression('v')} AS priceGrossCents,
         CAST((SELECT TOTAL(${sellableExpression()}) FROM inventory_balances b WHERE b.variant_id = v.id) AS INTEGER) AS availableUnits,
         v.backorder_allowed AS backorderAllowed,
         (v.status = 'published' AND p.status = 'published') AS published,
         (sp.kind = 'adr' OR COALESCE(spa.adr_class, 'NONE') <> 'NONE') AS hazardous
  FROM variants v
  JOIN products p ON p.id = v.product_id
  LEFT JOIN brands br ON br.id = p.brand_id
  JOIN shipping_profiles sp ON sp.id = v.shipping_profile_id
  LEFT JOIN variant_adr_specifications spa ON spa.variant_id = v.id
  WHERE v.status <> 'draft' AND p.status <> 'draft'
  ORDER BY v.sku
  LIMIT ${MAX_FEED_ROWS + 1}`

export async function loadFeedSourceRows(database: D1Database, instant: string): Promise<FeedSourceRow[]> {
  const { sql, instantParameters } = parameterizeEffectivePricingSql(SOURCE_SQL, instant)
  const { results } = await database
    .prepare(sql)
    .bind(...instantParameters)
    .all<
      Omit<FeedSourceRow, 'backorderAllowed' | 'published' | 'hazardous'> &
        Record<'backorderAllowed' | 'published' | 'hazardous', number>
    >()
  if (results.length > MAX_FEED_ROWS) throw new ChannelFeedError('too_large')
  return results.map((row) => ({
    ...row,
    backorderAllowed: row.backorderAllowed === 1,
    published: row.published === 1,
    hazardous: row.hazardous === 1
  }))
}

/** Feeds are only ever produced from an ACTIVE, versioned transform; there is no unversioned path. */
export async function generateChannelFeed(
  database: D1Database,
  channelInput: unknown,
  query: { origin: string } & Options
): Promise<ChannelFeed> {
  const channel = parseChannel(channelInput)
  const now = serverNow(query.now)
  const active = await database
    .prepare(
      `SELECT v.version, v.config_json AS configJson
       FROM channel_feed_active_transforms a
       JOIN channel_feed_transform_versions v ON v.channel = a.channel AND v.version = a.version
       WHERE a.channel = ?1`
    )
    .bind(channel)
    .first<{ version: number; configJson: string }>()
  if (!active) throw new ChannelFeedError('not_found')
  const config = channelFeedTransformSchema.parse(JSON.parse(active.configJson))
  const rows = await loadFeedSourceRows(database, now)
  const items: ChannelFeedItem[] = []
  const excluded: FeedExclusion[] = []
  for (const row of rows) {
    const result = transformFeedItem(config, row, query.origin.replace(/\/$/, ''))
    if ('item' in result) items.push(result.item)
    else excluded.push(result.excluded)
  }
  return { channel, transformVersion: active.version, generatedAt: now, items, excluded }
}
