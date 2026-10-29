import { z } from 'zod'
import {
  editorialCommandInputSchema,
  editorialPreviewSchema,
  editorialReceiptSchema,
  editorialPreviewProductSchema,
  type EditorialPreview,
  type EditorialReceipt,
  type EditorialInvalid
} from '../../shared/catalog-editorial-import'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  EditorialCsvError,
  parseEditorialCsv,
  exportEditorialCsv,
  type EditorialCsvRow
} from '../../shared/catalog-editorial-csv'
import { draftProductMetadataSchema } from './admin-catalog-mutations'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'

export class EditorialImportError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'version_conflict'
      | 'preview_expired'
      | 'idempotency_conflict'
      | 'already_applied'
      | 'already_reverted'
      | 'not_applied'
      | 'export_too_large'
      | 'no_editable_products'
  ) {
    super(code)
  }
}
const clock = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"
const actor = `SELECT i.id FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
  WHERE s.id = ?1 AND s.identity_id = ?2 AND s.session_version = ?3 AND i.session_version = s.session_version
    AND s.revoked_at IS NULL AND s.created_at <= ${clock} AND s.expires_at > ${clock}
    AND s.mfa_verified = 1 AND i.status IN ('active', 'pending')
    AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= ${clock}
    AND EXISTS (SELECT 1 FROM identity_roles r JOIN role_permissions g ON g.role_code = r.role_code
      WHERE r.identity_id = i.id AND g.permission_code = 'catalog.write'
        AND r.granted_at <= ${clock} AND (r.expires_at IS NULL OR r.expires_at > ${clock}))`
