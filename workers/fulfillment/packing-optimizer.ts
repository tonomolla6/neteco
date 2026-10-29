import {
  PACKING_ALGORITHM_VERSION,
  PackingOptimizerError,
  optimizePacking,
  toOrderPackingParcels,
  verifyPackingPlan,
  type BoxType,
  type HazardClass,
  type PackingContext,
  type PackingPlan,
  type ProductProfile
} from '../../shared/packing-optimizer'
import {
  boxCodeSchema,
  boxTypeInputSchema,
  createSuggestionInputSchema,
  decideSuggestionInputSchema,
  incompatibilityDeleteSchema,
  incompatibilityInputSchema,
  productProfileInputSchema,
  type BoxTypeInput,
  type CreateSuggestionInput,
  type DecideSuggestionInput,
  type PackingBoxView,
  type PackingConfigView,
  type PackingProfileView,
  type PackingSuggestionView,
  type ProductProfileInput
} from '../../shared/packing-optimizer-api'
import {
  ShippingOpsError,
  allRows,
  firstRow,
  guardedWrite,
  hashPayload,
  liveAdminSql,
  nowIso,
  randomId,
  requireAdmin
} from './shipping-ops-common'

/** Warehouse validation tolerance on gross parcel weight, in basis points of the planned weight. */
export const PACKING_WEIGHT_TOLERANCE_BP = 1500

interface BoxRow {
  code: string
  name: string
  inner_width_mm: number
  inner_height_mm: number
  inner_depth_mm: number
  tare_grams: number
  max_weight_grams: number
  hazmat_allowed: number
  active: number
  version: number
  updated_at: string
}
interface ProfileRow {
  sku: string
  weight_grams: number
  width_mm: number
  height_mm: number
  depth_mm: number
  hazard_class: HazardClass
  version: number
  updated_at: string
}
interface SuggestionRow {
  id: string
  command_id: string
  payload_hash: string
  order_id: string | null
  status: 'suggested' | 'validated' | 'rejected'
  version: number
  algorithm_version: string
  input_json: string
  plan_json: string
  parcel_count: number
  validation_json: string | null
  validated_at: string | null
  created_at: string
  updated_at: string
}

const boxView = (r: BoxRow): PackingBoxView => ({
  code: r.code,
  name: r.name,
  widthMm: r.inner_width_mm,
  heightMm: r.inner_height_mm,
  depthMm: r.inner_depth_mm,
  tareGrams: r.tare_grams,
  maxWeightGrams: r.max_weight_grams,
  hazmatAllowed: r.hazmat_allowed === 1,
  active: r.active === 1,
  version: r.version,
  updatedAt: r.updated_at
})
const profileView = (r: ProfileRow): PackingProfileView => ({
  sku: r.sku,
  weightGrams: r.weight_grams,
  widthMm: r.width_mm,
  heightMm: r.height_mm,
  depthMm: r.depth_mm,
  hazardClass: r.hazard_class,
  version: r.version,
  updatedAt: r.updated_at
})
const toBox = (r: BoxRow): BoxType => ({
  code: r.code,
  name: r.name,
  widthMm: r.inner_width_mm,
  heightMm: r.inner_height_mm,
  depthMm: r.inner_depth_mm,
  tareGrams: r.tare_grams,
  maxWeightGrams: r.max_weight_grams,
  hazmatAllowed: r.hazmat_allowed === 1,
  active: r.active === 1
})
const toProfile = (r: ProfileRow): ProductProfile => ({
  sku: r.sku,
  weightGrams: r.weight_grams,
  widthMm: r.width_mm,
  heightMm: r.height_mm,
  depthMm: r.depth_mm,
  hazardClass: r.hazard_class
})

function parse<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
  raw: unknown
): T {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new ShippingOpsError('invalid_input')
  return parsed.data
}

