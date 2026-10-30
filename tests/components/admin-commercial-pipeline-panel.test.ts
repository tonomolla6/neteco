import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminCommercialPipelinePanel from '../../app/components/AdminCommercialPipelinePanel.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => fetchMock)
mockNuxtImport('$fetch', () => fetchMock)

const samplePipelineData = {
  erpDisclaimer:
    'Este panel comercial coordina presupuestos nativos y canal de cuentas Neteco. No sustituye un ERP/CRM empresarial sin decisión explícita de integración.',
  stages: {
    lead: { count: 3, totalGrossCents: 150000, weightedValueCents: 15000 },
    contacted: { count: 2, totalGrossCents: 100000, weightedValueCents: 20000 },
    quote_drafted: { count: 4, totalGrossCents: 250000, weightedValueCents: 100000 },
    quote_sent: { count: 2, totalGrossCents: 180000, weightedValueCents: 90000 },
    negotiation: { count: 1, totalGrossCents: 95000, weightedValueCents: 66500 },
    approved: { count: 2, totalGrossCents: 120000, weightedValueCents: 108000 },
    converted: { count: 5, totalGrossCents: 450000, weightedValueCents: 450000 },
    lost: { count: 1, totalGrossCents: 30000, weightedValueCents: 0 }
  },
  overallGrossCents: 1375000,
  overallAverageMarginBps: 2850,
  pendingNextActionsCount: 2,
  accounts: [
    {
      customerId: '40000000-0000-4000-8000-000000000001',
      companyName: 'Industrias Químicas del Norte S.L.',
      contactName: 'Manuel Soto',
      contactEmail: 'cliente@industrias-quimicas.es',
      activeQuotesCount: 2,
      pipelineValueGrossCents: 150000,
      averageMarginBps: 3200,
      nextActions: [
        {
          id: '60000000-0000-4000-8000-000000000001',
          customerId: '40000000-0000-4000-8000-000000000001',
          actionDescription: 'Revisión técnica de incompatibilidades de surfactantes con cliente',
          dueDate: '2026-11-05',
          priority: 'high',
          assignedManagerId: '10000000-0000-4000-8000-000000000030',
          assignedManagerName: 'Carlos Gómez',
          completed: false,
          version: 1
        }
      ],
      recentActivities: []
    }
  ]
}

describe('ADM-030: AdminCommercialPipelinePanel Component', () => {
  let wrappers: Array<{ unmount(): void }> = []

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(samplePipelineData)
  })

  afterEach(() => {
    wrappers.forEach((w) => w.unmount())
    wrappers = []
  })

  it('renders pipeline stages, accounts and the required ERP/CRM non-substitution disclaimer', async () => {
    const wrapper = await mountSuspended(AdminCommercialPipelinePanel)
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('Panel Comercial de Presupuestos y Cuentas')
    expect(wrapper.find('[data-testid="erp-crm-disclaimer"]').text()).toContain(
      'No sustituye un ERP/CRM empresarial sin decisión'
    )
    expect(wrapper.text()).toContain('Industrias Químicas del Norte S.L.')
    expect(wrapper.find('[data-testid="stage-column-quote_drafted"]').exists()).toBe(true)
  })

  it('displays next action alert and average margin indicators', async () => {
    const wrapper = await mountSuspended(AdminCommercialPipelinePanel)
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('Revisión técnica de incompatibilidades')
    expect(wrapper.text()).toContain('high')
    expect(wrapper.text()).toContain('32.0%')
  })

  it('allows completing a next action', async () => {
    const wrapper = await mountSuspended(AdminCommercialPipelinePanel)
    wrappers.push(wrapper)
    await flushPromises()

    const completeBtn = wrapper.find('[data-testid="btn-complete-action-60000000-0000-4000-8000-000000000001"]')
    expect(completeBtn.exists()).toBe(true)
  })
})
