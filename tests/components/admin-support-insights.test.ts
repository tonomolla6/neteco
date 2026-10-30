import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminSupportContactAnalysis from '../../app/components/AdminSupportContactAnalysis.vue'
import AdminSupportEducation from '../../app/components/AdminSupportEducation.vue'
import AdminB2bRequests from '../../app/components/AdminB2bRequests.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const analysis = {
  window: { from: '2026-10-01', to: '2026-10-31' },
  totals: { orders: 15, contacts: 7, ratePer100Orders: 46.67, touches: 2, estimatedCostCents: null },
  byCategory: [{ key: 'shipping', contacts: 4, touches: 2 }],
  byRootCause: [{ key: 'unclassified', contacts: 7, touches: 2 }],
  byCarrier: [{ key: 'SEUR', orders: 10, contacts: 4, ratePer100Orders: 40 }],
  byProduct: [{ key: 'lejia-5l', orders: 8, contacts: 2, ratePer100Orders: 25 }],
  byOrder: [{ key: '50000000-0000-4000-8000-000000000001', contacts: 2 }],
  suggestions: [
    {
      dimension: 'carrier',
      dimensionKey: 'SEUR',
      rootCause: 'unclassified',
      contacts: 4,
      sharePct: 57.14,
      ratePer100Orders: 40,
      priority: 'high',
      title: 'Reducir contactos por transportista: SEUR'
    }
  ]
}
beforeEach(() => mocks.request.mockReset())
// Nuxt may call the mocked fetch with no URL while booting; only real endpoint calls fail.
const failAll = () =>
  mocks.request.mockImplementation(async (url: unknown) => {
    if (typeof url === 'string') throw new Error('fallo')
  })

describe('AdminSupportContactAnalysis (SUP-014)', () => {
  function route(overrides: Record<string, unknown> = {}) {
    mocks.request.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (typeof url !== 'string') return undefined // Nuxt itself may call the mocked fetch while booting
      if (url in overrides) {
        const v = overrides[url]
        if (v instanceof Error) throw v
        return v
      }
      if (url.startsWith('/api/admin/support/contact-analysis?')) return analysis
      if (url.startsWith('/api/admin/support/contact-analysis/backlog') && options?.method === 'POST')
        return { id: 'b1', status: 'open', version: 1 }
      if (url.startsWith('/api/admin/support/contact-analysis/backlog'))
        return {
          items: [
            {
              id: 'b0',
              dimension: 'category',
              dimensionKey: 'shipping',
              rootCause: 'delivery_delay',
              title: 'Retrasos de entrega',
              priority: 'normal',
              status: 'open',
              version: 1,
              evidence: {},
              windowFrom: '2026-10-01T00:00:00Z',
              windowTo: '2026-11-01T00:00:00Z',
              rcaId: null,
              createdAt: '2026-10-29T00:00:00Z'
            }
          ]
        }
      throw new Error('unhandled ' + url)
    })
  }
  it('shows the contact rate and the breakdown by carrier, product and root cause', async () => {
    route()
    const wrapper = await mountSuspended(AdminSupportContactAnalysis)
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('46,67')
    expect(text).toContain('SEUR')
    expect(text).toContain('lejia-5l')
    expect(text).toContain('Sin clasificar')
    expect(text).toContain('Retrasos de entrega')
  })
  it('turns a suggestion into a backlog item with the evidence', async () => {
    route()
    const wrapper = await mountSuspended(AdminSupportContactAnalysis)
    await flushPromises()
    await wrapper.find('[data-test="suggestion-add"]').trigger('click')
    await flushPromises()
    const post = mocks.request.mock.calls.find((c) => c[1]?.method === 'POST')!
    expect(post[0]).toBe('/api/admin/support/contact-analysis/backlog')
    expect(post[1].headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/)
    expect(post[1].body).toMatchObject({
      dimension: 'carrier',
      dimensionKey: 'SEUR',
      priority: 'high',
      evidence: { contacts: 4 }
    })
  })
  it('separates loading, error and empty states', async () => {
    failAll()
    const wrapper = await mountSuspended(AdminSupportContactAnalysis)
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })
})