async function loadContext(db: D1Database, skus: string[] | null): Promise<PackingContext & { rows: ProfileRow[] }> {
  const boxes = await allRows<BoxRow>(db, `SELECT * FROM packing_box_types ORDER BY code`)
  const rules = await allRows<{ class_a: HazardClass; class_b: HazardClass }>(
    db,
    `SELECT class_a, class_b FROM packing_incompatibilities`
  )
  const rows = skus?.length
    ? await allRows<ProfileRow>(
        db,
        `SELECT * FROM packing_product_profiles WHERE sku IN (${skus.map((_, i) => `?${i + 1}`).join(',')})`,
        ...skus
      )
    : []
  return {
    boxes: boxes.map(toBox),
    profiles: rows.map(toProfile),
    incompatibilities: rules.map((r) => ({ classA: r.class_a, classB: r.class_b })),
    rows
  }
}

export async function listPackingConfig(db: D1Database, actorId: string): Promise<PackingConfigView> {
  await requireAdmin(db, actorId)
  const boxes = await allRows<BoxRow>(db, `SELECT * FROM packing_box_types ORDER BY code`)
  const profiles = await allRows<ProfileRow>(db, `SELECT * FROM packing_product_profiles ORDER BY sku LIMIT 500`)
  const rules = await allRows<{ class_a: string; class_b: string; reason: string }>(
    db,
    `SELECT class_a, class_b, reason FROM packing_incompatibilities ORDER BY class_a, class_b`
  )
  const suggestions = await allRows<SuggestionRow>(
    db,
    `SELECT id, order_id, status, version, parcel_count, created_at FROM packing_suggestions ORDER BY created_at DESC, id DESC LIMIT 20`
  )
  await requireAdmin(db, actorId)
  return {
    boxes: boxes.map(boxView),
    profiles: profiles.map(profileView),
    incompatibilities: rules.map((r) => ({ classA: r.class_a, classB: r.class_b, reason: r.reason })),
    suggestions: suggestions.map((s) => ({
      id: s.id,
      orderId: s.order_id,
      status: s.status,
      version: s.version,
      createdAt: s.created_at,
      parcelCount: s.parcel_count
    }))
  }
}

export async function upsertBoxType(
  db: D1Database,
  args: { actorId: string; code: string; input: BoxTypeInput | unknown; now?: string }
): Promise<PackingBoxView> {
  const code = parse(boxCodeSchema, args.code)
  const input = parse(boxTypeInputSchema, args.input)
  const now = nowIso(args.now)
  const admin = liveAdminSql('?10')
  const values = [
    code,
    input.name,
    input.widthMm,
    input.heightMm,
    input.depthMm,
    input.tareGrams,
    input.maxWeightGrams,
    input.hazmatAllowed ? 1 : 0,
    input.active ? 1 : 0,
    args.actorId,
    now,
    input.expectedVersion
  ]
  try {
    const mutation =
      input.expectedVersion === 0
        ? db
            .prepare(
              `INSERT INTO packing_box_types(code,name,inner_width_mm,inner_height_mm,inner_depth_mm,tare_grams,max_weight_grams,hazmat_allowed,active,version,updated_at)
               SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,1,?11 WHERE ${admin} AND ?12 = 0`
            )
            .bind(...values)
        : db
            .prepare(
              `UPDATE packing_box_types SET name=?2,inner_width_mm=?3,inner_height_mm=?4,inner_depth_mm=?5,tare_grams=?6,max_weight_grams=?7,
                 hazmat_allowed=?8,active=?9,version=version+1,updated_at=?11
               WHERE code=?1 AND version=?12 AND ${admin}`
            )
            .bind(...values)
    await guardedWrite(db, mutation)
  } catch {
    await requireAdmin(db, args.actorId)
    throw new ShippingOpsError('version_conflict')
  }
  return boxView((await firstRow<BoxRow>(db, `SELECT * FROM packing_box_types WHERE code = ?1`, code))!)
}

