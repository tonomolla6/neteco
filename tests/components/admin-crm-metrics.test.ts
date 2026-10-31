import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminCrmMetricsPanel from '../../app/components/AdminCrmMetricsPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const mockFlows = [
  {
    flowId: 'welcome_series',
    treatment: {
      deliveries: 100,
      clicks: 30,
      ctrPercent: 30,
      conversions: 10,
      conversionRatePercent: 10,
      unsubscribes: 2,
      unsubscribeRatePercent: 2,
      complaints: 1,
      complaintRatePercent: 1,
      totalRevenueCents: 150000,
      totalCostCents: 90000,
      totalMarginCents: 60000,
      marginBasisPoints: 4000,
      averageOrderValueCents: 15000
    },
    holdout: {
      allocations: 50,
      conversions: 2,
      conversionRatePercent: 4,
      totalRevenueCents: 20000,
      totalCostCents: 12000,
      totalMarginCents: 8000,
      marginBasisPoints: 4000,
      averageOrderValueCents: 10000
    },
    incremental: {
      holdoutViable: true,
      incrementalConversions: 6,
      incrementalConversionRatePercent: 6,
      incrementalLiftPercent: 150,
      incrementalMarginCents: 44000
    },
    holdoutPolicy: {
      flowId: 'welcome_series',
      version: 1,
      holdoutPercentage: 10,
      holdoutEnabled: true,
      salt: 'neteco_crm_salt_2026',
      minSampleSize: 20,
      updatedAt: '2026-10-29T12:00:00Z',
      updatedBy: '10000000-0000-4000-8000-000000000001'
    }
  }
]

describe('AdminCrmMetricsPanel component (DAT-016)', () => {
  beforeEach(() => {
    mocks.request.mockReset()
  })

  it('renders flows table with delivery, clicks, conversions, margin and holdout lift', async () => {
    mocks.request.mockResolvedValueOnce({ flows: mockFlows })

    const wrapper = await mountSuspended(AdminCrmMetricsPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('welcome_series')
    expect(wrapper.text()).toContain('100') // deliveries
    expect(wrapper.text()).toContain('30%') // CTR
    expect(wrapper.text()).toContain('10%') // conversion rate
    expect(wrapper.text()).toContain('2 bajas')
    expect(wrapper.text()).toContain('1 quejas')
    expect(wrapper.text()).toContain('Viable (+150% lift)')
    expect(wrapper.text()).toContain('Conv. inc.: 6')
  })

  it('renders empty state when no flows are returned', async () => {
    mocks.request.mockResolvedValueOnce({ flows: [] })

    const wrapper = await mountSuspended(AdminCrmMetricsPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('No hay flujos de automatización registrados.')
  })

  it('displays error message when request fails', async () => {
    mocks.request.mockRejectedValueOnce({ data: { error: { code: 'service_unavailable' } } })

    const wrapper = await mountSuspended(AdminCrmMetricsPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('service_unavailable')
  })

  it('submits updated holdout policy and reloads data', async () => {
    mocks.request.mockResolvedValueOnce({ flows: mockFlows })

    const wrapper = await mountSuspended(AdminCrmMetricsPanel)
    await flushPromises()

    mocks.request.mockResolvedValueOnce({ appliedVersion: 2, receiptId: 'cmd-01' })
    mocks.request.mockResolvedValueOnce({
      flows: [
        {
          ...mockFlows[0],
          holdoutPolicy: { ...mockFlows[0]!.holdoutPolicy, version: 2, holdoutPercentage: 20 }
        }
      ]
    })

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Guardar'))
    expect(saveBtn).toBeDefined()
    await saveBtn!.trigger('click')
    await flushPromises()

    const putCall = mocks.request.mock.calls.find(
      ([url, opts]) => String(url).includes('/holdout/policy') && opts?.method === 'PUT'
    )
    expect(putCall).toBeDefined()
    expect(wrapper.text()).toContain('actualizada correctamente')
  })
})
