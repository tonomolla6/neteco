import { z } from 'zod'
import type { VerifiedSessionClaims } from './authorization'
import { canonicalPayloadHash } from './cart'
import {
  catalogMarketConfigInputSchema,
  MarketCatalogError,
  type CatalogMarketConfig,
  type CatalogMarketConfigInput
} from '../../shared/catalog-markets'

const uuidSchema = z.string().uuid()

interface Options {
  now?: () => string
}

function getNow(options?: Options): string {
  if (options?.now) return options.now()
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const authorityCte = `
  WITH clock AS MATERIALIZED (SELECT COALESCE(?1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) as now),
  authority AS MATERIALIZED (
    SELECT i.id as actorId, s.mfa_verified as mfaVerified,
           (i.email_verified_at IS NOT NULL AND i.email_verified_at <= (SELECT now FROM clock)) as emailVerified,
           EXISTS(
             SELECT 1 FROM identity_roles r
             JOIN role_permissions p ON p.role_code = r.role_code
             WHERE r.identity_id = i.id
               AND p.permission_code = 'administration.manage'
               AND r.granted_at <= (SELECT now FROM clock)
               AND (r.expires_at IS NULL OR r.expires_at > (SELECT now FROM clock))
           ) as permitted
    FROM auth_sessions s
    JOIN identities i ON i.id = s.identity_id
    WHERE s.id = ?2
      AND s.identity_id = ?3
      AND s.session_version = ?4
      AND i.session_version = s.session_version
      AND i.status IN ('pending', 'active')
      AND s.revoked_at IS NULL
      AND s.created_at <= (SELECT now FROM clock)
      AND s.expires_at > (SELECT now FROM clock)
  )
`

async function checkAuthority(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  options?: Options
): Promise<{ actorId: string }> {
  if (
    !claims ||
    !uuidSchema.safeParse(claims.identityId).success ||
    !uuidSchema.safeParse(claims.sessionId).success ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  ) {
    throw new MarketCatalogError('unauthenticated')
  }

  const now = getNow(options)
  const row = await database
    .prepare(`${authorityCte} SELECT * FROM authority`)
    .bind(now, claims.sessionId, claims.identityId, claims.sessionVersion)
    .first<{ actorId: string; emailVerified: number; mfaVerified: number; permitted: number }>()

  if (!row) throw new MarketCatalogError('unauthenticated')
  if (!row.emailVerified || !row.mfaVerified || !row.permitted) throw new MarketCatalogError('forbidden')
  return row
}

export async function seedDefaultMarkets(database: D1Database, options?: Options): Promise<void> {
  const now = getNow(options)
  const defaults = [
    ['ES', 'España', 'es-ES', 'EUR'],
    ['PT', 'Portugal', 'pt-PT', 'EUR'],
    ['FR', 'France', 'fr-FR', 'EUR'],
    ['DE', 'Deutschland', 'de-DE', 'EUR'],
    ['IT', 'Italia', 'it-IT', 'EUR'],
    ['GB', 'United Kingdom', 'en-GB', 'EUR'],
    ['CH', 'Schweiz', 'de-CH', 'EUR']
  ]

  for (const [code, name, locale, currency] of defaults) {
    await database
      .prepare(
        `INSERT OR IGNORE INTO catalog_markets(code, name, default_locale, currency, is_active, created_at, updated_at)
         VALUES(?, ?, ?, ?, 1, ?, ?)`
      )
      .bind(code, name, locale, currency, now, now)
      .run()
  }
}

export async function listActiveMarkets(database: D1Database): Promise<Array<{ code: string; name: string; defaultLocale: string; currency: string }>> {
  const result = await database
    .prepare('SELECT code, name, default_locale as defaultLocale, currency FROM catalog_markets WHERE is_active = 1 ORDER BY code ASC')
    .all<{ code: string; name: string; defaultLocale: string; currency: string }>()
  return result.results ?? []
}

export async function readProductMarketConfigs(
  database: D1Database,
  productId: string
): Promise<CatalogMarketConfig[]> {
  const result = await database
    .prepare(
      `SELECT id, product_id as productId, market_code as marketCode, version,
              is_available as isAvailable, availability_status as availabilityStatus,
              min_order_quantity as minOrderQuantity, max_order_quantity as maxOrderQuantity,
              restriction_reason as restrictionReason, locale, title, description, slug,
              meta_title as metaTitle, meta_description as metaDescription, usage_instructions as usageInstructions,
              is_compliant as isCompliant, clp_warnings as clpWarnings, ufi_code as ufiCode,
              registration_number as registrationNumber, sds_url as sdsUrl, compliance_notes as complianceNotes,
              created_at as createdAt, updated_at as updatedAt
       FROM catalog_market_configs
       WHERE product_id = ?
       ORDER BY market_code ASC`
    )
    .bind(productId)
    .all<any>()

  return (result.results ?? []).map((row) => ({
    ...row,
    clpWarnings: typeof row.clpWarnings === 'string' ? JSON.parse(row.clpWarnings) : row.clpWarnings
  }))
}

export async function resolveProductForMarket(
  database: D1Database,
  query: { productId?: string; slug?: string; marketCode: string; locale?: string }
): Promise<any> {
  const sql = query.slug
    ? `SELECT c.*, p.brand_id, p.category_id
       FROM catalog_market_configs c
       JOIN products p ON p.id = c.product_id
       WHERE c.slug = ? AND c.market_code = ?`
    : `SELECT c.*, p.brand_id, p.category_id
       FROM catalog_market_configs c
       JOIN products p ON p.id = c.product_id
       WHERE c.product_id = ? AND c.market_code = ?`

  const param = query.slug ?? query.productId
  const row = await database.prepare(sql).bind(param, query.marketCode).first<any>()
  if (!row) return null

  return {
    productId: row.product_id,
    marketCode: row.market_code,
    locale: row.locale,
    title: row.title,
    description: row.description,
    slug: row.slug,
    metaTitle: row.meta_title,
    metaDescription: row.meta_description,
    usageInstructions: row.usage_instructions,
    isAvailable: row.is_available === 1,
    availabilityStatus: row.availability_status,
    minOrderQuantity: row.min_order_quantity,
    maxOrderQuantity: row.max_order_quantity,
    isCompliant: row.is_compliant === 1,
    clpWarnings: typeof row.clp_warnings === 'string' ? JSON.parse(row.clp_warnings) : row.clp_warnings,
    ufiCode: row.ufi_code,
    registrationNumber: row.registration_number,
    sdsUrl: row.sds_url,
    brandId: row.brand_id,
    categoryId: row.category_id,
    version: row.version
  }
}

export async function executeMarketCatalogCommand(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  productId: string,
  commandId: string,
  rawInput: unknown,
  options?: Options
): Promise<{ commandId: string; productId: string; marketCode: string; version: number; createdAt: string }> {
  if (!uuidSchema.safeParse(commandId).success) {
    throw new MarketCatalogError('invalid_input')
  }

  const parsed = catalogMarketConfigInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new MarketCatalogError('invalid_input')
  }
  const input: CatalogMarketConfigInput = parsed.data

  const actor = await checkAuthority(database, claims, options)
  const now = getNow(options)

  const payloadHash = await canonicalPayloadHash({
    productId,
    actorId: actor.actorId,
    ...input
  })

  // Check if command previously stored (idempotency)
  const existingCommand = await database
    .prepare(
      'SELECT command_id, product_id, market_code, payload_hash, version, created_at FROM catalog_market_commands WHERE command_id = ?'
    )
    .bind(commandId)
    .first<{ command_id: string; product_id: string; market_code: string; payload_hash: string; version: number; created_at: string }>()

  if (existingCommand) {
    if (
      existingCommand.payload_hash !== payloadHash ||
      existingCommand.product_id !== productId ||
      existingCommand.market_code !== input.marketCode
    ) {
      throw new MarketCatalogError('conflict')
    }
    return {
      commandId: existingCommand.command_id,
      productId: existingCommand.product_id,
      marketCode: existingCommand.market_code,
      version: existingCommand.version,
      createdAt: existingCommand.created_at
    }
  }

  // Current config version check (optimistic CAS)
  const currentConfig = await database
    .prepare('SELECT version FROM catalog_market_configs WHERE product_id = ? AND market_code = ?')
    .bind(productId, input.marketCode)
    .first<{ version: number }>()

  const currentVersion = currentConfig?.version ?? 0
  if (currentVersion !== input.expectedVersion) {
    throw new MarketCatalogError('conflict')
  }

  const newVersion = input.expectedVersion + 1
  const configId = crypto.randomUUID()
  const clpWarningsJson = JSON.stringify(input.clpWarnings ?? [])

  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO catalog_market_commands(
            command_id, product_id, market_code, action, actor_id, session_id,
            session_version, payload_hash, expected_version, version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          commandId,
          productId,
          input.marketCode,
          input.action,
          actor.actorId,
          claims!.sessionId,
          claims!.sessionVersion,
          payloadHash,
          input.expectedVersion,
          newVersion,
          now
        ),
      database
        .prepare(
          `INSERT INTO catalog_market_configs(
            id, product_id, market_code, version, is_available, availability_status,
            min_order_quantity, max_order_quantity, restriction_reason, locale,
            title, description, slug, meta_title, meta_description, usage_instructions,
            is_compliant, clp_warnings, ufi_code, registration_number, sds_url, compliance_notes,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(product_id, market_code) DO UPDATE SET
            version = excluded.version,
            is_available = excluded.is_available,
            availability_status = excluded.availability_status,
            min_order_quantity = excluded.min_order_quantity,
            max_order_quantity = excluded.max_order_quantity,
            restriction_reason = excluded.restriction_reason,
            locale = excluded.locale,
            title = excluded.title,
            description = excluded.description,
            slug = excluded.slug,
            meta_title = excluded.meta_title,
            meta_description = excluded.meta_description,
            usage_instructions = excluded.usage_instructions,
            is_compliant = excluded.is_compliant,
            clp_warnings = excluded.clp_warnings,
            ufi_code = excluded.ufi_code,
            registration_number = excluded.registration_number,
            sds_url = excluded.sds_url,
            compliance_notes = excluded.compliance_notes,
            updated_at = excluded.updated_at`
        )
        .bind(
          configId,
          productId,
          input.marketCode,
          newVersion,
          input.isAvailable ? 1 : 0,
          input.availabilityStatus,
          input.minOrderQuantity,
          input.maxOrderQuantity ?? null,
          input.restrictionReason ?? null,
          input.locale,
          input.title,
          input.description,
          input.slug,
          input.metaTitle ?? null,
          input.metaDescription ?? null,
          input.usageInstructions ?? null,
          input.isCompliant ? 1 : 0,
          clpWarningsJson,
          input.ufiCode ?? null,
          input.registrationNumber ?? null,
          input.sdsUrl ?? null,
          input.complianceNotes ?? null,
          now,
          now
        )
    ])
  } catch (error: any) {
    if (error instanceof Error && (error.message.includes('conflict') || error.message.includes('UNIQUE'))) {
      throw new MarketCatalogError('conflict')
    }
    if (error instanceof Error && error.message.includes('CHECK')) {
      throw new MarketCatalogError('non_compliant')
    }
    throw error
  }

  return {
    commandId,
    productId,
    marketCode: input.marketCode,
    version: newVersion,
    createdAt: now
  }
}
