import { describe, expect, it } from 'vitest'
import {
  B2B_SLA_HOURS,
  b2bCreateInputSchema,
  b2bAdminCommandSchema,
  b2bNextStatus,
  b2bSlaState,
  computeDeflection,
  contactAnalysisQuerySchema,
  classifyInputSchema,
  backlogCreateInputSchema,
  educationCommandSchema,
  educationNextStatus,
  defaultRootCause,
  addHours
} from '../../shared/support-insights'

describe('addHours', () => {
  it('adds whole hours in ISO second precision', () => {
    expect(addHours('2026-10-29T10:00:00Z', 24)).toBe('2026-10-30T10:00:00Z')
  })
})

describe('b2bCreateInputSchema', () => {
  it('accepts each of the five request kinds', () => {
    const base = { subject: 'Solicitud de prueba' }
    expect(
      b2bCreateInputSchema.safeParse({
        ...base,
        kind: 'quote',
        details: { lines: [{ productSlug: 'lejia-5l', quantity: 20 }] }
      }).success
    ).toBe(true)
    expect(
      b2bCreateInputSchema.safeParse({
        ...base,
        kind: 'product_onboarding',
        details: {
          productName: 'Desengrasante X',
          intendedUse: 'Limpieza de cocinas industriales',
          estimatedMonthlyUnits: 100,
          hasSafetyDataSheet: true
        }
      }).success
    ).toBe(true)
    expect(
      b2bCreateInputSchema.safeParse({
        ...base,
        kind: 'documentation',
        details: { documentType: 'safety_data_sheet', productSlug: 'lejia-5l' }
      }).success
    ).toBe(true)
    expect(
      b2bCreateInputSchema.safeParse({
        ...base,
        kind: 'credit',
        details: { requestedLimitCents: 500000, paymentTermDays: 30, justification: 'Compras mensuales recurrentes' }
      }).success
    ).toBe(true)
    expect(
      b2bCreateInputSchema.safeParse({
        ...base,
        kind: 'claim',
        orderId: '10000000-0000-4000-8000-000000000001',
        details: { claimType: 'damaged', description: 'Dos garrafas llegaron rotas' }
      }).success
    ).toBe(true)
  })
  it('rejects empty quotes, bad quantities, unknown keys and mismatched kinds', () => {
    const base = { subject: 'Solicitud de prueba' }
    expect(b2bCreateInputSchema.safeParse({ ...base, kind: 'quote', details: { lines: [] } }).success).toBe(false)
    expect(
      b2bCreateInputSchema.safeParse({
        ...base,
        kind: 'quote',
        details: { lines: [{ productSlug: 'a', quantity: 0 }] }
      }).success
    ).toBe(false)
    expect(
      b2bCreateInputSchema.safeParse({
        ...base,
        kind: 'quote',
        details: { lines: [{ productSlug: 'a', quantity: 1 }], extra: 1 }
      }).success
    ).toBe(false)
    expect(b2bCreateInputSchema.safeParse({ ...base, kind: 'credit', details: { lines: [] } }).success).toBe(false)
    expect(
      b2bCreateInputSchema.safeParse({
        ...base,
        kind: 'credit',
        details: { requestedLimitCents: 1, paymentTermDays: 45, justification: 'Compras mensuales' }
      }).success
    ).toBe(false)
  })
  it('requires an order only for claims', () => {
    const details = { claimType: 'missing', description: 'Falta una caja del pedido' }
    expect(b2bCreateInputSchema.safeParse({ subject: 'Reclamación', kind: 'claim', details }).success).toBe(false)
    expect(
      b2bCreateInputSchema.safeParse({
        subject: 'Presupuesto',
        kind: 'quote',
        orderId: '10000000-0000-4000-8000-000000000001',
        details: { lines: [{ productSlug: 'a', quantity: 1 }] }
      }).success
    ).toBe(false)
  })
})

