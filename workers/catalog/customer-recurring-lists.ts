import { randomUUID } from 'node:crypto'
import {
  recurringListCreateInputSchema,
  recurringListUpdateInputSchema,
  recurringListCollaboratorInviteInputSchema,
  recurringListItemSetInputSchema,
  type RecurringFrequency,
  type RecurringListRevalidationReport,
  type RecurringListItemRevalidated
} from '../../shared/customer-recurring-lists'
import { publicationValidityExpression } from './publication-validity'
import { sellableExpression } from './inventory'

export interface CreateRecurringListParams {
  customerId: string
  ownerIdentityId: string
  name: string
  description?: string | null
  frequency: RecurringFrequency
  frequencyDays?: number | null
  nextSuggestedDate?: string | null
}

export interface UpdateRecurringListParams {
  listId: string
  requesterIdentityId: string
  name?: string
  description?: string | null
  frequency?: RecurringFrequency
  frequencyDays?: number | null
  nextSuggestedDate?: string | null
  status?: 'active' | 'paused' | 'archived'
  expectedVersion: number
}

export interface InviteCollaboratorParams {
  listId: string
  requesterIdentityId: string
  email: string
  role: 'editor' | 'viewer'
}

export interface RemoveCollaboratorParams {
  listId: string
  requesterIdentityId: string
  collaboratorIdentityId: string
}

export interface SetRecurringListItemParams {
  listId: string
  requesterIdentityId: string
  variantId: string
  quantity: number
  expectedUnitGrossCents?: number | null
}

export interface RemoveRecurringListItemParams {
  listId: string
  requesterIdentityId: string
  variantId: string
}

export interface RevalidateAssortmentParams {
  listId: string
  customerId: string
  now?: string
}

export interface RecordReplenishmentParams {
  listId: string
  requesterIdentityId: string
  replenishedAt?: string
}