export async function upsertProductProfile(
  db: D1Database,
  args: { actorId: string; sku: string; input: ProductProfileInput | unknown; now?: string }
): Promise<PackingProfileView> {
  const sku = args.sku
  if (typeof sku !== 'string' || sku.length < 1 || sku.length > 200) throw new ShippingOpsError('invalid_input')
  const input = parse(productProfileInputSchema, args.input)
  const now = nowIso(args.now)
  const admin = liveAdminSql('?9')
  const values = [
    sku,
    input.weightGrams,
    input.widthMm,
    input.heightMm,
    input.depthMm,
    input.hazardClass,
    now,
    input.expectedVersion,
    args.actorId
  ]
  try {
    const mutation =
      input.expectedVersion === 0
        ? db
            .prepare(
              `INSERT INTO packing_product_profiles(sku,weight_grams,width_mm,height_mm,depth_mm,hazard_class,version,updated_at)
               SELECT ?1,?2,?3,?4,?5,?6,1,?7 WHERE ${admin} AND ?8 = 0`
            )
            .bind(...values)
        : db
            .prepare(
              `UPDATE packing_product_profiles SET weight_grams=?2,width_mm=?3,height_mm=?4,depth_mm=?5,hazard_class=?6,version=version+1,updated_at=?7
               WHERE sku=?1 AND version=?8 AND ${admin}`
            )
            .bind(...values)
    await guardedWrite(db, mutation)
  } catch {
    await requireAdmin(db, args.actorId)
    throw new ShippingOpsError('version_conflict')
  }
  return profileView((await firstRow<ProfileRow>(db, `SELECT * FROM packing_product_profiles WHERE sku = ?1`, sku))!)
}

function orderedPair(a: HazardClass, b: HazardClass): [HazardClass, HazardClass] {
  return a <= b ? [a, b] : [b, a]
}

export async function setIncompatibility(
  db: D1Database,
  args: { actorId: string; classA: string; classB: string; reason: string }
): Promise<void> {
  const input = parse(incompatibilityInputSchema, { classA: args.classA, classB: args.classB, reason: args.reason })
  const [a, b] = orderedPair(input.classA, input.classB)
  await requireAdmin(db, args.actorId)
  await guardedWrite(
    db,
    db
      .prepare(
        `INSERT INTO packing_incompatibilities(class_a,class_b,reason) SELECT ?1,?2,?3 WHERE ${liveAdminSql('?4')}
         ON CONFLICT(class_a,class_b) DO UPDATE SET reason = excluded.reason`
      )
      .bind(a, b, input.reason, args.actorId)
  ).catch(async () => {
    await requireAdmin(db, args.actorId)
    throw new ShippingOpsError('internal')
  })
}

export async function deleteIncompatibility(
  db: D1Database,
  args: { actorId: string; classA: string; classB: string }
): Promise<void> {
  const input = parse(incompatibilityDeleteSchema, { classA: args.classA, classB: args.classB })
  const [a, b] = orderedPair(input.classA, input.classB)
  await requireAdmin(db, args.actorId)
  const existing = await firstRow(
    db,
    `SELECT 1 AS x FROM packing_incompatibilities WHERE class_a=?1 AND class_b=?2`,
    a,
    b
  )
  if (!existing) throw new ShippingOpsError('not_found')
  await guardedWrite(
    db,
    db
      .prepare(`DELETE FROM packing_incompatibilities WHERE class_a=?1 AND class_b=?2 AND ${liveAdminSql('?3')}`)
      .bind(a, b, args.actorId)
  ).catch(async () => {
    await requireAdmin(db, args.actorId)
    throw new ShippingOpsError('not_found')
  })
}

function mapOptimizerError(error: unknown): never {
  if (error instanceof PackingOptimizerError) {
    const code = error.code === 'line_index_required' ? 'invalid_input' : error.code
    throw new ShippingOpsError(code, error.details)
  }
  throw error
}

function suggestionView(row: SuggestionRow): PackingSuggestionView {
  const plan = JSON.parse(row.plan_json) as PackingPlan
  const input = JSON.parse(row.input_json) as { lines: PackingSuggestionView['lines'] }
  let orderPackingParcels: PackingSuggestionView['orderPackingParcels']
  try {
    orderPackingParcels = toOrderPackingParcels(plan)
  } catch {
    orderPackingParcels = null
  }
  return {
    id: row.id,
    orderId: row.order_id,
    status: row.status,
    version: row.version,
    algorithmVersion: row.algorithm_version,
    lines: input.lines,
    plan,
    orderPackingParcels,
    validation: row.validation_json ? (JSON.parse(row.validation_json) as Record<string, unknown>) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    validatedAt: row.validated_at
  }
}

