import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AccountB2bRequests from '../../app/components/AccountB2bRequests.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const item = {
  id: '80000000-0000-4000-8000-000000000001',
  publicRef: 'B2B-0123456789ABCDEF0123',
  kind: 'quote',
  subject: 'Presupuesto de lejía',
  status: 'waiting_customer',
  priority: 'normal',
  slaDueAt: '2026-10-30T12:00:00Z',
  slaState: 'on_track',
  firstResponseAt: '2026-10-29T13:00:00Z',
  closedAt: null,
  version: 3,
  createdAt: '2026-10-29T12:00:00Z',
  updatedAt: '2026-10-29T13:00:00Z'
}
beforeEach(() => {
  mocks.request.mockReset()
  mocks.request.mockImplementation(async (url: string, options?: { method?: string }) => {
    if (typeof url !== 'string') return undefined // Nuxt itself may call the mocked fetch while booting
    if (url === '/api/account/b2b-requests' && options?.method === 'POST')
      return { id: item.id, publicRef: item.publicRef, status: 'submitted', slaDueAt: item.slaDueAt, version: 1 }
    if (url === '/api/account/b2b-requests') return { items: [item] }
    if (url.endsWith('/reply')) return { id: item.id, status: 'in_review', version: 4 }
    if (url.endsWith('/cancel')) return { id: item.id, status: 'cancelled', version: 4 }
    if (url.endsWith('/documents'))
      return { documentId: 'd', requestId: item.id, scanStatus: 'pending', sha256: 'a'.repeat(64) }
    if (url === `/api/account/b2b-requests/${item.id}`)
      return {
        request: { ...item, details: { lines: [{ productSlug: 'lejia-5l', quantity: 40 }] } },
        events: [
          {
            seq: 1,
            actorType: 'customer',
            action: 'submitted',
            fromStatus: null,
            toStatus: 'submitted',
            note: null,
            createdAt: item.createdAt
          },
          {
            seq: 2,
            actorType: 'admin',
            action: 'status',
            fromStatus: 'submitted',
            toStatus: 'waiting_customer',
            note: 'Falta el CIF de la empresa',
            createdAt: item.updatedAt
          }
        ],
        documents: []
      }
    throw new Error('unhandled ' + url)
  })
})

describe('AccountB2bRequests (SUP-017)', () => {
  it('lists requests with status and SLA', async () => {
    const wrapper = await mountSuspended(AccountB2bRequests)
    await flushPromises()
    expect(wrapper.text()).toContain('Presupuesto de lejía')
    expect(wrapper.text()).toContain('Esperando tu respuesta')
    expect(wrapper.text()).toContain('B2B-0123456789ABCDEF0123')
  })
  it('creates a quote with an idempotency key', async () => {
    const wrapper = await mountSuspended(AccountB2bRequests)
    await flushPromises()
    await wrapper.find('[data-test="new-request"]').trigger('click')
    await wrapper.find('select[name="kind"]').setValue('quote')
    await wrapper.find('input[name="subject"]').setValue('Presupuesto de lejía')
    await wrapper.find('input[name="productSlug"]').setValue('lejia-5l')
    await wrapper.find('input[name="quantity"]').setValue('40')
    await wrapper.find('form[data-test="request-form"]').trigger('submit')
    await flushPromises()
    const post = mocks.request.mock.calls.find((c) => c[1]?.method === 'POST')!
    expect(post[1].headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/)
    expect(post[1].body).toEqual({
      kind: 'quote',
      subject: 'Presupuesto de lejía',
      details: { lines: [{ productSlug: 'lejia-5l', quantity: 40 }] }
    })
  })
  it('requires an order for claims and sends credit amounts in cents', async () => {
    const wrapper = await mountSuspended(AccountB2bRequests)
    await flushPromises()
    await wrapper.find('[data-test="new-request"]').trigger('click')
    await wrapper.find('select[name="kind"]').setValue('credit')
    await wrapper.find('input[name="subject"]').setValue('Línea de crédito')
    await wrapper.find('input[name="limitEuros"]').setValue('5000')
    await wrapper.find('textarea[name="justification"]').setValue('Compras mensuales recurrentes')
    await wrapper.find('form[data-test="request-form"]').trigger('submit')
    await flushPromises()
    const post = mocks.request.mock.calls.find((c) => c[1]?.method === 'POST')!
    expect(post[1].body.details).toMatchObject({ requestedLimitCents: 500000, paymentTermDays: 30 })
    await wrapper.find('[data-test="new-request"]').trigger('click')
    await wrapper.find('select[name="kind"]').setValue('claim')
    expect(wrapper.find('input[name="orderId"]').exists()).toBe(true)
  })
  it('opens the timeline, shows the team message and replies', async () => {
    const wrapper = await mountSuspended(AccountB2bRequests)
    await flushPromises()
    await wrapper.find('[data-test="request-open"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Falta el CIF de la empresa')
    await wrapper.find('textarea[name="message"]').setValue('Adjunto el CIF')
    await wrapper.find('form[data-test="reply-form"]').trigger('submit')
    await flushPromises()
    const call = mocks.request.mock.calls.find((c) => String(c[0]).endsWith('/reply'))!
    expect(call[1].body).toEqual({ message: 'Adjunto el CIF' })
  })
  it('cancels an open request with its version', async () => {
    const wrapper = await mountSuspended(AccountB2bRequests)
    await flushPromises()
    await wrapper.find('[data-test="request-open"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="request-cancel"]').trigger('click')
    await flushPromises()
    const call = mocks.request.mock.calls.find((c) => String(c[0]).endsWith('/cancel'))!
    expect(call[1].body).toEqual({ expectedVersion: 3 })
  })
  it('shows empty and error states', async () => {
    mocks.request.mockResolvedValue({ items: [] })
    const empty = await mountSuspended(AccountB2bRequests)
    await flushPromises()
    expect(empty.text()).toMatch(/todavía no tienes solicitudes/i)
    mocks.request.mockImplementation(async (url: unknown) => {
      if (typeof url === 'string') throw { data: { error: { code: 'company_not_approved' } } }
    })
    const failed = await mountSuspended(AccountB2bRequests)
    await flushPromises()
    expect(failed.find('[role="alert"]').text()).toMatch(/empresa.*aprobad/i)
  })
})