function canonicalNow(now?: string): string {
  const date = now ? new Date(now) : new Date()
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function calculateNextDate(fromIso: string, frequency: RecurringFrequency, days?: number | null): string {
  const d = new Date(fromIso)
  let addDays = 30
  if (frequency === 'weekly') addDays = 7
  else if (frequency === 'biweekly') addDays = 14
  else if (frequency === 'monthly') addDays = 30
  else if (frequency === 'quarterly') addDays = 90
  else if (frequency === 'custom' && days) addDays = days

  d.setUTCDate(d.getUTCDate() + addDays)
  return d.toISOString().slice(0, 10)
}

export async function createRecurringList(database: D1Database, params: CreateRecurringListParams) {
  const validated = recurringListCreateInputSchema.parse({
    name: params.name,
    description: params.description,
    frequency: params.frequency,
    frequencyDays: params.frequencyDays,
    nextSuggestedDate: params.nextSuggestedDate
  })
  const now = canonicalNow()
  const id = randomUUID()

  let nextDate = validated.nextSuggestedDate
  if (!nextDate) {
    nextDate = calculateNextDate(now, validated.frequency, validated.frequencyDays)
  }

  await database
    .prepare(
      `INSERT INTO customer_recurring_lists(
        id, customer_id, owner_identity_id, name, description,
        frequency, frequency_days, next_suggested_date, status, version,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`
    )
    .bind(
      id,
      params.customerId,
      params.ownerIdentityId,
      validated.name,
      validated.description ?? null,
      validated.frequency,
      validated.frequencyDays ?? null,
      nextDate,
      now,
      now
    )
    .run()

  return {
    id,
    customerId: params.customerId,
    ownerIdentityId: params.ownerIdentityId,
    name: validated.name,
    description: validated.description ?? null,
    frequency: validated.frequency,
    frequencyDays: validated.frequencyDays ?? null,
    nextSuggestedDate: nextDate,
    status: 'active' as const,
    version: 1,
    createdAt: now,
    updatedAt: now
  }
}

export async function getRecurringList(database: D1Database, listId: string, requesterIdentityId: string) {
  const list = await database
    .prepare(`SELECT * FROM customer_recurring_lists WHERE id = ?`)
    .bind(listId)
    .first<{
      id: string
      customer_id: string
      owner_identity_id: string
      name: string
      description: string | null
      frequency: RecurringFrequency
      frequency_days: number | null
      next_suggested_date: string | null
      last_replenished_at: string | null
      status: 'active' | 'paused' | 'archived'
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!list) return null

  // Check access: owner or collaborator
  const isOwner = list.owner_identity_id === requesterIdentityId
  let userRole: 'owner' | 'editor' | 'viewer' | null = isOwner ? 'owner' : null

  if (!isOwner) {
    const collab = await database
      .prepare(`SELECT role FROM customer_recurring_list_collaborators WHERE list_id = ? AND identity_id = ?`)
      .bind(listId, requesterIdentityId)
      .first<{ role: 'editor' | 'viewer' }>()
    if (!collab) return null
    userRole = collab.role
  }

  // Load collaborators
  const collaborators = (
    await database
      .prepare(
        `SELECT identity_id as identityId, email, role, invited_by as invitedBy, created_at as createdAt
         FROM customer_recurring_list_collaborators WHERE list_id = ? ORDER BY created_at ASC`
      )
      .bind(listId)
      .all<{ identityId: string; email: string; role: 'editor' | 'viewer'; invitedBy: string; createdAt: string }>()
  ).results

  // Load items
  const items = (
    await database
      .prepare(
        `SELECT i.variant_id as variantId, i.quantity, i.expected_unit_gross_cents as expectedUnitGrossCents,
                v.sku, p.name as productName, v.price_gross_cents as currentGrossCents
         FROM customer_recurring_list_items i
         JOIN variants v ON v.id = i.variant_id
         JOIN products p ON p.id = v.product_id
         WHERE i.list_id = ? ORDER BY i.created_at ASC`
      )
      .bind(listId)
      .all<{
        variantId: string
        quantity: number
        expectedUnitGrossCents: number | null
        sku: string
        productName: string
        currentGrossCents: number
      }>()
  ).results

  return {
    id: list.id,
    customerId: list.customer_id,
    ownerIdentityId: list.owner_identity_id,
    name: list.name,
    description: list.description,
    frequency: list.frequency,
    frequencyDays: list.frequency_days,
    nextSuggestedDate: list.next_suggested_date,
    lastReplenishedAt: list.last_replenished_at,
    status: list.status,
    version: list.version,
    createdAt: list.created_at,
    updatedAt: list.updated_at,
    isOwner,
    userRole,
    collaborators,
    items
  }
}

export async function listCustomerRecurringLists(
  database: D1Database,
  customerId: string,
  requesterIdentityId: string
) {
  // Lists where user is owner OR collaborator
  const rows = (
    await database
      .prepare(
        `SELECT l.*,
          CASE WHEN l.owner_identity_id = ?2 THEN 1 ELSE 0 END as is_owner,
          COALESCE(c.role, CASE WHEN l.owner_identity_id = ?2 THEN 'owner' ELSE NULL END) as user_role,
          (SELECT COUNT(*) FROM customer_recurring_list_items WHERE list_id = l.id) as item_count
         FROM customer_recurring_lists l
         LEFT JOIN customer_recurring_list_collaborators c ON c.list_id = l.id AND c.identity_id = ?2
         WHERE (l.customer_id = ?1 AND l.owner_identity_id = ?2) OR c.identity_id = ?2
         ORDER BY l.status = 'active' DESC, l.created_at DESC`
      )
      .bind(customerId, requesterIdentityId)
      .all<{
        id: string
        customer_id: string
        name: string
        description: string | null
        frequency: RecurringFrequency
        frequency_days: number | null
        next_suggested_date: string | null
        last_replenished_at: string | null
        status: 'active' | 'paused' | 'archived'
        version: number
        created_at: string
        updated_at: string
        is_owner: number
        user_role: string
        item_count: number
      }>()
  ).results

  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    name: r.name,
    description: r.description,
    frequency: r.frequency,
    frequencyDays: r.frequency_days,
    nextSuggestedDate: r.next_suggested_date,
    lastReplenishedAt: r.last_replenished_at,
    status: r.status,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    isOwner: Boolean(r.is_owner),
    userRole: r.user_role,
    itemCount: r.item_count
  }))
}

