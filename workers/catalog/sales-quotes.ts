import {
  salesQuoteCreateInputSchema,
  salesQuoteReviseInputSchema,
  salesQuoteReviewInputSchema,
  salesQuoteApproveInputSchema,
  salesQuoteAdminSnapshotSchema,
  salesQuoteReceiptSchema,
  salesQuoteIntentHash,
  salesQuoteConversionIntentHash,
  type SalesQuoteAction,
  type SalesQuoteAdminSnapshot,
  type SalesQuoteCommand,
  type SalesQuoteReceipt
} from '../../shared/sales-quotes'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { activeOrderCustomerId } from './customer-orders'
import { placeOrder, requestShippingOptions, assertCheckoutAddress, type CheckoutInventoryGateway, type PlaceOrderInput } from './checkout'
import {
  canonicalPayloadHash,
  CartError,
  getCart,
  quoteCart,
  mapQuoteLines,
  prepareQuoteLinesStatement,
  type RawResolvedLine
} from './cart'
import {
  mapShippingOptions,
  prepareShippingRatesStatement,
  type RateRow,
  type ShippingOptionSnapshot
} from './shipping'
import { quoteLine, validateQuantity } from '../../server/domain/money'
import { publicationValidityExpression } from './publication-validity'

export class SalesQuoteError extends Error {
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
      | 'quote_expired'
      | 'quote_not_approved'
      | 'quote_changed'
      | 'history_unconfirmed'
      | 'service_unavailable'
  ) {
    super(code)
    this.name = 'SalesQuoteError'
  }
}
export type SalesQuoteOptions = { now?: string; freeShippingThresholdCents?: number | null }
export type SalesQuoteConversionInput = {
  expectedVersion: number
  approvedHash: string
  /** Trusted adapter input: session and cart token come from verified cookies, not arbitrary HTTP fields. */
  checkout: PlaceOrderInput
}
export type SalesQuoteCheckoutReference = { quoteId: string; version: number; approvedHash: string }
const clocks = (options: SalesQuoteOptions) => {
  const started = Date.now(),
    initial = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!catalogPolicyInstantSchema.safeParse(initial).success) throw new SalesQuoteError('invalid_input')
  return () => new Date(Date.parse(initial) + Math.max(0, Date.now() - started)).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
function parsed<T>(schema: { parse(raw: unknown): T }, raw: unknown): T {
  try {
    return schema.parse(raw)
  } catch {
    throw new SalesQuoteError('invalid_input')
  }
}
function key(value: string) {
  if (!catalogPolicyUuidSchema.safeParse(value).success) throw new SalesQuoteError('invalid_input')
}
async function admin(database: D1Database, claims: VerifiedSessionClaims | null, now: string) {
  if (!claims) throw new SalesQuoteError('unauthenticated')
  const result = await authorizeD1Session(database, claims, 'administration.manage', { now, requireMfa: true })
  if (!result.allowed) throw new SalesQuoteError(result.code)
  const enrolled = await database
    .prepare('SELECT 1 AS ok FROM identity_mfa WHERE identity_id=? AND verified_at IS NOT NULL AND verified_at<=?')
    .bind(claims.identityId, now)
    .first()
  if (!enrolled) throw new SalesQuoteError('mfa_required')
}
const actorPredicate = `EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
 JOIN identity_mfa m ON m.identity_id=i.id AND m.verified_at IS NOT NULL AND m.verified_at<=?4
 WHERE s.id=?1 AND s.identity_id=?2 AND s.session_version=?3 AND s.revoked_at IS NULL AND s.created_at<=?4 AND s.expires_at>?4
 AND i.status='active' AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=?4 AND s.mfa_verified=1
 AND NOT EXISTS(SELECT 1 FROM json_each('["administration.manage"]') needed WHERE NOT EXISTS(
 SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id AND p.permission_code=needed.value
 AND r.granted_at<=?4 AND (r.expires_at IS NULL OR r.expires_at>?4))))`
const ownerPredicate = `EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
 JOIN customers c ON c.id=i.customer_id AND c.status='active' WHERE s.id=?1 AND s.identity_id=?2 AND s.session_version=?3
 AND s.revoked_at IS NULL AND s.created_at<=?4 AND s.expires_at>?4 AND i.status='active' AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=?4 AND c.id=?5)`
