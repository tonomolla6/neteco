import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import {
  adminCatalogRelationsSchema,
  catalogRelationsInputSchema,
  catalogRelationsReceiptSchema,
  catalogRelationsIntentHash,
  catalogRelationSlugsSchema,
  publicCatalogRelationsSchema,
  type AdminCatalogRelations,
  type CatalogRelationsReceipt,
  type CatalogRelationsCommand,
  type PublicCatalogRelations
} from '../../shared/catalog-relations'
import { catalogPolicyUuidSchema, catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { publicationValidityExpression } from './publication-validity'
import { effectiveGrossCentsExpression, parameterizeEffectivePricingSql } from './pricing'
import { canonicalJson } from './inventory'

export class CatalogRelationsError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'history_unconfirmed'
      | 'service_unavailable'
  ) {
    super(code)
    this.name = 'CatalogRelationsError'
  }
}
export interface CatalogRelationsOptions {
  now?: string
}
function fail(code: CatalogRelationsError['code']): never {
  throw new CatalogRelationsError(code)
}
function clock(options: CatalogRelationsOptions) {
  const started = Date.now(),
    base = options.now ?? new Date(started).toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!catalogPolicyInstantSchema.safeParse(base).success) fail('invalid_input')
  return {
    fresh: () => new Date(Date.parse(base) + Math.max(0, Date.now() - started)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    sql: () =>
      options.now === undefined
        ? null
        : new Date(Date.parse(base) + Math.max(0, Date.now() - started)).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
}
function productId(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) fail('invalid_input')
}
async function authorize(database: D1Database, claims: VerifiedSessionClaims | null, now: string) {
  if (!claims) return fail('unauthenticated')
  try {
    const result = await authorizeD1Session(database, claims, 'catalog.write', { now, requireMfa: true })
    if (!result.allowed) fail(result.code)
  } catch (error) {
    if (error instanceof CatalogRelationsError) throw error
    fail('service_unavailable')
  }
}
// Single-statement live authority, reused inside the transaction and as the
// final await before private data is released. No cached role or captured clock.
const authorityCte = `WITH a AS MATERIALIZED(SELECT json_extract(?1,'$.identityId') identityId,
 json_extract(?1,'$.sessionId') sessionId,json_extract(?1,'$.sessionVersion') sessionVersion,
 COALESCE(json_extract(?1,'$.now'),strftime('%Y-%m-%dT%H:%M:%SZ','now')) now),
 authority AS MATERIALIZED(SELECT i.id FROM a JOIN auth_sessions s ON s.id=a.sessionId
 JOIN identities i ON i.id=s.identity_id WHERE i.id=a.identityId AND s.session_version=a.sessionVersion
 AND i.session_version=s.session_version AND s.revoked_at IS NULL AND s.created_at<=a.now AND s.expires_at>a.now
 AND i.status IN('active','pending') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=a.now AND s.mfa_verified=1
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions rp ON rp.role_code=r.role_code
 WHERE r.identity_id=i.id AND rp.permission_code='catalog.write' AND r.granted_at<=a.now AND(r.expires_at IS NULL OR r.expires_at>a.now)))`
