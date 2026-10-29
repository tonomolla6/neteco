import { z } from 'zod'
import {
  REQUIRED_PUBLICATION_FIELDS,
  PUBLICATION_DOCUMENT_ROLES,
  catalogPolicyActionSchema,
  catalogPolicyCodeSchema,
  catalogPolicyInstantSchema,
  catalogPolicyOwnJson,
  catalogPolicyReceiptSchema,
  catalogPolicyStatusSchema,
  catalogPolicyUuidSchema,
  policyCreateInputSchema,
  policyWithdrawInputSchema,
  policyAssignInputSchema,
  exceptionCreateInputSchema,
  exceptionWithdrawInputSchema,
  policyRegulatoryInputSchema,
  type CatalogPolicyAction,
  type CatalogPolicyReceipt,
  type CatalogPoliciesView,
  type CatalogPublicationPolicyView,
  type ProductPublicationPolicyView,
  type PolicyCreateInput,
  type PolicyWithdrawInput,
  type PolicyAssignInput,
  type ExceptionCreateInput,
  type ExceptionWithdrawInput
} from '../../shared/catalog-publication-policy'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { parseAdminCatalogLegacyId } from './admin-catalog'

export class CatalogPolicyError extends Error {
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
      | 'invalid_state'
      | 'policy_in_use'
      | 'policy_unavailable'
      | 'conflict'
  ) {
    super(code)
  }
}
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const executionNow = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const actorSql = `SELECT i.id FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
  WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND s.revoked_at IS NULL
    AND s.created_at<=${executionNow} AND s.expires_at>${executionNow} AND s.mfa_verified=1
    AND i.status IN ('pending','active') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${executionNow}
    AND EXISTS(SELECT 1 FROM identity_roles assigned JOIN role_permissions granted ON granted.role_code=assigned.role_code
      WHERE assigned.identity_id=i.id AND granted.permission_code=?5 AND assigned.granted_at<=${executionNow}
        AND (assigned.expires_at IS NULL OR assigned.expires_at>${executionNow}))`
const actorParameters = (claims: VerifiedSessionClaims, now?: string) =>
  [now ?? null, claims.sessionId, claims.identityId, claims.sessionVersion, 'catalog.publish'] as const