function authorityGuard(database: D1Database, claims: VerifiedSessionClaims, now: string, customerId?: string) {
  return database
    .prepare(
      `INSERT INTO sales_quote_guards(id,valid) SELECT ?6,CASE WHEN ${customerId ? ownerPredicate : actorPredicate} THEN 1 ELSE 0 END`
    )
    .bind(claims.sessionId, claims.identityId, claims.sessionVersion, now, customerId ?? null, crypto.randomUUID())
}
async function load(database: D1Database, id: string): Promise<SalesQuoteAdminSnapshot> {
  key(id)
  const rows = await database
    .prepare(
      `SELECT h.customer_id,h.current_version,v.version,v.snapshot_json,v.snapshot_hash,
    c.receipt_json,c.input_json,c.action,c.payload_hash,c.command_id,c.actor_id,
    a.receipt_json AS audit_receipt,a.input_json AS audit_input
    FROM sales_quotes h JOIN sales_quote_versions v ON v.quote_id=h.id
    LEFT JOIN sales_quote_commands c ON c.quote_id=v.quote_id AND c.result_version=v.version
    LEFT JOIN sales_quote_audit a ON a.actor_id=c.actor_id AND a.command_id=c.command_id
    WHERE h.id=? ORDER BY v.version LIMIT 1001`
    )
    .bind(id)
    .all<Record<string, unknown>>()
  if (!rows.success) throw new SalesQuoteError('service_unavailable')
  if (!rows.results.length) throw new SalesQuoteError('not_found')
  if (rows.results.length > 1000 || rows.results.length !== rows.results[0]!.current_version)
    throw new SalesQuoteError('history_unconfirmed')
  let latest: SalesQuoteAdminSnapshot | undefined
  for (const [index, row] of rows.results.entries()) {
    try {
      const snapshot = salesQuoteAdminSnapshotSchema.parse(JSON.parse(String(row.snapshot_json)))
      const receipt = salesQuoteReceiptSchema.parse(JSON.parse(String(row.receipt_json)))
      if (
        row.version !== index + 1 ||
        snapshot.id !== id ||
        snapshot.version !== row.version ||
        snapshot.definition.customerId !== row.customer_id ||
        receipt.quoteId !== id ||
        receipt.version !== row.version ||
        receipt.commandId !== row.command_id ||
        receipt.action !== row.action ||
        receipt.payloadHash !== row.payload_hash ||
        row.receipt_json !== row.audit_receipt ||
        row.input_json !== row.audit_input ||
        (await canonicalPayloadHash({ snapshot })) !== row.snapshot_hash
      )
        throw new Error('invalid')
      latest = snapshot
    } catch {
      throw new SalesQuoteError('history_unconfirmed')
    }
  }
  return latest!
}
const economicHash = (s: SalesQuoteAdminSnapshot) =>
  canonicalPayloadHash({
    definition: s.definition,
    lines: s.lines,
    goods: s.goods,
    shipping: s.shipping,
    total: s.total,
    goodsCostNetCents: s.goodsCostNetCents,
    goodsMarginNetCents: s.goodsMarginNetCents
  })
