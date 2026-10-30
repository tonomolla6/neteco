import { readFile } from 'node:fs/promises'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { executeHighValueConsent } from '../../workers/communications/high-value-consent'
import { recordWhatsAppState, simulateWhatsAppMessage } from '../../workers/communications/whatsapp-business'
let f: Awaited<ReturnType<typeof returnsFixture>>
const key = '11111111-1111-4111-8111-111111111111',
  second = '22222222-2222-4222-8222-222222222222',
  third = '33333333-3333-4333-8333-333333333333',
  fourth = '44444444-4444-4444-8444-444444444444',
  eventId = '55555555-5555-4555-8555-555555555555'
const opts = () => ({
  now: () => utc(),
  transport: 'official-fake' as const,
  pricing: { whatsappCostMinor: 7, dailyBudgetMinor: 20 }
})
const message = { eventId, event: 'recall', consentVersion: 1, stateVersion: 1 } as const
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql', 'utf8'))
})
afterEach(() => f?.sqlite.close())
const grant = () =>
  executeHighValueConsent(
    f.database,
    CLAIMS,
    CUSTOMER,
    key,
    { channel: 'whatsapp', expectedVersion: 0, action: 'grant', proof: 'case-whatsapp-123' },
    opts()
  )
const state = (id: string, raw: unknown, claims = CLAIMS) =>
  recordWhatsAppState(f.database, claims, CUSTOMER, id, raw, opts())
const send = (raw: unknown = message, id = third, claims = CLAIMS) =>
  simulateWhatsAppMessage(f.database, claims, CUSTOMER, id, raw, opts())
