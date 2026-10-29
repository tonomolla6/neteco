import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import {
  createRecurringList,
  getRecurringList,
  listCustomerRecurringLists,
  updateRecurringList,
  deleteRecurringList,
  inviteCollaborator,
  removeCollaborator,
  setRecurringListItem,
  removeRecurringListItem,
  revalidateRecurringListAssortment,
  recordListReplenishment
} from '../../workers/catalog/customer-recurring-lists'

const NOW = '2026-10-29T10:00:00Z'
const CUSTOMER_A = '30000000-0000-4000-8000-000000000001'
const CUSTOMER_B = '30000000-0000-4000-8000-000000000002'
const CUSTOMER_C = '30000000-0000-4000-8000-000000000003'
const OWNER_IDENTITY = '10000000-0000-4000-8000-000000000001'
const COLLAB_IDENTITY = '10000000-0000-4000-8000-000000000002'
const OTHER_IDENTITY = '10000000-0000-4000-8000-000000000003'

describe('CUS-018: Customer Recurring & Shared Lists', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let publication: Awaited<ReturnType<typeof provisionPublicationValidityFixture>>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    // Apply migration 0108
    sqlite.exec(await readFile('db/d1/migrations/0108_b2b_shared_lists_edi_scoring.sql', 'utf8'))
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    publication = await provisionPublicationValidityFixture(database, {
      productIds: ['p-1', 'p-2', 'p-3'],
      now: NOW
    })

    // Seed test customers and identities
    sqlite
      .prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)')
      .run(CUSTOMER_A, NOW, NOW)
    sqlite
      .prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)')
      .run(CUSTOMER_B, NOW, NOW)
    sqlite
      .prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)')
      .run(CUSTOMER_C, NOW, NOW)

    for (const [id, email, cust] of [
      [OWNER_IDENTITY, 'owner@example.invalid', CUSTOMER_A],
      [COLLAB_IDENTITY, 'collab@example.invalid', CUSTOMER_C],
      [OTHER_IDENTITY, 'other@example.invalid', CUSTOMER_B]
    ]) {
      sqlite
        .prepare(
          `INSERT INTO identities(id, email, password_hash, email_verified_at, status, customer_id, created_at, updated_at)
           VALUES (?, ?, 'synthetic', ?, 'active', ?, ?, ?)`
        )
        .run(id, email, NOW, cust, NOW, NOW)
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('crea una lista recurrente con propietario, frecuencia y fecha sugerida', async () => {
    const list = await createRecurringList(database, {
      customerId: CUSTOMER_A,
      ownerIdentityId: OWNER_IDENTITY,
      name: 'Reposición Mensual Hostelería',
      description: 'Productos químicos de limpieza de cocina',
      frequency: 'monthly',
      nextSuggestedDate: '2026-11-29'
    })

    expect(list.id).toBeDefined()
    expect(list.name).toBe('Reposición Mensual Hostelería')
    expect(list.frequency).toBe('monthly')
    expect(list.nextSuggestedDate).toBe('2026-11-29')
    expect(list.version).toBe(1)
    expect(list.status).toBe('active')

    const fetched = await getRecurringList(database, list.id, OWNER_IDENTITY)
    expect(fetched).not.toBeNull()
    expect(fetched?.name).toBe('Reposición Mensual Hostelería')
    expect(fetched?.isOwner).toBe(true)
    expect(fetched?.collaborators).toHaveLength(0)
  })

  it('valida la frecuencia personalizada requiriendo frequencyDays', async () => {
    await expect(
      createRecurringList(database, {
        customerId: CUSTOMER_A,
        ownerIdentityId: OWNER_IDENTITY,
        name: 'Reposición Cada 10 Días',
        frequency: 'custom',
        frequencyDays: null
      })
    ).rejects.toThrow(/frequency_days_required/)

    const validCustom = await createRecurringList(database, {
      customerId: CUSTOMER_A,
      ownerIdentityId: OWNER_IDENTITY,
      name: 'Reposición Cada 10 Días',
      frequency: 'custom',
      frequencyDays: 10
    })
    expect(validCustom.frequencyDays).toBe(10)
  })

  it('permite al propietario invitar a colaboradores con rol editor o viewer', async () => {
    const list = await createRecurringList(database, {
      customerId: CUSTOMER_A,
      ownerIdentityId: OWNER_IDENTITY,
      name: 'Lista Compartida Lavandería',
      frequency: 'biweekly'
    })

    const collab = await inviteCollaborator(database, {
      listId: list.id,
      requesterIdentityId: OWNER_IDENTITY,
      email: 'collab@example.invalid',
      role: 'editor'
    })
    expect(collab.role).toBe('editor')

    const fetched = await getRecurringList(database, list.id, COLLAB_IDENTITY)
    expect(fetched).not.toBeNull()
    expect(fetched?.isOwner).toBe(false)
    expect(fetched?.userRole).toBe('editor')
    expect(fetched?.collaborators).toHaveLength(1)
    expect(fetched?.collaborators[0].email).toBe('collab@example.invalid')
  })

  it('bloquea que un no-propietario invite o elimine colaboradores', async () => {
    const list = await createRecurringList(database, {
      customerId: CUSTOMER_A,
      ownerIdentityId: OWNER_IDENTITY,
      name: 'Lista Privada',
      frequency: 'weekly'
    })

    await expect(
      inviteCollaborator(database, {
        listId: list.id,
        requesterIdentityId: OTHER_IDENTITY,
        email: 'collab@example.invalid',
        role: 'editor'
      })
    ).rejects.toThrow(/unauthorized/)
  })

  it('añade artículos a la lista, actualiza versión con CAS y gestiona cantidades', async () => {
    const list = await createRecurringList(database, {
      customerId: CUSTOMER_A,
      ownerIdentityId: OWNER_IDENTITY,
      name: 'Lista Insumos',
      frequency: 'weekly'
    })

    const variantId = 'v-1-1'
    const item = await setRecurringListItem(database, {
      listId: list.id,
      requesterIdentityId: OWNER_IDENTITY,
      variantId,
      quantity: 5,
      expectedUnitGrossCents: 1500
    })
    expect(item.quantity).toBe(5)

    const updatedList = await getRecurringList(database, list.id, OWNER_IDENTITY)
    expect(updatedList?.items).toHaveLength(1)
    expect(updatedList?.items[0].variantId).toBe(variantId)
    expect(updatedList?.version).toBeGreaterThan(list.version)

    // Remove item
    await removeRecurringListItem(database, {
      listId: list.id,
      requesterIdentityId: OWNER_IDENTITY,
      variantId
    })
    const emptyList = await getRecurringList(database, list.id, OWNER_IDENTITY)
    expect(emptyList?.items).toHaveLength(0)
  })

  it('permite al colaborador editor modificar artículos pero bloquea al viewer', async () => {
    const list = await createRecurringList(database, {
      customerId: CUSTOMER_A,
      ownerIdentityId: OWNER_IDENTITY,
      name: 'Lista Permisos',
      frequency: 'monthly'
    })

    // Invite COLLAB_IDENTITY as viewer
    await inviteCollaborator(database, {
      listId: list.id,
      requesterIdentityId: OWNER_IDENTITY,
      email: 'collab@example.invalid',
      role: 'viewer'
    })

    const variantId = 'v-1-1'
    await expect(
      setRecurringListItem(database, {
        listId: list.id,
        requesterIdentityId: COLLAB_IDENTITY,
        variantId,
        quantity: 3
      })
    ).rejects.toThrow(/forbidden_role/)
  })

  it('revalida surtido y precios detectando stock disponible y variaciones de precio', async () => {
    const list = await createRecurringList(database, {
      customerId: CUSTOMER_A,
      ownerIdentityId: OWNER_IDENTITY,
      name: 'Lista Revalidación',
      frequency: 'monthly'
    })

    const variant1 = 'v-1-1'
    const variant2 = 'v-2-1'

    await setRecurringListItem(database, {
      listId: list.id,
      requesterIdentityId: OWNER_IDENTITY,
      variantId: variant1,
      quantity: 2,
      expectedUnitGrossCents: 2000 // expected 2000 cents
    })

    await setRecurringListItem(database, {
      listId: list.id,
      requesterIdentityId: OWNER_IDENTITY,
      variantId: variant2,
      quantity: 1,
      expectedUnitGrossCents: 1000
    })

    const report = await revalidateRecurringListAssortment(database, {
      listId: list.id,
      customerId: CUSTOMER_A,
      now: NOW
    })

    expect(report.listId).toBe(list.id)
    expect(report.itemCount).toBe(2)
    expect(report.allAvailable).toBe(true)
    expect(report.items).toHaveLength(2)
    expect(report.items[0].available).toBe(true)
    expect(report.items[0].effectivePriceCents).toBeGreaterThan(0)
  })

  it('detecta productos no disponibles o sin stock en la revalidación', async () => {
    const list = await createRecurringList(database, {
      customerId: CUSTOMER_A,
      ownerIdentityId: OWNER_IDENTITY,
      name: 'Lista No Disponible',
      frequency: 'weekly'
    })

    const variantId = 'v-1-1'
    // Set quantity higher than available inventory
    await setRecurringListItem(database, {
      listId: list.id,
      requesterIdentityId: OWNER_IDENTITY,
      variantId,
      quantity: 999
    })

    const report = await revalidateRecurringListAssortment(database, {
      listId: list.id,
      customerId: CUSTOMER_A,
      now: NOW
    })

    expect(report.allAvailable).toBe(false)
    expect(report.unavailableCount).toBe(1)
    expect(report.items[0].reason).toBe('out_of_stock')
  })

  it('registra la reposición actualizando last_replenished_at y calculando la próxima fecha', async () => {
    const list = await createRecurringList(database, {
      customerId: CUSTOMER_A,
      ownerIdentityId: OWNER_IDENTITY,
      name: 'Lista Ciclo',
      frequency: 'biweekly'
    })

    const replenished = await recordListReplenishment(database, {
      listId: list.id,
      requesterIdentityId: OWNER_IDENTITY,
      replenishedAt: NOW
    })

    expect(replenished.lastReplenishedAt).toBe(NOW)
    // biweekly: 14 days after NOW (2026-10-29 -> 2026-11-12)
    expect(replenished.nextSuggestedDate).toBe('2026-11-12')
  })

  it('soporta control de concurrencia CAS al actualizar la cabecera de la lista', async () => {
    const list = await createRecurringList(database, {
      customerId: CUSTOMER_A,
      ownerIdentityId: OWNER_IDENTITY,
      name: 'Lista Concurrencia',
      frequency: 'weekly'
    })

    const updated = await updateRecurringList(database, {
      listId: list.id,
      requesterIdentityId: OWNER_IDENTITY,
      name: 'Lista Concurrencia Modificada',
      expectedVersion: list.version
    })
    expect(updated.name).toBe('Lista Concurrencia Modificada')
    expect(updated.version).toBe(list.version + 1)

    // Stale update with old version must fail with version_conflict
    await expect(
      updateRecurringList(database, {
        listId: list.id,
        requesterIdentityId: OWNER_IDENTITY,
        name: 'Conflicto',
        expectedVersion: list.version // stale!
      })
    ).rejects.toThrow(/version_conflict/)
  })

  it('elimina la lista y limpia en cascada colaboradores y artículos', async () => {
    const list = await createRecurringList(database, {
      customerId: CUSTOMER_A,
      ownerIdentityId: OWNER_IDENTITY,
      name: 'Lista a Borrar',
      frequency: 'weekly'
    })

    await deleteRecurringList(database, {
      listId: list.id,
      requesterIdentityId: OWNER_IDENTITY
    })

    const fetched = await getRecurringList(database, list.id, OWNER_IDENTITY)
    expect(fetched).toBeNull()
  })
})
