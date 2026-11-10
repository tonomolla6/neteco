import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import DownloadableTemplatesPanel from '../../app/components/DownloadableTemplatesPanel.vue'
import '#app/nuxt-vitest-app-entry'

const MOCK_RESPONSE = {
  source: 'cloudflare',
  items: [
    {
      id: '10000000-0000-4000-8000-000000000001',
      slug: 'checklist-appcc-cocinas',
      title: 'Checklist de Autocontrol APPCC en Cocinas',
      description: 'Control diario de temperaturas y desinfección.',
      templateType: 'checklist',
      category: 'hosteleria',
      targetAudience: 'Jefes de cocina',
      version: 1,
      publishedAt: '2026-10-29T12:00:00Z',
      canonicalPath: '/plantillas/checklist-appcc-cocinas',
      downloadUrl: '/api/templates/checklist-appcc-cocinas/pdf',
      itemCount: 8,
      indexable: true
    }
  ],
  total: 1,
  page: 1,
  perPage: 20,
  pages: 1,
  categories: ['hosteleria', 'industria', 'sanitario', 'lavanderia', 'alimentaria', 'mantenimiento'],
  types: ['checklist', 'plan', 'guide'],
  canonicalPath: '/plantillas',
  indexable: true
}

registerEndpoint('/api/templates', () => MOCK_RESPONSE)

describe('DownloadableTemplatesPanel component (MED-019)', () => {
  it('renders templates list with accessible titles and PDF download links', async () => {
    const wrapper = await mountSuspended(DownloadableTemplatesPanel)
    await vi.waitFor(() => expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false))
    await flushPromises()

    expect(wrapper.find('[data-testid="downloadable-templates-panel"]').exists()).toBe(true)

    const text = wrapper.text()
    expect(text).toContain('Biblioteca de plantillas descargables')
    expect(text).not.toContain('Documentación Oficial y Guías Técnicas')
    expect(text).toContain('Checklist de Autocontrol APPCC en Cocinas')
    expect(text).toContain('Descargar PDF')

    const downloadLink = wrapper.find('a[download]')
    expect(downloadLink.exists()).toBe(true)
    expect(downloadLink.attributes('href')).toBe('/api/templates/checklist-appcc-cocinas/pdf')
  })

  it('renders neutral message without role="alert" when API is 404/disabled', async () => {
    registerEndpoint('/api/templates', () => {
      throw createError({
        statusCode: 404,
        statusMessage: 'Feature disabled',
        data: { error: { code: 'feature_disabled' } }
      })
    })
    const wrapper = await mountSuspended(DownloadableTemplatesPanel)
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Esta sección estará disponible próximamente')
  })
})
