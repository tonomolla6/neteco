import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminGameDayPanel from '../../app/components/AdminGameDayPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const mockDrill = {
  id: '70000000-0000-4000-8000-000000000001',
  cohort: 'Campaña Masiva B2B 2026 - 3x Tráfico',
  status: 'passed',
  expansionGate: 'approved',
  leadEngineerId: '10000000-0000-4000-8000-000000000001',
  scenariosTotal: 7,
  scenariosPassed: 7,
  scenariosFailed: 0,
  version: 2,
  notes: 'Simulacro exitoso previo a Black Friday B2B',
  startedAt: '2026-10-25T10:00:00Z',
  completedAt: '2026-10-25T11:30:00Z',
  scenarios: [
    {
      id: '80000000-0000-4000-8000-000000000001',
      scenarioId: 'beply_outage',
      targetDetectionSeconds: 60,
      actualDetectionSeconds: 25,
      targetRecoverySeconds: 300,
      actualRecoverySeconds: 120,
      targetDataLossSeconds: 0,
      actualDataLossSeconds: 0,
      alertTriggered: true,
      alertSeverity: 'critical',
      alertChannel: 'pagerduty',
      rollbackRestoreStatus: 'restore_completed',
      coordinationStatus: 'completed',
      runbookReference: 'RB-GAME-BEPLY',
      status: 'passed',
      evaluatedAt: '2026-10-25T10:15:00Z'
    },
    {
      id: '80000000-0000-4000-8000-000000000002',
      scenarioId: 'carrier_outage',
      targetDetectionSeconds: 60,
      actualDetectionSeconds: 40,
      targetRecoverySeconds: 300,
      actualRecoverySeconds: 150,
      targetDataLossSeconds: 0,
      actualDataLossSeconds: 0,
      alertTriggered: true,
      alertSeverity: 'warning',
      alertChannel: 'slack_sre',
      rollbackRestoreStatus: 'not_needed',
      coordinationStatus: 'completed',
      runbookReference: 'RB-GAME-CARRIER',
      status: 'passed',
      evaluatedAt: '2026-10-25T10:25:00Z'
    },
    {
      id: '80000000-0000-4000-8000-000000000003',
      scenarioId: 'd1_outage',
      targetDetectionSeconds: 30,
      actualDetectionSeconds: 15,
      targetRecoverySeconds: 180,
      actualRecoverySeconds: 80,
      targetDataLossSeconds: 0,
      actualDataLossSeconds: 0,
      alertTriggered: true,
      alertSeverity: 'critical',
      alertChannel: 'pagerduty',
      rollbackRestoreStatus: 'restore_completed',
      coordinationStatus: 'completed',
      runbookReference: 'RB-GAME-D1',
      status: 'passed',
      evaluatedAt: '2026-10-25T10:35:00Z'
    },
    {
      id: '80000000-0000-4000-8000-000000000004',
      scenarioId: 'durable_object_outage',
      targetDetectionSeconds: 30,
      actualDetectionSeconds: 12,
      targetRecoverySeconds: 120,
      actualRecoverySeconds: 45,
      targetDataLossSeconds: 0,
      actualDataLossSeconds: 0,
      alertTriggered: true,
      alertSeverity: 'critical',
      alertChannel: 'pagerduty',
      rollbackRestoreStatus: 'restore_completed',
      coordinationStatus: 'completed',
      runbookReference: 'RB-GAME-DO',
      status: 'passed',
      evaluatedAt: '2026-10-25T10:45:00Z'
    },
    {
      id: '80000000-0000-4000-8000-000000000005',
      scenarioId: 'queue_outage',
      targetDetectionSeconds: 60,
      actualDetectionSeconds: 35,
      targetRecoverySeconds: 300,
      actualRecoverySeconds: 110,
      targetDataLossSeconds: 0,
      actualDataLossSeconds: 0,
      alertTriggered: true,
      alertSeverity: 'warning',
      alertChannel: 'slack_sre',
      rollbackRestoreStatus: 'not_needed',
      coordinationStatus: 'completed',
      runbookReference: 'RB-GAME-QUEUE',
      status: 'passed',
      evaluatedAt: '2026-10-25T10:55:00Z'
    },
    {
      id: '80000000-0000-4000-8000-000000000006',
      scenarioId: 'r2_outage',
      targetDetectionSeconds: 60,
      actualDetectionSeconds: 20,
      targetRecoverySeconds: 180,
      actualRecoverySeconds: 90,
      targetDataLossSeconds: 0,
      actualDataLossSeconds: 0,
      alertTriggered: true,
      alertSeverity: 'warning',
      alertChannel: 'slack_sre',
      rollbackRestoreStatus: 'not_needed',
      coordinationStatus: 'completed',
      runbookReference: 'RB-GAME-R2',
      status: 'passed',
      evaluatedAt: '2026-10-25T11:05:00Z'
    },
    {
      id: '80000000-0000-4000-8000-000000000007',
      scenarioId: 'worker_deployment_failure',
      targetDetectionSeconds: 30,
      actualDetectionSeconds: 18,
      targetRecoverySeconds: 120,
      actualRecoverySeconds: 65,
      targetDataLossSeconds: 0,
      actualDataLossSeconds: 0,
      alertTriggered: true,
      alertSeverity: 'critical',
      alertChannel: 'pagerduty',
      rollbackRestoreStatus: 'rollback_executed',
      coordinationStatus: 'completed',
      runbookReference: 'RB-GAME-WORKER',
      status: 'passed',
      evaluatedAt: '2026-10-25T11:15:00Z'
    }
  ]
}

