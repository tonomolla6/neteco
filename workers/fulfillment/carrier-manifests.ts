import {
  cancelManifestInputSchema,
  closeManifestInputSchema,
  confirmPickupInputSchema,
  createManifestInputSchema,
  schedulePickupInputSchema,
  setManifestItemInputSchema,
  type ExclusionReason,
  type ManifestItemView,
  type ManifestStatus,
  type ManifestSummary,
  type ManifestView
} from '../../shared/carrier-manifests'
import type { CarrierManifestAdapter } from './carrier-manifest-adapter'
import {
  ShippingOpsError,
  allRows,
  atomicBatch,
  firstRow,
  hashPayload,
  liveAdminSql,
  nowIso,
  randomId,
  requireAdmin,
  sha256Hex
} from './shipping-ops-common'

export const MAX_MANIFEST_SHIPMENTS = 500
const STATUSES: readonly ManifestStatus[] = ['open', 'closed', 'picked_up', 'discrepancy', 'cancelled']

interface ManifestRow {
  id: string
  carrier: string
  pickup_date: string
  status: ManifestStatus
  version: number
  included_shipments: number
  excluded_shipments: number
  parcel_count: number
  weight_grams: number
  provider_manifest_id: string | null
  closed_at: string | null
  created_at: string
  updated_at: string
}
interface ItemRow {
  tracking_number: string
  shipment_number: string
  order_id: string
  parcel_index: number
  weight_grams: number
  decision: 'included' | 'excluded'
  exclusion_reason: ExclusionReason | null
  scan_status: 'pending' | 'scanned' | 'missing'
}
interface CandidateRow {
  order_id: string
  tracking_number: string
  shipment_number: string
  parcel_index: number
  weight_grams: number
  fulfillment_status: string | null
  manifested: number
}
interface PickupRow {
  provider_pickup_id: string
  scheduled_date: string
  parcel_count: number
  status: 'scheduled' | 'confirmed' | 'discrepancy'
  scanned_count: number | null
  missing_count: number | null
  unexpected_trackings: string | null
  confirmed_at: string | null
}

type Actor = { actorId: string; now?: string }

function parse<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
  raw: unknown
): T {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new ShippingOpsError('invalid_input')
  return parsed.data
}

const normaliseCarrier = (carrier: string) => carrier.trim().toLowerCase()

function validDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function exclusionFor(row: CandidateRow): ExclusionReason | null {
  if (row.fulfillment_status === 'delivered') return 'already_delivered'
  if (row.fulfillment_status === 'exception') return 'order_exception'
  if (row.manifested === 1) return 'already_manifested'
  return null
}

/** Shipments recorded in order_packings.dispatch for one carrier, with the facts that decide eligibility. */
async function findCandidates(db: D1Database, carrier: string, ownManifestId: string): Promise<CandidateRow[]> {
  const rows = await allRows<CandidateRow>(
    db,
    `SELECT p.order_id AS order_id,
            json_extract(j.value, '$.trackingNumber') AS tracking_number,
            json_extract(j.value, '$.shipmentNumber') AS shipment_number,
            json_extract(j.value, '$.parcelIndex') AS parcel_index,
            COALESCE(json_extract(p.parcels, '$[' || json_extract(j.value, '$.parcelIndex') || '].weightGrams'), 0) AS weight_grams,
            f.status AS fulfillment_status,
            EXISTS(SELECT 1 FROM carrier_manifest_items i JOIN carrier_manifests m ON m.id = i.manifest_id
                   WHERE i.tracking_number = json_extract(j.value, '$.trackingNumber') AND i.decision = 'included'
                     AND m.status <> 'cancelled' AND m.id <> ?2) AS manifested
       FROM order_packings p, json_each(p.dispatch, '$.shipments') j
       LEFT JOIN order_fulfillments f ON f.order_id = p.order_id
      WHERE p.dispatch IS NOT NULL AND lower(trim(json_extract(j.value, '$.carrier'))) = ?1
      ORDER BY p.order_id, tracking_number
      LIMIT ${MAX_MANIFEST_SHIPMENTS + 1}`,
    carrier,
    ownManifestId
  )
  if (rows.length > MAX_MANIFEST_SHIPMENTS)
    throw new ShippingOpsError('invalid_input', { reason: 'too_many_shipments' })
  const seen = new Set<string>()
  return rows.filter((row) => (seen.has(row.tracking_number) ? false : (seen.add(row.tracking_number), true)))
}