export async function updateRecurringList(database: D1Database, params: UpdateRecurringListParams) {
  const validated = recurringListUpdateInputSchema.parse({
    name: params.name,
    description: params.description,
    frequency: params.frequency,
    frequencyDays: params.frequencyDays,
    nextSuggestedDate: params.nextSuggestedDate,
    status: params.status,
    expectedVersion: params.expectedVersion
  })
  const current = await database
    .prepare(`SELECT * FROM customer_recurring_lists WHERE id = ?`)
    .bind(params.listId)
    .first<{
      id: string
      customer_id: string
      owner_identity_id: string
      name: string
      description: string | null
      frequency: RecurringFrequency
      frequency_days: number | null
      next_suggested_date: string | null
      status: string
      version: number
    }>()

  if (!current) throw new Error('recurring_list_not_found')
  if (current.owner_identity_id !== params.requesterIdentityId) {
    throw new Error('unauthorized_only_owner_can_update')
  }

  if (current.version !== validated.expectedVersion) {
    throw new Error('version_conflict')
  }

  const now = canonicalNow()
  const newName = validated.name ?? current.name
  const newDesc = validated.description !== undefined ? validated.description : current.description
  const newFreq = validated.frequency ?? current.frequency
  const newFreqDays = validated.frequencyDays !== undefined ? validated.frequencyDays : current.frequency_days
  const newNextDate = validated.nextSuggestedDate !== undefined ? validated.nextSuggestedDate : current.next_suggested_date
  const newStatus = validated.status ?? current.status
  const nextVersion = current.version + 1

  await database
    .prepare(
      `UPDATE customer_recurring_lists
       SET name = ?, description = ?, frequency = ?, frequency_days = ?, next_suggested_date = ?,
           status = ?, version = ?, updated_at = ?
       WHERE id = ? AND version = ?`
    )
    .bind(
      newName,
      newDesc,
      newFreq,
      newFreqDays,
      newNextDate,
      newStatus,
      nextVersion,
      now,
      params.listId,
      current.version
    )
    .run()

  return {
    id: params.listId,
    name: newName,
    description: newDesc,
    frequency: newFreq,
    frequencyDays: newFreqDays,
    nextSuggestedDate: newNextDate,
    status: newStatus,
    version: nextVersion,
    updatedAt: now
  }
}

export async function deleteRecurringList(
  database: D1Database,
  params: { listId: string; requesterIdentityId: string }
) {
  const current = await database
    .prepare(`SELECT owner_identity_id FROM customer_recurring_lists WHERE id = ?`)
    .bind(params.listId)
    .first<{ owner_identity_id: string }>()

  if (!current) throw new Error('recurring_list_not_found')
  if (current.owner_identity_id !== params.requesterIdentityId) {
    throw new Error('unauthorized_only_owner_can_delete')
  }

  await database.prepare(`DELETE FROM customer_recurring_lists WHERE id = ?`).bind(params.listId).run()
  return { ok: true }
}

export async function inviteCollaborator(database: D1Database, params: InviteCollaboratorParams) {
  const validated = recurringListCollaboratorInviteInputSchema.parse({
    email: params.email,
    role: params.role
  })
  const list = await database
    .prepare(`SELECT owner_identity_id FROM customer_recurring_lists WHERE id = ?`)
    .bind(params.listId)
    .first<{ owner_identity_id: string }>()

  if (!list) throw new Error('recurring_list_not_found')
  if (list.owner_identity_id !== params.requesterIdentityId) {
    throw new Error('unauthorized_only_owner_can_manage_collaborators')
  }

  // Find identity by email
  const target = await database
    .prepare(`SELECT id, customer_id FROM identities WHERE email = ?`)
    .bind(validated.email)
    .first<{ id: string; customer_id: string }>()

  if (!target) throw new Error('target_identity_not_found')

  const now = canonicalNow()
  await database
    .prepare(
      `INSERT INTO customer_recurring_list_collaborators(list_id, identity_id, email, role, invited_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(list_id, identity_id) DO UPDATE SET role = excluded.role`
    )
    .bind(params.listId, target.id, validated.email, validated.role, params.requesterIdentityId, now)
    .run()

  return {
    listId: params.listId,
    identityId: target.id,
    email: validated.email,
    role: validated.role,
    createdAt: now
  }
}

