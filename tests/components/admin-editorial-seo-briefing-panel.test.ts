import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminEditorialSeoBriefingPanel from '../../app/components/AdminEditorialSeoBriefingPanel.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => fetchMock)
mockNuxtImport('$fetch', () => fetchMock)

const sampleBriefings = [
  {
    id: '30000000-0000-4000-8000-000000000101',
    topic: 'Guía de Desinfección Hospitalaria con Amonios Cuaternarios',
    searchIntent: 'informational',
    targetKeyword: 'desinfeccion hospitalaria amonios',
    secondaryKeywords: ['biocidas clinicos'],
    expertAuthor: {
      name: 'Dra. Carmen Rivas',
      credentials: 'Dra. en Química Industrial'
    },
    sources: [
      {
        title: 'Reglamento Biocidas UE 528/2012',
        citation: 'DOUE L 167',
        verified: true
      }
    ],
    assets: [
      {
        assetType: 'infographic',
        name: 'Compatibilidad de polímeros',
        status: 'ready'
      }
    ],
    reviewStatus: 'approved',
    reviewNotes: 'Validado por departamento regulatorio',
    targetPublishDate: '2026-11-15',
    updateCadenceMonths: 6,
    kpiTargets: {
      targetMonthlyVisits: 2500,
      targetSerpRank: 3,
      conversionGoal: 'Lead B2B'
    },
    status: 'scheduled',
    version: 1,
    createdAt: '2026-10-29T10:00:00Z',
    updatedAt: '2026-10-29T10:00:00Z'
  }
]

describe('ADM-029: AdminEditorialSeoBriefingPanel Component', () => {
  let wrappers: Array<{ unmount(): void }> = []

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({
      month: '2026-11',
      timeZone: 'Europe/Madrid',
      briefings: sampleBriefings,
      metrics: {
        totalPlanned: 1,
        totalInReview: 0,
        totalApproved: 1,
        totalPublished: 0
      }
    })
  })

  afterEach(() => {
    wrappers.forEach((w) => w.unmount())
    wrappers = []
  })

  it('renders editorial SEO briefing calendar panel with topic, intent, and expert author', async () => {
    const wrapper = await mountSuspended(AdminEditorialSeoBriefingPanel, {
      props: {
        initialMonth: '2026-11'
      }
    })
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('Calendario Editorial y Briefing SEO')
    expect(wrapper.text()).toContain('Guía de Desinfección Hospitalaria')
    expect(wrapper.text()).toContain('Dra. Carmen Rivas')
    expect(wrapper.text()).toContain('informational')
    expect(wrapper.find('[data-testid="briefing-card"]').exists()).toBe(true)
  })

  it('displays KPI goals and review status badge', async () => {
    const wrapper = await mountSuspended(AdminEditorialSeoBriefingPanel, {
      props: {
        initialMonth: '2026-11'
      }
    })
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('2500')
    expect(wrapper.text()).toContain('approved')
  })

  it('opens briefing creation modal when clicking create button', async () => {
    const wrapper = await mountSuspended(AdminEditorialSeoBriefingPanel, {
      props: {
        initialMonth: '2026-11'
      }
    })
    wrappers.push(wrapper)
    await flushPromises()

    const createBtn = wrapper.find('[data-testid="btn-create-briefing"]')
    expect(createBtn.exists()).toBe(true)
    await createBtn.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="modal-create-briefing"]').exists()).toBe(true)
  })
})