const mockGate = {
  status: 'approved',
  approved: true,
  latestDrillId: mockDrill.id,
  completedAt: '2026-10-25T11:30:00Z',
  freshnessDays: 6,
  scenariosTotal: 7,
  scenariosPassed: 7,
  scenariosFailed: 0,
  reasons: []
}

describe('AdminGameDayPanel Component (OBS-024)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders Traffic Expansion Gate status banner and drills list', async () => {
    mocks.request.mockImplementation((url: string) => {
      if (url.includes('/gate')) return Promise.resolve(mockGate)
      if (url.includes('/drills')) return Promise.resolve({ drills: [mockDrill] })
      return Promise.resolve({})
    })

    const wrapper = await mountSuspended(AdminGameDayPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('Game Day y Puerta de Tráfico (OBS-024)')
    expect(wrapper.text()).toContain('AMPLIACIÓN AUTORIZADA')
    expect(wrapper.text()).toContain('Campaña Masiva B2B 2026 - 3x Tráfico')
    expect(wrapper.text()).toContain('7 de 7')
  })

  it('displays all 7 governed fault scenarios with target comparisons', async () => {
    mocks.request.mockImplementation((url: string) => {
      if (url.includes('/gate')) return Promise.resolve(mockGate)
      if (url.includes('/drills/')) return Promise.resolve({ drill: mockDrill })
      if (url.includes('/drills')) return Promise.resolve({ drills: [mockDrill] })
      return Promise.resolve({})
    })

    const wrapper = await mountSuspended(AdminGameDayPanel)
    await flushPromises()

    // Scenarios should appear
    expect(wrapper.text()).toContain('Caída Beply ERP')
    expect(wrapper.text()).toContain('Caída Transportista')
    expect(wrapper.text()).toContain('Caída Base Datos D1')
    expect(wrapper.text()).toContain('Caída Durable Object')
    expect(wrapper.text()).toContain('Saturación Colas Queue')
    expect(wrapper.text()).toContain('Caída Almacenamiento R2')
    expect(wrapper.text()).toContain('Fallo Despliegue Worker')

    // Comparison details
    expect(wrapper.text()).toContain('RB-GAME-BEPLY')
    expect(wrapper.text()).toContain('RB-GAME-WORKER')
    expect(wrapper.text()).toContain('pagerduty')
    expect(wrapper.text()).toContain('rollback_executed')
  })

  it('renders empty state when no drills exist', async () => {
    mocks.request.mockImplementation((url: string) => {
      if (url.includes('/gate')) {
        return Promise.resolve({
          status: 'blocked',
          approved: false,
          latestDrillId: null,
          freshnessDays: null,
          scenariosTotal: 0,
          scenariosPassed: 0,
          scenariosFailed: 0,
          reasons: ['no_drills_executed']
        })
      }
      if (url.includes('/drills')) return Promise.resolve({ drills: [] })
      return Promise.resolve({})
    })

    const wrapper = await mountSuspended(AdminGameDayPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('No se han registrado simulacros de Game Day.')
    expect(wrapper.text()).toContain('BLOQUEADA')
  })

  it('displays error state when request fails', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Network error loading game day'))

    const wrapper = await mountSuspended(AdminGameDayPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('Error al cargar la información de Game Day')
  })
})