async function loadView(db: D1Database, id: string): Promise<ManifestView | null> {
  const m = await firstRow<ManifestRow>(db, `SELECT * FROM carrier_manifests WHERE id = ?1`, id)
  if (!m) return null
  const items = await allRows<ItemRow>(
    db,
    `SELECT * FROM carrier_manifest_items WHERE manifest_id = ?1 ORDER BY tracking_number`,
    id
  )
  const docs = await allRows<{
    kind: 'manifest_csv' | 'pickup_receipt'
    sha256: string
    byte_length: number
    created_at: string
  }>(
    db,
    `SELECT kind, sha256, byte_length, created_at FROM carrier_manifest_documents WHERE manifest_id = ?1 ORDER BY kind`,
    id
  )
  const pickup = await firstRow<PickupRow>(db, `SELECT * FROM carrier_pickups WHERE manifest_id = ?1`, id)
  const itemViews: ManifestItemView[] = items.map((i) => ({
    trackingNumber: i.tracking_number,
    shipmentNumber: i.shipment_number,
    orderId: i.order_id,
    parcelIndex: i.parcel_index,
    weightGrams: i.weight_grams,
    decision: i.decision,
    exclusionReason: i.exclusion_reason,
    scanStatus: i.scan_status
  }))
  const byReason: Partial<Record<ExclusionReason, number>> = {}
  for (const item of itemViews)
    if (item.exclusionReason) byReason[item.exclusionReason] = (byReason[item.exclusionReason] ?? 0) + 1
  const included = itemViews.filter((i) => i.decision === 'included')
  return {
    id: m.id,
    carrier: m.carrier,
    pickupDate: m.pickup_date,
    status: m.status,
    version: m.version,
    includedShipments: m.included_shipments,
    excludedShipments: m.excluded_shipments,
    parcelCount: m.parcel_count,
    weightGrams: m.weight_grams,
    providerManifestId: m.provider_manifest_id,
    closedAt: m.closed_at,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    items: itemViews,
    documents: docs.map((d) => ({
      kind: d.kind,
      sha256: d.sha256,
      byteLength: d.byte_length,
      createdAt: d.created_at
    })),
    pickup: pickup
      ? {
          providerPickupId: pickup.provider_pickup_id,
          scheduledDate: pickup.scheduled_date,
          parcelCount: pickup.parcel_count,
          status: pickup.status,
          scannedCount: pickup.scanned_count,
          missingCount: pickup.missing_count,
          unexpectedTrackings: pickup.unexpected_trackings ? (JSON.parse(pickup.unexpected_trackings) as string[]) : [],
          confirmedAt: pickup.confirmed_at
        }
      : null,
    reconciliation: {
      candidates: itemViews.length,
      included: included.length,
      excluded: itemViews.length - included.length,
      excludedByReason: byReason,
      balanced:
        included.length === m.included_shipments &&
        itemViews.length - included.length === m.excluded_shipments &&
        included.length === m.parcel_count &&
        included.reduce((n, i) => n + i.weightGrams, 0) === m.weight_grams
    }
  }
}

async function replayView(db: D1Database, commandId: string, payloadHash: string): Promise<ManifestView | null> {
  const cmd = await firstRow<{ payload_hash: string; manifest_id: string }>(
    db,
    `SELECT payload_hash, manifest_id FROM carrier_manifest_commands WHERE command_id = ?1`,
    commandId
  )
  if (!cmd) return null
  if (cmd.payload_hash !== payloadHash) throw new ShippingOpsError('idempotency_conflict')
  // Replays return the manifest as it is now; the command's own effect is already part of it.
  return loadView(db, cmd.manifest_id)
}