it('uses an approved matching template outside the conversation window', async () => {
  await grant()
  await state(second, {
    action: 'approve_template',
    expectedVersion: 0,
    event: 'recall',
    templateId: 'recall_v1',
    approvalRef: 'approval-case-123'
  })
  const r = await send()
  expect(r).toMatchObject({
    status: 'simulated',
    channel: 'whatsapp',
    mode: 'template',
    templateId: 'recall_v1',
    costMinor: 7
  })
  expect(await send()).toEqual(r)
})
it('uses session messages only after inbound contact and within its window', async () => {
  await grant()
  await state(second, { action: 'inbound', expectedVersion: 0 })
  expect(await send()).toMatchObject({ status: 'simulated', mode: 'session' })
})
it('requires an approved template when no inbound conversation exists', async () => {
  await grant()
  await state(second, {
    action: 'approve_template',
    expectedVersion: 0,
    event: 'security_alert',
    templateId: 'security_v1',
    approvalRef: 'approval-case-123'
  })
  await expect(send()).rejects.toMatchObject({ code: 'template_required' })
})
it('blocks automation during human handoff and permits resumption only after a command', async () => {
  await grant()
  await state(second, { action: 'inbound', expectedVersion: 0 })
  await state(fourth, { action: 'handoff', expectedVersion: 1 })
  await expect(send({ ...message, stateVersion: 2 })).rejects.toMatchObject({ code: 'human_handoff' })
  await state('66666666-6666-4666-8666-666666666666', { action: 'resume', expectedVersion: 2 })
  expect(await send({ ...message, stateVersion: 3 })).toMatchObject({ status: 'simulated' })
})
it('requires opt-in and checks stale state', async () => {
  await state(second, { action: 'inbound', expectedVersion: 0 })
  await expect(send()).rejects.toMatchObject({ code: 'consent_required' })
  await grant()
  await expect(send({ ...message, stateVersion: 0 })).rejects.toMatchObject({ code: 'conflict' })
})
it('prevents unapproved or unofficial transports', async () => {
  await grant()
  await state(second, { action: 'inbound', expectedVersion: 0 })
  await expect(
    simulateWhatsAppMessage(f.database, CLAIMS, CUSTOMER, third, message, { ...opts(), transport: 'unofficial' })
  ).rejects.toMatchObject({ code: 'delivery_disabled' })
})
it('requires live authority for state and messages', async () => {
  await expect(state(second, { action: 'inbound', expectedVersion: 0 }, BUYER_CLAIMS)).rejects.toMatchObject({
    code: 'mfa_required'
  })
  await grant()
  await state(second, { action: 'inbound', expectedVersion: 0 })
  await expect(send(message, third, BUYER_CLAIMS)).rejects.toMatchObject({ code: 'mfa_required' })
})
it('rejects duplicate command payload changes and stale versions', async () => {
  await state(second, { action: 'inbound', expectedVersion: 0 })
  await expect(state(second, { action: 'handoff', expectedVersion: 0 })).rejects.toMatchObject({ code: 'conflict' })
  await expect(state(third, { action: 'inbound', expectedVersion: 0 })).rejects.toMatchObject({ code: 'conflict' })
})
it.each([
  { action: 'inbound', expectedVersion: 0, occurredAt: '2030-01-01T00:00:00Z' },
  {
    action: 'approve_template',
    expectedVersion: 0,
    event: 'recall',
    templateId: 'http://bad',
    approvalRef: 'approval-case-123'
  },
  { action: 'blast', expectedVersion: 0 }
])('rejects untrusted state %j', async (raw) => {
  await expect(state(second, raw)).rejects.toMatchObject({ code: 'invalid_input' })
})
it('keeps the state journal immutable', async () => {
  await state(second, { action: 'inbound', expectedVersion: 0 })
  expect(() => f.sqlite.exec('DELETE FROM high_value_whatsapp_state')).toThrow()
})
it('closes the conversation window at exactly 24 hours', async () => {
  await grant()
  const now = utc()
  await recordWhatsAppState(
    f.database,
    CLAIMS,
    CUSTOMER,
    second,
    { action: 'inbound', expectedVersion: 0 },
    { ...opts(), now: () => now }
  )
  f.sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?').run(utc(172800000), CLAIMS.sessionId)
  const after = new Date(Date.parse(now) + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await expect(
    simulateWhatsAppMessage(f.database, CLAIMS, CUSTOMER, third, message, { ...opts(), now: () => after })
  ).rejects.toMatchObject({ code: 'template_required' })
})
it('enforces a shared cost budget across channels', async () => {
  await grant()
  await state(second, { action: 'inbound', expectedVersion: 0 })
  const cost = { ...opts(), pricing: { whatsappCostMinor: 7, dailyBudgetMinor: 6 } }
  await expect(simulateWhatsAppMessage(f.database, CLAIMS, CUSTOMER, third, message, cost)).rejects.toMatchObject({
    code: 'budget_exceeded'
  })
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_whatsapp_delivery').get()).toEqual({ n: 0 })
})
it('blocks delivery if handoff is requested concurrently', async () => {
  await grant()
  await state(second, { action: 'inbound', expectedVersion: 0 })
  const batch = f.database.batch.bind(f.database)
  let first = true
  f.database.batch = async (statements) => {
    if (first) {
      first = false
      await state(fourth, { action: 'handoff', expectedVersion: 1 })
    }
    return batch(statements)
  }
  await expect(send()).rejects.toMatchObject({ code: 'conflict' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_whatsapp_delivery').get()).toEqual({ n: 0 })
})
it('blocks delivery if opt-in is revoked concurrently', async () => {
  await grant()
  await state(second, { action: 'inbound', expectedVersion: 0 })
  const batch = f.database.batch.bind(f.database)
  let first = true
  f.database.batch = async (statements) => {
    if (first) {
      first = false
      await executeHighValueConsent(
        f.database,
        CLAIMS,
        CUSTOMER,
        fourth,
        { channel: 'whatsapp', expectedVersion: 1, action: 'revoke', proof: 'case-optout-123' },
        opts()
      )
    }
    return batch(statements)
  }
  await expect(send()).rejects.toMatchObject({ code: 'consent_required' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_whatsapp_delivery').get()).toEqual({ n: 0 })
})
it('uses fixed WhatsApp content without sensitive data or links', async () => {
  await grant()
  await state(second, { action: 'inbound', expectedVersion: 0 })
  const result = await send()
  expect(result.message).toContain('NETECO')
  expect(result.message).not.toMatch(/https?:|www\.|@|\d{5}/i)
})
it('reads simulated WhatsApp state without exposing approval evidence', async () => {
  await state(second, {
    action: 'approve_template',
    expectedVersion: 0,
    event: 'recall',
    templateId: 'recall_v1',
    approvalRef: 'approval-case-123'
  })
  await state(third, { action: 'handoff', expectedVersion: 1 })
  const { readWhatsAppState } = await import('../../workers/communications/whatsapp-business')
  const result = await readWhatsAppState(f.database, CLAIMS, CUSTOMER, opts())
  expect(result).toMatchObject({ version: 2, handoff: true, templates: [{ event: 'recall', templateId: 'recall_v1' }] })
  expect(JSON.stringify(result)).not.toContain('approval-case-123')
  await expect(readWhatsAppState(f.database, BUYER_CLAIMS, CUSTOMER, opts())).rejects.toMatchObject({
    code: 'mfa_required'
  })
})
it('counts SMS simulations in the same daily budget before WhatsApp', async () => {
  const { dispatchHighValueMessage } = await import('../../workers/communications/high-value-delivery')
  await executeHighValueConsent(
    f.database,
    CLAIMS,
    CUSTOMER,
    '77777777-7777-4777-8777-777777777777',
    { channel: 'sms', expectedVersion: 0, action: 'grant', proof: 'case-sms-123' },
    opts()
  )
  await dispatchHighValueMessage(
    f.database,
    CLAIMS,
    CUSTOMER,
    '88888888-8888-4888-8888-888888888888',
    { eventId: '99999999-9999-4999-8999-999999999999', event: 'recall', channel: 'sms', consentVersion: 1 },
    { now: () => utc(), transport: 'local-fake', pricing: { smsCostMinor: 5, dailyBudgetMinor: 10 } }
  )
  await grant()
  await state(second, { action: 'inbound', expectedVersion: 0 })
  await expect(
    simulateWhatsAppMessage(f.database, CLAIMS, CUSTOMER, third, message, {
      ...opts(),
      pricing: { whatsappCostMinor: 7, dailyBudgetMinor: 10 }
    })
  ).rejects.toMatchObject({ code: 'budget_exceeded' })
})
it('counts WhatsApp simulations in the same daily budget before SMS', async () => {
  const { dispatchHighValueMessage } = await import('../../workers/communications/high-value-delivery')
  await grant()
  await state(second, { action: 'inbound', expectedVersion: 0 })
  await send()
  await executeHighValueConsent(
    f.database,
    CLAIMS,
    CUSTOMER,
    '77777777-7777-4777-8777-777777777777',
    { channel: 'sms', expectedVersion: 0, action: 'grant', proof: 'case-sms-123' },
    opts()
  )
  await expect(
    dispatchHighValueMessage(
      f.database,
      CLAIMS,
      CUSTOMER,
      '88888888-8888-4888-8888-888888888888',
      { eventId: '99999999-9999-4999-8999-999999999999', event: 'recall', channel: 'sms', consentVersion: 1 },
      { now: () => utc(), transport: 'local-fake', pricing: { smsCostMinor: 5, dailyBudgetMinor: 10 } }
    )
  ).rejects.toMatchObject({ code: 'budget_exceeded' })
})
