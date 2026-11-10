import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import BrandCenterPanel from '../../app/components/BrandCenterPanel.vue'
import '#app/nuxt-vitest-app-entry'

const MOCK_BRAND_CENTER = {
  source: 'cloudflare',
  brandAssets: [
    {
      id: '20000000-0000-4000-8000-000000000001',
      name: 'Logotipo Maestro Vectorial',
      category: 'logo',
      format: 'svg',
      variant: 'primary',
      url: '/assets/brand/neteco.svg',
      minClearspacePx: 24,
      prohibitedUses: ['No alterar proporciones'],
      status: 'active',
      version: 1,
      updatedAt: '2026-10-29T12:00:00Z'
    }
  ],
  certifications: [
    {
      id: '30000000-0000-4000-8000-000000000001',
      standardCode: 'ISO-9001',
      title: 'Sistema de Gestión de la Calidad ISO 9001:2015',
      issuer: 'AENOR',
      certificateNumber: 'ER-0428/2021',
      scope: 'Fabricación y envasado de productos químicos de limpieza profesional.',
      validFrom: '2026-10-29T12:00:00Z',
      validUntil: '2028-10-29T12:00:00Z',
      verificationUrl: 'https://certificados.aenor.com/verificacion?cert=ER-0428/2021',
      documentUrl: '/media/certificados/iso9001.pdf',
      status: 'active',
      version: 1,
      auditedBy: 'Auditor Jefe AENOR ENAC',
      createdAt: '2026-10-29T12:00:00Z',
      updatedAt: '2026-10-29T12:00:00Z'
    }
  ],
  authorizations: [
    {
      id: '40000000-0000-4000-8000-000000000001',
      partnerName: 'Distribuidor Químico Autorizado',
      authorizedDomain: 'distribuidor.es',
      scope: 'distribuidor_oficial',
      status: 'active',
      validFrom: '2026-10-29T12:00:00Z',
      validUntil: '2028-10-29T12:00:00Z',
      authorizedBy: '10000000-0000-4000-8000-000000000019',
      createdAt: '2026-10-29T12:00:00Z',
      updatedAt: '2026-10-29T12:00:00Z'
    }
  ],
  usageGuidelines: {
    generalRules: ['Utilizar únicamente archivos vectoriales oficiales.'],
    minimumClearspaceFormula: 'X = Altura del imagotipo.',
    unauthorizedPractices: ['Prohibido el uso de sellos ecológicos vagos sin acreditación.']
  },
  generatedAt: '2026-10-29T12:00:00Z'
}

registerEndpoint('/api/brand-center', () => MOCK_BRAND_CENTER)
registerEndpoint('/api/brand-center/verify/ER-0428%2F2021', () => MOCK_BRAND_CENTER.certifications[0])

describe('BrandCenterPanel component (MED-021)', () => {
  it('renders official certifications, verifiable links, and anti-greenwashing banner', async () => {
    const wrapper = await mountSuspended(BrandCenterPanel)
    await vi.waitFor(() => expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false))
    await flushPromises()

    expect(wrapper.find('[data-testid="brand-center-panel"]').exists()).toBe(true)

    const text = wrapper.text()
    expect(text).toContain('Centro de marca y certificaciones oficiales')
    expect(text).toContain('Política de tolerancia cero con sellos vagos y greenwashing')
    expect(text).not.toContain('Transparencia y Garantía Oficial')
    expect(text).toContain('ISO-9001')
    expect(text).toContain('AENOR')
    expect(text).toContain('ER-0428/2021')

    const extLink = wrapper.find('a[href*="certificados.aenor.com"]')
    expect(extLink.exists()).toBe(true)
    expect(extLink.attributes('target')).toBe('_blank')
    expect(extLink.attributes('rel')).toContain('noopener')
  })

  it('renders neutral message without role="alert" when API is 404/disabled', async () => {
    registerEndpoint('/api/brand-center', () => {
      throw createError({
        statusCode: 404,
        statusMessage: 'Feature disabled',
        data: { error: { code: 'feature_disabled' } }
      })
    })
    const wrapper = await mountSuspended(BrandCenterPanel)
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Esta sección estará disponible próximamente')
  })
})