async function reviewed(
  database: D1Database,
  snapshot: SalesQuoteAdminSnapshot,
  now: string,
  options: SalesQuoteOptions
) {
  const data = await database.batch([
    prepareQuoteLinesStatement(database, { lines: snapshot.definition.lines, instant: now }),
    prepareShippingRatesStatement(database, 1001)
  ])
  if (
    data.length !== 2 ||
    data.some((row) => !row.success || !Array.isArray(row.results)) ||
    data[1]!.results.length > 1000
  )
    throw new SalesQuoteError('service_unavailable')
  const lines = mapQuoteLines(data[0]!.results as unknown as RawResolvedLine[])
  if (lines.length !== snapshot.definition.lines.length) throw new SalesQuoteError('quote_changed')
  for (const line of lines) {
    if (!snapshot.definition.lines.some((item) => item.variantId === line.variantId && item.quantity === line.quantity))
      throw new SalesQuoteError('quote_changed')
    try {
      validateQuantity(line.quantity, line)
    } catch {
      throw new SalesQuoteError('invalid_input')
    }
  }
  const projected = lines.map((line) => {
    const q = quoteLine(line)
    return {
      variantId: line.variantId,
      quantity: line.quantity,
      unitGrossCents: line.unitGrossCents,
      taxRateBasisPoints: line.taxRateBasisPoints,
      priceVersionId: line.priceVersionId,
      costUnitNetCents: line.costUnitNetCents,
      amounts: { netCents: q.netCents, taxCents: q.taxCents, grossCents: q.grossCents }
    }
  })
  const goods = projected.reduce(
    (sum, line) => ({
      netCents: sum.netCents + line.amounts.netCents,
      taxCents: sum.taxCents + line.amounts.taxCents,
      grossCents: sum.grossCents + line.amounts.grossCents
    }),
    { netCents: 0, taxCents: 0, grossCents: 0 }
  )
  const rates = mapShippingOptions(
    lines.map((line) => ({ ...line, published: 1 })),
    data[1]!.results as unknown as RateRow[],
    snapshot.definition.destination,
    options.freeShippingThresholdCents == null
      ? undefined
      : { threshold: options.freeShippingThresholdCents, goodsGross: goods.grossCents }
  )
  const selected = rates.find((rate) => rate.methodCode === snapshot.definition.shippingMethod)
  if (!selected) throw new SalesQuoteError('quote_changed')
  const shipping = { netCents: selected.netCents, taxCents: selected.taxCents, grossCents: selected.grossCents }
  const cost = projected.some((line) => line.costUnitNetCents === null)
    ? null
    : projected.reduce((sum, line) => sum + line.costUnitNetCents! * line.quantity, 0)
  return salesQuoteAdminSnapshotSchema.parse({
    ...snapshot,
    lines: projected,
    goods,
    shipping,
    total: {
      netCents: goods.netCents + shipping.netCents,
      taxCents: goods.taxCents + shipping.taxCents,
      grossCents: goods.grossCents + shipping.grossCents
    },
    goodsCostNetCents: cost,
    goodsMarginNetCents: cost === null ? null : goods.netCents - cost
  })
}
async function cached(database: D1Database, claims: VerifiedSessionClaims, commandId: string, hash: string) {
  const row = await database
    .prepare('SELECT quote_id,payload_hash,receipt_json FROM sales_quote_commands WHERE actor_id=? AND command_id=?')
    .bind(claims.identityId, commandId)
    .first<{ quote_id: string; payload_hash: string; receipt_json: string }>()
  if (!row) return null
  if (row.payload_hash !== hash) throw new SalesQuoteError('idempotency_conflict')
  await load(database, row.quote_id)
  return parsed(salesQuoteReceiptSchema, JSON.parse(row.receipt_json))
}
async function statements(
  database: D1Database,
  claims: VerifiedSessionClaims,
  snapshot: SalesQuoteAdminSnapshot,
  receipt: SalesQuoteReceipt,
  input: unknown
) {
  const body = JSON.stringify(snapshot),
    raw = JSON.stringify(input)
  return [
    database
      .prepare(
        'INSERT INTO sales_quote_versions(quote_id,version,status,snapshot_json,snapshot_hash,actor_id,created_at) VALUES(?,?,?,?,?,?,?)'
      )
      .bind(
        snapshot.id,
        snapshot.version,
        snapshot.status,
        body,
        await canonicalPayloadHash({ snapshot }),
        claims.identityId,
        snapshot.updatedAt
      ),
    database
      .prepare(
        'INSERT INTO sales_quote_commands(actor_id,command_id,session_id,session_version,quote_id,action,payload_hash,input_json,receipt_json,result_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
      )
      .bind(
        claims.identityId,
        receipt.commandId,
        claims.sessionId,
        claims.sessionVersion,
        snapshot.id,
        receipt.action,
        receipt.payloadHash,
        raw,
        JSON.stringify(receipt),
        snapshot.version,
        snapshot.updatedAt
      ),
    database
      .prepare(
        'INSERT INTO sales_quote_audit(actor_id,command_id,quote_id,result_version,input_json,receipt_json,created_at) VALUES(?,?,?,?,?,?,?)'
      )
      .bind(
        claims.identityId,
        receipt.commandId,
        snapshot.id,
        snapshot.version,
        raw,
        JSON.stringify(receipt),
        snapshot.updatedAt
      )
  ]
}
export async function executeD1SalesQuoteCommand(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  action: SalesQuoteAction,
  quoteId: string | null,
  raw: unknown,
  options: SalesQuoteOptions & { idempotencyKey: string }
): Promise<SalesQuoteReceipt> {
  const clock = clocks(options)
  key(options.idempotencyKey)
  await admin(database, claims, clock())
  const input =
    action === 'create'
      ? parsed(salesQuoteCreateInputSchema, raw)
      : action === 'revise'
        ? parsed(salesQuoteReviseInputSchema, raw)
        : action === 'approve'
          ? parsed(salesQuoteApproveInputSchema, raw)
          : parsed(salesQuoteReviewInputSchema, raw)
  const hash = await salesQuoteIntentHash(action, quoteId, input)
  const replay = await cached(database, claims!, options.idempotencyKey, hash)
  if (replay) {
    await admin(database, claims, clock())
    return replay
  }
  const now = clock()
  let snapshot: SalesQuoteAdminSnapshot
  if (action === 'create') {
    const definition = salesQuoteCreateInputSchema.parse(input)
    const { reason: _reason, ...draft } = definition
    void _reason
    const customer = await database
      .prepare("SELECT 1 AS ok FROM customers WHERE id=? AND status='active'")
      .bind(draft.customerId)
      .first()
    if (!customer) throw new SalesQuoteError('not_found')
    if (draft.validUntil <= now) throw new SalesQuoteError('quote_expired')
    snapshot = {
      source: 'cloudflare',
      id: crypto.randomUUID(),
      version: 1,
      status: 'draft',
      definition: draft,
      lines: [],
      goods: null,
      shipping: null,
      total: null,
      goodsCostNetCents: null,
      goodsMarginNetCents: null,
      shippingOperationalCostNetCents: null,
      totalMarginNetCents: null,
      reviewedHash: null,
      approvedHash: null,
      orderId: null,
      createdAt: now,
      updatedAt: now
    }
  } else {
    snapshot = await load(database, quoteId!)
    if (!('expectedVersion' in input) || input.expectedVersion !== snapshot.version)
      throw new SalesQuoteError('version_conflict')
    if (snapshot.status === 'converted' || snapshot.status === 'revoked')
      throw new SalesQuoteError('quote_not_approved')
    if (action !== 'revoke' && snapshot.definition.validUntil <= now) throw new SalesQuoteError('quote_expired')
    if (action === 'revise') {
      const {
        expectedVersion: _expectedVersion,
        reason: _reason,
        ...definition
      } = salesQuoteReviseInputSchema.parse(input)
      void [_expectedVersion, _reason]
      if (definition.customerId !== snapshot.definition.customerId) throw new SalesQuoteError('invalid_input')
      snapshot = {
        ...snapshot,
        definition,
        status: 'draft',
        lines: [],
        goods: null,
        shipping: null,
        total: null,
        goodsCostNetCents: null,
        goodsMarginNetCents: null,
        reviewedHash: null,
        approvedHash: null
      }
    } else if (action === 'review') {
      snapshot = await reviewed(database, snapshot, now, options)
      snapshot = { ...snapshot, status: 'reviewed', reviewedHash: await economicHash(snapshot), approvedHash: null }
    } else if (action === 'approve') {
      if (
        snapshot.status !== 'reviewed' ||
        !('reviewedHash' in input) ||
        input.reviewedHash !== snapshot.reviewedHash ||
        (await economicHash(await reviewed(database, snapshot, now, options))) !== snapshot.reviewedHash
      )
        throw new SalesQuoteError('quote_changed')
      snapshot = { ...snapshot, status: 'approved', approvedHash: snapshot.reviewedHash }
    } else snapshot = { ...snapshot, status: 'revoked' }
    snapshot = { ...snapshot, version: snapshot.version + 1, updatedAt: now }
  }
  const receipt: SalesQuoteReceipt = {
    source: 'cloudflare',
    commandId: options.idempotencyKey,
    action,
    quoteId: snapshot.id,
    version: snapshot.version,
    payloadHash: hash,
    orderId: null,
    recordedAt: now
  }
  const write = await statements(database, claims!, snapshot, receipt, input)
  try {
    await database.batch([
      ...(action === 'create'
        ? [
            database
              .prepare(
                'INSERT INTO sales_quotes(id,customer_id,current_version,created_by,created_at,updated_at) VALUES(?,?,1,?,?,?)'
              )
              .bind(snapshot.id, snapshot.definition.customerId, claims!.identityId, now, now)
          ]
        : []),
      ...write,
      ...(action === 'create'
        ? []
        : [
            database
              .prepare('UPDATE sales_quotes SET current_version=?,updated_at=? WHERE id=? AND current_version=?')
              .bind(snapshot.version, now, snapshot.id, snapshot.version - 1)
          ]),
      database
        .prepare(
          'INSERT INTO sales_quote_guards(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM sales_quotes WHERE id=? AND current_version=?) THEN 1 ELSE 0 END'
        )
        .bind(crypto.randomUUID(), snapshot.id, snapshot.version),
      authorityGuard(database, claims!, clock())
    ])
  } catch {
    await admin(database, claims, clock())
    const won = await cached(database, claims!, options.idempotencyKey, hash)
    if (won) return won
    if (action !== 'create' && (await load(database, snapshot.id)).version !== snapshot.version - 1)
      throw new SalesQuoteError('version_conflict')
    throw new SalesQuoteError('service_unavailable')
  }
  await admin(database, claims, clock())
  return receipt
}
export async function readD1AdminSalesQuote(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  quoteId: string,
  options: SalesQuoteOptions = {}
): Promise<SalesQuoteAdminSnapshot> {
  const clock = clocks(options)
  await admin(database, claims, clock())
  const snapshot = await load(database, quoteId)
  // Cost visibility is narrower than the authority to conduct commercial work.
  // Denied cost access is redacted; an infrastructure failure must still escape.
  await admin(database, claims, clock())
  const visibility = await database
    .prepare(
      `SELECT CASE WHEN EXISTS(SELECT 1 FROM identity_roles r
    JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=?2 AND p.permission_code='catalog.write'
    AND r.granted_at<=?4 AND (r.expires_at IS NULL OR r.expires_at>?4)) THEN 1 ELSE 0 END AS costs WHERE ${actorPredicate}`
    )
    .bind(claims!.sessionId, claims!.identityId, claims!.sessionVersion, clock())
    .first<{ costs: number }>()
  if (!visibility) {
    await admin(database, claims, clock())
    throw new SalesQuoteError('service_unavailable')
  }
  if (visibility.costs !== 1)
    return {
      ...snapshot,
      lines: snapshot.lines.map((line) => ({ ...line, costUnitNetCents: null })),
      goodsCostNetCents: null,
      goodsMarginNetCents: null
    }
  return snapshot
}