export async function createPackingSuggestion(
  db: D1Database,
  args: { actorId: string; input: CreateSuggestionInput | unknown; now?: string }
): Promise<PackingSuggestionView> {
  const input = parse(createSuggestionInputSchema, args.input)
  const now = nowIso(args.now)
  await requireAdmin(db, args.actorId)
  const payloadHash = await hashPayload({ orderId: input.orderId ?? null, lines: input.lines ?? null })
  const replay = async () => {
    const row = await firstRow<SuggestionRow>(
      db,
      `SELECT * FROM packing_suggestions WHERE command_id = ?1`,
      input.commandId
    )
    if (!row) return null
    if (row.payload_hash !== payloadHash) throw new ShippingOpsError('idempotency_conflict')
    return suggestionView(row)
  }
  const replayed = await replay()
  if (replayed) return replayed

  let lines = input.lines
  if (!lines) {
    const rows = await allRows<{ line_index: number; sku: string; quantity: number }>(
      db,
      `SELECT line_index, sku, quantity FROM order_lines WHERE order_id = ?1 ORDER BY line_index`,
      input.orderId
    )
    if (!rows.length) throw new ShippingOpsError('not_found')
    lines = rows.map((r) => ({ sku: r.sku, quantity: r.quantity, lineIndex: r.line_index }))
  }
  const skus = [...new Set(lines.map((l) => l.sku))]
  const context = await loadContext(db, skus)
  let plan: PackingPlan
  try {
    plan = optimizePacking({ lines }, context)
  } catch (error) {
    mapOptimizerError(error)
  }
  if (verifyPackingPlan(plan, { lines }, context).length) throw new ShippingOpsError('internal')

  const id = randomId()
  try {
    await guardedWrite(
      db,
      db
        .prepare(
          `INSERT INTO packing_suggestions(id,command_id,payload_hash,order_id,status,version,algorithm_version,input_json,plan_json,parcel_count,gross_weight_grams,created_by,created_at,updated_at)
           SELECT ?1,?2,?3,?4,'suggested',1,?5,?6,?7,?8,?9,?10,?11,?11 WHERE ${liveAdminSql('?10')}`
        )
        .bind(
          id,
          input.commandId,
          payloadHash,
          input.orderId ?? null,
          PACKING_ALGORITHM_VERSION,
          JSON.stringify({ lines }),
          JSON.stringify(plan),
          plan.totals.parcelCount,
          plan.totals.grossWeightGrams,
          args.actorId,
          now
        )
    )
  } catch {
    const raced = await replay()
    if (raced) return raced
    await requireAdmin(db, args.actorId)
    throw new ShippingOpsError('internal')
  }
  return suggestionView((await firstRow<SuggestionRow>(db, `SELECT * FROM packing_suggestions WHERE id = ?1`, id))!)
}

export async function getPackingSuggestion(
  db: D1Database,
  actorId: string,
  id: string
): Promise<PackingSuggestionView> {
  await requireAdmin(db, actorId)
  const row = await firstRow<SuggestionRow>(db, `SELECT * FROM packing_suggestions WHERE id = ?1`, id)
  if (!row) throw new ShippingOpsError('not_found')
  await requireAdmin(db, actorId)
  return suggestionView(row)
}

