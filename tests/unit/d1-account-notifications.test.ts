import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { multichannelFixture, CUSTOMER, BUYER_CLAIMS, OTHER_BUYER_CLAIMS, utc } from './d1-multichannel-fixture'
import {
  createAccountNotification,
  listAccountNotifications,
  markAccountNotificationsRead,
  getAccountNotificationSummary
} from '../../workers/communications/account-notifications'
import { deterministicUuid } from '../fixtures/deterministic'

describe('COM-016 Account Notification Center', () => {
  let f: Awaited<ReturnType<typeof multichannelFixture>>
  const key = (name: string) => deterministicUuid('notifications-test-' + name)

  beforeEach(async () => {
    f = await multichannelFixture()
  })

  afterEach(() => {
    f.sqlite.close()
  })

  it('creates and categorizes events for pedido, factura, stock, and soporte', async () => {
    const categories = ['pedido', 'factura', 'stock', 'soporte'] as const
    for (const cat of categories) {
      const item = await createAccountNotification(
        f.database,
        key(`notif-${cat}`),
        {
          customerId: CUSTOMER,
          category: cat,
          title: `Aviso de ${cat}`,
          body: `Detalles importantes para ${cat}.`,
          link: `/cuenta/${cat === 'pedido' ? 'pedidos' : cat}`,
          mandatory: cat === 'factura',
          dedupKey: `dedup-${cat}-1`
        },
        { now: () => utc() }
      )
      expect(item.id).toBe(key(`notif-${cat}`))
      expect(item.category).toBe(cat)
      expect(item.read).toBe(false)
      expect(item.readAt).toBeNull()
      if (cat === 'factura') {
        expect(item.mandatory).toBe(true)
      } else {
        expect(item.mandatory).toBe(false)
      }
    }

    // List all
    const all = await listAccountNotifications(f.database, BUYER_CLAIMS, {
      category: 'all',
      status: 'all',
      limit: 10,
      offset: 0
    })
    expect(all.total).toBe(4)
    expect(all.items).toHaveLength(4)

    // Filter by category
    const pedidos = await listAccountNotifications(f.database, BUYER_CLAIMS, {
      category: 'pedido',
      status: 'all',
      limit: 10,
      offset: 0
    })
    expect(pedidos.total).toBe(1)
    expect(pedidos.items[0].category).toBe('pedido')

    const facturas = await listAccountNotifications(f.database, BUYER_CLAIMS, {
      category: 'factura',
      status: 'all',
      limit: 10,
      offset: 0
    })
    expect(facturas.total).toBe(1)
    expect(facturas.items[0].mandatory).toBe(true)
  })

  it('marks individual and multiple notifications as read with timestamps', async () => {
    const id1 = key('notif-read-1')
    const id2 = key('notif-read-2')
    const id3 = key('notif-read-3')

    await createAccountNotification(
      f.database,
      id1,
      {
        customerId: CUSTOMER,
        category: 'pedido',
        title: 'Pedido enviado',
        body: 'El pedido #101 va en camino.',
        dedupKey: 'dedup-read-1'
      },
      { now: () => utc() }
    )
    await createAccountNotification(
      f.database,
      id2,
      {
        customerId: CUSTOMER,
        category: 'stock',
        title: 'Stock disponible',
        body: 'Producto disponible.',
        dedupKey: 'dedup-read-2'
      },
      { now: () => utc() }
    )
    await createAccountNotification(
      f.database,
      id3,
      {
        customerId: CUSTOMER,
        category: 'soporte',
        title: 'Ticket resuelto',
        body: 'Tu consulta ha sido resuelta.',
        dedupKey: 'dedup-read-3'
      },
      { now: () => utc() }
    )

    // Mark single notification as read
    const markSingle = await markAccountNotificationsRead(
      f.database,
      BUYER_CLAIMS,
      key('cmd-mark-1'),
      { notificationIds: [id1] },
      { now: () => utc() }
    )
    expect(markSingle.affectedCount).toBe(1)

    // Check read status
    const unread = await listAccountNotifications(f.database, BUYER_CLAIMS, {
      category: 'all',
      status: 'unread',
      limit: 10,
      offset: 0
    })
    expect(unread.total).toBe(2)
    expect(unread.items.map((i) => i.id)).not.toContain(id1)

    // Mark remaining all as read
    const markAll = await markAccountNotificationsRead(
      f.database,
      BUYER_CLAIMS,
      key('cmd-mark-all'),
      { all: true },
      { now: () => utc() }
    )
    expect(markAll.affectedCount).toBe(2)

    const unreadAfter = await listAccountNotifications(f.database, BUYER_CLAIMS, {
      category: 'all',
      status: 'unread',
      limit: 10,
      offset: 0
    })
    expect(unreadAfter.total).toBe(0)

    const readAll = await listAccountNotifications(f.database, BUYER_CLAIMS, {
      category: 'all',
      status: 'read',
      limit: 10,
      offset: 0
    })
    expect(readAll.total).toBe(3)
  })

  it('computes accurate notification summary counts per category', async () => {
    await createAccountNotification(
      f.database,
      key('sum-ped-1'),
      { customerId: CUSTOMER, category: 'pedido', title: 'P1', body: 'B' },
      { now: () => utc() }
    )
    await createAccountNotification(
      f.database,
      key('sum-ped-2'),
      { customerId: CUSTOMER, category: 'pedido', title: 'P2', body: 'B' },
      { now: () => utc() }
    )
    await createAccountNotification(
      f.database,
      key('sum-fac-1'),
      { customerId: CUSTOMER, category: 'factura', title: 'F1', body: 'B', mandatory: true },
      { now: () => utc() }
    )
    await createAccountNotification(
      f.database,
      key('sum-sop-1'),
      { customerId: CUSTOMER, category: 'soporte', title: 'S1', body: 'B' },
      { now: () => utc() }
    )

    // Initially all 4 unread
    let summary = await getAccountNotificationSummary(f.database, BUYER_CLAIMS)
    expect(summary.total).toBe(4)
    expect(summary.unread).toBe(4)
    expect(summary.byCategory.pedido.unread).toBe(2)
    expect(summary.byCategory.factura.unread).toBe(1)
    expect(summary.byCategory.stock.unread).toBe(0)
    expect(summary.byCategory.soporte.unread).toBe(1)

    // Mark one pedido as read
    await markAccountNotificationsRead(
      f.database,
      BUYER_CLAIMS,
      key('cmd-sum-mark'),
      { notificationIds: [key('sum-ped-1')] },
      { now: () => utc() }
    )

    summary = await getAccountNotificationSummary(f.database, BUYER_CLAIMS)
    expect(summary.total).toBe(4)
    expect(summary.unread).toBe(3)
    expect(summary.byCategory.pedido.unread).toBe(1)
    expect(summary.byCategory.pedido.total).toBe(2)
  })

  it('strictly enforces customer isolation and authorization boundary', async () => {
    // Notification belongs to CUSTOMER
    const notifId = key('isolated-notif')
    await createAccountNotification(
      f.database,
      notifId,
      {
        customerId: CUSTOMER,
        category: 'pedido',
        title: 'Pedido privado',
        body: 'Datos privados de cliente'
      },
      { now: () => utc() }
    )

    // Other customer attempts to list
    const otherList = await listAccountNotifications(f.database, OTHER_BUYER_CLAIMS, {
      category: 'all',
      status: 'all',
      limit: 10,
      offset: 0
    })
    expect(otherList.total).toBe(0)
    expect(otherList.items).toHaveLength(0)

    // Other customer attempts to mark as read
    const result = await markAccountNotificationsRead(
      f.database,
      OTHER_BUYER_CLAIMS,
      key('cmd-cross-tenant'),
      { notificationIds: [notifId] },
      { now: () => utc() }
    )
    // Should NOT affect another customer's notification
    expect(result.affectedCount).toBe(0)

    // Verify it is still unread for rightful owner
    const ownerList = await listAccountNotifications(f.database, BUYER_CLAIMS, {
      category: 'all',
      status: 'unread',
      limit: 10,
      offset: 0
    })
    expect(ownerList.total).toBe(1)
    expect(ownerList.items[0].read).toBe(false)
  })

  it('guarantees notification commands are append-only and immutable', async () => {
    const notifId = key('immutability-test-notif')
    await createAccountNotification(
      f.database,
      notifId,
      {
        customerId: CUSTOMER,
        category: 'stock',
        title: 'Stock test',
        body: 'Stock body'
      },
      { now: () => utc() }
    )

    const cmdId = key('cmd-immutable-record')
    await markAccountNotificationsRead(
      f.database,
      BUYER_CLAIMS,
      cmdId,
      { notificationIds: [notifId] },
      { now: () => utc() }
    )

    expect(() => {
      f.sqlite.prepare("UPDATE customer_notification_commands SET action='modified' WHERE command_id=?").run(cmdId)
    }).toThrow('customer_notification_commands_immutable')

    expect(() => {
      f.sqlite.prepare('DELETE FROM customer_notification_commands WHERE command_id=?').run(cmdId)
    }).toThrow('customer_notification_commands_immutable')
  })

  it('rejects invalid inputs on create, list and mark read', async () => {
    // Bad notification ID
    await expect(
      createAccountNotification(
        f.database,
        'not-a-uuid',
        { customerId: CUSTOMER, category: 'pedido', title: 'T', body: 'B' },
        { now: () => utc() }
      )
    ).rejects.toThrow('invalid_input')

    // Empty title
    await expect(
      createAccountNotification(
        f.database,
        key('bad-title'),
        { customerId: CUSTOMER, category: 'pedido', title: '', body: 'B' },
        { now: () => utc() }
      )
    ).rejects.toThrow('invalid_input')

    // Exceeded title length (> 200 chars)
    await expect(
      createAccountNotification(
        f.database,
        key('bad-title-long'),
        { customerId: CUSTOMER, category: 'pedido', title: 'A'.repeat(201), body: 'B' },
        { now: () => utc() }
      )
    ).rejects.toThrow('invalid_input')

    // Mark read without any IDs and all: false
    await expect(
      markAccountNotificationsRead(
        f.database,
        BUYER_CLAIMS,
        key('cmd-empty-mark'),
        { notificationIds: [] },
        { now: () => utc() }
      )
    ).rejects.toThrow('invalid_input')

    // Mark read without session
    await expect(
      markAccountNotificationsRead(f.database, null, key('cmd-no-session'), { all: true }, { now: () => utc() })
    ).rejects.toThrow('unauthenticated')
  })

  it('handles pagination boundary cases correctly (offset beyond total, small limit)', async () => {
    await createAccountNotification(
      f.database,
      key('page-1'),
      { customerId: CUSTOMER, category: 'pedido', title: 'Pedido 1', body: 'B1' },
      { now: () => utc() }
    )
    await createAccountNotification(
      f.database,
      key('page-2'),
      { customerId: CUSTOMER, category: 'pedido', title: 'Pedido 2', body: 'B2' },
      { now: () => utc() }
    )

    // Limit 1, offset 0
    const page1 = await listAccountNotifications(f.database, BUYER_CLAIMS, {
      category: 'all',
      status: 'all',
      limit: 1,
      offset: 0
    })
    expect(page1.total).toBe(2)
    expect(page1.items).toHaveLength(1)

    // Offset beyond total
    const pageBeyond = await listAccountNotifications(f.database, BUYER_CLAIMS, {
      category: 'all',
      status: 'all',
      limit: 10,
      offset: 100
    })
    expect(pageBeyond.total).toBe(2)
    expect(pageBeyond.items).toHaveLength(0)
  })

  it('returns existing notification idempotently on dedup_key collision', async () => {
    const first = await createAccountNotification(
      f.database,
      key('dedup-notif-1'),
      {
        customerId: CUSTOMER,
        category: 'stock',
        title: 'Stock disponible',
        body: 'Vuelve a estar disponible',
        dedupKey: 'dedup-unique-test'
      },
      { now: () => utc() }
    )

    const second = await createAccountNotification(
      f.database,
      key('dedup-notif-2'),
      {
        customerId: CUSTOMER,
        category: 'stock',
        title: 'Stock disponible duplicado',
        body: 'Mismo evento',
        dedupKey: 'dedup-unique-test'
      },
      { now: () => utc() }
    )

    expect(second.id).toBe(first.id)
    expect(second.dedupKey).toBe('dedup-unique-test')
  })
})