interface Row {
  uuid: string
  productId: number
  version: number
  command_id: string | null
  updated_at: string | null
  relations_json: string | null
  input_json: string | null
  receipt_json: string | null
  payload_hash: string | null
  history: number
}
interface CommandRow {
  actor_id: string
  command_id: string
  product_id: string
  product_legacy_id: number
  expected_version: number
  result_version: number
  input_json: string
  payload_hash: string
  receipt_json: string
  recorded_at: string
}
// Every historical revision is paired with its immutable command. Headless
// history is corruption, never an initial empty snapshot.
function historyProof(product: string) {
  return `((SELECT count(*) FROM catalog_relation_revisions r WHERE r.product_id=${product})=COALESCE(h.version,0)
 AND (SELECT count(*) FROM catalog_relation_commands c WHERE c.product_id=${product})=COALESCE(h.version,0)
 AND NOT EXISTS(SELECT 1 FROM catalog_relation_revisions r LEFT JOIN catalog_relation_commands c ON c.actor_id=r.actor_id AND c.command_id=r.command_id
 WHERE r.product_id=${product} AND(c.command_id IS NULL OR c.product_id<>r.product_id OR c.result_version<>r.version
 OR c.recorded_at<>r.recorded_at OR c.payload_hash<>r.payload_hash OR r.relations_json<>json_extract(c.input_json,'$.relations')))
 AND (h.product_id IS NULL OR EXISTS(SELECT 1 FROM catalog_relation_revisions r WHERE r.product_id=h.product_id
 AND r.version=h.version AND r.actor_id=h.actor_id AND r.command_id=h.command_id AND r.recorded_at=h.updated_at)))`
}
const readSql = `SELECT p.id uuid,p.legacy_id productId,COALESCE(h.version,0) version,h.command_id,h.updated_at,
 r.relations_json,c.input_json,c.receipt_json,c.payload_hash,${historyProof('p.id')} history
 FROM products p LEFT JOIN catalog_relation_heads h ON h.product_id=p.id
 LEFT JOIN catalog_relation_revisions r ON r.product_id=h.product_id AND r.version=h.version
 LEFT JOIN catalog_relation_commands c ON c.actor_id=r.actor_id AND c.command_id=r.command_id WHERE p.legacy_id=?1`