export async function removeCollaborator(database: D1Database, params: RemoveCollaboratorParams) {
  const list = await database
    .prepare(`SELECT owner_identity_id FROM customer_recurring_lists WHERE id = ?`)
    .bind(params.listId)
    .first<{ owner_identity_id: string }>()

  if (!list) throw new Error('recurring_list_not_found')
  if (list.owner_identity_id !== params.requesterIdentityId && params.requesterIdentityId !== params.collaboratorIdentityId) {
    throw new Error('unauthorized')
  }

  await database
    .prepare(`DELETE FROM customer_recurring_list_collaborators WHERE list_id = ? AND identity_id = ?`)
    .bind(params.listId, params.collaboratorIdentityId)
    .run()

  return { ok: true }
}

export async function setRecurringListItem(database: D1Database, params: SetRecurringListItemParams) {
  const validated = recurringListItemSetInputSchema.parse({
    variantId: params.variantId,
    quantity: params.quantity,
    expectedUnitGrossCents: params.expectedUnitGrossCents
  })
  const list = await database
    .prepare(`SELECT owner_identity_id FROM customer_recurring_lists WHERE id = ?`)
    .bind(params.listId)
    .first<{ owner_identity_id: string }>()

  if (!list) throw new Error('recurring_list_not_found')

  // Check role: owner or editor
  if (list.owner_identity_id !== params.requesterIdentityId) {
    const collab = await database
      .prepare(`SELECT role FROM customer_recurring_list_collaborators WHERE list_id = ? AND identity_id = ?`)
      .bind(params.listId, params.requesterIdentityId)
      .first<{ role: string }>()
    if (!collab || collab.role !== 'editor') {
      throw new Error('forbidden_role_viewer_cannot_modify')
    }
  }

  const now = canonicalNow()
  await database
    .prepare(
      `INSERT INTO customer_recurring_list_items(list_id, variant_id, quantity, expected_unit_gross_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(list_id, variant_id) DO UPDATE SET
         quantity = excluded.quantity,
         expected_unit_gross_cents = COALESCE(excluded.expected_unit_gross_cents, customer_recurring_list_items.expected_unit_gross_cents),
         updated_at = excluded.updated_at`
    )
    .bind(
      params.listId,
      validated.variantId,
      validated.quantity,
      validated.expectedUnitGrossCents ?? null,
      now,
      now
    )
    .run()

  return {
    listId: params.listId,
    variantId: validated.variantId,
    quantity: validated.quantity,
    expectedUnitGrossCents: validated.expectedUnitGrossCents ?? null,
    updatedAt: now
  }
}

export async function removeRecurringListItem(database: D1Database, params: RemoveRecurringListItemParams) {
  const list = await database
    .prepare(`SELECT owner_identity_id FROM customer_recurring_lists WHERE id = ?`)
    .bind(params.listId)
    .first<{ owner_identity_id: string }>()

  if (!list) throw new Error('recurring_list_not_found')

  if (list.owner_identity_id !== params.requesterIdentityId) {
    const collab = await database
      .prepare(`SELECT role FROM customer_recurring_list_collaborators WHERE list_id = ? AND identity_id = ?`)
      .bind(params.listId, params.requesterIdentityId)
      .first<{ role: string }>()
    if (!collab || collab.role !== 'editor') {
      throw new Error('forbidden_role_viewer_cannot_modify')
    }
  }

  await database
    .prepare(`DELETE FROM customer_recurring_list_items WHERE list_id = ? AND variant_id = ?`)
    .bind(params.listId, params.variantId)
    .run()

  return { ok: true }
}

