import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminAnomalyDetectionPanel from '../../app/components/AdminAnomalyDetectionPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const mockAlerts = [
  {
    id: 'a0000000-0000-4000-8000-000000000001',
    dimension: 'conversion',
    metricName: 'checkout_conversion_rate',
    severity: 'critical',
    status: 'open',
    baselineValue: 4.5,
    observedValue: 1.0,
    deviationPercent: 77.78,
    sampleSize: 150,
    thresholdApplied: 50,
    runbookId: 'RB-CONV-001',
    runbookTitle: 'Protocolo de Caída de Conversión en Checkout (RB-CONV-001)',
    summary: 'Caída anómala de 77.78% en checkout_conversion_rate',
    detectedAt: '2026-10-29T12:00:00Z',
    version: 1,
    reviewerId: null,
    reviewedAt: null,
    reviewNotes: null,
    resolutionAction: null,
    createdAt: '2026-10-29T12:00:00Z',
    updatedAt: '2026-10-29T12:00:00Z'
  }
]

const mockPolicies = [
  {
    dimension: 'conversion',
    version: 1,
    warningDropPercent: 25,
    criticalDropPercent: 50,
    minSampleSize: 20,
    evaluationWindowMinutes: 60,
    cooldownMinutes: 60,
    enabled: true,
    updatedAt: '2026-10-29T12:00:00Z',
    updatedBy: '10000000-0000-4000-8000-000000000001'
  }
]

const mockRunbooks = [
  {
    runbookId: 'RB-CONV-001',
    dimension: 'conversion',
    title: 'Protocolo de Caída de Conversión en Checkout (RB-CONV-001)',
    severity: 'critical',
    summary: 'Detección de desplome anómalo en la tasa de conversión respecto a la línea base esperada.',
    immediateActions: ['Verificar estado de salud y latencia del worker de checkout.'],
    diagnosticSteps: ['Comprobar ratio de errores HTTP 4xx y 5xx.'],
    mitigationSteps: ['Rollback inmediato si se asocia a release reciente.'],
    escalationContact: 'oncall-engineering@neteco.es'
  }
]

describe('AdminAnomalyDetectionPanel component (DAT-024)', () => {
  beforeEach(() => {
    mocks.request.mockReset()
  })

  function routeStandard() {
    mocks.request.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PUT') return { appliedVersion: 2 }
      if (opts?.method === 'POST') return { alert: { ...mockAlerts[0], status: 'acknowledged' } }
      if (url.includes('/anomalies/alerts/')) {
        return {
          alert: mockAlerts[0],
          reviews: [],
          runbook: mockRunbooks[0]
        }
      }
      if (url.includes('/anomalies/alerts')) return { items: mockAlerts, total: 1 }
      if (url.includes('/anomalies/policies')) return { policies: mockPolicies }
      if (url.includes('/anomalies/runbooks')) return { runbooks: mockRunbooks }
      return {}
    })
  }

  it('renders anomaly alerts list with dimension, deviation and runbook ID', async () => {
    routeStandard()

    const wrapper = await mountSuspended(AdminAnomalyDetectionPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('checkout_conversion_rate')
    expect(wrapper.text()).toContain('critical')
    expect(wrapper.text()).toContain('-77.78%')
    expect(wrapper.text()).toContain('RB-CONV-001')
    expect(wrapper.text()).toContain('open')
  })

  it('opens modal with runbook instructions and reviews alert', async () => {
    routeStandard()

    const wrapper = await mountSuspended(AdminAnomalyDetectionPanel)
    await flushPromises()

    // Click "Revisar / Runbook"
    const reviewBtn = wrapper.find('button:has-text("Revisar / Runbook")')
    if (reviewBtn.exists()) {
      await reviewBtn.trigger('click')
    } else {
      // Find button in table
      const btn = wrapper.findAll('button').find((b) => b.text().includes('Revisar'))
      expect(btn).toBeDefined()
      await btn!.trigger('click')
    }
    await flushPromises()

    // Modal should be visible with runbook checklist
    expect(wrapper.text()).toContain('Protocolo de Caída de Conversión en Checkout')
    expect(wrapper.text()).toContain('Verificar estado de salud y latencia del worker de checkout.')
    expect(wrapper.text()).toContain('oncall-engineering@neteco.es')

    // Submit review
    const textarea = wrapper.find('textarea')
    expect(textarea.exists()).toBe(true)
    await textarea.setValue('Revisado con SRE, no hay 5xx')

    const submitBtn = wrapper.findAll('button').find((b) => b.text().includes('Guardar revisión'))
    expect(submitBtn).toBeDefined()
    await submitBtn!.trigger('click')
    await flushPromises()

    const reviewCall = mocks.request.mock.calls.find(
      ([url, opts]) => String(url).includes('/review') && opts?.method === 'POST'
    )
    expect(reviewCall).toBeDefined()
  })

  it('displays empty state when no alerts exist', async () => {
    mocks.request.mockImplementation(async (url: string) => {
      if (url.includes('/anomalies/alerts')) return { items: [], total: 0 }
      if (url.includes('/anomalies/policies')) return { policies: mockPolicies }
      if (url.includes('/anomalies/runbooks')) return { runbooks: mockRunbooks }
      return {}
    })

    const wrapper = await mountSuspended(AdminAnomalyDetectionPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('No se detectaron alertas de anomalías')
  })

  it('displays error notice on load failure', async () => {
    mocks.request.mockRejectedValueOnce({ data: { error: { code: 'forbidden' } } })

    const wrapper = await mountSuspended(AdminAnomalyDetectionPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('forbidden')
  })
})