function commandInsert(
  db: D1Database,
  c: {
    commandId: string
    manifestId: string
    actorId: string
    action: string
    hash: string
    expected: number
    now: string
  }
) {
  return db
    .prepare(
      `INSERT INTO carrier_manifest_commands(command_id,manifest_id,actor_id,action,payload_hash,expected_version,result_version,response_json,created_at)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`
    )
    .bind(
      c.commandId,
      c.manifestId,
      c.actorId,
      c.action,
      c.hash,
      c.expected,
      c.expected + 1,
      JSON.stringify({ manifestId: c.manifestId, version: c.expected + 1 }),
      c.now
    )
}

async function mustLoad(db: D1Database, id: string): Promise<ManifestRow> {
  const row = await firstRow<ManifestRow>(db, `SELECT * FROM carrier_manifests WHERE id = ?1`, id)
  if (!row) throw new ShippingOpsError('not_found')
  return row
}

/** After a failed atomic write: explain it (replay race, revoked admin, state, version) instead of guessing. */
async function diagnose(db: D1Database, actorId: string, manifestId: string, expectedVersion: number): Promise<never> {
  await requireAdmin(db, actorId)
  const row = await mustLoad(db, manifestId)
  if (row.version !== expectedVersion) throw new ShippingOpsError('version_conflict')
  throw new ShippingOpsError('conflict')
}

async function finish(db: D1Database, id: string): Promise<ManifestView> {
  const view = await loadView(db, id)
  if (!view) throw new ShippingOpsError('internal')
  return view
}

export async function createManifest(db: D1Database, args: Actor & { input: unknown }): Promise<ManifestView> {
  const input = parse(createManifestInputSchema, args.input)
  const now = nowIso(args.now)
  const carrier = normaliseCarrier(input.carrier)
  if (!carrier || !validDate(input.pickupDate) || input.pickupDate < now.slice(0, 10))
    throw new ShippingOpsError('invalid_input')
  await requireAdmin(db, args.actorId)
  const hash = await hashPayload({ action: 'create', carrier, pickupDate: input.pickupDate })
  const replay = await replayView(db, input.commandId, hash)
  if (replay) return replay

  const candidates = await findCandidates(db, carrier, '')
  if (!candidates.length) throw new ShippingOpsError('nothing_to_manifest')
  const rows = candidates.map((c) => ({ c, reason: exclusionFor(c) }))
  const included = rows.filter((r) => r.reason === null)
  const id = randomId()
  const weight = included.reduce((n, r) => n + r.c.weight_grams, 0)
  try {
    await atomicBatch(db, (g) => [
      db
        .prepare(
          `INSERT INTO carrier_manifests(id,carrier,pickup_date,status,version,included_shipments,excluded_shipments,parcel_count,weight_grams,created_by,created_at,updated_at)
           SELECT ?1,?2,?3,'open',1,?4,?5,?4,?6,?7,?8,?8 WHERE ${liveAdminSql('?7')}`
        )
        .bind(id, carrier, input.pickupDate, included.length, rows.length - included.length, weight, args.actorId, now),
      g.expectOne(),
      ...rows.map(({ c, reason }) =>
        db
          .prepare(
            `INSERT INTO carrier_manifest_items(manifest_id,tracking_number,shipment_number,order_id,parcel_index,weight_grams,decision,exclusion_reason)
             SELECT ?1,?2,?3,?4,?5,?6,?7,?8
              WHERE ?7 = 'excluded' OR NOT EXISTS(SELECT 1 FROM carrier_manifest_items i JOIN carrier_manifests m ON m.id = i.manifest_id
                    WHERE i.tracking_number = ?2 AND i.decision = 'included' AND m.status <> 'cancelled' AND m.id <> ?1)`
          )
          .bind(
            id,
            c.tracking_number,
            c.shipment_number,
            c.order_id,
            c.parcel_index,
            c.weight_grams,
            reason ? 'excluded' : 'included',
            reason
          )
      ),
      g.check(`(SELECT count(*) FROM carrier_manifest_items WHERE manifest_id = ?2) = ?3`, id, rows.length),
      commandInsert(db, {
        commandId: input.commandId,
        manifestId: id,
        actorId: args.actorId,
        action: 'create',
        hash,
        expected: 0,
        now
      })
    ])
  } catch {
    const raced = await replayView(db, input.commandId, hash)
    if (raced) return raced
    await requireAdmin(db, args.actorId)
    const active = await firstRow(
      db,
      `SELECT 1 AS x FROM carrier_manifests WHERE carrier = ?1 AND pickup_date = ?2 AND status <> 'cancelled'`,
      carrier,
      input.pickupDate
    )
    throw new ShippingOpsError(active ? 'conflict' : 'internal')
  }
  return finish(db, id)
}