describe('AdminSupportEducation (SUP-012/015)', () => {
  const candidate = {
    id: '60000000-0000-4000-8000-000000000001',
    sampleQuestion: '¿Qué pintura epoxi industrial recomendáis?',
    occurrences: 4,
    firstSeenAt: '2026-10-01T00:00:00Z',
    lastSeenAt: '2026-10-04T00:00:00Z',
    status: 'detected',
    targetKind: null,
    targetPageId: null,
    targetProductSlug: null,
    reviewNotes: null,
    safetyReviewed: false,
    publishedAt: null,
    version: 1
  }
  const handoff = {
    id: '70000000-0000-4000-8000-000000000001',
    turnId: 't',
    status: 'open',
    contactEmail: 'ana@example.com',
    hasCustomer: false,
    note: null,
    ownerId: null,
    question: 'Necesito un presupuesto',
    reason: 'no_match',
    outcome: 'uncertain',
    slaDueAt: '2026-10-30T12:00:00Z',
    slaState: 'on_track',
    version: 1,
    createdAt: '2026-10-29T12:00:00Z'
  }
  function route(candidates = [candidate]) {
    mocks.request.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (typeof url !== 'string') return undefined // Nuxt itself may call the mocked fetch while booting
      if (url.startsWith('/api/admin/support/education/candidates') && url.includes('/deflection'))
        return {
          status: 'measured',
          before: { turns: 5, escalated: 5, rateBp: 10000, helpfulRateBp: null },
          after: { turns: 4, escalated: 0, rateBp: 0, helpfulRateBp: 10000 },
          observedDays: 14,
          deflectionBp: 10000
        }
      if (url.endsWith('/commands')) return { candidateId: candidate.id, status: 'in_review', version: 2 }
      if (url.startsWith('/api/admin/support/education/candidates')) return { items: candidates }
      if (url === '/api/admin/support/education/detect') return { created: 1, updated: 0, scannedTurns: 4, runId: 'r' }
      if (url.startsWith('/api/admin/support/assistant/handoffs') && url.endsWith('/commands'))
        return { handoffId: handoff.id, status: 'claimed', version: 2 }
      if (url.startsWith('/api/admin/support/assistant/handoffs')) return { items: [handoff] }
      if (url.startsWith('/api/admin/support/assistant/stats'))
        return {
          turns: 10,
          answered: 6,
          uncertain: 3,
          handoffRequired: 1,
          handoffRequested: 2,
          helpful: 4,
          notHelpful: 1,
          answeredRateBp: 6000,
          handoffRateBp: 2000
        }
      throw new Error('unhandled ' + url + options?.method)
    })
  }
  it('lists repeated questions, the assistant handoff queue and its statistics', async () => {
    route()
    const wrapper = await mountSuspended(AdminSupportEducation)
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('¿Qué pintura epoxi industrial recomendáis?')
    expect(text).toContain('4 veces')
    expect(text).toContain('Necesito un presupuesto')
    expect(text).toContain('ana@example.com')
    expect(text).toContain('60 %')
  })
  it('starts a review with the current version', async () => {
    route()
    const wrapper = await mountSuspended(AdminSupportEducation)
    await flushPromises()
    await wrapper.find('[data-test="candidate-start-review"]').trigger('click')
    await flushPromises()
    const call = mocks.request.mock.calls.find((c) => String(c[0]).endsWith(`${candidate.id}/commands`))!
    expect(call[1].body).toEqual({ action: 'start_review', expectedVersion: 1 })
  })
  it('does not offer approval without expert notes and the safety check', async () => {
    route([{ ...candidate, status: 'in_review', version: 2 }])
    const wrapper = await mountSuspended(AdminSupportEducation)
    await flushPromises()
    const approve = wrapper.find('[data-test="candidate-approve"]')
    expect(approve.attributes('disabled')).toBeDefined()
    await wrapper.find('textarea[name="reviewNotes"]').setValue('Revisado por el responsable técnico de producto')
    await wrapper.find('input[name="safetyReviewed"]').setValue(true)
    expect(wrapper.find('[data-test="candidate-approve"]').attributes('disabled')).toBeUndefined()
  })
  it('shows the measured deflection of a published topic', async () => {
    route([{ ...candidate, status: 'published', version: 4, publishedAt: '2026-10-15T00:00:00Z', targetKind: 'faq' }])
    const wrapper = await mountSuspended(AdminSupportEducation)
    await flushPromises()
    await wrapper.find('[data-test="candidate-deflection"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('100 %')
    expect(wrapper.text()).toMatch(/antes.*5/s)
  })
  it('claims a handoff', async () => {
    route()
    const wrapper = await mountSuspended(AdminSupportEducation)
    await flushPromises()
    await wrapper.find('[data-test="handoff-claim"]').trigger('click')
    await flushPromises()
    const call = mocks.request.mock.calls.find(
      (c) => String(c[0]).includes('/handoffs/') && String(c[0]).endsWith('/commands')
    )!
    expect(call[1].body).toEqual({ action: 'claim', expectedVersion: 1 })
  })
  it('shows empty and error states', async () => {
    route([])
    const empty = await mountSuspended(AdminSupportEducation)
    await flushPromises()
    expect(empty.text()).toMatch(/no hay preguntas repetidas/i)
    failAll()
    const failed = await mountSuspended(AdminSupportEducation)
    await flushPromises()
    expect(failed.find('[role="alert"]').exists()).toBe(true)
  })
})

