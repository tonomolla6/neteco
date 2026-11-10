import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CustomerCaseStudiesList from '../../app/components/CustomerCaseStudiesList.vue'
import '#app/nuxt-vitest-app-entry'

const sampleCases = [
  {
    id: 'cs-1',
    slug: 'caso-lavanderias-turia',
    title: 'Descarbonización en Lavanderías del Turia',
    subtitle: 'Reducción del 35% de costes de lavado',
    sector: 'Lavandería Industrial',
    facilityDescription: 'Planta de 4.000m² con 2 túneles continuos',
    initialSituation: 'Pérdidas continuas por manchas e incrustaciones',
    solutionSummary: 'Instalación de central de dosificación telemétrica',
    dosageProtocol: 'Dosificación peristáltica a 4.2 ml/kg',
    implementationDurationWeeks: 3,
    outcomeMetrics: [
      {
        metric: 'Ahorro económico',
        before: 5800,
        after: 3770,
        unit: 'EUR/mes',
        improvementPercent: 35.0
      }
    ],
    verifierIdentity: 'Instituto Tecnológico Textil Levante',
    verificationMethod: 'Auditoría gravimétrica ISO 2267',
    customerAuthorizationStatement: 'Publicación expresamente autorizada por Lavanderías Industriales del Turia S.L.',
    reviewValidUntil: '2027-10-29T10:00:00Z',
    publishedAt: '2026-10-29T10:00:00Z'
  }
]

describe('CustomerCaseStudiesList.vue Component', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/case-studies')) {
          return {
            ok: true,
            json: async () => ({
              cases: sampleCases,
              total: 1
            })
          }
        }
        return { ok: false, json: async () => ({ error: { code: 'not_found' } }) }
      })
    )
  })

  it('renders case studies list with verified metrics and customer authorization statement', async () => {
    const wrapper = await mountSuspended(CustomerCaseStudiesList)
    await flushPromises()

    expect(wrapper.text()).toContain('Casos de éxito de clientes Neteco')
    expect(wrapper.text()).not.toContain('✓ Evidencia empírica verificada')
    expect(wrapper.text()).toContain('Descarbonización en Lavanderías del Turia')
    expect(wrapper.text()).toContain('-35%')
    expect(wrapper.text()).toContain('Ahorro económico')
    expect(wrapper.text()).toContain('Lavanderías Industriales del Turia S.L.')
    expect(wrapper.text()).toContain('Instituto Tecnológico Textil Levante')
  })

  it('renders a neutral notice without role="alert" when API is 404/disabled, never internal code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: { code: 'feature_disabled' } })
      }))
    )
    const wrapper = await mountSuspended(CustomerCaseStudiesList)
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Esta sección estará disponible próximamente')
    expect(wrapper.text()).not.toContain('error_loading_cases')
  })

  it('verifies strict absence of community comment forms and social profile links (MKT-031)', async () => {
    const wrapper = await mountSuspended(CustomerCaseStudiesList)
    await flushPromises()

    // Assert that no comments textarea, like buttons, or social feed widgets exist
    expect(wrapper.find('textarea[name="comment"]').exists()).toBe(false)
    expect(wrapper.find('button.like-btn').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Dejar un comentario')
    expect(wrapper.text()).not.toContain('Seguidores')
  })

  it('opens detailed case study modal on click', async () => {
    const wrapper = await mountSuspended(CustomerCaseStudiesList)
    await flushPromises()

    const openBtn = wrapper.findAll('button').find((b) => b.text().includes('Ver estudio técnico completo'))
    expect(openBtn).toBeDefined()
    await openBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Contexto e Instalaciones')
    expect(wrapper.text()).toContain('Solución y Protocolo de Dosificación')
    expect(wrapper.text()).toContain('Resultados Verificables Contrastados')
    expect(wrapper.text()).toContain('Cerrar estudio')
  })
})