export async function setManifestItem(
  db: D1Database,
  args: Actor & { manifestId: string; input: unknown }
): Promise<ManifestView> {
  const input = parse(setManifestItemInputSchema, args.input)
  const now = nowIso(args.now)
  await requireAdmin(db, args.actorId)
  const hash = await hashPayload({ action: 'set_item', manifestId: args.manifestId, ...input })
  const replay = await replayView(db, input.commandId, hash)
  if (replay) return replay
  const manifest = await mustLoad(db, args.manifestId)
  if (manifest.status !== 'open') throw new ShippingOpsError('manifest_not_open')
  if (manifest.version !== input.expectedVersion) throw new ShippingOpsError('version_conflict')
  const item = await firstRow<ItemRow>(
    db,
    `SELECT * FROM carrier_manifest_items WHERE manifest_id = ?1 AND tracking_number = ?2`,
    manifest.id,
    input.trackingNumber
  )
  if (!item) throw new ShippingOpsError('not_found')
  const excluding = input.decision === 'excluded'
  if (
    excluding ? item.decision !== 'included' : item.decision !== 'excluded' || item.exclusion_reason !== 'manual_hold'
  )
    throw new ShippingOpsError('invalid_transition')
  const sign = excluding ? -1 : 1
  try {
    await atomicBatch(db, (g) => [
      db
        .prepare(
          `UPDATE carrier_manifests SET version = version + 1, updated_at = ?2,
             included_shipments = included_shipments + ?3, excluded_shipments = excluded_shipments - ?3,
             parcel_count = parcel_count + ?3, weight_grams = weight_grams + ?3 * ?4
           WHERE id = ?1 AND version = ?5 AND status = 'open' AND ${liveAdminSql('?6')}`
        )
        .bind(manifest.id, now, sign, item.weight_grams, manifest.version, args.actorId),
      g.expectOne(),
      db
        .prepare(
          `UPDATE carrier_manifest_items SET decision = ?3, exclusion_reason = ?4
           WHERE manifest_id = ?1 AND tracking_number = ?2 AND decision = ?5`
        )
        .bind(manifest.id, item.tracking_number, input.decision, excluding ? 'manual_hold' : null, item.decision),
      g.expectOne(),
      commandInsert(db, {
        commandId: input.commandId,
        manifestId: manifest.id,
        actorId: args.actorId,
        action: 'set_item',
        hash,
        expected: manifest.version,
        now
      })
    ])
  } catch {
    const raced = await replayView(db, input.commandId, hash)
    if (raced) return raced
    return diagnose(db, args.actorId, manifest.id, manifest.version)
  }
  return finish(db, manifest.id)
}