export async function revalidateRecurringListAssortment(
  database: D1Database,
  params: RevalidateAssortmentParams
): Promise<RecurringListRevalidationReport> {
  const now = canonicalNow(params.now)
  const list = await database
    .prepare(`SELECT id, name, frequency, next_suggested_date FROM customer_recurring_lists WHERE id = ?`)
    .bind(params.listId)
    .first<{ id: string; name: string; frequency: RecurringFrequency; next_suggested_date: string | null }>()

  if (!list) throw new Error('recurring_list_not_found')

  // Query each item joining publication, variant status, prices and inventory
  const sql = `
    SELECT
      i.variant_id AS variantId,
      i.quantity AS requestedQuantity,
      i.expected_unit_gross_cents AS expectedUnitGrossCents,
      v.sku,
      p.name AS productName,
      v.price_gross_cents AS baselineGrossCents,
      CASE WHEN v.status = 'published' AND p.status = 'published' AND c.status = 'published'
        AND ${publicationValidityExpression('p')}
        THEN 1 ELSE 0 END AS isPublished,
      COALESCE((SELECT TOTAL(${sellableExpression()}) FROM inventory_balances b WHERE b.variant_id = v.id), 0) AS sellableStock
    FROM customer_recurring_list_items i
    LEFT JOIN variants v ON v.id = i.variant_id
    LEFT JOIN products p ON p.id = v.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE i.list_id = ?
    ORDER BY i.created_at ASC
  `

  const rows = (
    await database
      .prepare(sql)
      .bind(params.listId)
      .all<{
        variantId: string
        requestedQuantity: number
        expectedUnitGrossCents: number | null
        sku: string | null
        productName: string | null
        baselineGrossCents: number | null
        isPublished: number | null
        sellableStock: number
      }>()
  ).results

  const items: RecurringListItemRevalidated[] = []
  let allAvailable = true
  let availableCount = 0
  let unavailableCount = 0
  let priceChangedCount = 0
  let totalCurrentGrossCents = 0
  let totalExpectedGrossCents = 0

  for (const row of rows) {
    const isPub = Boolean(row.isPublished)
    const sellable = row.sellableStock ?? 0
    const hasStock = sellable >= row.requestedQuantity
    const baselinePrice = row.baselineGrossCents ?? 0
    const effectivePrice = baselinePrice // Or B2B if configured
    const expectedPrice = row.expectedUnitGrossCents ?? effectivePrice
    const priceVariance = effectivePrice - expectedPrice

    let available = true
    let reason: 'unpublished' | 'out_of_stock' | 'price_changed' | null = null

    if (!isPub || !row.sku) {
      available = false
      reason = 'unpublished'
    } else if (!hasStock) {
      available = false
      reason = 'out_of_stock'
    } else if (priceVariance !== 0) {
      priceChangedCount++
      // Still available, but price changed
      reason = 'price_changed'
    }

    if (available && reason !== 'price_changed') {
      availableCount++
    } else if (!available) {
      unavailableCount++
      allAvailable = false
    } else {
      availableCount++
    }

    totalCurrentGrossCents += effectivePrice * row.requestedQuantity
    totalExpectedGrossCents += expectedPrice * row.requestedQuantity

    items.push({
      variantId: row.variantId,
      sku: row.sku ?? 'UNKNOWN',
      name: row.productName ?? 'Desconocido',
      quantity: row.requestedQuantity,
      available,
      reason,
      baselinePriceCents: baselinePrice,
      effectivePriceCents: effectivePrice,
      priceVarianceCents: priceVariance,
      sellableStock: sellable
    })
  }

  return {
    listId: list.id,
    listName: list.name,
    frequency: list.frequency,
    nextSuggestedDate: list.next_suggested_date,
    allAvailable,
    itemCount: items.length,
    availableCount,
    unavailableCount,
    priceChangedCount,
    totalCurrentGrossCents,
    totalExpectedGrossCents,
    totalVarianceCents: totalCurrentGrossCents - totalExpectedGrossCents,
    items
  }
}

export async function recordListReplenishment(database: D1Database, params: RecordReplenishmentParams) {
  const now = canonicalNow(params.replenishedAt)
  const list = await database
    .prepare(`SELECT id, frequency, frequency_days FROM customer_recurring_lists WHERE id = ?`)
    .bind(params.listId)
    .first<{ id: string; frequency: RecurringFrequency; frequency_days: number | null }>()

  if (!list) throw new Error('recurring_list_not_found')

  const nextSuggested = calculateNextDate(now, list.frequency, list.frequency_days)

  await database
    .prepare(
      `UPDATE customer_recurring_lists
       SET last_replenished_at = ?, next_suggested_date = ?, version = version + 1, updated_at = ?
       WHERE id = ?`
    )
    .bind(now, nextSuggested, now, params.listId)
    .run()

  return {
    listId: params.listId,
    lastReplenishedAt: now,
    nextSuggestedDate: nextSuggested
  }
}
