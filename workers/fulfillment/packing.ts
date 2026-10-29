import { z } from 'zod'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalJson } from '../catalog/inventory'
import { roundRatio } from '../../server/domain/money'
import {
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema as uuid,
  catalogPolicyInstantSchema as instant
} from '../../shared/catalog-publication-policy'
import {
  adminOrderPackingSchema,
  orderPackingInputSchema,
  orderPackingReceiptSchema,
  orderPackingIntentHash,
  type AdminOrderPacking,
  type OrderPackingInput,
  type OrderPackingReceipt,
  type OrderPackingCommandResponse
} from '../../shared/order-packing'
import {
  fulfillmentActorSql as actorSql,
  fulfillmentFactsSql as factsSql,
  fulfillmentLiveSql as live,
  fulfillmentSourceSchema,
  fulfillmentSourceBlockers,
  fulfillmentFreshClock
} from './admin'

export class PackingError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'PackingError'
  }
}
function fail(code: string): never {
  throw new PackingError(code)
}
function checked<T, I>(schema: z.ZodType<T, z.ZodTypeDef, I>, raw: unknown, code = 'invalid_input'): T {
  let owned: unknown
  try {
    owned = catalogPolicyOwnJson(raw)
  } catch {
    return fail(code)
  }
  const parsed = schema.safeParse(owned)
  if (!parsed.success) fail(code)
  return parsed.data
}
const clock = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const claimsSchema = z
  .object({ identityId: uuid, sessionId: uuid, sessionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
  .strict()
const optionsSchema = z.object({ now: instant.optional() }).strict()
interface Context {
  db: D1Database
  claims: VerifiedSessionClaims
  id: string
  fresh: () => string | undefined
}
async function authorize(c: Context) {
  const result = await authorizeD1Session(c.db, c.claims, 'administration.manage', { requireMfa: true, now: c.fresh() })
  if (!result.allowed) fail(result.code)
}
async function context(db: D1Database, rawClaims: VerifiedSessionClaims | null, id: string, options: { now?: string }) {
  const parsed = checked(optionsSchema, options),
    claims = checked(claimsSchema, rawClaims, 'unauthenticated')
  const c: Context = { db, claims, id: checked(uuid, id), fresh: fulfillmentFreshClock(parsed.now) }
  await authorize(c)
  return c
}
function binds(c: Context) {
  return [c.fresh() ?? null, c.claims.sessionId, c.claims.identityId, c.claims.sessionVersion, c.id]
}
const auditColumns =
  'actor_id,order_id,action,payload_hash,input,expected_version,result_version,fulfillment_version,source_snapshot,parcels,dispatch,response,created_at'
const auditProof = `EXISTS(SELECT 1 FROM order_packing_audit a WHERE a.command_id=c.command_id AND ${auditColumns
  .split(',')
  .map((column) => `a.${column} IS c.${column}`)
  .join(' AND ')})`
const projectionProof = `EXISTS(SELECT 1 FROM order_packings p WHERE p.order_id=c.order_id AND p.version=c.result_version AND p.last_command_id=c.command_id AND p.parcels=c.parcels AND p.dispatch IS c.dispatch AND p.updated_at=c.created_at AND p.state=CASE c.action WHEN 'pack' THEN 'packed' ELSE 'manual_dispatch_recorded' END)`
const historyProof = `((p.order_id IS NULL AND NOT EXISTS(SELECT 1 FROM order_packing_commands WHERE order_id=s.order_id)
 AND NOT EXISTS(SELECT 1 FROM order_packing_audit WHERE order_id=s.order_id)) OR
 (p.order_id IS NOT NULL AND p.updated_at<=${clock} AND EXISTS(SELECT 1 FROM order_packing_commands c WHERE c.command_id=p.last_command_id
 AND c.order_id=p.order_id AND c.result_version=p.version AND c.parcels=p.parcels AND c.dispatch IS p.dispatch AND c.created_at=p.updated_at
 AND p.state=CASE c.action WHEN 'pack' THEN 'packed' ELSE 'manual_dispatch_recorded' END AND ${auditProof})
 AND (SELECT count(*) FROM order_packing_commands WHERE order_id=s.order_id)=p.version
 AND (SELECT count(*) FROM order_packing_audit WHERE order_id=s.order_id)=p.version
 AND NOT EXISTS(SELECT 1 FROM order_packing_commands c WHERE c.order_id=s.order_id AND (c.result_version>p.version OR NOT (${auditProof})))))`
type Source = z.infer<typeof fulfillmentSourceSchema>
export { historyProof as packingHistoryProofSql }
interface State {
  source: Source
  dto: AdminOrderPacking
  receipt: OrderPackingReceipt | null
  receiptHash: string | null
}
async function state(c: Context, key: string | null = null): Promise<State> {
  const raw = await c.db
    .prepare(
      `WITH actor AS MATERIALIZED(${actorSql}),${factsSql}
 SELECT s.*,actor.id actorId,COALESCE(p.version,0) packingVersion,p.state packingState,p.parcels packingParcels,p.dispatch packingDispatch,
 CASE WHEN s.order_id IS NULL THEN 1 ELSE ${historyProof} END packingConfirmed,
 (SELECT shipping_gross_cents FROM orders WHERE id=s.order_id) quotedGrossCents,${clock} evaluatedAt,
 (SELECT response FROM order_packing_commands c WHERE c.command_id=?6 AND c.order_id=s.order_id AND c.actor_id=actor.id) receipt,
 (SELECT payload_hash FROM order_packing_commands c WHERE c.command_id=?6 AND c.order_id=s.order_id AND c.actor_id=actor.id) receiptHash,
 (SELECT CASE WHEN ${auditProof} THEN 1 ELSE 0 END FROM order_packing_commands c WHERE c.command_id=?6 AND c.order_id=s.order_id AND c.actor_id=actor.id) receiptConfirmed
 FROM actor LEFT JOIN facts s ON 1=1 LEFT JOIN order_packings p ON p.order_id=s.order_id`
    )
    .bind(...binds(c), key)
    .first<Record<string, unknown>>()
  if (!raw) {
    await authorize(c)
    return fail('unauthenticated')
  }
  const {
    actorId: _actorId,
    packingVersion,
    packingState,
    packingParcels,
    packingDispatch,
    packingConfirmed,
    quotedGrossCents,
    evaluatedAt,
    receipt: rawReceipt,
    receiptHash,
    receiptConfirmed,
    ...sourceRaw
  } = raw
  if (sourceRaw.order_id === null) fail('not_found')
  const source = checked(fulfillmentSourceSchema, sourceRaw, 'service_unavailable')
  if (source.history_confirmed !== 1 || packingConfirmed !== 1 || (rawReceipt !== null && receiptConfirmed !== 1))
    fail('history_unconfirmed')
  let parcels: unknown,
    dispatch: unknown,
    snapshot: { lines: Array<{ index: number; sku: string; name: string; quantity: number }> }
  try {
    parcels = packingParcels === null ? [] : JSON.parse(packingParcels as string)
    dispatch = packingDispatch === null ? null : JSON.parse(packingDispatch as string)
    snapshot = JSON.parse(source.snapshot)
  } catch {
    return fail('history_unconfirmed')
  }
  const blockers = fulfillmentSourceBlockers(source),
    ready = blockers.length === 0,
    locked = dispatch !== null
  const dto = checked(
    adminOrderPackingSchema,
    {
      source: 'cloudflare',
      orderId: c.id,
      version: packingVersion,
      state: packingState ?? 'unpacked',
      fulfillmentVersion: source.version,
      fulfillmentState: source.state,
      shippingMethod: ['pickup', 'own_delivery', 'parcel'].includes(source.shipping_method)
        ? source.shipping_method
        : null,
      lines: snapshot.lines.map((line) => ({
        lineIndex: line.index,
        sku: line.sku,
        name: line.name,
        quantity: line.quantity
      })),
      parcels,
      dispatch,
      quotedGrossCents,
      readiness: { ready, blockers },
      capabilities: {
        packingWrite: ready && !locked && ['picking', 'packed'].includes(source.state),
        manualDispatch:
          ready && !locked && source.state === 'packed' && source.shipping_method === 'parcel' && packingVersion !== 0
      },
      evaluatedAt
    },
    'history_unconfirmed'
  )
  let receipt: OrderPackingReceipt | null = null
  if (rawReceipt !== null) {
    try {
      receipt = checked(orderPackingReceiptSchema, JSON.parse(rawReceipt as string), 'history_unconfirmed')
    } catch {
      return fail('history_unconfirmed')
    }
    if (
      receipt.commandId !== key ||
      receipt.orderId !== c.id ||
      receipt.payloadHash !== receiptHash ||
      receipt.version > dto.version
    )
      fail('history_unconfirmed')
  }
  return { source, dto, receipt, receiptHash: receiptHash as string | null }
}
export async function readD1AdminPacking(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  options: { now?: string } = {}
): Promise<AdminOrderPacking> {
  return (await state(await context(db, claims, id, options))).dto
}
export async function readD1AdminPackingCommand(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  key: string,
  hash: string,
  options: { now?: string } = {}
): Promise<OrderPackingCommandResponse> {
  checked(uuid, key)
  if (!/^[a-f0-9]{64}$/.test(hash)) fail('invalid_input')
  const current = await state(await context(db, claims, id, options), key)
  if (current.receipt && current.receiptHash !== hash) fail('idempotency_conflict')
  return current.receipt
    ? { source: 'cloudflare', outcome: 'applied', receipt: current.receipt }
    : { source: 'cloudflare', outcome: 'unknown' }
}
function validate(current: State, input: OrderPackingInput) {
  const blocked = fulfillmentSourceBlockers(current.source)
  if (blocked.length) fail(blocked[0]!)
  if (current.dto.version !== input.expectedVersion) fail('version_conflict')
  if (current.source.version !== input.expectedFulfillmentVersion) fail('fulfillment_version_conflict')
  if (current.dto.dispatch !== null) fail('packing_locked')
  if (input.action === 'pack') {
    if (!['picking', 'packed'].includes(current.source.state)) fail('invalid_transition')
    const totals = new Map<number, bigint>()
    for (const parcel of input.parcels)
      for (const line of parcel.contents)
        totals.set(line.lineIndex, (totals.get(line.lineIndex) ?? 0n) + BigInt(line.quantity))
    if (
      totals.size !== current.dto.lines.length ||
      current.dto.lines.some((line) => totals.get(line.lineIndex) !== BigInt(line.quantity))
    )
      fail('packing_incomplete')
  } else {
    if (current.source.shipping_method !== 'parcel') fail('shipping_mode_mismatch')
    if (current.source.state !== 'packed') fail('invalid_transition')
    if (
      current.dto.parcels.length === 0 ||
      input.shipments.length !== current.dto.parcels.length ||
      input.shipments.some((shipment) => shipment.parcelIndex >= current.dto.parcels.length)
    )
      fail('packing_incomplete')
  }
}
export async function executeD1AdminPackingCommand(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  raw: unknown,
  options: { idempotencyKey: string; now?: string }
): Promise<OrderPackingReceipt> {
  const key = checked(uuid, options.idempotencyKey),
    input = checked(orderPackingInputSchema, raw)
  const hash = await orderPackingIntentHash(id, input),
    c = await context(db, claims, id, options.now === undefined ? {} : { now: options.now })
  const before = await state(c, key)
  if (before.receipt) {
    if (before.receiptHash !== hash) fail('idempotency_conflict')
    return before.receipt
  }
  validate(before, input)
  const parcels = input.action === 'pack' ? input.parcels : before.dto.parcels
  const actualTaxCents =
    input.action === 'manual_dispatch' ? roundRatio(BigInt(input.actualNetCents) * BigInt(input.taxBps), 10000n) : 0
  const nextDispatch =
    input.action === 'manual_dispatch'
      ? {
          commandId: key,
          packingVersion: before.dto.version,
          shipments: input.shipments,
          actualNetCents: input.actualNetCents,
          taxBps: input.taxBps,
          actualTaxCents,
          actualGrossCents: input.actualNetCents + actualTaxCents,
          quotedGrossCents: before.dto.quotedGrossCents,
          varianceGrossCents: input.actualNetCents + actualTaxCents - before.dto.quotedGrossCents,
          labelVerification: 'unverified_reference_only'
        }
      : null
  const nonce = crypto.randomUUID(),
    serialized = canonicalJson(input),
    serializedParcels = canonicalJson(parcels)
  const serializedDispatch = nextDispatch === null ? null : canonicalJson(nextDispatch)
  // The canonical facts SQL drives every write precondition. No provider,
  // inventory gateway, second stock balance or duplicated readiness policy.
  // Keep the bounded common parameter envelope explicit in every batch member.
  const requestSql = `request AS(SELECT ${Array.from({ length: 16 }, (_, index) => `?${index + 1} p${index + 1}`).join(',')})`
  const actorPrefix = `WITH ${requestSql},actor AS MATERIALIZED(${actorSql})`
  const prefix = `${actorPrefix},${factsSql}`
  const params = [
    ...binds(c),
    key,
    nonce,
    hash,
    serialized,
    input.action,
    input.expectedVersion,
    input.expectedFulfillmentVersion,
    before.source.snapshot,
    serializedParcels,
    serializedDispatch,
    before.dto.quotedGrossCents
  ]
  const owned = `c.command_id=?6 AND c.claim_nonce=?7 AND c.actor_id=?3 AND c.order_id=?5 AND c.payload_hash=?8 AND c.input=?9`
  const livePacking = `${live} AND s.snapshot=?13 AND s.version=?12 AND COALESCE(p.version,0)=?11 AND ${historyProof}
 AND p.dispatch IS NULL AND ((?10='pack' AND s.state IN('picking','packed')) OR (?10='manual_dispatch' AND s.state='packed' AND s.shipping_method='parcel' AND p.version>0))`
  try {
    await db.batch([
      db
        .prepare(
          `${prefix} INSERT INTO order_packing_commands(command_id,claim_nonce,actor_id,order_id,action,payload_hash,input,expected_version,result_version,fulfillment_version,source_snapshot,parcels,dispatch,response,created_at)
      SELECT ?6,?7,actor.id,s.order_id,?10,?8,?9,?11,?11+1,s.version,s.snapshot,?14,
        CASE WHEN ?15 IS NULL THEN NULL ELSE json_set(?15,'$.recordedAt',${clock}) END,
        json_object('source','cloudflare','commandId',?6,'orderId',s.order_id,'action',?10,'version',?11+1,'fulfillmentVersion',s.version,'payloadHash',?8,'parcelCount',json_array_length(?14),'recordedAt',${clock},'inventoryEffect','none','economicEffect','none','providerEffect','none'),${clock}
      FROM facts s JOIN actor LEFT JOIN order_packings p ON p.order_id=s.order_id
      WHERE ${livePacking} AND (SELECT shipping_gross_cents FROM orders WHERE id=s.order_id)=?16
      AND NOT EXISTS(SELECT 1 FROM order_packing_commands WHERE command_id=?6)`
        )
        .bind(...params),
      db
        .prepare(
          `${actorPrefix} INSERT INTO order_packings(order_id,version,state,parcels,dispatch,last_command_id,updated_at)
      SELECT c.order_id,c.result_version,CASE c.action WHEN 'pack' THEN 'packed' ELSE 'manual_dispatch_recorded' END,c.parcels,c.dispatch,c.command_id,c.created_at
      FROM order_packing_commands c JOIN actor ON actor.id=c.actor_id WHERE ${owned}
      ON CONFLICT(order_id) DO UPDATE SET version=excluded.version,state=excluded.state,parcels=excluded.parcels,dispatch=excluded.dispatch,last_command_id=excluded.last_command_id,updated_at=excluded.updated_at`
        )
        .bind(...params),
      db
        .prepare(
          `${actorPrefix} INSERT INTO order_packing_audit(command_id,${auditColumns})
      SELECT c.command_id,${auditColumns
        .split(',')
        .map((column) => 'c.' + column)
        .join(
          ','
        )} FROM order_packing_commands c JOIN actor ON actor.id=c.actor_id WHERE ${owned} AND ${projectionProof}`
        )
        .bind(...params),
      db
        .prepare(
          `${actorPrefix} INSERT INTO order_packing_guards(id,satisfied)
      SELECT ?6,EXISTS(SELECT 1 FROM order_packing_commands c JOIN actor ON actor.id=c.actor_id WHERE ${owned} AND ${auditProof} AND ${projectionProof})`
        )
        .bind(...params),
      db.prepare('DELETE FROM order_packing_guards WHERE id=?').bind(key)
    ])
  } catch {
    const latest = await state(c, key)
    if (latest.receipt) {
      if (latest.receiptHash !== hash) fail('idempotency_conflict')
      return latest.receipt
    }
    validate(latest, input)
    fail('service_unavailable')
  }
  const completed = await state(c, key)
  if (!completed.receipt || completed.receiptHash !== hash) fail('history_unconfirmed')
  return completed.receipt
}