export async function closeManifest(
  db: D1Database,
  args: Actor & { manifestId: string; input: unknown; adapter: CarrierManifestAdapter }
): Promise<ManifestView> {
  const input = parse(closeManifestInputSchema, args.input)
  const now = nowIso(args.now)
  await requireAdmin(db, args.actorId)
  const hash = await hashPayload({ action: 'close', manifestId: args.manifestId, ...input })
  const replay = await replayView(db, input.commandId, hash)
  if (replay) return replay
  const manifest = await mustLoad(db, args.manifestId)
  if (manifest.status !== 'open') throw new ShippingOpsError('manifest_not_open')
  if (manifest.version !== input.expectedVersion) throw new ShippingOpsError('version_conflict')

  const items = await allRows<ItemRow>(
    db,
    `SELECT * FROM carrier_manifest_items WHERE manifest_id = ?1 ORDER BY tracking_number`,
    manifest.id
  )
  const facts = new Map((await findCandidates(db, manifest.carrier, manifest.id)).map((c) => [c.tracking_number, c]))
  const demoted: Array<{ item: ItemRow; reason: ExclusionReason }> = []
  const kept: ItemRow[] = []
  for (const item of items.filter((i) => i.decision === 'included')) {
    const reason = facts.has(item.tracking_number) ? exclusionFor(facts.get(item.tracking_number)!) : null
    if (reason) demoted.push({ item, reason })
    else kept.push(item)
  }
  if (!kept.length) throw new ShippingOpsError('nothing_to_manifest')

  let document: Awaited<ReturnType<CarrierManifestAdapter['closeManifest']>>
  try {
    document = await args.adapter.closeManifest({
      carrier: manifest.carrier,
      pickupDate: manifest.pickup_date,
      idempotencyKey: manifest.id,
      shipments: kept.map((i) => ({
        trackingNumber: i.tracking_number,
        shipmentNumber: i.shipment_number,
        orderId: i.order_id,
        parcelIndex: i.parcel_index,
        weightGrams: i.weight_grams
      }))
    })
  } catch {
    throw new ShippingOpsError('carrier_unavailable')
  }
  const sha = await sha256Hex(document.content)
  const bytes = new TextEncoder().encode(document.content).length
  const weight = kept.reduce((n, i) => n + i.weight_grams, 0)
  const excludedTotal = items.length - kept.length
  try {
    await atomicBatch(db, (g) => [
      db
        .prepare(
          `UPDATE carrier_manifests SET status = 'closed', version = version + 1, updated_at = ?2, closed_at = ?2,
             provider_manifest_id = ?3, included_shipments = ?4, excluded_shipments = ?5, parcel_count = ?4, weight_grams = ?6
           WHERE id = ?1 AND version = ?7 AND status = 'open' AND ${liveAdminSql('?8')}`
        )
        .bind(
          manifest.id,
          now,
          document.providerManifestId,
          kept.length,
          excludedTotal,
          weight,
          manifest.version,
          args.actorId
        ),
      g.expectOne(),
      ...demoted.flatMap(({ item, reason }) => [
        db
          .prepare(
            `UPDATE carrier_manifest_items SET decision = 'excluded', exclusion_reason = ?3 WHERE manifest_id = ?1 AND tracking_number = ?2 AND decision = 'included'`
          )
          .bind(manifest.id, item.tracking_number, reason),
        g.expectOne()
      ]),
      db
        .prepare(
          `INSERT INTO carrier_manifest_documents(id,manifest_id,kind,content_type,content,sha256,byte_length,created_at)
           VALUES(?1,?2,'manifest_csv',?3,?4,?5,?6,?7)`
        )
        .bind(randomId(), manifest.id, document.contentType, document.content, sha, bytes, now),
      commandInsert(db, {
        commandId: input.commandId,
        manifestId: manifest.id,
        actorId: args.actorId,
        action: 'close',
        hash,
        expected: manifest.version,
        now
      })
    ])
  } catch {
    const raced = await replayView(db, input.commandId, hash)
    if (raced) return raced
    const current = await firstRow<ManifestRow>(db, `SELECT * FROM carrier_manifests WHERE id = ?1`, manifest.id)
    await requireAdmin(db, args.actorId)
    if (current && current.status !== 'open') throw new ShippingOpsError('manifest_not_open')
    return diagnose(db, args.actorId, manifest.id, manifest.version)
  }
  return finish(db, manifest.id)
}

