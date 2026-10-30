import { describe, expect, it } from 'vitest'
import { evaluateHighValueMessage } from '../../workers/communications/high-value-messaging-policy'

const now = '2026-10-29T12:00:00Z'
const sms = {
  channel: 'sms',
  event: 'recall',
  consent: true,
  optedOut: false,
  costMinor: 8,
  budgetMinor: 8,
  fallback: 'email',
  now
} as const
const whatsapp = {
  channel: 'whatsapp',
  event: 'recall',
  consent: true,
  optedOut: false,
  costMinor: 8,
  budgetMinor: 8,
  fallback: 'email',
  now,
  provider: 'official',
  template: { id: 'recall_v1', event: 'recall', approved: true },
  lastInboundAt: null,
  handoffRequested: false
} as const

describe('high-value messaging policy', () => {
  it('allows an eligible SMS with fixed content and exact cost', () => {
    expect(evaluateHighValueMessage(sms)).toMatchObject({ outcome: 'send', costMinor: 8, text: expect.any(String) })
  })
  it.each(['recall', 'delivery_exception', 'security_alert'] as const)('allows high-value SMS event %s', (event) => {
    expect(evaluateHighValueMessage({ ...sms, event }).outcome).toBe('send')
  })
  it('uses fixed content without links or customer data', () => {
    const result = evaluateHighValueMessage(sms)
    expect(result.outcome).toBe('send')
    if (result.outcome === 'send') expect(result.text).not.toMatch(/https?:|www\.|@|\d{5}/i)
  })
  it.each([
    [{ consent: false }, 'consent_required'],
    [{ optedOut: true }, 'opted_out'],
    [{ costMinor: 9 }, 'budget_exceeded']
  ])('suppresses SMS with %j', (change, reason) => {
    expect(evaluateHighValueMessage({ ...sms, ...change })).toEqual({ outcome: 'fallback', reason, channel: 'email' })
  })
  it('uses a manual fallback when no email fallback is configured', () => {
    expect(evaluateHighValueMessage({ ...sms, consent: false, fallback: 'manual' })).toEqual({
      outcome: 'fallback',
      reason: 'consent_required',
      channel: 'manual'
    })
  })
  it('allows an approved WhatsApp template outside the conversation window', () => {
    expect(evaluateHighValueMessage(whatsapp)).toMatchObject({
      outcome: 'send',
      mode: 'template',
      templateId: 'recall_v1'
    })
  })
  it('uses a fixed session message within the 24-hour window', () => {
    expect(
      evaluateHighValueMessage({ ...whatsapp, lastInboundAt: '2026-10-28T12:00:01Z', template: null })
    ).toMatchObject({ outcome: 'send', mode: 'session' })
  })
  it('treats the 24-hour boundary as closed', () => {
    expect(
      evaluateHighValueMessage({ ...whatsapp, lastInboundAt: '2026-10-28T12:00:00Z', template: null })
    ).toMatchObject({ outcome: 'fallback', reason: 'template_required' })
  })
  it.each([
    [{ consent: false }, 'consent_required'],
    [{ optedOut: true }, 'opted_out'],
    [{ costMinor: 9 }, 'budget_exceeded'],
    [{ provider: 'unofficial' }, 'provider_not_official'],
    [{ template: null }, 'template_required'],
    [{ template: { id: 'recall_v1', event: 'recall', approved: false } }, 'template_required'],
    [{ handoffRequested: true }, 'human_handoff']
  ])('suppresses WhatsApp with %j', (change, reason) => {
    expect(evaluateHighValueMessage({ ...whatsapp, ...change })).toEqual({
      outcome: 'fallback',
      reason,
      channel: reason === 'human_handoff' ? 'manual' : 'email'
    })
  })
  it('does not use a template approved for a different event', () => {
    expect(
      evaluateHighValueMessage({
        ...whatsapp,
        template: { id: 'security_v1', event: 'security_alert', approved: true }
      })
    ).toMatchObject({ outcome: 'fallback', reason: 'template_required' })
  })
  it('never uses a future inbound event to open a conversation window', () => {
    expect(
      evaluateHighValueMessage({ ...whatsapp, lastInboundAt: '2026-10-29T12:00:01Z', template: null })
    ).toMatchObject({ outcome: 'fallback', reason: 'template_required' })
  })
  it.each([
    { event: 'marketing' },
    { channel: 'email' },
    { costMinor: -1 },
    { costMinor: 1.5 },
    { budgetMinor: -1 },
    { now: 'bad' },
    { now: '2026-02-30T12:00:00Z' },
    { fallback: 'sms' },
    { text: 'personal data' },
    { consent: 'yes' }
  ])('rejects malformed or untrusted input %j', (change) => {
    expect(() => evaluateHighValueMessage({ ...sms, ...change })).toThrow('invalid_input')
  })
  it.each([
    { template: { id: 'bad link https://example.com', event: 'recall', approved: true } },
    { lastInboundAt: 'not-a-date' },
    { provider: 'unknown' },
    { handoffRequested: 'yes' }
  ])('rejects malformed WhatsApp input %j', (change) => {
    expect(() => evaluateHighValueMessage({ ...whatsapp, ...change })).toThrow('invalid_input')
  })
})
it.each(['recall', 'delivery_exception', 'security_alert'] as const)('uses one ASCII SMS segment for %s', (event) => {
  const result = evaluateHighValueMessage({ ...sms, event })
  expect(result.outcome).toBe('send')
  if (result.outcome === 'send') {
    expect(result.text).toMatch(/^[\x20-\x7e]+$/)
    expect(result.text.length).toBeLessThanOrEqual(70)
  }
})