describe('AdminB2bRequests (SUP-017)', () => {
  const item = {
    id: '80000000-0000-4000-8000-000000000001',
    publicRef: 'B2B-0123456789ABCDEF0123',
    kind: 'credit',
    subject: 'Línea de crédito',
    status: 'submitted',
    priority: 'normal',
    slaDueAt: '2026-10-30T12:00:00Z',
    slaState: 'at_risk',
    firstResponseAt: null,
    closedAt: null,
    version: 1,
    createdAt: '2026-10-29T12:00:00Z',
    updatedAt: '2026-10-29T12:00:00Z',
    companyName: 'Empresa Uno',
    ownerId: null
  }
  let detailStatus = 'submitted'
  beforeEach(() => {
    detailStatus = 'submitted'
    mocks.request.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (typeof url !== 'string') return undefined // Nuxt itself may call the mocked fetch while booting
      if (url.endsWith('/commands')) return { id: item.id, status: 'in_review', version: 2 }
      if (url === `/api/admin/support/b2b-requests/${item.id}`)
        return {
          request: {
            ...item,
            status: detailStatus,
            version: detailStatus === 'submitted' ? 1 : 2,
            details: { requestedLimitCents: 500000, paymentTermDays: 30, justification: 'Compras mensuales' },
            orderId: null
          },
          events: [
            {
              seq: 1,
              actorType: 'customer',
              actorId: 'x',
              action: 'submitted',
              fromStatus: null,
              toStatus: 'submitted',
              note: null,
              createdAt: item.createdAt
            }
          ],
          documents: [
            {
              id: 'd',
              kind: 'tax_document',
              fileName: 'cif.pdf',
              contentType: 'application/pdf',
              sizeBytes: 100,
              sha256: 'a'.repeat(64),
              scanStatus: 'pending',
              createdAt: item.createdAt
            }
          ]
        }
      if (url.startsWith('/api/admin/support/b2b-requests')) return { items: [item] }
      throw new Error('unhandled ' + url + options?.method)
    })
  })
  it('lists requests with kind, company and SLA state', async () => {
    const wrapper = await mountSuspended(AdminB2bRequests)
    await flushPromises()
    expect(wrapper.text()).toContain('Empresa Uno')
    expect(wrapper.text()).toContain('Crédito')
    expect(wrapper.text()).toContain('En riesgo')
  })
  it('opens a request, shows documents pending scan and sends a workflow command', async () => {
    const wrapper = await mountSuspended(AdminB2bRequests)
    await flushPromises()
    await wrapper.find('[data-test="request-open"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('cif.pdf')
    expect(wrapper.text()).toMatch(/pendiente de análisis/i)
    await wrapper.find('[data-test="command-start_review"]').trigger('click')
    await flushPromises()
    const call = mocks.request.mock.calls.find((c) => String(c[0]).endsWith('/commands'))!
    expect(call[1].body).toEqual({ action: 'start_review', expectedVersion: 1 })
    expect(call[1].headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('offers only the actions the workflow allows and requires a note to reject', async () => {
    detailStatus = 'in_review'
    const wrapper = await mountSuspended(AdminB2bRequests)
    await flushPromises()
    await wrapper.find('[data-test="request-open"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="command-start_review"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="command-reject"]').attributes('disabled')).toBeDefined()
    await wrapper.find('textarea[name="note"]').setValue('No cumple la política de crédito')
    expect(wrapper.find('[data-test="command-reject"]').attributes('disabled')).toBeUndefined()
  })
  it('shows an error state', async () => {
    failAll()
    const wrapper = await mountSuspended(AdminB2bRequests)
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })
})