export async function schedulePickup(
  db: D1Database,
  args: Actor & { manifestId: string; input: unknown; adapter: CarrierManifestAdapter }
): Promise<ManifestView> {
  const input = parse(schedulePickupInputSchema, args.input)
  const now = nowIso(args.now)
  await requireAdmin(db, args.actorId)
  const hash = await hashPayload({ action: 'schedule_pickup', manifestId: args.manifestId, ...input })
  const replay = await replayView(db, input.commandId, hash)
  if (replay) return replay
  const manifest = await mustLoad(db, args.manifestId)
  if (manifest.status !== 'closed') throw new ShippingOpsError('manifest_not_closed')
  if (await firstRow(db, `SELECT 1 AS x FROM carrier_pickups WHERE manifest_id = ?1`, manifest.id))
    throw new ShippingOpsError('invalid_transition')
  if (manifest.version !== input.expectedVersion) throw new ShippingOpsError('version_conflict')
  let pickup: Awaited<ReturnType<CarrierManifestAdapter['schedulePickup']>>
  try {
    pickup = await args.adapter.schedulePickup({
      carrier: manifest.carrier,
      pickupDate: manifest.pickup_date,
      parcelCount: manifest.parcel_count,
      idempotencyKey: manifest.id
    })
  } catch {
    throw new ShippingOpsError('carrier_unavailable')
  }
  try {
    await atomicBatch(db, (g) => [
      db
        .prepare(
          `UPDATE carrier_manifests SET version = version + 1, updated_at = ?2
           WHERE id = ?1 AND version = ?3 AND status = 'closed' AND ${liveAdminSql('?4')}
             AND NOT EXISTS(SELECT 1 FROM carrier_pickups WHERE manifest_id = ?1)`
        )
        .bind(manifest.id, now, manifest.version, args.actorId),
      g.expectOne(),
      db
        .prepare(
          `INSERT INTO carrier_pickups(manifest_id,provider_pickup_id,scheduled_date,parcel_count,status,created_at)
           VALUES(?1,?2,?3,?4,'scheduled',?5)`
        )
        .bind(manifest.id, pickup.providerPickupId, manifest.pickup_date, manifest.parcel_count, now),
      commandInsert(db, {
        commandId: input.commandId,
        manifestId: manifest.id,
        actorId: args.actorId,
        action: 'schedule_pickup',
        hash,
        expected: manifest.version,
        now
      })
    ])
  } catch {
    const raced = await replayView(db, input.commandId, hash)
    if (raced) return raced
    return diagnose(db, args.actorId, manifest.id, manifest.version)
  }
  return finish(db, manifest.id)
}

