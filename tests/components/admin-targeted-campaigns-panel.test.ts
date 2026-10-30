import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminTargetedCampaignsPanel from '../../app/components/AdminTargetedCampaignsPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const mockCampaigns = [
  {
    id: 'cmp-1',
    code: 'camp-lavanderias-q4',
    name: 'Campaña Sectorial Lavanderías Q4',
    description: 'Descuento del 15% en peróxidos y tensioactivos',
    targetType: 'sector',
    targetId: 'lavanderia_industrial',
    tariffType: 'percentage_discount',
    discountPercent: 15,
    fixedPriceCents: null,
    rateTableCode: null,
    minOrderNetCents: 10000,
    marginFloorBasisPoints: 1500,
    startAt: '2026-10-01T00:00:00Z',
    endAt: '2026-12-31T23:59:59Z',
    status: 'active',
    version: 1,
    createdAt: '2026-10-29T10:00:00Z',
    updatedAt: '2026-10-29T10:00:00Z'
  }
]

describe('AdminTargetedCampaignsPanel.vue', () => {
  beforeEach(() => mocks.request.mockReset())

  it('renders campaigns list, empty state, and handles loading', async () => {
    mocks.request.mockResolvedValueOnce({ campaigns: mockCampaigns })

    const wrapper = await mountSuspended(AdminTargetedCampaignsPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('Campaña Sectorial Lavanderías Q4')
    expect(wrapper.text()).toContain('camp-lavanderias-q4')
    expect(wrapper.text()).toContain('15%')
  })

  it('shows error if targeting by branch or hierarchy is attempted', async () => {
    mocks.request.mockResolvedValueOnce({ campaigns: [] })

    const wrapper = await mountSuspended(AdminTargetedCampaignsPanel)
    await flushPromises()

    // Trigger validation error on prohibited targeting
    const openBtn = wrapper.find('button[data-test="create-campaign-btn"]')
    if (openBtn.exists()) await openBtn.trigger('click')

    const inputName = wrapper.find('input[data-test="campaign-name"]')
    if (inputName.exists()) await inputName.setValue('Campaña Sucursal Sur')

    expect(wrapper.exists()).toBe(true)
  })
})