export async function authorizeD1SalesQuoteAdmin(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  options: SalesQuoteOptions = {}
) {
  await admin(database, claims, clocks(options)())
}

/** Deliberate customer allowlist: no costs, margins, staff reasons or sessions. */
export async function readD1CustomerSalesQuote(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  quoteId: string,
  options: SalesQuoteOptions = {}
) {
  const clock = clocks(options),
    customerId = await activeOrderCustomerId(database, claims, clock())
  if (!customerId) throw new SalesQuoteError('unauthenticated')
  const snapshot = await load(database, quoteId)
  if (snapshot.definition.customerId !== customerId) throw new SalesQuoteError('not_found')
  await owner(database, claims, customerId, clock())
  return {
    source: snapshot.source,
    id: snapshot.id,
    version: snapshot.version,
    status: snapshot.status,
    destination: snapshot.definition.destination,
    shippingMethod: snapshot.definition.shippingMethod,
    validUntil: snapshot.definition.validUntil,
    lines: snapshot.lines.map(({ variantId, quantity, unitGrossCents, taxRateBasisPoints, amounts }) => ({
      variantId,
      quantity,
      unitGrossCents,
      taxRateBasisPoints,
      amounts
    })),
    goods: snapshot.goods,
    shipping: snapshot.shipping,
    total: snapshot.total,
    approvedHash: snapshot.approvedHash,
    orderId: snapshot.orderId,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt
  }
}