export async function confirmPickup(
  db: D1Database,
  args: Actor & { manifestId: string; input: unknown }
): Promise<ManifestView> {
  const input = parse(confirmPickupInputSchema, args.input)
  const now = nowIso(args.now)
  await requireAdmin(db, args.actorId)
  const scanned = [...new Set(input.scannedTrackingNumbers)].sort()
  const hash = await hashPayload({
    action: 'confirm_pickup',
    manifestId: args.manifestId,
    commandId: input.commandId,
    expectedVersion: input.expectedVersion,
    scanned
  })
  const replay = await replayView(db, input.commandId, hash)
  if (replay) return replay
  const manifest = await mustLoad(db, args.manifestId)
  const pickup = await firstRow<PickupRow>(db, `SELECT * FROM carrier_pickups WHERE manifest_id = ?1`, manifest.id)
  if (manifest.status !== 'closed' || !pickup || pickup.status !== 'scheduled')
    throw new ShippingOpsError('invalid_transition')
  if (manifest.version !== input.expectedVersion) throw new ShippingOpsError('version_conflict')

  const included = (
    await allRows<{ tracking_number: string }>(
      db,
      `SELECT tracking_number FROM carrier_manifest_items WHERE manifest_id = ?1 AND decision = 'included'`,
      manifest.id
    )
  ).map((r) => r.tracking_number)
  const includedSet = new Set(included)
  const scannedSet = new Set(scanned)
  const matched = included.filter((t) => scannedSet.has(t)).sort()
  const missing = included.filter((t) => !scannedSet.has(t)).sort()
  const unexpected = scanned.filter((t) => !includedSet.has(t))
  const clean = missing.length === 0 && unexpected.length === 0
  const status = clean ? 'picked_up' : 'discrepancy'
  const receipt =
    [
      `manifest=${manifest.id}`,
      `carrier=${manifest.carrier}`,
      `pickup_date=${manifest.pickup_date}`,
      `provider_pickup_id=${pickup.provider_pickup_id}`,
      `expected=${included.length}`,
      `scanned=${matched.length}`,
      `missing=${missing.length}`,
      `unexpected=${unexpected.length}`,
      ...missing.map((t) => `missing_tracking=${t}`),
      ...unexpected.map((t) => `unexpected_tracking=${t}`)
    ].join('\n') + '\n'
  const sha = await sha256Hex(receipt)
  try {
    await atomicBatch(db, (g) => [
      db
        .prepare(
          `UPDATE carrier_manifests SET status = ?2, version = version + 1, updated_at = ?3
           WHERE id = ?1 AND version = ?4 AND status = 'closed' AND ${liveAdminSql('?5')}
             AND EXISTS(SELECT 1 FROM carrier_pickups WHERE manifest_id = ?1 AND status = 'scheduled')`
        )
        .bind(manifest.id, status, now, manifest.version, args.actorId),
      g.expectOne(),
      db
        .prepare(
          `UPDATE carrier_pickups SET status = ?2, scanned_count = ?3, missing_count = ?4, unexpected_trackings = ?5, confirmed_at = ?6
           WHERE manifest_id = ?1 AND status = 'scheduled'`
        )
        .bind(
          manifest.id,
          clean ? 'confirmed' : 'discrepancy',
          matched.length,
          missing.length,
          JSON.stringify(unexpected),
          now
        ),
      g.expectOne(),
      db
        .prepare(
          `UPDATE carrier_manifest_items SET scan_status = CASE WHEN tracking_number IN (SELECT value FROM json_each(?2)) THEN 'scanned' ELSE 'missing' END
           WHERE manifest_id = ?1 AND decision = 'included'`
        )
        .bind(manifest.id, JSON.stringify(scanned)),
      db
        .prepare(
          `INSERT INTO carrier_manifest_documents(id,manifest_id,kind,content_type,content,sha256,byte_length,created_at)
           VALUES(?1,?2,'pickup_receipt','text/plain; charset=utf-8',?3,?4,?5,?6)`
        )
        .bind(randomId(), manifest.id, receipt, sha, new TextEncoder().encode(receipt).length, now),
      commandInsert(db, {
        commandId: input.commandId,
        manifestId: manifest.id,
        actorId: args.actorId,
        action: 'confirm_pickup',
        hash,
        expected: manifest.version,
        now
      })
    ])
  } catch {
    const raced = await replayView(db, input.commandId, hash)
    if (raced) return raced
    return diagnose(db, args.actorId, manifest.id, manifest.version)
  }
  return finish(db, manifest.id)
}

