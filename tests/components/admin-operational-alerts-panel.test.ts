import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminOperationalAlertsPanel from '../../app/components/AdminOperationalAlertsPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const mockAlert = (over: Record<string, unknown> = {}) => ({
  id: 'a0000000-0000-4000-8000-000000000001',
  area: 'warehouse',
  severity: 'critical',
  category: 'chemical_spill',
  title: 'Derrame de desengrasante industrial pasillo C',
  description: 'Bidón perforado, contención de vertido químico en curso',
  locationRef: 'AISLE-C-04',
  status: 'open',
  escalationTier: 1,
  redundantChannelRequired: true,
  redundantChannelDispatched: true,
  version: 1,
  acknowledgedAt: null,
  acknowledgedBy: null,
  ackNote: null,
  escalatedAt: null,
  escalationReason: null,
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  createdAt: '2026-10-29T14:00:00Z',
  createdBy: '10000000-0000-4000-8000-000000000001',
  dispatches: [
    {
      id: 'd1',
      alertId: 'a0000000-0000-4000-8000-000000000001',
      channel: 'dashboard',
      isRedundant: false,
      recipientTarget: 'warehouse_dashboard',
      status: 'delivered',
      dispatchedAt: '2026-10-29T14:00:00Z'
    },
    {
      id: 'd2',
      alertId: 'a0000000-0000-4000-8000-000000000001',
      channel: 'sms_pager',
      isRedundant: true,
      recipientTarget: 'sms:operations_pager',
      status: 'dispatched',
      dispatchedAt: '2026-10-29T14:00:00Z'
    }
  ],
  ...over
})

describe('AdminOperationalAlertsPanel', () => {
  beforeEach(() => mocks.request.mockReset())

  it('displays loading, empty state, and handles error state with retry', async () => {
    mocks.request.mockResolvedValueOnce({ items: [], total: 0, page: 1, perPage: 20 })
    let wrapper = await mountSuspended(AdminOperationalAlertsPanel)
    await flushPromises()
    expect(wrapper.find('[data-empty]').exists()).toBe(true)

    // Error state
    mocks.request.mockReset()
    mocks.request.mockRejectedValueOnce({ data: { error: { code: 'forbidden' } } })
    wrapper = await mountSuspended(AdminOperationalAlertsPanel)
    await flushPromises()
    expect(wrapper.find('[data-error]').exists()).toBe(true)
    expect(wrapper.get('[data-error]').text()).toContain('forbidden')
  })

  it('renders critical alert with redundant channel badge and allows acknowledge with note', async () => {
    const alert = mockAlert()
    mocks.request.mockImplementation(async (url?: string, options?: { method?: string; body?: unknown }) => {
      if (options?.method === 'POST') {
        return { alert: { ...alert, status: 'acknowledged', version: 2, ackNote: 'Revisado por almacén' } }
      }
      return { items: [alert], total: 1, page: 1, perPage: 20 }
    })

    const wrapper = await mountSuspended(AdminOperationalAlertsPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('Derrame de desengrasante industrial')
    expect(wrapper.find('[data-redundant-badge]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Canal Redundante')

    // Open acknowledge dialog
    const ackBtn = wrapper.get('[data-action-ack]')
    await ackBtn.trigger('click')

    const input = wrapper.get('input[data-ack-note]')
    await input.setValue('Revisado por almacén')

    const submitAck = wrapper.get('[data-submit-ack]')
    await submitAck.trigger('click')
    await flushPromises()

    expect(mocks.request).toHaveBeenCalledWith(
      expect.stringContaining('/ack'),
      expect.objectContaining({ method: 'POST' })
    )
  })
})