export async function decidePackingSuggestion(
  db: D1Database,
  args: { actorId: string; suggestionId: string; input: DecideSuggestionInput | unknown; now?: string }
): Promise<PackingSuggestionView> {
  const input = parse(decideSuggestionInputSchema, args.input)
  const now = nowIso(args.now)
  await requireAdmin(db, args.actorId)
  const payloadHash = await hashPayload({ suggestionId: args.suggestionId, ...input })
  const replay = async () => {
    const cmd = await firstRow<{ payload_hash: string; response_json: string }>(
      db,
      `SELECT payload_hash, response_json FROM packing_suggestion_commands WHERE command_id = ?1`,
      input.commandId
    )
    if (!cmd) return null
    if (cmd.payload_hash !== payloadHash) throw new ShippingOpsError('idempotency_conflict')
    return JSON.parse(cmd.response_json) as PackingSuggestionView
  }
  const replayed = await replay()
  if (replayed) return replayed

  const row = await firstRow<SuggestionRow>(db, `SELECT * FROM packing_suggestions WHERE id = ?1`, args.suggestionId)
  if (!row) throw new ShippingOpsError('not_found')
  if (row.status !== 'suggested') throw new ShippingOpsError('invalid_transition')
  if (row.version !== input.expectedVersion) throw new ShippingOpsError('version_conflict')

  const plan = JSON.parse(row.plan_json) as PackingPlan
  const lines = (JSON.parse(row.input_json) as { lines: PackingSuggestionView['lines'] }).lines
  let actualParcels: Array<{ parcelIndex: number; weightGrams: number }> | null = null
  if (input.decision === 'accept') {
    const given = input.actualParcels ?? []
    const indexes = given.map((p) => p.parcelIndex).sort((a, b) => a - b)
    if (given.length !== plan.parcels.length || indexes.some((v, i) => v !== i))
      throw new ShippingOpsError('invalid_input')
    const context = await loadContext(db, [...new Set(lines.map((l) => l.sku))])
    const problems = verifyPackingPlan(plan, { lines }, context)
    if (problems.length) throw new ShippingOpsError('plan_stale', { problems })
    for (const actual of given) {
      const planned = plan.parcels[actual.parcelIndex]!
      const box = context.boxes.find((b) => b.code === planned.boxCode)!
      if (
        actual.weightGrams > box.maxWeightGrams ||
        Math.abs(actual.weightGrams - planned.grossWeightGrams) * 10000 >
          planned.grossWeightGrams * PACKING_WEIGHT_TOLERANCE_BP
      )
        throw new ShippingOpsError('validation_out_of_tolerance', { parcelIndex: actual.parcelIndex })
    }
    actualParcels = [...given].sort((a, b) => a.parcelIndex - b.parcelIndex)
  } else if ((input.note ?? '').length < 10) {
    throw new ShippingOpsError('invalid_input')
  }

  const validation = {
    decision: input.decision,
    note: input.note ?? null,
    actualParcels,
    toleranceBp: PACKING_WEIGHT_TOLERANCE_BP,
    decidedBy: args.actorId
  }
  const status = input.decision === 'accept' ? 'validated' : 'rejected'
  const view: PackingSuggestionView = {
    ...suggestionView(row),
    status,
    version: row.version + 1,
    validation,
    validatedAt: now,
    updatedAt: now
  }
  try {
    await guardedWrite(
      db,
      db
        .prepare(
          `UPDATE packing_suggestions SET status=?1, version=version+1, validated_by=?2, validation_json=?3, validated_at=?4, updated_at=?4
           WHERE id=?5 AND version=?6 AND status='suggested' AND ${liveAdminSql('?2')}`
        )
        .bind(status, args.actorId, JSON.stringify(validation), now, row.id, row.version),
      [
        db
          .prepare(
            `INSERT INTO packing_suggestion_commands(command_id,suggestion_id,actor_id,action,payload_hash,expected_version,response_json,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`
          )
          .bind(
            input.commandId,
            row.id,
            args.actorId,
            input.decision === 'accept' ? 'validate' : 'reject',
            payloadHash,
            row.version,
            JSON.stringify(view),
            now
          )
      ]
    )
  } catch {
    const raced = await replay()
    if (raced) return raced
    await requireAdmin(db, args.actorId)
    const current = await firstRow<SuggestionRow>(db, `SELECT * FROM packing_suggestions WHERE id = ?1`, row.id)
    if (current && current.status !== 'suggested') throw new ShippingOpsError('invalid_transition')
    throw new ShippingOpsError('version_conflict')
  }
  return view
}
