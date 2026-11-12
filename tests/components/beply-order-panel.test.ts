import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Panel from '../../app/components/BeplyOrderPanel.vue'
const { read } = vi.hoisted(() => ({ read: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => read)
const id = '10000000-0000-4000-8000-000000000010'
const view = (orderId = id, audience = 'customer') => ({
  audience,
  orderId,
  status: 'synced',
  version: 1,
  syncedVersion: 1,
  state: 'shipped',
  stateLabel: 'Enviado',
  providerOrderId: '71',
  providerCode: 'PED71',
  erp: { served: true, deliveryNoteIds: ['81'], invoiceIds: [] },
  erpCheckedAt: '2026-11-12T10:00:00Z',
  expectedDeliveryAt: null,
  shipments: [{ parcelIndex: 0, carrier: 'Synthetic carrier', trackingNumber: 'TRACK1', shipmentNumber: 'SHIP1' }],
  lastErrorCode: null
})
const props = { orderId: id, audience: 'customer' as const, scopeKey: 'scope1', enabled: true }
beforeEach(() => {
  read.mockReset()
  read.mockResolvedValue(view())
})
describe('Beply private account/admin fetch panel', () => {
  it('loads the authorized private endpoint without shared caching or automatic retries', async () => {
    const panel = mount(Panel, { props })
    await flushPromises()
    expect(read).toHaveBeenCalledWith(
      `/api/orders/${id}/beply`,
      expect.objectContaining({ method: 'GET', retry: 0, cache: 'no-store' })
    )
    expect(panel.text()).toContain('TRACK1')
    panel.unmount()
  })
  it('does not query while the parent has no current authorization', async () => {
    const panel = mount(Panel, { props: { ...props, enabled: false } })
    await flushPromises()
    expect(read).not.toHaveBeenCalled()
    expect(panel.text()).not.toContain('TRACK1')
    panel.unmount()
  })
  it('purges old facts synchronously and rejects a response from a previous order/session', async () => {
    let resolveOld!: (value: unknown) => void
    read.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve
      })
    )
    const panel = mount(Panel, { props })
    const otherId = '10000000-0000-4000-8000-000000000099'
    read.mockResolvedValueOnce(view(otherId))
    await panel.setProps({ orderId: otherId, scopeKey: 'scope2' })
    await flushPromises()
    resolveOld(view())
    await flushPromises()
    expect(read).toHaveBeenCalledTimes(2)
    expect(panel.text()).toContain('Enviado')
    await panel.setProps({ enabled: false })
    expect(panel.text()).not.toContain('TRACK1')
    panel.unmount()
  })
  it('uses the admin endpoint and refuses a mismatching response audience', async () => {
    const panel = mount(Panel, { props: { ...props, audience: 'admin' } })
    await flushPromises()
    expect(read.mock.calls[0]![0]).toBe(`/api/admin/orders/${id}/beply`)
    expect(panel.text()).not.toContain('TRACK1')
    expect(panel.text()).toContain('No se ha podido')
    panel.unmount()
  })
  it('shows the operational alert and submits a versioned admin retry exactly once while pending', async () => {
    const manual = { ...view(id, 'admin'), status: 'manual_review', lastErrorCode: 'credentials' }
    let complete!: (value: unknown) => void
    read
      .mockResolvedValueOnce(manual)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve
        })
      )
      .mockResolvedValueOnce({ ...manual, status: 'pending', version: 2 })
    const panel = mount(Panel, { props: { ...props, audience: 'admin' } })
    await flushPromises()
    expect(panel.text()).toContain('necesita revisión')
    await panel.get('[data-beply-retry-reason]').setValue('Credenciales de sandbox revisadas')
    await panel.get('[data-beply-retry-form]').trigger('submit')
    await panel.get('[data-beply-retry-form]').trigger('submit')
    const posts = read.mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]).toEqual([
      `/api/admin/orders/${id}/beply/retry`,
      expect.objectContaining({
        retry: 0,
        body: { commandId: expect.any(String), expectedVersion: 1, reason: 'Credenciales de sandbox revisadas' }
      })
    ])
    complete({ version: 2 })
    await flushPromises()
    expect(panel.find('[data-beply-retry-form]').exists()).toBe(false)
    panel.unmount()
  })
  it('reuses the exact retry intent after a lost response and never exposes the action to customers', async () => {
    const manual = { ...view(id, 'admin'), status: 'manual_review', lastErrorCode: 'provider' }
    read
      .mockResolvedValueOnce(manual)
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce({ version: 2 })
      .mockResolvedValueOnce({ ...manual, status: 'pending', version: 2 })
    const panel = mount(Panel, { props: { ...props, audience: 'admin' } })
    await flushPromises()
    await panel.get('[data-beply-retry-reason]').setValue('Proveedor disponible tras incidencia')
    await panel.get('[data-beply-retry-form]').trigger('submit')
    await flushPromises()
    await panel.get('[data-beply-retry-form]').trigger('submit')
    await flushPromises()
    const posts = read.mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[1]![1].body).toEqual(posts[0]![1].body)
    panel.unmount()
    read.mockResolvedValueOnce({ ...manual, audience: 'customer', lastErrorCode: null })
    const customer = mount(Panel, { props })
    await flushPromises()
    expect(customer.find('[data-beply-retry-form]').exists()).toBe(false)
    customer.unmount()
  })
})