export async function cancelManifest(
  db: D1Database,
  args: Actor & { manifestId: string; input: unknown }
): Promise<ManifestView> {
  const input = parse(cancelManifestInputSchema, args.input)
  const now = nowIso(args.now)
  await requireAdmin(db, args.actorId)
  const hash = await hashPayload({ action: 'cancel', manifestId: args.manifestId, ...input })
  const replay = await replayView(db, input.commandId, hash)
  if (replay) return replay
  const manifest = await mustLoad(db, args.manifestId)
  const pickup = await firstRow(db, `SELECT 1 AS x FROM carrier_pickups WHERE manifest_id = ?1`, manifest.id)
  if (!['open', 'closed'].includes(manifest.status) || pickup) throw new ShippingOpsError('invalid_transition')
  if (manifest.version !== input.expectedVersion) throw new ShippingOpsError('version_conflict')
  try {
    await atomicBatch(db, (g) => [
      db
        .prepare(
          `UPDATE carrier_manifests SET status = 'cancelled', version = version + 1, updated_at = ?2
           WHERE id = ?1 AND version = ?3 AND status IN ('open','closed') AND ${liveAdminSql('?4')}
             AND NOT EXISTS(SELECT 1 FROM carrier_pickups WHERE manifest_id = ?1)`
        )
        .bind(manifest.id, now, manifest.version, args.actorId),
      g.expectOne(),
      commandInsert(db, {
        commandId: input.commandId,
        manifestId: manifest.id,
        actorId: args.actorId,
        action: 'cancel',
        hash,
        expected: manifest.version,
        now
      })
    ])
  } catch {
    const raced = await replayView(db, input.commandId, hash)
    if (raced) return raced
    return diagnose(db, args.actorId, manifest.id, manifest.version)
  }
  return finish(db, manifest.id)
}

export async function getManifest(db: D1Database, actorId: string, id: string): Promise<ManifestView> {
  await requireAdmin(db, actorId)
  const view = await loadView(db, id)
  if (!view) throw new ShippingOpsError('not_found')
  await requireAdmin(db, actorId)
  return view
}

export async function listManifests(
  db: D1Database,
  actorId: string,
  filter: { status?: ManifestStatus; limit?: number }
): Promise<ManifestSummary[]> {
  await requireAdmin(db, actorId)
  if (filter.status !== undefined && !STATUSES.includes(filter.status)) throw new ShippingOpsError('invalid_input')
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), 200)
  const rows = await allRows<ManifestRow>(
    db,
    `SELECT * FROM carrier_manifests WHERE (?1 IS NULL OR status = ?1) ORDER BY pickup_date DESC, created_at DESC, id LIMIT ?2`,
    filter.status ?? null,
    limit
  )
  await requireAdmin(db, actorId)
  return rows.map((m) => ({
    id: m.id,
    carrier: m.carrier,
    pickupDate: m.pickup_date,
    status: m.status,
    version: m.version,
    includedShipments: m.included_shipments,
    excludedShipments: m.excluded_shipments,
    parcelCount: m.parcel_count
  }))
}

export async function getManifestDocument(
  db: D1Database,
  actorId: string,
  manifestId: string,
  kind: 'manifest_csv' | 'pickup_receipt'
) {
  await requireAdmin(db, actorId)
  if (kind !== 'manifest_csv' && kind !== 'pickup_receipt') throw new ShippingOpsError('invalid_input')
  const doc = await firstRow<{
    content_type: string
    content: string
    sha256: string
    byte_length: number
    created_at: string
  }>(
    db,
    `SELECT content_type, content, sha256, byte_length, created_at FROM carrier_manifest_documents WHERE manifest_id = ?1 AND kind = ?2`,
    manifestId,
    kind
  )
  if (!doc) throw new ShippingOpsError('not_found')
  if ((await sha256Hex(doc.content)) !== doc.sha256)
    throw new ShippingOpsError('internal', { reason: 'document_hash_mismatch' })
  await requireAdmin(db, actorId)
  return {
    kind,
    contentType: doc.content_type,
    content: doc.content,
    sha256: doc.sha256,
    byteLength: doc.byte_length,
    createdAt: doc.created_at
  }
}