function own(value: unknown): unknown {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
function checked<T, I>(
  schema: z.ZodType<T, z.ZodTypeDef, I>,
  value: unknown,
  code: 'invalid_input' | 'unauthenticated' = 'invalid_input'
): T {
  const result = schema.safeParse(own(value))
  if (!result.success) throw new CatalogPolicyError(code)
  return result.data
}
const claimsSchema = z
  .object({ sessionId: catalogPolicyUuidSchema, identityId: catalogPolicyUuidSchema, sessionVersion: positive })
  .strict()
async function authorize(database: D1Database, claims: VerifiedSessionClaims, now?: string) {
  const result = await authorizeD1Session(database, claims, 'catalog.publish', {
    now: now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    requireMfa: true
  })
  if (!result.allowed) throw new CatalogPolicyError(result.code)
}
function instant(now?: string) {
  const result = catalogPolicyInstantSchema.safeParse(now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
  if (!result.success) throw new CatalogPolicyError('invalid_input')
  return result.data
}
function json(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('catalog_policy_source_invalid')
  }
}
const currentAssignment = (product: string) =>
  `(SELECT id FROM catalog_product_publication_policies WHERE product_id=${product} ORDER BY seq DESC LIMIT 1)`
const sqlValues = (values: readonly string[]) => values.map((value) => `'${value}'`).join(',')
function availablePolicy(p: string, clock = executionNow) {
  return `${p}.created_at<=${clock} AND ${p}.valid_from<=${clock} AND (${p}.valid_until IS NULL OR ${p}.valid_until>${clock})
    AND NOT EXISTS(SELECT 1 FROM catalog_publication_policy_withdrawals w WHERE w.policy_id=${p}.id)
    AND NOT EXISTS(SELECT 1 FROM json_each(${p}.required_fields) WHERE type<>'text' OR value NOT IN (${sqlValues(REQUIRED_PUBLICATION_FIELDS)}))
    AND NOT EXISTS(SELECT 1 FROM json_each(${p}.required_media_roles) WHERE type<>'text' OR value NOT IN (${sqlValues(PUBLICATION_DOCUMENT_ROLES)}))
    AND (SELECT count(DISTINCT value) FROM json_each(${p}.required_fields))=json_array_length(${p}.required_fields)
    AND (SELECT count(DISTINCT value) FROM json_each(${p}.required_media_roles))=json_array_length(${p}.required_media_roles)`
}
const inUse = (
  policy: string
) => `EXISTS(SELECT 1 FROM products p JOIN catalog_product_publication_policies a ON a.id=${currentAssignment('p.id')}
  WHERE p.status='published' AND a.policy_id=${policy})`
function policyProjection(p: string) {
  return `${p}.id,${p}.code,${p}.version,${p}.name,${p}.required_fields AS requiredFields,${p}.required_media_roles AS requiredMediaRoles,
    ${p}.identifier_exceptions_allowed AS identifierExceptionsAllowed,${p}.valid_from AS validFrom,${p}.valid_until AS validUntil,
    ${p}.actor_id AS actorId,${p}.reason,${p}.created_at AS createdAt,
    EXISTS(SELECT 1 FROM catalog_publication_policy_withdrawals w WHERE w.policy_id=${p}.id) AS withdrawn,
    CASE WHEN ${availablePolicy(p)} THEN 1 ELSE 0 END AS current,
    (SELECT count(*) FROM catalog_product_publication_policies a WHERE a.policy_id=${p}.id AND a.id=${currentAssignment('a.product_id')}) AS assignedProductCount,
    (SELECT count(*) FROM catalog_product_publication_policies a JOIN products pr ON pr.id=a.product_id
      WHERE a.policy_id=${p}.id AND pr.status='published' AND a.id=${currentAssignment('a.product_id')}) AS publishedProductCount`
}
const policyRowSchema = z.object({
  id: catalogPolicyUuidSchema,
  code: catalogPolicyCodeSchema,
  version: positive,
  name: z.string(),
  requiredFields: z.string().max(4096),
  requiredMediaRoles: z.string().max(4096),
  identifierExceptionsAllowed: z.union([z.literal(0), z.literal(1)]),
  validFrom: catalogPolicyInstantSchema,
  validUntil: catalogPolicyInstantSchema.nullable(),
  actorId: catalogPolicyUuidSchema,
  reason: z.string(),
  createdAt: catalogPolicyInstantSchema,
  current: z.union([z.literal(0), z.literal(1)]),
  withdrawn: z.union([z.literal(0), z.literal(1)]),
  assignedProductCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  publishedProductCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
})
type PolicyRow = z.infer<typeof policyRowSchema>
function policyView(value: unknown): CatalogPublicationPolicyView {
  const row = policyRowSchema.parse(value)
  const fields = policyCreateInputSchema.parse({
    code: row.code,
    name: row.name,
    expectedVersion: row.version - 1,
    requiredFields: json(row.requiredFields),
    requiredMediaRoles: json(row.requiredMediaRoles),
    identifierExceptionsAllowed: row.identifierExceptionsAllowed === 1,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    reason: row.reason
  })
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    name: fields.name,
    requiredFields: fields.requiredFields,
    requiredMediaRoles: fields.requiredMediaRoles,
    identifierExceptionsAllowed: fields.identifierExceptionsAllowed,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    current: row.current === 1,
    withdrawn: row.withdrawn === 1,
    assignedProductCount: row.assignedProductCount,
    publishedProductCount: row.publishedProductCount
  }
}
const productRowSchema = z.object({
  uuid: catalogPolicyUuidSchema,
  id: positive,
  catalogVersion: positive,
  status: catalogPolicyStatusSchema,
  regulatory: z.string().max(64 * 1024),
  updatedAt: z.string().max(100),
  assignmentId: catalogPolicyUuidSchema.nullable()
})
type ProductRow = z.infer<typeof productRowSchema>
const productProjection = `p.id AS uuid,p.legacy_id AS id,p.catalog_version AS catalogVersion,p.status,p.regulatory,p.updated_at AS updatedAt,${currentAssignment('p.id')} AS assignmentId`
function regulatoryObject(raw: string) {
  const value = json(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value
}
function regulatoryView(raw: string): ProductPublicationPolicyView['regulatory'] {
  const value = regulatoryObject(raw)
  if (!value) throw new Error('catalog_policy_source_invalid')
  const known: Record<string, unknown> = Object.create(null)
  for (const key of [
    'productType',
    'requiresSds',
    'safetyInstructions',
    'hazardStatements',
    'precautionaryStatements',
    'manufacturer'
  ])
    if (Object.hasOwn(value, key)) known[key] = Reflect.get(value, key)
  const result = policyRegulatoryInputSchema.partial().parse(known)
  return {
    productType: result.productType ?? null,
    requiresSds: result.requiresSds ?? null,
    safetyInstructions: result.safetyInstructions ?? null,
    hazardStatements: result.hazardStatements ?? null,
    precautionaryStatements: result.precautionaryStatements ?? null,
    manufacturer: result.manufacturer ?? null
  }
}

export async function readD1CatalogPolicies(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  query: { page: number; perPage: number; code?: string },
  now?: string
): Promise<CatalogPoliciesView> {
  const claims = checked(claimsSchema, claimsInput, 'unauthenticated')
  const input = checked(
    z
      .object({
        page: z.number().int().min(1).max(1000000),
        perPage: z.number().int().min(1).max(50),
        code: catalogPolicyCodeSchema.optional()
      })
      .strict(),
    query
  )
  const evaluatedAt = instant(now),
    started = Date.now()
  await authorize(database, claims, evaluatedAt)
  const parameters = [
    ...actorParameters(claims, evaluatedAt),
    input.code ?? null,
    input.perPage,
    (input.page - 1) * input.perPage
  ]
  const results = await database.batch([
    database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT ${policyProjection('policy')} FROM actor CROSS JOIN catalog_publication_policies policy
      WHERE (?6 IS NULL OR policy.code=?6) ORDER BY policy.code ASC,policy.version DESC LIMIT ?7 OFFSET ?8`
      )
      .bind(...parameters),
    database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT count(*) AS total FROM actor CROSS JOIN catalog_publication_policies policy
      WHERE (?6 IS NULL OR policy.code=?6)`
      )
      .bind(...parameters.slice(0, 6))
  ])
  if (results.some((result) => !result || result.success !== true)) throw new Error('catalog_policy_read_unavailable')
  const items = z.array(policyRowSchema).max(50).parse(results[0]?.results).map(policyView)
  const counter = z
    .array(z.object({ total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }))
    .length(1)
    .parse(results[1]?.results)[0]!
  await authorize(
    database,
    claims,
    now === undefined
      ? undefined
      : new Date(Date.parse(evaluatedAt) + Math.max(0, Date.now() - started)).toISOString().replace(/\.\d{3}Z$/, 'Z')
  )
  return {
    source: 'cloudflare',
    capabilities: { publicationPoliciesRead: true, publicationPoliciesWrite: true },
    items,
    pagination: {
      page: input.page,
      perPage: input.perPage,
      total: counter.total,
      pages: Math.ceil(counter.total / input.perPage)
    },
    evaluatedAt
  }
}
const exceptionViewSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    reason: z.string(),
    evidenceReference: z.string(),
    validFrom: catalogPolicyInstantSchema,
    validUntil: catalogPolicyInstantSchema.nullable()
  })
  .strict()
