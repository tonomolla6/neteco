import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminMultichannelCommunications from '../../app/components/AdminMultichannelCommunications.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const sampleLogs = {
  total: 1,
  limit: 50,
  offset: 0,
  commands: [
    {
      command_id: 'cmd-1',
      customer_id: '11111111-1111-4111-8111-111111111111',
      dedup_key: 'order-created-123',
      category: 'transactional',
      event_type: 'order.confirmation',
      selected_channel: 'email',
      priority_order: 'email,sms,push',
      status: 'delivered',
      payload_hash: 'hash-abc',
      attempts: 1,
      created_at: '2026-11-01T10:00:00Z',
      updated_at: '2026-11-01T10:01:00Z'
    }
  ]
}

const apiError = (code: string) => Object.assign(new Error(code), { data: { error: { code } } })

const mount = async () => {
  const wrapper = await mountSuspended(AdminMultichannelCommunications)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  mocks.request.mockReset()
})

describe('AdminMultichannelCommunications (COM-015)', () => {
  it('shows loading and error states', async () => {
    mocks.request.mockImplementation(() => new Promise(() => {}))
    const loadingWrapper = await mountSuspended(AdminMultichannelCommunications)
    expect(loadingWrapper.find('[role="status"]').text()).toContain('Cargando')

    mocks.request.mockReset()
    mocks.request.mockRejectedValueOnce(apiError('forbidden'))
    const errorWrapper = await mount()
    expect(errorWrapper.find('[role="alert"]').text()).toContain('forbidden')
  })

  it('renders log table when logs are returned', async () => {
    mocks.request.mockResolvedValueOnce(sampleLogs)
    const wrapper = await mount()
    expect(wrapper.text()).toContain('Comunicaciones multicanal')
    expect(wrapper.text()).toContain('order-created-123')
    expect(wrapper.text()).toContain('order.confirmation')
    expect(wrapper.text()).toContain('delivered')
    expect(wrapper.text()).toContain('email')
  })

  it('shows empty state when no commands are found', async () => {
    mocks.request.mockResolvedValueOnce({ total: 0, limit: 50, offset: 0, commands: [] })
    const wrapper = await mount()
    expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('No hay comunicaciones registradas')
  })

  it('dispatches a notification successfully', async () => {
    mocks.request.mockResolvedValueOnce(sampleLogs)
    const wrapper = await mount()

    mocks.request
      .mockResolvedValueOnce({
        commandId: 'cmd-new',
        status: 'sent',
        selectedChannel: 'email'
      })
      .mockResolvedValueOnce(sampleLogs)

    await wrapper.find('[data-test="customer-id"]').setValue('11111111-1111-4111-8111-111111111111')
    await wrapper.find('[data-test="event-type"]').setValue('shipment.tracking')
    await wrapper.find('[data-test="category"]').setValue('transactional')
    await wrapper.find('[data-test="payload"]').setValue('{"trackingNumber":"TRACK123"}')
    await wrapper.find('[data-test="dispatch-btn"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="success-message"]').text()).toContain('notificación enviada')
  })
})