const claimsSchema = z
  .object({
    sessionId: catalogPolicyUuidSchema,
    identityId: catalogPolicyUuidSchema,
    sessionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
function parameters(claims: VerifiedSessionClaims) {
  return [claims.sessionId, claims.identityId, claims.sessionVersion] as const
}
async function authorize(database: D1Database, input: VerifiedSessionClaims | null) {
  let data: unknown
  try {
    data = catalogPolicyOwnJson(input)
  } catch {
    throw new EditorialImportError('unauthenticated')
  }
  const parsed = claimsSchema.safeParse(data)
  if (!parsed.success) throw new EditorialImportError('unauthenticated')
  const result = await authorizeD1Session(database, parsed.data, 'catalog.write', { requireMfa: true })
  if (!result.allowed) throw new EditorialImportError(result.code)
  return parsed.data
}
const metadataSql = (alias: string) => `json_object('name', ${alias}.name,
  'shortDesc', ${alias}.short_description, 'description', ${alias}.description,
  'usage', ${alias}.usage, 'series', ${alias}.series,
  'featured', json(CASE WHEN ${alias}.featured = 1 THEN 'true' ELSE 'false' END))`
async function sha256(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
function invalid(code: string, row?: number, field?: string): EditorialInvalid {
  return {
    source: 'cloudflare',
    outcome: 'invalid',
    issues: [
      {
        code,
        ...(row === undefined ? {} : { row }),
        ...(field === undefined ? {} : { field }),
        message: 'Revisa el CSV y la versión actual del borrador.'
      }
    ]
  }
}
function validId(id: string) {
  if (!catalogPolicyUuidSchema.safeParse(id).success) throw new EditorialImportError('invalid_input')
}
interface ProductRow {
  id: string
  legacy_id: number
  catalog_version: number
  status: string
  metadata: string
}
interface PreviewRow {
  id: string
  hash: string
  manifest: string
  created_at: string
  expires_at: string
  status: EditorialPreview['status']
}
export async function readEditorialPreview(
  database: D1Database,
  input: VerifiedSessionClaims | null,
  id: string
): Promise<EditorialPreview> {
  validId(id)
  const claims = await authorize(database, input)
  const row = await database
    .prepare(
      `WITH actor AS (${actor}) SELECT p.*,
    CASE WHEN EXISTS (SELECT 1 FROM catalog_editorial_commands WHERE preview_id = p.id AND action = 'revert')
      THEN 'reverted' WHEN EXISTS (SELECT 1 FROM catalog_editorial_commands WHERE preview_id = p.id AND action = 'apply')
      THEN 'applied' WHEN p.expires_at <= ${clock} THEN 'expired' ELSE 'pending' END AS status
    FROM actor JOIN catalog_editorial_previews p ON p.actor_id = actor.id WHERE p.id = ?4`
    )
    .bind(...parameters(claims), id)
    .first<PreviewRow>()
  await authorize(database, claims)
  if (!row) throw new EditorialImportError('not_found')
  return editorialPreviewSchema.parse({
    source: 'cloudflare',
    outcome: 'preview',
    id: row.id,
    hash: row.hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
    products: JSON.parse(row.manifest)
  })
}
export async function exportEditorialTemplate(database: D1Database, input: VerifiedSessionClaims | null) {
  const claims = await authorize(database, input)
  const rows = (
    await database
      .prepare(
        `WITH actor AS (${actor}) SELECT p.id, p.legacy_id,
    p.catalog_version, p.status, ${metadataSql('p')} AS metadata FROM actor JOIN products p
    WHERE p.status IN ('draft', 'review') ORDER BY p.legacy_id LIMIT 101`
      )
      .bind(...parameters(claims))
      .all<ProductRow>()
  ).results
  await authorize(database, claims)
  if (rows.length > 100) throw new EditorialImportError('export_too_large')
  const records = rows
    .map((row) => ({
      productId: row.id,
      legacyId: row.legacy_id,
      expectedVersion: row.catalog_version,
      metadata: JSON.parse(row.metadata)
    }))
    .map((row) => ({
      ...row,
      metadata: {
        ...row.metadata,
        shortDesc: row.metadata.shortDesc ?? '',
        description: row.metadata.description ?? ''
      }
    })) as EditorialCsvRow[]
  return exportEditorialCsv(records)
}
export async function previewEditorialCsv(
  database: D1Database,
  input: VerifiedSessionClaims | null,
  csv: Uint8Array
): Promise<EditorialPreview | EditorialInvalid> {
  const claims = await authorize(database, input)
  let records: EditorialCsvRow[]
  try {
    records = parseEditorialCsv(csv)
  } catch (failure) {
    return failure instanceof EditorialCsvError
      ? invalid(failure.code, failure.row, failure.field)
      : invalid('invalid_csv')
  }
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!
    if (
      !draftProductMetadataSchema.safeParse({
        ...record.metadata,
        expectedVersion: record.expectedVersion,
        reason: 'Editorial CSV validation'
      }).success
    )
      return invalid('invalid_metadata', index + 2)
  }
  const rows = (
    await database
      .prepare(
        `WITH actor AS (${actor}) SELECT p.id, p.legacy_id,
    p.catalog_version, p.status, ${metadataSql('p')} AS metadata FROM actor JOIN products p
    WHERE p.id IN (SELECT value FROM json_each(?4))`
      )
      .bind(...parameters(claims), JSON.stringify(records.map((record) => record.productId)))
      .all<ProductRow>()
  ).results
  await authorize(database, claims)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const products: EditorialPreview['products'] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!,
      row = byId.get(record.productId)
    if (!row || row.legacy_id !== record.legacyId) return invalid('not_found', index + 2)
    if (!['draft', 'review'].includes(row.status)) return invalid('not_editable', index + 2)
    if (row.catalog_version !== record.expectedVersion) return invalid('version_conflict', index + 2)
    const item = editorialPreviewProductSchema.parse({
      productId: row.id,
      legacyId: row.legacy_id,
      expectedVersion: row.catalog_version,
      before: JSON.parse(row.metadata),
      after: record.metadata
    })
    if (JSON.stringify(item.before) !== JSON.stringify(item.after)) products.push(item)
  }
  if (!products.length) return invalid('no_changes')
  products.sort((left, right) => (left.productId < right.productId ? -1 : left.productId > right.productId ? 1 : 0))
  const manifest = JSON.stringify(products),
    hash = await sha256(manifest),
    id = crypto.randomUUID()
  await authorize(database, claims)
  await database
    .batch([
      database
        .prepare(
          `WITH actor AS (${actor}) INSERT INTO catalog_editorial_previews
      (id, actor_id, hash, manifest, created_at, expires_at)
      SELECT ?4, actor.id, ?5, ?6, ${clock}, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+30 minutes') FROM actor
      WHERE (SELECT count(*) FROM json_each(?6) item JOIN products p
        ON p.id = json_extract(item.value, '$.productId') AND p.legacy_id = json_extract(item.value, '$.legacyId')
        WHERE p.status IN ('draft', 'review') AND p.catalog_version = json_extract(item.value, '$.expectedVersion')
          AND ${metadataSql('p')} = json_extract(item.value, '$.before')) = json_array_length(?6)`
        )
        .bind(...parameters(claims), id, hash, manifest),
      database
        .prepare(
          `WITH actor AS (${actor}) INSERT INTO catalog_editorial_guards(id, satisfied)
      SELECT ?4, CASE WHEN EXISTS (SELECT 1 FROM actor JOIN catalog_editorial_previews p
        ON p.actor_id = actor.id WHERE p.id = ?4 AND p.expires_at > ${clock}
          AND (SELECT count(*) FROM json_each(p.manifest) item JOIN products product
            ON product.id = json_extract(item.value, '$.productId')
              AND product.legacy_id = json_extract(item.value, '$.legacyId')
            WHERE product.status IN ('draft', 'review')
              AND product.catalog_version = json_extract(item.value, '$.expectedVersion')
              AND ${metadataSql('product')} = json_extract(item.value, '$.before')) = json_array_length(p.manifest))
        THEN 1 ELSE 0 END`
        )
        .bind(...parameters(claims), id),
      database.prepare('DELETE FROM catalog_editorial_guards WHERE id = ?').bind(id)
    ])
    .catch(async (failure: unknown) => {
      if (!isD1CheckConstraintFailure(failure)) throw failure
      await authorize(database, claims)
      throw new EditorialImportError('version_conflict')
    })
  return readEditorialPreview(database, claims, id)
}
interface CommandRow {
  payload_hash: string
  response: string
}
async function replay(database: D1Database, claims: VerifiedSessionClaims, key: string, hash: string) {
  const row = await database
    .prepare(
      `WITH actor AS (${actor}) SELECT c.payload_hash, c.response
    FROM actor JOIN catalog_editorial_commands c ON c.actor_id = actor.id WHERE c.idempotency_key = ?4`
    )
    .bind(...parameters(claims), key)
    .first<CommandRow>()
  await authorize(database, claims)
  if (!row) return null
  if (row.payload_hash !== hash) throw new EditorialImportError('idempotency_conflict')
  return editorialReceiptSchema.parse(JSON.parse(row.response))
}
export async function executeEditorialCommand(
  database: D1Database,
  input: VerifiedSessionClaims | null,
  id: string,
  action: 'apply' | 'revert',
  raw: unknown,
  idempotencyKey: string
): Promise<EditorialReceipt> {
  validId(id)
  const parsed = editorialCommandInputSchema.safeParse(raw)
  if (
    !parsed.success ||
    !['apply', 'revert'].includes(action) ||
    typeof idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(idempotencyKey)
  )
    throw new EditorialImportError('invalid_input')
  const claims = await authorize(database, input),
    body = parsed.data
  const payloadHash = await sha256(JSON.stringify(['editorial.v1', id, action, body]))
  const prior = await replay(database, claims, idempotencyKey, payloadHash)
  if (prior) return prior
  const preview = await readEditorialPreview(database, claims, id)
  if (preview.hash !== body.previewHash) throw new EditorialImportError('version_conflict')
  if (action === 'apply' && preview.status !== 'pending')
    throw new EditorialImportError(preview.status === 'expired' ? 'preview_expired' : 'already_applied')
  if (action === 'revert' && preview.status !== 'applied')
    throw new EditorialImportError(preview.status === 'reverted' ? 'already_reverted' : 'not_applied')
  const manifest = JSON.stringify(preview.products)
  if ((await sha256(manifest)) !== preview.hash) throw new Error('editorial_manifest_integrity')
  const commandId = crypto.randomUUID(),
    nonce = crypto.randomUUID()
  const receipt: EditorialReceipt = {
    source: 'cloudflare',
    action,
    previewId: id,
    previewHash: preview.hash,
    commandId,
    productCount: preview.products.length,
    updated: true
  }
  const offset = action === 'apply' ? 0 : 1,
    before = action === 'apply' ? 'before' : 'after',
    after = action === 'apply' ? 'after' : 'before'
  // All branches below are closed server constants, never request SQL.
  const condition =
    action === 'apply'
      ? `p.expires_at > ${clock} AND NOT EXISTS (SELECT 1 FROM catalog_editorial_commands WHERE preview_id = p.id)`
      : `EXISTS (SELECT 1 FROM catalog_editorial_commands WHERE preview_id = p.id AND action = 'apply')
       AND NOT EXISTS (SELECT 1 FROM catalog_editorial_commands WHERE preview_id = p.id AND action = 'revert')`
  const binds = [
    ...parameters(claims),
    id,
    preview.hash,
    commandId,
    nonce,
    idempotencyKey,
    payloadHash,
    body.reason,
    JSON.stringify(receipt),
    action
  ]
  const command = database
    .prepare(
      `WITH actor AS (${actor}) INSERT INTO catalog_editorial_commands
    (id, nonce, actor_id, preview_id, action, idempotency_key, payload_hash, reason, response, created_at)
    SELECT ?6, ?7, actor.id, p.id, ?12, ?8, ?9, ?10, ?11, ${clock}
    FROM actor JOIN catalog_editorial_previews p ON p.actor_id = actor.id
    WHERE p.id = ?4 AND p.hash = ?5 AND ${condition}
      AND NOT EXISTS (SELECT 1 FROM catalog_editorial_commands WHERE actor_id = actor.id AND idempotency_key = ?8)
      AND (SELECT count(*) FROM json_each(p.manifest) item JOIN products product
        ON product.id = json_extract(item.value, '$.productId')
          AND product.legacy_id = json_extract(item.value, '$.legacyId')
        WHERE product.status IN ('draft', 'review')
          AND product.catalog_version = json_extract(item.value, '$.expectedVersion') + ${offset}
          AND ${metadataSql('product')} = json_extract(item.value, '$.${before}')) = json_array_length(p.manifest)`
    )
    .bind(...binds)
  const audit = database
    .prepare(
      `INSERT INTO catalog_editorial_audit
    (command_id, product_id, before_version, after_version, before_metadata, after_metadata)
    SELECT c.id, json_extract(item.value, '$.productId'),
      json_extract(item.value, '$.expectedVersion') + ${offset},
      json_extract(item.value, '$.expectedVersion') + ${offset + 1},
      json_extract(item.value, '$.${before}'), json_extract(item.value, '$.${after}')
    FROM catalog_editorial_commands c JOIN catalog_editorial_previews p ON p.id = c.preview_id,
      json_each(p.manifest) item WHERE c.id = ?1 AND c.nonce = ?2`
    )
    .bind(commandId, nonce)
  const columnMap = [
    ['name', 'name'],
    ['short_description', 'shortDesc'],
    ['description', 'description'],
    ['usage', 'usage'],
    ['series', 'series'],
    ['featured', 'featured']
  ] as const
  const sets = columnMap
    .map(
      ([column, key]) =>
        `${column} = (SELECT json_extract(a.after_metadata, '$.${key}') FROM catalog_editorial_audit a
      WHERE a.command_id = ?1 AND a.product_id = products.id)`
    )
    .join(', ')
  const update = database
    .prepare(
      `UPDATE products SET ${sets},
    catalog_version = catalog_version + 1, updated_at = ${clock}
    WHERE id IN (SELECT product_id FROM catalog_editorial_audit WHERE command_id = ?1)
      AND EXISTS (SELECT 1 FROM catalog_editorial_audit a JOIN catalog_editorial_commands c ON c.id = a.command_id
      WHERE c.id = ?1 AND c.nonce = ?2 AND a.product_id = products.id
        AND a.before_version = products.catalog_version AND products.status IN ('draft', 'review')
        AND ${metadataSql('products')} = a.before_metadata)`
    )
    .bind(commandId, nonce)
  const guard = database
    .prepare(
      `WITH actor AS (${actor}) INSERT INTO catalog_editorial_guards(id, satisfied)
    SELECT ?4, CASE WHEN EXISTS (SELECT 1 FROM actor JOIN catalog_editorial_commands c ON c.actor_id = actor.id
      JOIN catalog_editorial_previews p ON p.id = c.preview_id WHERE c.id = ?4 AND c.nonce = ?5
        AND (?6 = 'revert' OR p.expires_at > ${clock})
        AND (SELECT count(*) FROM catalog_editorial_audit WHERE command_id = c.id) = json_array_length(p.manifest)
        AND (SELECT count(*) FROM catalog_editorial_audit a JOIN products product ON product.id = a.product_id
          WHERE a.command_id = c.id AND product.status IN ('draft', 'review')
            AND product.catalog_version = a.after_version AND ${metadataSql('product')} = a.after_metadata)
          = json_array_length(p.manifest)) THEN 1 ELSE 0 END`
    )
    .bind(...parameters(claims), commandId, nonce, action)
  try {
    await database.batch([
      command,
      audit,
      update,
      guard,
      database.prepare('DELETE FROM catalog_editorial_guards WHERE id = ?').bind(commandId)
    ])
  } catch (failure) {
    if (!isD1CheckConstraintFailure(failure)) throw failure
    await authorize(database, claims)
    const raced = await replay(database, claims, idempotencyKey, payloadHash)
    if (raced) return raced
    throw new EditorialImportError('version_conflict')
  }
  await authorize(database, claims)
  return receipt
}