describe('B2B workflow', () => {
  it('has an SLA target for every kind', () => {
    expect(Object.keys(B2B_SLA_HOURS).sort()).toEqual([
      'claim',
      'credit',
      'documentation',
      'product_onboarding',
      'quote'
    ])
  })
  it('moves only along allowed transitions', () => {
    expect(b2bNextStatus('submitted', 'start_review', 'quote')).toBe('in_review')
    expect(b2bNextStatus('in_review', 'request_info', 'quote')).toBe('waiting_customer')
    expect(b2bNextStatus('in_review', 'approve', 'credit')).toBe('approved')
    expect(b2bNextStatus('in_review', 'reject', 'credit')).toBe('rejected')
    expect(b2bNextStatus('in_review', 'resolve', 'claim')).toBe('resolved')
    expect(b2bNextStatus('approved', 'resolve', 'quote')).toBe('resolved')
    expect(b2bNextStatus('submitted', 'approve', 'credit')).toBeNull()
    expect(b2bNextStatus('resolved', 'start_review', 'claim')).toBeNull()
    expect(b2bNextStatus('in_review', 'approve', 'claim')).toBeNull()
    expect(b2bNextStatus('in_review', 'approve', 'documentation')).toBeNull()
  })
  it('requires a note when asking for information or rejecting', () => {
    expect(b2bAdminCommandSchema.safeParse({ action: 'reject', expectedVersion: 2 }).success).toBe(false)
    expect(
      b2bAdminCommandSchema.safeParse({ action: 'request_info', expectedVersion: 2, note: 'Falta el CIF' }).success
    ).toBe(true)
    expect(b2bAdminCommandSchema.safeParse({ action: 'start_review', expectedVersion: 1 }).success).toBe(true)
    expect(b2bAdminCommandSchema.safeParse({ action: 'start_review', expectedVersion: 0 }).success).toBe(false)
    expect(b2bAdminCommandSchema.safeParse({ action: 'delete', expectedVersion: 1 }).success).toBe(false)
  })
  it('derives the SLA state from the due date, response and current time', () => {
    const r = {
      createdAt: '2026-10-29T00:00:00Z',
      slaDueAt: '2026-10-30T00:00:00Z',
      firstResponseAt: null as string | null
    }
    expect(b2bSlaState(r, '2026-10-29T06:00:00Z')).toBe('on_track')
    expect(b2bSlaState(r, '2026-10-29T20:00:00Z')).toBe('at_risk')
    expect(b2bSlaState(r, '2026-10-30T00:00:01Z')).toBe('breached')
    expect(b2bSlaState({ ...r, firstResponseAt: '2026-10-29T09:00:00Z' }, '2026-11-05T00:00:00Z')).toBe('met')
    expect(b2bSlaState({ ...r, firstResponseAt: '2026-10-30T01:00:00Z' }, '2026-11-05T00:00:00Z')).toBe('breached')
  })
})