async function readRow(database: D1Database, id: number): Promise<Row> {
  try {
    const row = await database.prepare(readSql).bind(id).first<Row>()
    if (!row) fail('not_found')
    if (row.history !== 1) fail('history_unconfirmed')
    return row
  } catch (error) {
    if (error instanceof CatalogRelationsError) throw error
    return fail('service_unavailable')
  }
}
function parseJson(value: string | null): unknown {
  if (value === null) fail('history_unconfirmed')
  try {
    return JSON.parse(value)
  } catch {
    return fail('history_unconfirmed')
  }
}
async function view(row: Row): Promise<AdminCatalogRelations> {
  if (row.version === 0)
    return adminCatalogRelationsSchema.parse({
      source: 'cloudflare',
      productId: row.productId,
      version: 0,
      items: [],
      updatedAt: null
    })
  const input = catalogRelationsInputSchema.safeParse(parseJson(row.input_json))
  const receipt = catalogRelationsReceiptSchema.safeParse(parseJson(row.receipt_json))
  if (
    !input.success ||
    !receipt.success ||
    input.data.expectedVersion !== row.version - 1 ||
    receipt.data.productId !== row.productId ||
    receipt.data.version !== row.version ||
    receipt.data.commandId !== row.command_id ||
    receipt.data.recordedAt !== row.updated_at ||
    receipt.data.payloadHash !== row.payload_hash ||
    (await catalogRelationsIntentHash(row.productId, input.data)) !== row.payload_hash
  )
    fail('history_unconfirmed')
  const result = adminCatalogRelationsSchema.safeParse({
    source: 'cloudflare',
    productId: row.productId,
    version: row.version,
    items: parseJson(row.relations_json),
    updatedAt: row.updated_at
  })
  if (!result.success || canonicalJson(result.data.items) !== canonicalJson(input.data.relations))
    fail('history_unconfirmed')
  return result.data
}
async function release(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  id: number,
  now: string | null,
  expected?: { uuid: string; version: number }
) {
  const args = JSON.stringify({ ...claims, now, productId: id })
  let row: { authorized: number; version: number; uuid: string | null } | null
  try {
    row = await database
      .prepare(
        `${authorityCte} SELECT EXISTS(SELECT 1 FROM authority) authorized,
      p.id uuid,COALESCE(h.version,0) version FROM products p LEFT JOIN catalog_relation_heads h ON h.product_id=p.id
      WHERE p.legacy_id=json_extract(?1,'$.productId')`
      )
      .bind(args)
      .first()
  } catch {
    return fail('service_unavailable')
  }
  if (!row?.authorized) {
    await authorize(database, claims, now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
    fail(row ? 'unauthenticated' : 'not_found')
  }
  if (expected && (row.uuid !== expected.uuid || row.version !== expected.version)) fail('version_conflict')
}
async function command(database: D1Database, claims: VerifiedSessionClaims | null, key: string) {
  try {
    return await database
      .prepare('SELECT * FROM catalog_relation_commands WHERE actor_id=?1 AND command_id=?2')
      .bind(claims!.identityId, key)
      .first<CommandRow>()
  } catch {
    return fail('service_unavailable')
  }
}
async function receipt(row: CommandRow, id: number, hash: string): Promise<CatalogRelationsReceipt> {
  if (row.product_legacy_id !== id || row.payload_hash !== hash) fail('idempotency_conflict')
  const input = catalogRelationsInputSchema.safeParse(parseJson(row.input_json)),
    parsed = catalogRelationsReceiptSchema.safeParse(parseJson(row.receipt_json))
  if (
    !input.success ||
    !parsed.success ||
    (await catalogRelationsIntentHash(id, input.data)) !== hash ||
    parsed.data.commandId !== row.command_id ||
    parsed.data.productId !== id ||
    parsed.data.payloadHash !== hash ||
    parsed.data.version !== row.result_version ||
    parsed.data.expectedVersion !== row.expected_version ||
    parsed.data.recordedAt !== row.recorded_at
  )
    fail('history_unconfirmed')
  return parsed.data
}
export async function readD1AdminCatalogRelations(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  id: number,
  options: CatalogRelationsOptions = {}
): Promise<AdminCatalogRelations> {
  const time = clock(options)
  await authorize(database, claims, time.fresh())
  productId(id)
  const row = await readRow(database, id),
    result = await view(row)
  await release(database, claims, id, time.sql(), { uuid: row.uuid, version: row.version })
  return result
}
export async function readD1CatalogRelationsCommand(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  id: number,
  key: string,
  hash: string,
  options: CatalogRelationsOptions = {}
): Promise<CatalogRelationsCommand> {
  const time = clock(options)
  await authorize(database, claims, time.fresh())
  productId(id)
  if (!catalogPolicyUuidSchema.safeParse(key).success || !/^[0-9a-f]{64}$/.test(hash)) fail('invalid_input')
  const source = await readRow(database, id)
  await view(source)
  const stored = await command(database, claims, key)
  const result: CatalogRelationsCommand = stored
    ? { source: 'cloudflare', outcome: 'applied', receipt: await receipt(stored, id, hash) }
    : { source: 'cloudflare', outcome: 'unknown', receipt: null }
  await release(database, claims, id, time.sql(), { uuid: source.uuid, version: source.version })
  return result
}
export async function updateD1CatalogRelations(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  id: number,
  raw: unknown,
  options: CatalogRelationsOptions & { idempotencyKey: string }
): Promise<CatalogRelationsReceipt> {
  const time = clock(options)
  await authorize(database, claims, time.fresh())
  productId(id)
  const input = catalogRelationsInputSchema.safeParse(raw)
  if (
    !input.success ||
    !catalogPolicyUuidSchema.safeParse(options.idempotencyKey).success ||
    input.data.relations.some((edge) => edge.targetProductId === id)
  )
    fail('invalid_input')
  const hash = await catalogRelationsIntentHash(id, input.data),
    existing = await command(database, claims, options.idempotencyKey)
  if (existing) {
    const result = await receipt(existing, id, hash)
    await release(database, claims, id, time.sql())
    return result
  }
  const source = await readRow(database, id)
  await view(source)
  if (source.version !== input.data.expectedVersion) fail('version_conflict')
  if (source.version === Number.MAX_SAFE_INTEGER) fail('invalid_input')
  const targetIds = [...new Set(input.data.relations.map((edge) => edge.targetProductId))]
  const targets = await database
    .prepare('SELECT legacy_id FROM products WHERE legacy_id IN(SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(targetIds))
    .all()
  if (targets.results.length !== targetIds.length) fail('not_found')
  const recordedAt = time.fresh(),
    result = catalogRelationsReceiptSchema.parse({
      source: 'cloudflare',
      commandId: options.idempotencyKey,
      productId: id,
      expectedVersion: source.version,
      version: source.version + 1,
      payloadHash: hash,
      recordedAt
    })
  const args = JSON.stringify({
    ...claims,
    now: time.sql(),
    productId: id,
    productUuid: source.uuid,
    key: options.idempotencyKey,
    input: input.data,
    hash,
    receipt: result,
    recordedAt
  })
  const valid = `EXISTS(SELECT 1 FROM authority) AND EXISTS(SELECT 1 FROM products WHERE id=json_extract(?1,'$.productUuid') AND legacy_id=json_extract(?1,'$.productId'))
    AND COALESCE((SELECT version FROM catalog_relation_heads WHERE product_id=json_extract(?1,'$.productUuid')),0)=json_extract(?1,'$.input.expectedVersion')
    AND NOT EXISTS(SELECT 1 FROM json_each(?1,'$.input.relations') edge LEFT JOIN products p ON p.legacy_id=json_extract(edge.value,'$.targetProductId')
      WHERE p.id IS NULL OR p.id=json_extract(?1,'$.productUuid'))`
  const q = (sql: string) => database.prepare(`${authorityCte} ${sql}`).bind(args)
  try {
    await database.batch([
      q(`INSERT INTO catalog_relation_commands(actor_id,command_id,product_id,product_legacy_id,expected_version,result_version,input_json,payload_hash,receipt_json,recorded_at)
      SELECT authority.id,json_extract(?1,'$.key'),json_extract(?1,'$.productUuid'),json_extract(?1,'$.productId'),json_extract(?1,'$.input.expectedVersion'),
      json_extract(?1,'$.input.expectedVersion')+1,json_extract(?1,'$.input'),json_extract(?1,'$.hash'),json_extract(?1,'$.receipt'),json_extract(?1,'$.recordedAt') FROM authority WHERE ${valid}`),
      q(`INSERT INTO catalog_relation_revisions(product_id,version,actor_id,command_id,relations_json,payload_hash,recorded_at)
      SELECT c.product_id,c.result_version,c.actor_id,c.command_id,json_extract(c.input_json,'$.relations'),c.payload_hash,c.recorded_at
      FROM catalog_relation_commands c JOIN authority ON authority.id=c.actor_id WHERE c.command_id=json_extract(?1,'$.key')`),
      q(`INSERT INTO catalog_relation_heads(product_id,version,actor_id,command_id,updated_at)
      SELECT c.product_id,c.result_version,c.actor_id,c.command_id,c.recorded_at FROM catalog_relation_commands c JOIN authority ON authority.id=c.actor_id
      WHERE c.command_id=json_extract(?1,'$.key') ON CONFLICT(product_id) DO UPDATE SET version=excluded.version,actor_id=excluded.actor_id,command_id=excluded.command_id,updated_at=excluded.updated_at`),
      q(`INSERT INTO catalog_relation_guards(id,valid) SELECT json_extract(?1,'$.key'),CASE WHEN EXISTS(SELECT 1 FROM authority)
      AND EXISTS(SELECT 1 FROM catalog_relation_heads h JOIN catalog_relation_revisions r ON r.product_id=h.product_id AND r.version=h.version
      WHERE h.product_id=json_extract(?1,'$.productUuid') AND h.version=json_extract(?1,'$.input.expectedVersion')+1
      AND h.actor_id=(SELECT id FROM authority) AND h.command_id=json_extract(?1,'$.key') AND r.command_id=h.command_id) THEN 1 ELSE 0 END`),
      database.prepare('DELETE FROM catalog_relation_guards WHERE id=?1').bind(options.idempotencyKey)
    ])
  } catch {
    await authorize(database, claims, time.fresh())
    const replay = await command(database, claims, options.idempotencyKey)
    if (replay) {
      const original = await receipt(replay, id, hash)
      await release(database, claims, id, time.sql())
      return original
    }
    const latest = await readRow(database, id)
    if (latest.version !== source.version) fail('version_conflict')
    fail('service_unavailable')
  }
  const stored = await command(database, claims, options.idempotencyKey)
  if (!stored) fail('service_unavailable')
  const original = await receipt(stored, id, hash)
  await release(database, claims, id, time.sql())
  return original
}
interface PublicRow {
  productId: number
  productSlug: string
  version: number
  history: number
  items: string
}
function publicStatement(database: D1Database, slugs: readonly string[], now: string) {
  const pricing = parameterizeEffectivePricingSql(effectiveGrossCentsExpression('v'), now)
  return database
    .prepare(
      `WITH sources AS MATERIALIZED(SELECT p.id,p.legacy_id productId,p.slug productSlug FROM products p
    JOIN categories category ON category.id=p.category_id AND category.status='published'
    WHERE p.slug IN(SELECT value FROM json_each(?)) AND p.status='published' AND p.legacy_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM variants source_variant WHERE source_variant.product_id=p.id
      AND source_variant.status='published' AND source_variant.legacy_id IS NOT NULL)
    AND ${publicationValidityExpression('p')}), edges AS MATERIALIZED(
    SELECT s.id sourceId,json_extract(edge.value,'$.targetProductId') targetId,json_extract(edge.value,'$.kind') kind,CAST(edge.key AS INTEGER) ordinal
    FROM sources s JOIN catalog_relation_heads head ON head.product_id=s.id
    JOIN catalog_relation_revisions rev ON rev.product_id=head.product_id AND rev.version=head.version JOIN json_each(rev.relations_json) edge),
    targets AS MATERIALIZED(SELECT p.* FROM products p JOIN categories category ON category.id=p.category_id AND category.status='published'
    WHERE p.legacy_id IN(SELECT targetId FROM edges) AND p.status='published' AND ${publicationValidityExpression('p')}),
    prices AS MATERIALIZED(SELECT v.product_id,${pricing.sql} grossCents,tax.rate_basis_points rate FROM variants v
    JOIN targets t ON t.id=v.product_id JOIN tax_classes tax ON tax.id=v.tax_class_id WHERE v.status='published' AND v.legacy_id IS NOT NULL),
    summary AS MATERIALIZED(SELECT product_id,min(grossCents) minPrice,
    min(CAST(round(grossCents*10000.0/(10000+rate)) AS INTEGER)) minNetPrice,count(*) formats FROM prices WHERE grossCents>0 GROUP BY product_id)
    SELECT s.productId,s.productSlug,COALESCE(h.version,0) version,${historyProof('s.id')} history,
    COALESCE((SELECT json_group_array(json_object('kind',kind,'productId',productId,'slug',slug,'name',name,'brand',brand,
    'minPrice',minPrice,'minNetPrice',minNetPrice,'formats',formats)) FROM(SELECT e.kind,t.legacy_id productId,t.slug,t.name,COALESCE(b.name,'NETECO') brand,
    summary.minPrice,summary.minNetPrice,summary.formats FROM edges e JOIN targets t ON t.legacy_id=e.targetId JOIN summary ON summary.product_id=t.id
    LEFT JOIN brands b ON b.id=t.brand_id WHERE e.sourceId=s.id ORDER BY e.ordinal)),'[]') items
    FROM sources s LEFT JOIN catalog_relation_heads h ON h.product_id=s.id ORDER BY s.productSlug,s.productId`
    )
    .bind(JSON.stringify(slugs), ...pricing.instantParameters)
}
export async function readD1ProductRelations(
  database: D1Database,
  slugs: readonly string[],
  options: CatalogRelationsOptions = {}
): Promise<PublicCatalogRelations> {
  const time = clock(options),
    parsed = catalogRelationSlugsSchema.safeParse(slugs)
  if (!parsed.success) fail('invalid_input')
  const query = async () => {
    try {
      const result = await publicStatement(database, parsed.data, time.fresh()).all<PublicRow>()
      if (result.success !== true || result.results.some((row) => row.history !== 1)) fail('history_unconfirmed')
      return result.results
    } catch (error) {
      if (error instanceof CatalogRelationsError) throw error
      return fail('service_unavailable')
    }
  }
  const rows = await query()
  const result = publicCatalogRelationsSchema.safeParse({
    source: 'cloudflare',
    groups: rows.map((row) => ({ productId: row.productId, productSlug: row.productSlug, items: parseJson(row.items) }))
  })
  if (!result.success) fail('history_unconfirmed')
  // Final coherent reread after all awaits proves current publication, price
  // and relation revisions. No earlier private snapshot is released on drift.
  const latest = await query()
  if (canonicalJson(rows) !== canonicalJson(latest)) fail('service_unavailable')
  return result.data
}
