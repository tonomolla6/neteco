import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import AdminProductRecall from '../../app/components/AdminProductRecall.vue'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const lot = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
beforeEach(() => {
  mocks.request.mockReset()
})
it('loads an empty recall and exposes actions appropriate to its state', async () => {
  mocks.request.mockResolvedValue({ version: 0, open: false, affected: [] })
  const wrapper = await mountSuspended(AdminProductRecall)
  await wrapper.find('input[name=lot]').setValue(lot)
  await wrapper.find('form').trigger('submit')
  await flushPromises()
  expect(wrapper.text()).toContain('No hay líneas de lotes registradas')
  expect(wrapper.find('button[data-action=open]').exists()).toBe(true)
  expect(wrapper.find('button[data-action=resolve]').exists()).toBe(false)
})
it('renders affected lines and records communication with the observed version', async () => {
  mocks.request
    .mockResolvedValueOnce({
      version: 1,
      open: true,
      affected: [{ orderId: 'order-1', lineIndex: 0, customerId: null, quantity: 2 }]
    })
    .mockResolvedValueOnce({ version: 2 })
    .mockResolvedValueOnce({ version: 2, open: true, affected: [] })
  const wrapper = await mountSuspended(AdminProductRecall)
  await wrapper.find('input[name=lot]').setValue(lot)
  await wrapper.find('form').trigger('submit')
  await flushPromises()
  expect(wrapper.text()).toContain('order-1')
  await wrapper.find('input[name=evidence]').setValue('case-verified-123')
  await wrapper.find('button[data-action=communicate]').trigger('click')
  await flushPromises()
  expect(mocks.request.mock.calls[1]![1]).toMatchObject({
    method: 'POST',
    body: { action: 'communicate', expectedVersion: 1, evidence: 'case-verified-123', orderId: 'order-1', lineIndex: 0 }
  })
})
it('reports errors without showing a stale snapshot', async () => {
  mocks.request.mockRejectedValue(new Error('unavailable'))
  const wrapper = await mountSuspended(AdminProductRecall)
  await wrapper.find('input[name=lot]').setValue(lot)
  await wrapper.find('form').trigger('submit')
  await flushPromises()
  expect(wrapper.find('[role=alert]').text()).toContain('No se ha podido cargar')
  expect(wrapper.find('button[data-action=open]').exists()).toBe(false)
})
it('loads the next page of affected lines', async () => {
 mocks.request.mockResolvedValueOnce({ version:1, open:true, affected:[{orderId:'order-1',lineIndex:0,customerId:null,quantity:1}], nextCursor:'cursor:0' }).mockResolvedValueOnce({ version:1, open:true, affected:[{orderId:'order-2',lineIndex:0,customerId:null,quantity:1}], nextCursor:null })
 const wrapper=await mountSuspended(AdminProductRecall)
 await wrapper.find('input[name=lot]').setValue(lot)
 await wrapper.find('form').trigger('submit'); await flushPromises()
 await wrapper.find('button[data-action=next]').trigger('click'); await flushPromises()
 expect(wrapper.text()).toContain('order-2')
 expect(mocks.request.mock.calls[1]![0]).toContain('after=cursor%3A0')
})