describe('contact analysis inputs', () => {
  it('bounds the window and requires from < to', () => {
    expect(contactAnalysisQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31' }).success).toBe(true)
    expect(contactAnalysisQuerySchema.safeParse({ from: '2026-10-31', to: '2026-10-01' }).success).toBe(false)
    expect(contactAnalysisQuerySchema.safeParse({ from: '2025-01-01', to: '2026-10-31' }).success).toBe(false)
    expect(
      contactAnalysisQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31', touchCostCents: -1 }).success
    ).toBe(false)
    expect(contactAnalysisQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31', extra: 1 }).success).toBe(false)
  })
  it('maps ticket categories to a default root cause and validates classification input', () => {
    expect(defaultRootCause('shipping')).toBe('delivery_delay')
    expect(defaultRootCause('payment')).toBe('payment_issue')
    expect(defaultRootCause('unknown')).toBe('other')
    const ticketId = '10000000-0000-4000-8000-000000000001'
    expect(classifyInputSchema.safeParse({ ticketId, rootCause: 'wrong_item', expectedVersion: 0 }).success).toBe(true)
    expect(classifyInputSchema.safeParse({ ticketId, rootCause: 'unclassified', expectedVersion: 0 }).success).toBe(
      false
    )
  })
  it('validates a backlog item built from the analysis', () => {
    const ok = {
      dimension: 'carrier',
      dimensionKey: 'SEUR',
      rootCause: 'delivery_delay',
      title: 'Retrasos recurrentes SEUR',
      priority: 'high',
      from: '2026-10-01',
      to: '2026-10-31',
      evidence: { contacts: 12, ratePer100Orders: 8.5 }
    }
    expect(backlogCreateInputSchema.safeParse(ok).success).toBe(true)
    expect(backlogCreateInputSchema.safeParse({ ...ok, title: 'x' }).success).toBe(false)
    expect(backlogCreateInputSchema.safeParse({ ...ok, dimension: 'color' }).success).toBe(false)
  })
})

describe('education pipeline', () => {
  it('allows only review -> approve|reject -> publish', () => {
    expect(educationNextStatus('detected', 'start_review')).toBe('in_review')
    expect(educationNextStatus('in_review', 'approve')).toBe('approved')
    expect(educationNextStatus('in_review', 'reject')).toBe('rejected')
    expect(educationNextStatus('approved', 'publish')).toBe('published')
    expect(educationNextStatus('detected', 'approve')).toBeNull()
    expect(educationNextStatus('detected', 'publish')).toBeNull()
    expect(educationNextStatus('published', 'reject')).toBeNull()
  })
  it('requires expert notes, a target and a safety check to approve', () => {
    expect(
      educationCommandSchema.safeParse({
        action: 'approve',
        expectedVersion: 2,
        reviewNotes: 'Revisado por el responsable técnico',
        targetKind: 'faq',
        safetyReviewed: true
      }).success
    ).toBe(true)
    expect(
      educationCommandSchema.safeParse({
        action: 'approve',
        expectedVersion: 2,
        reviewNotes: 'corto',
        targetKind: 'faq',
        safetyReviewed: true
      }).success
    ).toBe(false)
    expect(
      educationCommandSchema.safeParse({
        action: 'approve',
        expectedVersion: 2,
        reviewNotes: 'Revisado por el responsable técnico',
        targetKind: 'faq',
        safetyReviewed: false
      }).success
    ).toBe(false)
    expect(educationCommandSchema.safeParse({ action: 'publish', expectedVersion: 3 }).success).toBe(false)
    expect(
      educationCommandSchema.safeParse({
        action: 'publish',
        expectedVersion: 3,
        targetPageId: '10000000-0000-4000-8000-000000000001'
      }).success
    ).toBe(true)
    expect(
      educationCommandSchema.safeParse({ action: 'publish', expectedVersion: 3, targetProductSlug: 'lejia-5l' }).success
    ).toBe(true)
  })
})

describe('computeDeflection', () => {
  const published = '2026-10-15T00:00:00Z'
  const turn = (createdAt: string, escalated: boolean, helpful: boolean | null = null) => ({
    createdAt,
    escalated,
    helpful
  })
  it('reports insufficient data before the observation period and with too few prior turns', () => {
    expect(
      computeDeflection({ publishedAt: published, now: '2026-10-18T00:00:00Z', windowDays: 14, turns: [] }).status
    ).toBe('insufficient_data')
    const few = [turn('2026-10-10T00:00:00Z', true)]
    expect(
      computeDeflection({ publishedAt: published, now: '2026-11-15T00:00:00Z', windowDays: 14, turns: few }).status
    ).toBe('insufficient_data')
  })
  it('measures the drop of the escalation rate after publication', () => {
    const before = ['01', '02', '03', '04'].map((d) => turn(`2026-10-${d}T10:00:00Z`, true))
    before.push(turn('2026-10-05T10:00:00Z', false))
    const after = [
      turn('2026-10-16T10:00:00Z', false, true),
      turn('2026-10-17T10:00:00Z', false, true),
      turn('2026-10-18T10:00:00Z', true, false),
      turn('2026-10-19T10:00:00Z', false, true),
      turn('2026-10-20T10:00:00Z', false)
    ]
    const r = computeDeflection({
      publishedAt: published,
      now: '2026-10-29T00:00:00Z',
      windowDays: 14,
      turns: [...before, ...after]
    })
    expect(r.status).toBe('measured')
    expect(r.before).toMatchObject({ turns: 5, escalated: 4, rateBp: 8000 })
    expect(r.after).toMatchObject({ turns: 5, escalated: 1, rateBp: 2000, helpfulRateBp: 7500 })
    expect(r.deflectionBp).toBe(7500)
  })
  it('ignores turns outside both windows and never reports negative deflection as improvement', () => {
    const turns = [
      turn('2026-09-01T00:00:00Z', true),
      turn('2026-10-02T00:00:00Z', false),
      turn('2026-10-03T00:00:00Z', false),
      turn('2026-10-04T00:00:00Z', true),
      turn('2026-10-20T00:00:00Z', true),
      turn('2026-10-21T00:00:00Z', true)
    ]
    const r = computeDeflection({ publishedAt: published, now: '2026-11-30T00:00:00Z', windowDays: 14, turns })
    expect(r.before.turns).toBe(3)
    expect(r.after.turns).toBe(2)
    expect(r.deflectionBp).toBeLessThan(0)
  })
})
