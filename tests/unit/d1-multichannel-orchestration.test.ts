import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { multichannelFixture, CUSTOMER, BUYER_CLAIMS, utc } from './d1-multichannel-fixture'
import {
  orchestrateMultichannelDelivery,
  updateCustomerChannelPreferences,
  readCustomerChannelPreferences,
  type MultichannelTransportAdapters
} from '../../workers/communications/multichannel-orchestrator'
import { deterministicUuid } from '../fixtures/deterministic'

describe('COM-015 Multichannel Priority Orchestration', () => {
  let f: Awaited<ReturnType<typeof multichannelFixture>>
  let sentEmail: Array<{ customerId: string; subject: string; body: string }>
  let sentSms: Array<{ customerId: string; text: string }>
  let sentWhatsApp: Array<{ customerId: string; text: string }>

  const mockTransports: MultichannelTransportAdapters = {
    email: {
      send: async (msg) => {
        sentEmail.push(msg)
        return { success: true, messageId: 'fake-email-' + sentEmail.length }
      }
    },
    sms: {
      send: async (msg) => {
        sentSms.push(msg)
        return { success: true, messageId: 'fake-sms-' + sentSms.length }
      }
    },
    whatsapp: {
      send: async (msg) => {
        sentWhatsApp.push(msg)
        return { success: true, messageId: 'fake-whatsapp-' + sentWhatsApp.length }
      }
    }
  }

  const key = (name: string) => deterministicUuid('multichannel-test-' + name)

  beforeEach(async () => {
    f = await multichannelFixture()
    sentEmail = []
    sentSms = []
    sentWhatsApp = []
  })

  afterEach(() => {
    f.sqlite.close()
  })

  it('dispatches to primary channel in default priority order (whatsapp -> sms -> email)', async () => {
    const result = await orchestrateMultichannelDelivery(
      f.database,
      key('cmd-1'),
      {
        customerId: CUSTOMER,
        dedupKey: 'order-created-1001',
        category: 'pedido',
        eventType: 'order.created',
        title: 'Pedido recibido',
        body: 'Tu pedido 1001 ha sido confirmado.',
        mandatory: false
      },
      { transports: mockTransports, now: () => utc() }
    )

    expect(result.status).toBe('delivered')
    expect(result.selectedChannel).toBe('whatsapp')
    expect(sentWhatsApp).toHaveLength(1)
    expect(sentSms).toHaveLength(0)
    expect(sentEmail).toHaveLength(0)

    // Verify subsequent channels are suppressed to prevent duplicates
    const whatsappResult = result.results.find((r) => r.channel === 'whatsapp')
    const smsResult = result.results.find((r) => r.channel === 'sms')
    const emailResult = result.results.find((r) => r.channel === 'email')

    expect(whatsappResult?.status).toBe('delivered')
    expect(smsResult?.status).toBe('suppressed')
    expect(smsResult?.cause).toBe('delivered_primary_channel')
    expect(emailResult?.status).toBe('suppressed')
    expect(emailResult?.cause).toBe('delivered_primary_channel')
  })

  it('avoids cross-channel duplicates when called with same dedupKey (idempotent)', async () => {
    const input = {
      customerId: CUSTOMER,
      dedupKey: 'invoice-issued-inv-500',
      category: 'factura' as const,
      eventType: 'invoice.issued',
      title: 'Factura disponible',
      body: 'Tu factura INV-500 ya está lista para descargar.',
      mandatory: true
    }

    const first = await orchestrateMultichannelDelivery(f.database, key('cmd-dedup-1'), input, {
      transports: mockTransports,
      now: () => utc()
    })
    expect(first.status).toBe('delivered')
    expect(sentWhatsApp).toHaveLength(1)

    // Repeat with another commandId but identical dedupKey
    const second = await orchestrateMultichannelDelivery(f.database, key('cmd-dedup-2'), input, {
      transports: mockTransports,
      now: () => utc()
    })

    // Should NOT send again on any channel!
    expect(sentWhatsApp).toHaveLength(1)
    expect(sentSms).toHaveLength(0)
    expect(sentEmail).toHaveLength(0)
    expect(second.status).toBe('delivered')
    expect(second.cause).toBe('duplicate_suppressed')
  })

  it('cascades to fallback channel when higher priority channel delivery fails', async () => {
    const failingTransports: MultichannelTransportAdapters = {
      whatsapp: {
        send: async () => ({ success: false, error: 'simulated_provider_down' })
      },
      sms: {
        send: async (msg) => {
          sentSms.push(msg)
          return { success: true, messageId: 'fake-sms-fallback' }
        }
      },
      email: {
        send: async (msg) => {
          sentEmail.push(msg)
          return { success: true, messageId: 'fake-email-fallback' }
        }
      }
    }

    const result = await orchestrateMultichannelDelivery(
      f.database,
      key('cmd-cascade-1'),
      {
        customerId: CUSTOMER,
        dedupKey: 'stock-alert-prod-99',
        category: 'stock',
        eventType: 'stock.back_in_stock',
        title: 'Stock disponible',
        body: 'El producto Químico Pro vuelve a estar disponible.',
        mandatory: false
      },
      { transports: failingTransports, now: () => utc() }
    )

    expect(result.status).toBe('delivered')
    expect(result.selectedChannel).toBe('sms')
    expect(result.cause).toBe('channel_fallback')
    expect(sentSms).toHaveLength(1)
    expect(sentEmail).toHaveLength(0)

    const whatsappResult = result.results.find((r) => r.channel === 'whatsapp')
    const smsResult = result.results.find((r) => r.channel === 'sms')
    const emailResult = result.results.find((r) => r.channel === 'email')

    expect(whatsappResult?.status).toBe('failed')
    expect(smsResult?.status).toBe('delivered')
    expect(emailResult?.status).toBe('suppressed')
    expect(emailResult?.cause).toBe('delivered_primary_channel')
  })

  it('respects customer channel preferences and custom priority order', async () => {
    // Customer sets preferred order: email -> whatsapp, with SMS disabled
    await updateCustomerChannelPreferences(
      f.database,
      BUYER_CLAIMS,
      CUSTOMER,
      key('cmd-pref-1'),
      {
        expectedVersion: 0,
        priorityOrder: ['email', 'whatsapp', 'sms'],
        emailEnabled: true,
        smsEnabled: false,
        whatsappEnabled: true
      },
      { now: () => utc() }
    )

    const prefs = await readCustomerChannelPreferences(f.database, CUSTOMER)
    expect(prefs.priorityOrder).toEqual(['email', 'whatsapp', 'sms'])
    expect(prefs.smsEnabled).toBe(false)
    expect(prefs.version).toBe(1)

    const result = await orchestrateMultichannelDelivery(
      f.database,
      key('cmd-pref-run'),
      {
        customerId: CUSTOMER,
        dedupKey: 'support-ticket-reply-333',
        category: 'soporte',
        eventType: 'support.ticket.reply',
        title: 'Respuesta de soporte',
        body: 'Hemos respondido a tu consulta #333.',
        mandatory: false
      },
      { transports: mockTransports, now: () => utc() }
    )

    expect(result.status).toBe('delivered')
    expect(result.selectedChannel).toBe('email')
    expect(sentEmail).toHaveLength(1)
    expect(sentWhatsApp).toHaveLength(0)
    expect(sentSms).toHaveLength(0)
  })

  it('enforces mandatory communications policy: never suppresses mandatory notices', async () => {
    // Customer disables ALL optional channels
    await updateCustomerChannelPreferences(
      f.database,
      BUYER_CLAIMS,
      CUSTOMER,
      key('cmd-disable-all'),
      {
        expectedVersion: 0,
        priorityOrder: ['whatsapp', 'sms', 'email'],
        emailEnabled: false,
        smsEnabled: false,
        whatsappEnabled: false
      },
      { now: () => utc() }
    )

    // Non-mandatory notification is skipped
    const nonMandatory = await orchestrateMultichannelDelivery(
      f.database,
      key('cmd-non-mandatory'),
      {
        customerId: CUSTOMER,
        dedupKey: 'stock-optional-promo',
        category: 'stock',
        eventType: 'stock.promo',
        title: 'Oferta de stock',
        body: 'Descuento en producto químico',
        mandatory: false
      },
      { transports: mockTransports, now: () => utc() }
    )
    expect(nonMandatory.status).toBe('skipped')
    expect(nonMandatory.cause).toBe('opted_out_all_channels')
    expect(sentEmail).toHaveLength(0)

    // Mandatory notification (e.g. invoice) falls back to mandatory legal email
    const mandatory = await orchestrateMultichannelDelivery(
      f.database,
      key('cmd-mandatory-invoice'),
      {
        customerId: CUSTOMER,
        dedupKey: 'invoice-mandatory-444',
        category: 'factura',
        eventType: 'invoice.issued',
        title: 'Factura oficial emitida',
        body: 'Adjunta factura legal F-2026-00444.',
        mandatory: true
      },
      { transports: mockTransports, now: () => utc() }
    )

    expect(mandatory.status).toBe('delivered')
    expect(mandatory.selectedChannel).toBe('email')
    expect(mandatory.cause).toBe('mandatory_legal_fallback')
    expect(sentEmail).toHaveLength(1)
  })

  it('stores immutable audit trail in multichannel_orchestration_commands', async () => {
    await orchestrateMultichannelDelivery(
      f.database,
      key('cmd-audit-trail'),
      {
        customerId: CUSTOMER,
        dedupKey: 'order-audit-test',
        category: 'pedido',
        eventType: 'order.shipped',
        title: 'Pedido enviado',
        body: 'Tu pedido está en camino.',
        mandatory: false
      },
      { transports: mockTransports, now: () => utc() }
    )

    const row = f.sqlite
      .prepare('SELECT * FROM multichannel_orchestration_commands WHERE dedup_key=?')
      .get('order-audit-test') as Record<string, unknown>

    expect(row).toBeDefined()
    expect(row.customer_id).toBe(CUSTOMER)
    expect(row.category).toBe('pedido')
    expect(row.event_type).toBe('order.shipped')
    expect(row.status).toBe('delivered')
    expect(row.selected_channel).toBe('whatsapp')
    expect(JSON.parse(row.results as string)).toHaveLength(3)

    // Immutability trigger checks
    expect(() => {
      f.sqlite
        .prepare("UPDATE multichannel_orchestration_commands SET status='failed' WHERE dedup_key=?")
        .run('order-audit-test')
    }).toThrow('multichannel_orchestration_immutable')

    expect(() => {
      f.sqlite.prepare('DELETE FROM multichannel_orchestration_commands WHERE dedup_key=?').run('order-audit-test')
    }).toThrow('multichannel_orchestration_immutable')
  })

  it('rejects update preferences on CAS version conflict', async () => {
    await updateCustomerChannelPreferences(
      f.database,
      BUYER_CLAIMS,
      CUSTOMER,
      key('cmd-cas-1'),
      {
        expectedVersion: 0,
        emailEnabled: true,
        smsEnabled: true,
        whatsappEnabled: true
      },
      { now: () => utc() }
    )

    // Stale expectedVersion 0 should fail with conflict
    await expect(
      updateCustomerChannelPreferences(
        f.database,
        BUYER_CLAIMS,
        CUSTOMER,
        key('cmd-cas-conflict'),
        {
          expectedVersion: 0,
          emailEnabled: false
        },
        { now: () => utc() }
      )
    ).rejects.toThrow('conflict')
  })

  it('rejects invalid inputs on orchestrate and preferences update', async () => {
    // Invalid customer UUID
    await expect(
      orchestrateMultichannelDelivery(
        f.database,
        key('cmd-bad-cust'),
        {
          customerId: 'not-a-uuid',
          dedupKey: 'dedup-bad',
          category: 'pedido',
          eventType: 'order.created',
          title: 'T',
          body: 'B'
        },
        { transports: mockTransports, now: () => utc() }
      )
    ).rejects.toThrow('invalid_input')

    // Invalid command UUID
    await expect(
      orchestrateMultichannelDelivery(
        f.database,
        'invalid-uuid',
        {
          customerId: CUSTOMER,
          dedupKey: 'dedup-bad',
          category: 'pedido',
          eventType: 'order.created',
          title: 'T',
          body: 'B'
        },
        { transports: mockTransports, now: () => utc() }
      )
    ).rejects.toThrow('invalid_input')

    // Invalid category
    await expect(
      orchestrateMultichannelDelivery(
        f.database,
        key('cmd-bad-cat'),
        {
          customerId: CUSTOMER,
          dedupKey: 'dedup-bad',
          category: 'invalid_category' as unknown as 'pedido',
          eventType: 'order.created',
          title: 'T',
          body: 'B'
        },
        { transports: mockTransports, now: () => utc() }
      )
    ).rejects.toThrow('invalid_input')

    // Invalid priority order with duplicates
    await expect(
      updateCustomerChannelPreferences(
        f.database,
        BUYER_CLAIMS,
        CUSTOMER,
        key('cmd-bad-priority'),
        {
          expectedVersion: 0,
          priorityOrder: ['email', 'email'] as unknown as ['email']
        },
        { now: () => utc() }
      )
    ).rejects.toThrow('invalid_input')
  })

  it('falls back through multiple failed channels (whatsapp fails -> sms fails -> email succeeds)', async () => {
    const multiFailingTransports: MultichannelTransportAdapters = {
      whatsapp: { send: async () => ({ success: false, error: 'wa_timeout' }) },
      sms: { send: async () => ({ success: false, error: 'sms_rejected' }) },
      email: { send: async () => ({ success: true, messageId: 'email-last-resort' }) }
    }

    const result = await orchestrateMultichannelDelivery(
      f.database,
      key('cmd-double-fail'),
      {
        customerId: CUSTOMER,
        dedupKey: 'multi-fail-1',
        category: 'soporte',
        eventType: 'support.ticket.escalated',
        title: 'Escalado urgente',
        body: 'Tu consulta ha sido escalada.',
        mandatory: false
      },
      { transports: multiFailingTransports, now: () => utc() }
    )

    expect(result.status).toBe('delivered')
    expect(result.selectedChannel).toBe('email')
    expect(result.cause).toBe('channel_fallback')
    expect(result.results).toHaveLength(3)
    expect(result.results[0].status).toBe('failed')
    expect(result.results[1].status).toBe('failed')
    expect(result.results[2].status).toBe('delivered')
  })

  it('handles inAppCenter: false without creating an in-app notification', async () => {
    const result = await orchestrateMultichannelDelivery(
      f.database,
      key('cmd-no-in-app'),
      {
        customerId: CUSTOMER,
        dedupKey: 'no-in-app-1',
        category: 'stock',
        eventType: 'stock.alert',
        title: 'Alerta sin in-app',
        body: 'Mensaje directo',
        inAppCenter: false
      },
      { transports: mockTransports, now: () => utc() }
    )

    expect(result.status).toBe('delivered')
    expect(result.inAppNotificationId).toBeNull()

    const notif = f.sqlite.prepare('SELECT * FROM customer_notifications WHERE dedup_key=?').get('no-in-app-1')
    expect(notif).toBeUndefined()
  })

  it('allows overriding channel priority order on a per-dispatch basis', async () => {
    const result = await orchestrateMultichannelDelivery(
      f.database,
      key('cmd-override-order'),
      {
        customerId: CUSTOMER,
        dedupKey: 'override-priority-1',
        category: 'factura',
        eventType: 'invoice.issued',
        title: 'Factura con prioridad personalizada',
        body: 'Envío prioritario por SMS',
        overridePriority: ['sms', 'email', 'whatsapp']
      },
      { transports: mockTransports, now: () => utc() }
    )

    expect(result.status).toBe('delivered')
    expect(result.selectedChannel).toBe('sms')
    expect(sentSms).toHaveLength(1)
    expect(sentWhatsApp).toHaveLength(0)
    expect(sentEmail).toHaveLength(0)
  })
})