const variantViewSchema = z.object({
  id: catalogPolicyUuidSchema,
  legacyId: positive.nullable(),
  status: catalogPolicyStatusSchema,
  ean: z.string().max(2000).nullable(),
  gtin: z.string().max(2000).nullable(),
  mpn: z.string().max(2000).nullable(),
  identifierException: z.string().nullable()
})
export async function readD1ProductPublicationPolicy(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  legacyId: string,
  now?: string
): Promise<ProductPublicationPolicyView> {
  const claims = checked(claimsSchema, claimsInput, 'unauthenticated'),
    id = typeof legacyId === 'string' ? parseAdminCatalogLegacyId(legacyId) : null
  if (id === null) throw new CatalogPolicyError('invalid_input')
  const evaluatedAt = instant(now),
    started = Date.now()
  await authorize(database, claims, evaluatedAt)
  const results = await database.batch([
    database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT ${productProjection} FROM actor CROSS JOIN products p WHERE p.legacy_id=?6`
      )
      .bind(...actorParameters(claims, evaluatedAt), id),
    database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT ${policyProjection('policy')} FROM actor CROSS JOIN products p
      JOIN catalog_product_publication_policies assigned ON assigned.id=${currentAssignment('p.id')}
      JOIN catalog_publication_policies policy ON policy.id=assigned.policy_id WHERE p.legacy_id=?6`
      )
      .bind(...actorParameters(claims, evaluatedAt), id),
    database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT v.id,v.legacy_id AS legacyId,v.status,v.ean,v.gtin,v.mpn,
      (SELECT json_object('id',exception.id,'reason',exception.reason,'evidenceReference',exception.evidence_reference,
        'validFrom',exception.valid_from,'validUntil',exception.valid_until)
        FROM catalog_variant_identifier_exceptions exception WHERE exception.variant_id=v.id AND exception.valid_from<=${executionNow}
        AND (exception.valid_until IS NULL OR exception.valid_until>${executionNow}) AND exception.created_at<=${executionNow}
        AND NOT EXISTS(SELECT 1 FROM catalog_variant_identifier_exception_withdrawals w WHERE w.exception_id=exception.id)
        ORDER BY exception.valid_from DESC,exception.created_at DESC,exception.id DESC LIMIT 1) AS identifierException
      FROM actor CROSS JOIN products p JOIN variants v ON v.product_id=p.id WHERE p.legacy_id=?6 ORDER BY v.id LIMIT 501`
      )
      .bind(...actorParameters(claims, evaluatedAt), id)
  ])
  if (results.some((result) => !result || result.success !== true)) throw new Error('catalog_policy_read_unavailable')
  const products = z.array(productRowSchema).max(1).parse(results[0]?.results),
    policies = z.array(policyRowSchema).max(1).parse(results[1]?.results)
  const rows = z.array(variantViewSchema).max(501).parse(results[2]?.results)
  await authorize(
    database,
    claims,
    now === undefined
      ? undefined
      : new Date(Date.parse(evaluatedAt) + Math.max(0, Date.now() - started)).toISOString().replace(/\.\d{3}Z$/, 'Z')
  )
  const product = products[0]
  if (!product) throw new CatalogPolicyError('not_found')
  if (rows.length > 500) throw new CatalogPolicyError('conflict')
  const variants = rows.map(({ identifierException, ...variant }) => {
    const exception = identifierException === null ? null : exceptionViewSchema.parse(json(identifierException))
    if (exception)
      exceptionCreateInputSchema.parse({
        expectedVersion: 1,
        variantId: variant.id,
        reason: exception.reason,
        evidenceReference: exception.evidenceReference,
        validFrom: exception.validFrom,
        validUntil: exception.validUntil
      })
    return { ...variant, identifierException: exception }
  })
  return {
    source: 'cloudflare',
    capabilities: {
      productPublicationPolicyRead: true,
      productPublicationPolicyWrite: true,
      productIdentifierExceptionsWrite: true
    },
    productId: product.id,
    productUuid: product.uuid,
    catalogVersion: product.catalogVersion,
    status: product.status,
    regulatory: regulatoryView(product.regulatory),
    policy: policies[0] ? policyView(policies[0]) : null,
    variants,
    evaluatedAt
  }
}

type Command =
  | { action: 'policy_create'; body: PolicyCreateInput }
  | { action: 'policy_withdraw'; body: PolicyWithdrawInput }
  | { action: 'policy_assign'; body: PolicyAssignInput }
  | { action: 'exception_create'; body: ExceptionCreateInput }
  | { action: 'exception_withdraw'; body: ExceptionWithdrawInput }
function command(action: CatalogPolicyAction, input: unknown): Command {
  switch (action) {
    case 'policy_create':
      return { action, body: checked(policyCreateInputSchema, input) }
    case 'policy_withdraw':
      return { action, body: checked(policyWithdrawInputSchema, input) }
    case 'policy_assign':
      return { action, body: checked(policyAssignInputSchema, input) }
    case 'exception_create':
      return { action, body: checked(exceptionCreateInputSchema, input) }
    case 'exception_withdraw':
      return { action, body: checked(exceptionWithdrawInputSchema, input) }
  }
}
const j = (path: string) => `json_extract(?9,'$.${path}')`
const expected = j('expectedVersion')
const owned = `c.id=?12 AND c.claim_nonce=?13 AND c.actor_id=?3 AND c.action=?6 AND c.idempotency_key=?10
  AND c.payload_hash=?11 AND c.target=?20 AND c.input=?9`
const auditMatch = `a.command_id=c.id AND a.actor_id=c.actor_id AND a.action=c.action AND a.target=c.target AND a.input=c.input
  AND a.entity_id=c.entity_id AND a.resource_id=c.resource_id AND a.policy_version IS c.policy_version
  AND a.product_id IS c.product_id AND a.product_uuid IS c.product_uuid AND a.expected_version=c.expected_version
  AND a.result_version IS c.result_version AND a.reason=c.reason AND a.before_state=c.before_state
  AND a.after_state=c.after_state AND a.response=c.response AND a.created_at=c.created_at`
function response(raw: string): CatalogPolicyReceipt {
  const parsed = json(raw),
    result = catalogPolicyReceiptSchema.safeParse(parsed)
  if (
    !result.success ||
    !parsed ||
    typeof parsed !== 'object' ||
    Object.keys(parsed).join(',') !==
      'source,action,entityId,resourceId,policyVersion,productId,productUuid,catalogVersion,updated'
  )
    throw new Error('catalog_policy_receipt_invalid')
  // The parsed persisted object itself retains the exact historical key order.
  return parsed as CatalogPolicyReceipt
}
async function replay(database: D1Database, claims: VerifiedSessionClaims, key: string, hash: string, now?: string) {
  const row = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT c.payload_hash,c.response,
    EXISTS(SELECT 1 FROM catalog_policy_audit a WHERE ${auditMatch}) AS completed
    FROM actor JOIN catalog_policy_commands c ON c.actor_id=actor.id WHERE c.idempotency_key=?6`
    )
    .bind(...actorParameters(claims, now), key)
    .first<{ payload_hash: string; response: string; completed: number }>()
  if (!row) return null
  // The persisted result is historical, its authorization is not: a grant or
  // session may have changed while the completed-command read was awaiting.
  await authorize(database, claims, now)
  if (row.payload_hash !== hash) throw new CatalogPolicyError('idempotency_conflict')
  if (row.completed !== 1) throw new CatalogPolicyError('conflict')
  return response(row.response)
}
interface Context {
  product: ProductRow | null
  policy: PolicyRow | null
  variantId: string | null
}
async function context(
  database: D1Database,
  claims: VerifiedSessionClaims,
  cmd: Command,
  target: { productId?: string; resourceId?: string },
  now?: string
): Promise<Context> {
  const result: Context = { product: null, policy: null, variantId: null }
  if (cmd.action === 'policy_create') {
    const maximum = await database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT COALESCE(max(policy.version),0) AS version
      FROM actor LEFT JOIN catalog_publication_policies policy ON policy.code=?6`
      )
      .bind(...actorParameters(claims, now), cmd.body.code)
      .first<{ version: number }>()
    await authorize(database, claims, now)
    if (!maximum || !Number.isSafeInteger(maximum.version)) throw new Error('catalog_policy_source_invalid')
    if (maximum.version !== cmd.body.expectedVersion) throw new CatalogPolicyError('version_conflict')
    return result
  }
  if (cmd.action !== 'policy_withdraw') {
    const row = await database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT ${productProjection} FROM actor CROSS JOIN products p WHERE p.legacy_id=?6`
      )
      .bind(...actorParameters(claims, now), Number(target.productId))
      .first()
    await authorize(database, claims, now)
    if (!row) throw new CatalogPolicyError('not_found')
    result.product = productRowSchema.parse(row)
    if (result.product.catalogVersion !== cmd.body.expectedVersion) throw new CatalogPolicyError('version_conflict')
    if (!['draft', 'review', 'hidden'].includes(result.product.status)) throw new CatalogPolicyError('invalid_state')
    if (cmd.action === 'policy_assign' && !regulatoryObject(result.product.regulatory))
      throw new CatalogPolicyError('invalid_state')
  }
  if (cmd.action === 'policy_withdraw' || cmd.action === 'policy_assign' || cmd.action === 'exception_create') {
    const selected =
      cmd.action === 'policy_withdraw'
        ? target.resourceId
        : cmd.action === 'policy_assign'
          ? cmd.body.policyId
          : result.product!.assignmentId
    const predicate =
      cmd.action === 'exception_create'
        ? 'policy.id=(SELECT policy_id FROM catalog_product_publication_policies WHERE id=?6)'
        : 'policy.id=?6'
    const row = await database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT ${policyProjection('policy')} FROM actor CROSS JOIN catalog_publication_policies policy WHERE ${predicate}`
      )
      .bind(...actorParameters(claims, now), selected ?? null)
      .first()
    await authorize(database, claims, now)
    if (!row) throw new CatalogPolicyError(cmd.action === 'exception_create' ? 'policy_unavailable' : 'not_found')
    result.policy = policyRowSchema.parse(row)
    policyView(result.policy)
    if (cmd.action === 'policy_withdraw') {
      if (result.policy.version !== cmd.body.expectedVersion) throw new CatalogPolicyError('version_conflict')
      if (result.policy.withdrawn === 1) throw new CatalogPolicyError('invalid_state')
      if (result.policy.publishedProductCount > 0) throw new CatalogPolicyError('policy_in_use')
    } else if (result.policy.current !== 1) throw new CatalogPolicyError('policy_unavailable')
    if (cmd.action === 'policy_assign' && cmd.body.regulatory.productType !== result.policy.code)
      throw new CatalogPolicyError('invalid_input')
    if (cmd.action === 'exception_create') {
      const regulatory = regulatoryObject(result.product!.regulatory)
      if (
        result.policy.identifierExceptionsAllowed !== 1 ||
        !regulatory ||
        Reflect.get(regulatory, 'productType') !== result.policy.code ||
        typeof Reflect.get(regulatory, 'requiresSds') !== 'boolean'
      )
        throw new CatalogPolicyError('policy_unavailable')
    }
  }
  if (cmd.action === 'exception_create' || cmd.action === 'exception_withdraw') {
    const sql =
      cmd.action === 'exception_create'
        ? `WITH actor AS (${actorSql}) SELECT v.id,v.status FROM actor CROSS JOIN variants v WHERE v.id=?6 AND v.product_id=?7`
        : `WITH actor AS (${actorSql}) SELECT v.id,v.status,EXISTS(SELECT 1 FROM catalog_variant_identifier_exception_withdrawals w WHERE w.exception_id=e.id) AS withdrawn
       FROM actor CROSS JOIN catalog_variant_identifier_exceptions e JOIN variants v ON v.id=e.variant_id WHERE e.id=?6 AND v.product_id=?7`
    const row = await database
      .prepare(sql)
      .bind(
        ...actorParameters(claims, now),
        cmd.action === 'exception_create' ? cmd.body.variantId : target.resourceId,
        result.product!.uuid
      )
      .first<{ id: string; status: string; withdrawn?: number }>()
    await authorize(database, claims, now)
    if (!row) throw new CatalogPolicyError('not_found')
    result.variantId = catalogPolicyUuidSchema.parse(row.id)
    catalogPolicyStatusSchema.parse(row.status)
    if ((cmd.action === 'exception_create' && row.status === 'discontinued') || row.withdrawn === 1)
      throw new CatalogPolicyError('invalid_state')
  }
  return result
}

function entityObject(table: string, id: string, fields: readonly string[]) {
  return `(SELECT json_object(${fields.map((field) => `'${field}',e.${field}`).join(',')}) FROM ${table} e WHERE e.id=${id})`
}
const policyFields = [
  'id',
  'code',
  'version',
  'name',
  'required_fields',
  'required_media_roles',
  'identifier_exceptions_allowed',
  'actor_id',
  'reason',
  'valid_from',
  'valid_until',
  'created_at'
]
const assignmentFields = ['seq', 'id', 'product_id', 'policy_id', 'actor_id', 'reason', 'created_at']
const exceptionFields = [
  'id',
  'variant_id',
  'actor_id',
  'reason',
  'evidence_reference',
  'valid_from',
  'valid_until',
  'created_at'
]
const withdrawalFields = ['id', 'actor_id', 'reason', 'created_at']
function productState(after: boolean, assign: boolean) {
  let regulatory = 'p.regulatory'
  if (after && assign) {
    regulatory = `json_set(p.regulatory,'$.productType',${j('regulatory.productType')},'$.requiresSds',json(CASE WHEN ${j('regulatory.requiresSds')}=1 THEN 'true' ELSE 'false' END))`
    for (const field of ['safetyInstructions', 'hazardStatements', 'precautionaryStatements', 'manufacturer'])
      regulatory = `CASE WHEN json_type(?9,'$.regulatory.${field}') IS NULL THEN ${regulatory} ELSE json_set(${regulatory},'$.${field}',${j(`regulatory.${field}`)}) END`
  }
  return `(SELECT json_object('uuid',p.id,'legacyId',p.legacy_id,'status',p.status,'version',${after ? `CAST(${expected}+1 AS INTEGER)` : 'p.catalog_version'},
    'regulatory',json(${regulatory}),'updatedAt',${after ? executionNow : 'p.updated_at'}) FROM products p WHERE p.id=?15)`
}
function predictedEntity(action: CatalogPolicyAction) {
  const base = `'id',?14,'actor_id',?3,'reason',${j('reason')},'created_at',${executionNow}`
  switch (action) {
    case 'policy_create':
      return `json_object(${base},'code',${j('code')},'version',CAST(${expected}+1 AS INTEGER),'name',${j('name')},
      'required_fields',json_extract(?9,'$.requiredFields')||'','required_media_roles',json_extract(?9,'$.requiredMediaRoles')||'',
      'identifier_exceptions_allowed',${j('identifierExceptionsAllowed')},'valid_from',${j('validFrom')},'valid_until',${j('validUntil')})`
    case 'policy_withdraw':
      return `json_object(${base},'policy_id',?16)`
    case 'policy_assign':
      return `json_object(${base},'seq',(SELECT COALESCE(MAX(seq),0)+1 FROM catalog_product_publication_policies),
      'product_id',?15,'policy_id',?16)`
    case 'exception_create':
      return `json_object(${base},'variant_id',?18,'evidence_reference',${j('evidenceReference')},'valid_from',${j('validFrom')},'valid_until',${j('validUntil')})`
    case 'exception_withdraw':
      return `json_object(${base},'exception_id',?8)`
  }
}
function reorderedPrediction(action: CatalogPolicyAction) {
  const fields =
    action === 'policy_create'
      ? policyFields
      : action === 'policy_assign'
        ? assignmentFields
        : action === 'exception_create'
          ? exceptionFields
          : action === 'policy_withdraw'
            ? ['id', 'policy_id', ...withdrawalFields.slice(1)]
            : ['id', 'exception_id', ...withdrawalFields.slice(1)]
  const predicted = predictedEntity(action)
  return `json_object(${fields.map((field) => `'${field}',json_extract(${predicted},'$.${field}')`).join(',')})`
}
interface Plan {
  before: string
  predicted: string
  after: string
  pre: string
  post: string
  domain: string[]
}
function plan(cmd: Command, ctx: Context): Plan {
  const action = cmd.action,
    isProduct = ctx.product !== null,
    assign = action === 'policy_assign'
  const entityTable =
    action === 'policy_create'
      ? 'catalog_publication_policies'
      : action === 'policy_withdraw'
        ? 'catalog_publication_policy_withdrawals'
        : assign
          ? 'catalog_product_publication_policies'
          : action === 'exception_create'
            ? 'catalog_variant_identifier_exceptions'
            : 'catalog_variant_identifier_exception_withdrawals'
  const fields =
    action === 'policy_create'
      ? policyFields
      : assign
        ? assignmentFields
        : action === 'exception_create'
          ? exceptionFields
          : action === 'policy_withdraw'
            ? ['id', 'policy_id', ...withdrawalFields.slice(1)]
            : ['id', 'exception_id', ...withdrawalFields.slice(1)]
  const entity = entityObject(entityTable, '?14', fields),
    policy = ctx.policy ? entityObject('catalog_publication_policies', '?16', policyFields) : 'NULL'
  const oldAssignment = entityObject('catalog_product_publication_policies', '?17', assignmentFields)
  const maximum = `(SELECT COALESCE(MAX(version),0) FROM catalog_publication_policies WHERE code=${j('code')})`
  const beforeEntity =
    action === 'exception_withdraw'
      ? entityObject('catalog_variant_identifier_exceptions', '?8', exceptionFields)
      : 'NULL'
  const snapshot = (
    product: string,
    assignment: string,
    record: string,
    max: string
  ) => `json_object('product',json(${product}),'policy',json(${policy}),
    'assignment',json(${assignment}),'previousException',json(${beforeEntity}),'entity',json(${record}),'maximumVersion',${max})`
  const before = snapshot(
    isProduct ? productState(false, false) : 'NULL',
    isProduct ? oldAssignment : 'NULL',
    'NULL',
    action === 'policy_create' ? maximum : 'NULL'
  )
  const predicted = snapshot(
    isProduct ? productState(true, assign) : 'NULL',
    assign ? reorderedPrediction(action) : isProduct ? oldAssignment : 'NULL',
    reorderedPrediction(action),
    action === 'policy_create' ? `CAST(${expected}+1 AS INTEGER)` : 'NULL'
  )
  // Actual state uses actual timestamps/version/regulatory, never a prediction.
  const after = snapshot(
    isProduct ? productState(false, false) : 'NULL',
    assign
      ? entityObject('catalog_product_publication_policies', currentAssignment('?15'), assignmentFields)
      : isProduct
        ? entityObject('catalog_product_publication_policies', currentAssignment('?15'), assignmentFields)
        : 'NULL',
    entity,
    action === 'policy_create' ? maximum : 'NULL'
  )
  const productPre = `EXISTS(SELECT 1 FROM products p WHERE p.id=?15 AND p.legacy_id=?7 AND p.catalog_version=${expected}
    AND p.status IN ('draft','review','hidden') AND ${currentAssignment('p.id')} IS ?17)`
  const productPost = `EXISTS(SELECT 1 FROM products p WHERE p.id=?15 AND p.legacy_id=?7 AND p.catalog_version=${expected}+1
    AND p.status IN ('draft','review','hidden') AND ${currentAssignment('p.id')} IS ${assign ? '?14' : '?17'})`
  const policyAvailable = `EXISTS(SELECT 1 FROM catalog_publication_policies policy WHERE policy.id=?16 AND ${availablePolicy('policy')})`
  const classification = `EXISTS(SELECT 1 FROM products p JOIN catalog_publication_policies policy ON policy.id=?16 WHERE p.id=?15
    AND json_type(p.regulatory)='object' AND json_extract(p.regulatory,'$.productType')=policy.code
    AND json_type(p.regulatory,'$.requiresSds') IN ('true','false') AND policy.identifier_exceptions_allowed=1)`
  const variant = `EXISTS(SELECT 1 FROM variants v WHERE v.id=?18 AND v.product_id=?15${action === 'exception_create' ? " AND v.status<>'discontinued'" : ''})`
  let pre = '1',
    post = '1'
  if (action === 'policy_create') {
    pre = `${maximum}=${expected}`
    post = `${maximum}=${expected}+1`
  }
  if (action === 'policy_withdraw') {
    pre = `EXISTS(SELECT 1 FROM catalog_publication_policies policy WHERE policy.id=?16 AND policy.version=${expected})
    AND NOT EXISTS(SELECT 1 FROM catalog_publication_policy_withdrawals WHERE policy_id=?16) AND NOT ${inUse('?16')}`
    post = `NOT ${inUse('?16')}`
  }
  if (assign) {
    pre = `${productPre} AND ${policyAvailable} AND EXISTS(SELECT 1 FROM products p JOIN catalog_publication_policies policy ON policy.id=?16
    WHERE p.id=?15 AND json_type(p.regulatory)='object' AND policy.code=${j('regulatory.productType')})`
    post = `${productPost} AND ${policyAvailable}`
  }
  if (action === 'exception_create') {
    pre = `${productPre} AND ${policyAvailable} AND ${classification} AND ${variant}`
    post = `${productPost} AND ${policyAvailable} AND ${classification} AND ${variant}`
  }
  if (action === 'exception_withdraw') {
    pre = `${productPre} AND ${variant} AND NOT EXISTS(SELECT 1 FROM catalog_variant_identifier_exception_withdrawals WHERE exception_id=?8)`
    post = `${productPost} AND ${variant}`
  }
  const live = `WITH actor AS (${actorSql}),owned AS MATERIALIZED(SELECT c.* FROM actor JOIN catalog_policy_commands c ON c.actor_id=actor.id
    WHERE ${owned} AND (${pre}) AND c.before_state=${before})`
  const insertSelect = (sql: string, where: string) => `${sql} SELECT ${where} FROM owned c`
  const domain: string[] = []
  if (action === 'policy_create')
    domain.push(
      `${live} ${insertSelect(
        `INSERT INTO catalog_publication_policies(${policyFields.join(',')})`,
        `?14,${j('code')},CAST(${expected}+1 AS INTEGER),${j('name')},json_extract(?9,'$.requiredFields'),json_extract(?9,'$.requiredMediaRoles'),${j('identifierExceptionsAllowed')},?3,${j('reason')},${j('validFrom')},${j('validUntil')},c.created_at`
      )}`
    )
  if (action === 'policy_withdraw')
    domain.push(
      `${live} ${insertSelect(
        `INSERT INTO catalog_publication_policy_withdrawals(id,policy_id,actor_id,reason,created_at)`,
        `?14,?16,?3,${j('reason')},c.created_at`
      )}`
    )
  if (isProduct) {
    const nextReg = assign ? `json_extract(c.after_state,'$.product.regulatory')` : 'p.regulatory'
    domain.push(`${live} UPDATE products AS p SET regulatory=${assign ? `(SELECT ${nextReg} FROM owned c)` : 'regulatory'},
      catalog_version=CAST(${expected}+1 AS INTEGER),updated_at=(SELECT created_at FROM owned)
      WHERE p.id=?15 AND p.catalog_version=${expected} AND EXISTS(SELECT 1 FROM owned)`)
    const intermediate = `EXISTS(SELECT 1 FROM products p WHERE p.id=?15 AND p.catalog_version=${expected}+1 AND p.status IN ('draft','review','hidden')
      AND ${currentAssignment('p.id')} IS ?17 AND json(p.regulatory)=json_extract(c.after_state,'$.product.regulatory') AND p.updated_at=c.created_at)`
    const secondLive = `WITH actor AS (${actorSql})`
    const selectOwned = `FROM actor JOIN catalog_policy_commands c ON c.actor_id=actor.id WHERE ${owned} AND ${intermediate}`
    if (assign)
      domain.push(`${secondLive} INSERT INTO catalog_product_publication_policies(${assignmentFields.join(',')})
      SELECT json_extract(c.after_state,'$.assignment.seq'),?14,?15,?16,?3,${j('reason')},c.created_at ${selectOwned} AND ${policyAvailable}
        AND NOT EXISTS(SELECT 1 FROM catalog_product_publication_policies WHERE seq>=json_extract(c.after_state,'$.assignment.seq'))`)
    if (action === 'exception_create')
      domain.push(`${secondLive} INSERT INTO catalog_variant_identifier_exceptions(${exceptionFields.join(',')})
      SELECT ?14,?18,?3,${j('reason')},${j('evidenceReference')},${j('validFrom')},${j('validUntil')},c.created_at ${selectOwned}
        AND ${policyAvailable} AND ${classification} AND ${variant}`)
    if (action === 'exception_withdraw')
      domain.push(`${secondLive} INSERT INTO catalog_variant_identifier_exception_withdrawals(id,exception_id,actor_id,reason,created_at)
      SELECT ?14,?8,?3,${j('reason')},c.created_at ${selectOwned} AND ${variant}
        AND NOT EXISTS(SELECT 1 FROM catalog_variant_identifier_exception_withdrawals WHERE exception_id=?8)`)
  }
  return { before, predicted, after, pre, post, domain }
}

export async function executeD1CatalogPolicyCommand(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  actionInput: CatalogPolicyAction,
  targetInput: { productId?: string; resourceId?: string },
  input: unknown,
  options: { idempotencyKey: string; now?: string }
): Promise<CatalogPolicyReceipt> {
  const action = checked(catalogPolicyActionSchema, actionInput),
    cmd = command(action, input)
  const target = checked(
    z.object({ productId: z.string().optional(), resourceId: catalogPolicyUuidSchema.optional() }).strict(),
    targetInput
  )
  const requiresProduct = ['policy_assign', 'exception_create', 'exception_withdraw'].includes(action),
    requiresResource = ['policy_withdraw', 'exception_withdraw'].includes(action)
  if (
    requiresProduct !== Object.hasOwn(target, 'productId') ||
    requiresResource !== Object.hasOwn(target, 'resourceId') ||
    (requiresProduct && parseAdminCatalogLegacyId(target.productId!) === null)
  )
    throw new CatalogPolicyError('invalid_input')
  const opts = checked(
    z
      .object({
        idempotencyKey: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9._:-]+$/)
          .refine((value) =>
            [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
          ),
        now: catalogPolicyInstantSchema.optional()
      })
      .strict(),
    options
  )
  const claims = checked(claimsSchema, claimsInput, 'unauthenticated')
  await authorize(database, claims, opts.now)
  const payload = JSON.stringify(['catalog.policy.v1', action, target, cmd.body]),
    digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const completed = await replay(database, claims, opts.idempotencyKey, hash, opts.now)
  if (completed) return completed
  let ctx: Context
  try {
    ctx = await context(database, claims, cmd, target, opts.now)
  } catch (error) {
    if (error instanceof CatalogPolicyError) {
      await authorize(database, claims, opts.now)
      const winner = await replay(database, claims, opts.idempotencyKey, hash, opts.now)
      if (winner) return winner
    }
    throw error
  }
  const execution = plan(cmd, ctx),
    entityId = crypto.randomUUID()
  const resourceId =
    action === 'policy_create'
      ? entityId
      : action === 'exception_create'
        ? ctx.variantId!
        : action === 'exception_withdraw'
          ? target.resourceId!
          : ctx.policy!.id
  const policyVersion =
    action === 'policy_create'
      ? cmd.body.expectedVersion + 1
      : action === 'exception_withdraw'
        ? null
        : ctx.policy!.version
  const parameters = [
    ...actorParameters(claims, opts.now),
    action,
    requiresProduct ? Number(target.productId) : null,
    target.resourceId ?? null,
    JSON.stringify(cmd.body),
    opts.idempotencyKey,
    hash,
    crypto.randomUUID(),
    crypto.randomUUID(),
    entityId,
    ctx.product?.uuid ?? null,
    ctx.policy?.id ?? null,
    ctx.product?.assignmentId ?? null,
    ctx.variantId,
    policyVersion,
    JSON.stringify(target)
  ]
  const resultVersion = requiresProduct ? `CAST(${expected}+1 AS INTEGER)` : 'NULL'
  const resource =
    action === 'policy_create'
      ? '?14'
      : action === 'exception_create'
        ? '?18'
        : action === 'exception_withdraw'
          ? '?8'
          : '?16'
  const policyVersionSql = action === 'policy_create' ? `CAST(${expected}+1 AS INTEGER)` : 'CAST(?19 AS INTEGER)'
  const receiptSql = `json_object('source','cloudflare','action',?6,'entityId',?14,'resourceId',${resource},'policyVersion',${policyVersionSql},
    'productId',CAST(?7 AS INTEGER),'productUuid',?15,'catalogVersion',${resultVersion},'updated',json('true'))`
  const columns =
    'actor_id,action,target,input,entity_id,resource_id,policy_version,product_id,product_uuid,expected_version,result_version,reason,before_state,after_state,response,created_at'
  const statements = [
    database
      .prepare(
        `WITH actor AS (${actorSql}) INSERT INTO catalog_policy_commands
    (id,claim_nonce,${columns},idempotency_key,payload_hash)
    SELECT ?12,?13,actor.id,?6,?20,?9,?14,${resource},${policyVersionSql},?7,?15,CAST(${expected} AS INTEGER),${resultVersion},${j('reason')},
      ${execution.before},${execution.predicted},${receiptSql},${executionNow},?10,?11 FROM actor WHERE (${execution.pre})
      AND NOT EXISTS(SELECT 1 FROM catalog_policy_commands WHERE actor_id=?3 AND idempotency_key=?10)`
      )
      .bind(...parameters),
    ...execution.domain.map((sql) => database.prepare(sql).bind(...parameters)),
    database
      .prepare(
        `WITH actor AS (${actorSql}) INSERT INTO catalog_policy_audit(id,command_id,${columns})
      SELECT c.id,c.id,${columns
        .split(',')
        .map((column) => `c.${column}`)
        .join(',')} FROM actor JOIN catalog_policy_commands c ON c.actor_id=actor.id
      WHERE ${owned} AND (${execution.post}) AND c.after_state=${execution.after}`
      )
      .bind(...parameters),
    database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT c.response FROM actor JOIN catalog_policy_commands c ON c.actor_id=actor.id
      JOIN catalog_policy_audit a ON ${auditMatch} WHERE ${owned}`
      )
      .bind(...parameters),
    database
      .prepare(
        `WITH actor AS (${actorSql}) INSERT INTO catalog_policy_guards(id,satisfied) SELECT lower(hex(randomblob(16))),0
      WHERE NOT EXISTS(SELECT 1 FROM actor JOIN catalog_policy_commands c ON c.actor_id=actor.id JOIN catalog_policy_audit a ON ${auditMatch}
        WHERE ${owned} AND (${execution.post}) AND c.after_state=${execution.after})`
      )
      .bind(...parameters)
  ]
  try {
    const results = await database.batch<{ response: string }>(statements)
    if (results.length !== statements.length || results.some((result) => !result || result.success !== true))
      throw new Error('catalog_policy_write_unavailable')
    const row = results[statements.length - 2]?.results[0]
    if (!row || typeof row.response !== 'string') throw new CatalogPolicyError('conflict')
    const result = response(row.response)
    if (result.resourceId !== resourceId || result.policyVersion !== policyVersion)
      throw new Error('catalog_policy_receipt_invalid')
    return result
  } catch (error) {
    const errorCode: unknown = error instanceof Error ? Reflect.get(error, 'errcode') : undefined
    const constraint =
      error instanceof Error &&
      (/\bSQLITE_CONSTRAINT(?:_[A-Z_]+)?\b/.test(error.message) ||
        /^(?:D1_ERROR: )?(?:catalog_policy_atomic_guard|catalog_policy_(?:commands|audit)_immutable|catalog_policy_audit_command)$/.test(
          error.message
        ) ||
        (typeof errorCode === 'number' && (errorCode & 255) === 19))
    if (!(error instanceof CatalogPolicyError) && !constraint) throw error
    await authorize(database, claims, opts.now)
    const winner = await replay(database, claims, opts.idempotencyKey, hash, opts.now)
    if (winner) return winner
    await context(database, claims, cmd, target, opts.now)
    throw new CatalogPolicyError('conflict')
  }
}
