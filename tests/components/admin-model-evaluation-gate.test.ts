import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminModelEvaluationGate from '../../app/components/AdminModelEvaluationGate.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const mockModels = [
  {
    id: 'mod-margin-retention-01',
    modelName: 'B2B Margin & Repurchase Optimizer',
    modelVersion: '1.2.0',
    modelType: 'margin_recommendation',
    status: 'gate_passed',
    objective: 'margin_retention',
    weights: { margin: 0.5, retention: 0.3, clicks: 0.2 },
    fallbackStrategy: 'static_bestsellers',
    version: 1,
    createdAt: '2026-10-29T10:00:00Z',
    updatedAt: '2026-10-29T10:00:00Z'
  }
]

const mockSummary = {
  offline: {
    id: 'off-1',
    modelId: 'mod-margin-retention-01',
    evalType: 'offline',
    metrics: { rocAuc: 0.89, precisionAtK: 0.83 },
    driftPsi: 0.04,
    biasDisparateImpact: 0.95,
    marginLiftPercent: 14.2,
    retentionLiftPercent: 0,
    status: 'healthy',
    sampleSize: 10000,
    createdAt: '2026-10-29T10:00:00Z'
  },
  online: {
    id: 'on-1',
    modelId: 'mod-margin-retention-01',
    evalType: 'online',
    metrics: { ctr: 0.082, conversionRate: 0.039 },
    driftPsi: 0.05,
    biasDisparateImpact: 0.93,
    marginLiftPercent: 12.5,
    retentionLiftPercent: 7.8,
    status: 'healthy',
    sampleSize: 25000,
    createdAt: '2026-10-29T10:00:00Z'
  },
  healthy: true
}

describe('AdminModelEvaluationGate.vue', () => {
  beforeEach(() => mocks.request.mockReset())

  it('renders models list, multi-objective weights, and offline/online monitors', async () => {
    mocks.request.mockImplementation((url: unknown) => {
      const u = typeof url === 'string' ? url : ''
      if (u.includes('/models')) return Promise.resolve({ models: mockModels })
      if (u.includes('/summary')) return Promise.resolve({ summary: mockSummary })
      return Promise.resolve({})
    })

    const wrapper = await mountSuspended(AdminModelEvaluationGate)
    await flushPromises()

    expect(wrapper.text()).toContain('Evaluación Continua de IA y Modelos ML')
    expect(wrapper.text()).toContain('B2B Margin & Repurchase Optimizer')
    expect(wrapper.text()).toContain('50%') // Margin weight
    expect(wrapper.text()).toContain('30%') // Retention weight
    expect(wrapper.text()).toContain('20%') // Clicks weight
    expect(wrapper.text()).toContain('0.89') // ROC-AUC
  })

  it('executes golden set evaluation and displays quality gate results', async () => {
    mocks.request.mockImplementation((url: unknown, opts?: { method?: string; body?: unknown }) => {
      const u = typeof url === 'string' ? url : ''
      if (opts?.method === 'POST' && u.includes('/golden-set/run')) {
        return Promise.resolve({
          run: {
            id: 'run-123',
            modelId: 'mod-margin-retention-01',
            suiteName: 'neteco_chemical_golden_suite_v1',
            factualityScore: 0.98,
            safetyScore: 1.0,
            safetyViolationsCount: 0,
            biasDisparateImpact: 0.96,
            driftPsi: 0.04,
            latencyP50Ms: 42,
            latencyP95Ms: 88,
            costEstimateEur: 0.001,
            fallbackTested: 1,
            fallbackPassed: 1,
            gateVerdict: 'passed',
            gateReasons: [],
            createdAt: '2026-10-29T12:00:00Z'
          }
        })
      }
      if (u.includes('/models')) return Promise.resolve({ models: mockModels })
      if (u.includes('/summary')) return Promise.resolve({ summary: mockSummary })
      return Promise.resolve({})
    })

    const wrapper = await mountSuspended(AdminModelEvaluationGate)
    await flushPromises()

    const btn = wrapper.find('[data-test="run-golden-set-btn"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="quality-gate-results"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('VEREDICTO: PASSED')
    expect(wrapper.text()).toContain('100% (0 Violaciones)')
    expect(wrapper.text()).toContain('88 ms')
  })
})