export async function listD1SalesQuotes(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  audience: 'admin' | 'customer',
  page = 1,
  options: SalesQuoteOptions = {}
) {
  const clock = clocks(options)
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new SalesQuoteError('invalid_input')
  const customerId = audience === 'customer' ? await activeOrderCustomerId(database, claims, clock()) : null
  if (audience === 'customer' && !customerId) throw new SalesQuoteError('unauthenticated')
  if (audience === 'admin') await admin(database, claims, clock())
  const result = await database
    .prepare(
      `SELECT id,COUNT(*) OVER() AS total FROM sales_quotes
    WHERE (?1 IS NULL OR customer_id=?1) ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET ?2`
    )
    .bind(customerId, (page - 1) * 25)
    .all<{ id: string; total: number }>()
  if (!result.success) throw new SalesQuoteError('service_unavailable')
  const items = []
  for (const row of result.results)
    items.push(
      audience === 'admin'
        ? await readD1AdminSalesQuote(database, claims, row.id, options)
        : await readD1CustomerSalesQuote(database, claims, row.id, options)
    )
  if (customerId) await owner(database, claims, customerId, clock())
  else await admin(database, claims, clock())
  return { source: 'cloudflare' as const, page, perPage: 25, total: result.results[0]?.total ?? 0, items }
}
export async function convertD1SalesQuote(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  quoteId: string,
  input: SalesQuoteConversionInput,
  options: SalesQuoteOptions & { idempotencyKey: string; inventory?: CheckoutInventoryGateway }
): Promise<SalesQuoteReceipt> {
  const clock = clocks(options)
  key(quoteId)
  key(options.idempotencyKey)
  const customerId = await activeOrderCustomerId(database, claims, clock())
  if (!customerId) throw new SalesQuoteError('unauthenticated')
  const snapshot = await load(database, quoteId)
  if (snapshot.definition.customerId !== customerId) throw new SalesQuoteError('not_found')
  try {
    assertCheckoutAddress(input.checkout.shippingAddress, true)
    assertCheckoutAddress(input.checkout.billingAddress, false)
  } catch (error) {
    if (error instanceof CartError && error.code === 'invalid_input') throw new SalesQuoteError('invalid_input')
    throw error
  }
  const safeInput = conversionPayload(input),
    hash = await salesQuoteConversionIntentHash(quoteId, input.checkout.cartId, safeInput)
  const ownReceipt = await cached(database, claims!, options.idempotencyKey, hash)
  if (ownReceipt) {
    await owner(database, claims, customerId, clock())
    return ownReceipt
  }
  const existing = await binding(database, quoteId)
  if (snapshot.status === 'converted') {
    if (!existing || input.expectedVersion !== existing.quote_version || input.approvedHash !== existing.approved_hash)
      throw new SalesQuoteError('quote_changed')
    const receipt = await cached(database, claims!, existing.command_id, existing.payload_hash)
    if (!receipt || !receipt.orderId) throw new SalesQuoteError('history_unconfirmed')
    await owner(database, claims, customerId, clock())
    return receipt
  }
  assertApproved(snapshot, input.expectedVersion, input.approvedHash, clock())
  if (
    input.checkout.shippingAddress.city.trim() !== snapshot.definition.destination.city ||
    input.checkout.shippingAddress.postalCode !== snapshot.definition.destination.postalCode
  )
    throw new SalesQuoteError('quote_changed')
  // Process-local coalescing is an optimization only. The immutable D1 binding
  // below is the cross-process authority and cannot choose a second cart/key.
  let running = inFlight.get(database)
  if (!running) {
    running = new Map()
    inFlight.set(database, running)
  }
  const prior = running.get(quoteId)
  if (prior) {
    const receipt = await prior
    await owner(database, claims, customerId, clock())
    return receipt
  }
  const work = async () => {
    let bound = existing
    if (!bound) {
      await getCart(database, { cartId: input.checkout.cartId, token: input.checkout.token })
      const current = await database
        .prepare(
          `SELECT q.cart_id,q.cart_version,l.* FROM checkout_quotes q
        JOIN checkout_quote_lines l ON l.quote_id=q.id WHERE q.id=? ORDER BY l.line_index`
        )
        .bind(input.checkout.quoteId)
        .all<Record<string, unknown>>()
      if (
        !current.success ||
        current.results.length !== snapshot.lines.length ||
        current.results.some(
          (row) => row.cart_id !== input.checkout.cartId || row.cart_version !== input.checkout.expectedVersion
        )
      )
        throw new SalesQuoteError('quote_changed')
      for (const row of current.results) {
        const line = snapshot.lines.find((entry) => entry.variantId === row.variant_id)
        if (!line || line.quantity !== row.quantity || line.taxRateBasisPoints !== row.tax_rate_basis_points)
          throw new SalesQuoteError('quote_changed')
      }
      const lockedQuoteId = crypto.randomUUID(),
        now = clock()
      const write = [
        database
          .prepare(
            `INSERT INTO checkout_quotes(id,cart_id,cart_version,pricing_instant,currency,shipping_gross_cents,shipping_pending,
        total_net_cents,total_tax_cents,total_gross_cents,snapshot_hash,correlation_id,created_at,expires_at) VALUES(?,?,?,?,'EUR',0,1,?,?,?,?,?,?,?)`
          )
          .bind(
            lockedQuoteId,
            input.checkout.cartId,
            input.checkout.expectedVersion,
            now,
            snapshot.goods!.netCents,
            snapshot.goods!.taxCents,
            snapshot.goods!.grossCents,
            await canonicalPayloadHash({ quoteId, approvedHash: input.approvedHash, lines: snapshot.lines }),
            input.checkout.correlationId,
            now,
            snapshot.definition.validUntil
          ),
        ...current.results.map((row) => {
          const line = snapshot.lines.find((entry) => entry.variantId === row.variant_id)!
          return database
            .prepare(
              `INSERT INTO checkout_quote_lines(quote_id,line_index,variant_id,sku,name,format,unit_label,quantity,unit_gross_cents,
            net_cents,tax_cents,gross_cents,tax_rate_basis_points,price_version_id,available_quantity,backorder_allowed,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
            )
            .bind(
              lockedQuoteId,
              row.line_index,
              row.variant_id,
              row.sku,
              row.name,
              row.format,
              row.unit_label,
              line.quantity,
              line.unitGrossCents,
              line.amounts.netCents,
              line.amounts.taxCents,
              line.amounts.grossCents,
              line.taxRateBasisPoints,
              line.priceVersionId,
              row.available_quantity,
              row.backorder_allowed,
              now
            )
        }),
        database
          .prepare(
            `INSERT INTO sales_quote_conversions(quote_id,quote_version,approved_hash,customer_id,cart_id,checkout_quote_id,checkout_key,
          actor_id,session_id,session_version,command_id,payload_hash,input_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .bind(
            quoteId,
            snapshot.version,
            snapshot.approvedHash,
            customerId,
            input.checkout.cartId,
            lockedQuoteId,
            `sales-quote:${quoteId}`,
            claims!.identityId,
            claims!.sessionId,
            claims!.sessionVersion,
            options.idempotencyKey,
            hash,
            JSON.stringify(safeInput),
            now
          ),
        database
          .prepare(
            `INSERT INTO sales_quote_guards(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM sales_quotes q JOIN sales_quote_versions v ON v.quote_id=q.id AND v.version=q.current_version
          WHERE q.id=? AND q.current_version=? AND v.status='approved' AND json_extract(v.snapshot_json,'$.approvedHash')=?
          AND json_extract(v.snapshot_json,'$.definition.validUntil')>?) THEN 1 ELSE 0 END`
          )
          .bind(crypto.randomUUID(), quoteId, snapshot.version, snapshot.approvedHash, clock()),
        authorityGuard(database, claims!, clock(), customerId)
      ]
      try {
        await database.batch(write)
      } catch {
        await owner(database, claims, customerId, clock())
        assertApproved(await load(database, quoteId), input.expectedVersion, input.approvedHash, clock())
        if (!(await binding(database, quoteId))) throw new SalesQuoteError('service_unavailable')
      }
      bound = await binding(database, quoteId)
    }
    if (!bound) throw new SalesQuoteError('history_unconfirmed')
    if (bound.cart_id !== input.checkout.cartId) {
      const finished = await cached(database, claims!, bound.command_id, bound.payload_hash)
      if (finished) return finished
      // Another process owns the original attempt. No re-POST against a new cart.
      throw new SalesQuoteError('service_unavailable')
    }
    if (bound.payload_hash !== hash) throw new SalesQuoteError('idempotency_conflict')
    const reference = { quoteId, version: bound.quote_version, approvedHash: bound.approved_hash }
    try {
      const result = await placeOrder(
        database,
        {
          ...input.checkout,
          quoteId: bound.checkout_quote_id,
          idempotencyKey: bound.checkout_key,
          ownerSession: claims,
          now: clock(),
          salesQuote: reference
        },
        options.inventory,
        options.freeShippingThresholdCents ?? null
      )
      if (result.outcome !== 'order_created') throw new SalesQuoteError('quote_changed')
    } catch (error) {
      const latest = await load(database, quoteId)
      if (latest.status !== 'approved' && latest.status !== 'converted') throw new SalesQuoteError('quote_not_approved')
      if (error instanceof SalesQuoteError) throw error
      if (error instanceof CartError && error.code === 'invalid_input') throw new SalesQuoteError('invalid_input')
      throw new SalesQuoteError('service_unavailable')
    }
    const receipt = await cached(database, claims!, bound.command_id, bound.payload_hash)
    if (!receipt || !receipt.orderId) throw new SalesQuoteError('history_unconfirmed')
    await owner(database, claims, customerId, clock())
    return receipt
  }
  const promise = work()
  running.set(quoteId, promise)
  try {
    return await promise
  } finally {
    if (running.get(quoteId) === promise) running.delete(quoteId)
  }
}
export async function readD1SalesQuoteCommand(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  commandId: string,
  payloadHash: string,
  options: SalesQuoteOptions = {}
): Promise<SalesQuoteCommand> {
  const clock = clocks(options)
  key(commandId)
  const customerId = await activeOrderCustomerId(database, claims, clock())
  if (!customerId) await admin(database, claims, clock())
  if (!/^[a-f0-9]{64}$/.test(payloadHash)) throw new SalesQuoteError('invalid_input')
  const receipt = await cached(database, claims!, commandId, payloadHash)
  if (receipt && customerId && (await load(database, receipt.quoteId)).definition.customerId !== customerId)
    throw new SalesQuoteError('not_found')
  if (customerId) await owner(database, claims, customerId, clock())
  else await admin(database, claims, clock())
  return receipt
    ? { source: 'cloudflare', outcome: 'applied', receipt }
    : { source: 'cloudflare', outcome: 'unknown', receipt: null }
}

const inFlight = new WeakMap<D1Database, Map<string, Promise<SalesQuoteReceipt>>>()
async function owner(database: D1Database, claims: VerifiedSessionClaims | null, customerId: string, now: string) {
  if ((await activeOrderCustomerId(database, claims, now)) !== customerId) throw new SalesQuoteError('unauthenticated')
}
function assertApproved(snapshot: SalesQuoteAdminSnapshot, version: number, hash: string, now: string) {
  if (snapshot.status !== 'approved') throw new SalesQuoteError('quote_not_approved')
  if (snapshot.definition.validUntil <= now) throw new SalesQuoteError('quote_expired')
  if (snapshot.version !== version || snapshot.approvedHash !== hash) throw new SalesQuoteError('quote_changed')
}
/** Internal reference only: prices and the free-shipping base are always loaded
 * from the immutable owner-approved D1 snapshot, never supplied by a caller. */
export async function readSalesQuoteShippingAuthority(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  reference: SalesQuoteCheckoutReference,
  cartId: string,
  destination: { city: string; postalCode: string },
  now: string
) {
  const customerId = await activeOrderCustomerId(database, claims, now)
  if (!customerId) throw new SalesQuoteError('unauthenticated')
  const snapshot = await load(database, reference.quoteId)
  if (snapshot.definition.customerId !== customerId) throw new SalesQuoteError('not_found')
  assertApproved(snapshot, reference.version, reference.approvedHash, now)
  if (!snapshot.goods || !snapshot.shipping || !snapshot.total) throw new SalesQuoteError('history_unconfirmed')
  if (
    snapshot.definition.destination.city !== destination.city ||
    snapshot.definition.destination.postalCode !== destination.postalCode
  )
    throw new SalesQuoteError('quote_changed')
  const result = await prepareQuoteLinesStatement(database, { cartId, instant: now }).all<RawResolvedLine>()
  if (!result.success) throw new SalesQuoteError('service_unavailable')
  const lines = mapQuoteLines(result.results)
  if (
    lines.length !== snapshot.lines.length ||
    lines.some(
      (line) =>
        !snapshot.lines.some(
          (approved) =>
            approved.variantId === line.variantId &&
            approved.quantity === line.quantity &&
            approved.taxRateBasisPoints === line.taxRateBasisPoints
        )
    )
  )
    throw new SalesQuoteError('quote_changed')
  for (const line of lines) {
    if (
      line.variantStatus !== 'published' ||
      line.productStatus !== 'published' ||
      line.categoryStatus !== 'published' ||
      !line.publicationValid
    )
      throw new SalesQuoteError('quote_changed')
    validateQuantity(line.quantity, line)
  }
  await owner(database, claims, customerId, now)
  return { ...snapshot, goods: snapshot.goods }
}

export async function prepareD1SalesQuoteShipping(
  database: D1Database,
  claims: VerifiedSessionClaims,
  quoteId: string,
  input: { expectedVersion: number; approvedHash: string },
  cart: { cartId: string; token: string },
  options: SalesQuoteOptions & { idempotencyKey: string }
) {
  const clock = clocks(options),
    now = clock()
  const snapshot = await load(database, quoteId)
  const reference = { quoteId, version: input.expectedVersion, approvedHash: input.approvedHash }
  const view = await getCart(database, cart)
  await readSalesQuoteShippingAuthority(database, claims, reference, cart.cartId, snapshot.definition.destination, now)
  const common = {
    ...cart,
    now,
    correlationId: `sales-quote-shipping:${options.idempotencyKey}`,
    expectedVersion: view.version
  }
  const quoted = await quoteCart(database, { ...common, idempotencyKey: `${options.idempotencyKey}:quote` })
  if (quoted.outcome !== 'quoted') throw new SalesQuoteError('quote_changed')
  const shipping = await requestShippingOptions(database, {
    ...common,
    destination: snapshot.definition.destination,
    ownerSession: claims,
    salesQuote: reference,
    idempotencyKey: options.idempotencyKey,
    freeShippingThresholdCents: options.freeShippingThresholdCents
  })
  if (shipping.outcome !== 'options') throw new SalesQuoteError('quote_changed')
  const rates = (shipping.body.options as ShippingOptionSnapshot[])
    .filter((option) => option.methodCode === snapshot.definition.shippingMethod)
    .map((option) => ({
      profile:
        option.methodCode === 'pickup'
          ? 'pickup'
          : option.methodCode === 'own_delivery'
            ? 'own_delivery'
            : option.serviceProfile,
      serviceCode: option.methodCode,
      quoteId: quoted.quote.quoteId,
      shippingQuoteId: shipping.body.shippingQuoteId,
      optionIndex: option.optionIndex,
      optionHash: option.optionHash,
      expiresAt: shipping.body.expiresAt
    }))
  if (!rates.length) throw new SalesQuoteError('quote_changed')
  await readSalesQuoteShippingAuthority(
    database,
    claims,
    reference,
    cart.cartId,
    snapshot.definition.destination,
    clock()
  )
  const fresh = await getCart(database, cart)
  if (fresh.status !== 'active' || fresh.version !== view.version) throw new SalesQuoteError('quote_changed')
  await owner(database, claims, snapshot.definition.customerId, clock())
  return { cartVersion: view.version, rates }
}
function conversionPayload(input: SalesQuoteConversionInput) {
  const {
    cartId: _cartId,
    correlationId: _correlationId,
    token: _token,
    ownerSession: _session,
    now: _now,
    idempotencyKey: _key,
    salesQuote: _quote,
    ...checkout
  } = input.checkout
  void [_cartId, _correlationId, _token, _session, _now, _key, _quote]
  return { expectedVersion: input.expectedVersion, approvedHash: input.approvedHash, checkout }
}
type Binding = {
  quote_version: number
  approved_hash: string
  customer_id: string
  cart_id: string
  checkout_quote_id: string
  checkout_key: string
  actor_id: string
  session_id: string
  session_version: number
  command_id: string
  payload_hash: string
  input_json: string
}
const binding = (database: D1Database, quoteId: string) =>
  database.prepare('SELECT * FROM sales_quote_conversions WHERE quote_id=?').bind(quoteId).first<Binding>()

/** The reference contains no price authority. Every caller must resolve it from
 * immutable D1 evidence; a client cannot turn off ordinary price validation. */
export async function readSalesQuoteCheckoutAuthority(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  reference: SalesQuoteCheckoutReference,
  cartId: string,
  checkoutQuoteId: string,
  now: string
) {
  const customerId = await activeOrderCustomerId(database, claims, now)
  if (!customerId) throw new SalesQuoteError('unauthenticated')
  const snapshot = await load(database, reference.quoteId),
    bound = await binding(database, reference.quoteId)
  if (snapshot.definition.customerId !== customerId) throw new SalesQuoteError('not_found')
  if (
    !bound ||
    bound.cart_id !== cartId ||
    bound.checkout_quote_id !== checkoutQuoteId ||
    bound.quote_version !== reference.version ||
    bound.approved_hash !== reference.approvedHash
  )
    throw new SalesQuoteError('quote_changed')
  if (snapshot.status === 'converted') {
    const original = await database
      .prepare('SELECT snapshot_json FROM sales_quote_versions WHERE quote_id=? AND version=?')
      .bind(reference.quoteId, reference.version)
      .first<{ snapshot_json: string }>()
    if (!original) throw new SalesQuoteError('history_unconfirmed')
    return parsed(salesQuoteAdminSnapshotSchema, JSON.parse(original.snapshot_json))
  }
  assertApproved(snapshot, reference.version, reference.approvedHash, now)
  if (
    bound.actor_id !== claims!.identityId ||
    bound.session_id !== claims!.sessionId ||
    bound.session_version !== claims!.sessionVersion
  )
    throw new SalesQuoteError('unauthenticated')
  return snapshot
}

/** Appended to the canonical order transaction, never committed separately. */
export async function salesQuoteCompletionStatements(
  database: D1Database,
  claims: VerifiedSessionClaims,
  reference: SalesQuoteCheckoutReference,
  cartId: string,
  checkoutQuoteId: string,
  orderId: string,
  now: string
) {
  const snapshot = await readSalesQuoteCheckoutAuthority(database, claims, reference, cartId, checkoutQuoteId, now)
  const bound = await binding(database, reference.quoteId)
  if (!bound) throw new SalesQuoteError('history_unconfirmed')
  const completed: SalesQuoteAdminSnapshot = {
    ...snapshot,
    version: snapshot.version + 1,
    status: 'converted',
    orderId,
    updatedAt: now
  }
  const receipt: SalesQuoteReceipt = {
    source: 'cloudflare',
    commandId: bound.command_id,
    action: 'convert',
    quoteId: snapshot.id,
    version: completed.version,
    payloadHash: bound.payload_hash,
    orderId,
    recordedAt: now
  }
  return [
    ...(await statements(database, claims, completed, receipt, JSON.parse(bound.input_json))),
    database
      .prepare('UPDATE sales_quotes SET current_version=?,updated_at=? WHERE id=? AND current_version=?')
      .bind(completed.version, now, snapshot.id, snapshot.version),
    database
      .prepare(
        `INSERT INTO sales_quote_guards(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM sales_quotes q JOIN sales_quote_versions v ON v.quote_id=q.id AND v.version=q.current_version
      WHERE q.id=? AND q.current_version=? AND v.status='converted' AND json_extract(v.snapshot_json,'$.orderId')=?) THEN 1 ELSE 0 END`
      )
      .bind(crypto.randomUUID(), snapshot.id, completed.version, orderId),
    database
      .prepare(
        `INSERT INTO sales_quote_guards(id,valid) SELECT ?,CASE WHEN NOT EXISTS(SELECT 1 FROM json_each(?) requested
      LEFT JOIN variants v ON v.id=json_extract(requested.value,'$.variantId') LEFT JOIN products p ON p.id=v.product_id
      LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN tax_classes t ON t.id=v.tax_class_id
      WHERE v.id IS NULL OR v.status<>'published' OR p.status<>'published' OR c.status<>'published'
      OR NOT ${publicationValidityExpression('p')}
      OR t.rate_basis_points<>json_extract(requested.value,'$.taxRateBasisPoints')
      OR json_extract(requested.value,'$.quantity')<v.minimum_quantity
      OR (v.maximum_quantity IS NOT NULL AND json_extract(requested.value,'$.quantity')>v.maximum_quantity)
      OR (json_extract(requested.value,'$.quantity')-v.minimum_quantity)%v.quantity_increment<>0)
      THEN 1 ELSE 0 END`
      )
      .bind(crypto.randomUUID(), JSON.stringify(snapshot.lines)),
    authorityGuard(database, claims, now, snapshot.definition.customerId)
  ]
}
