import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminCaseStudyEditor from '../../app/components/AdminCaseStudyEditor.vue'
import '#app/nuxt-vitest-app-entry'

const adminSampleCase = {
  id: 'cs-admin-1',
  slug: 'caso-admin-test',
  title: 'Caso de Prueba Admin',
  publicationStatus: 'draft',
  reviewStatus: 'current',
  nextReviewDueAt: '2027-10-29T10:00:00Z',
  version: 1,
  signedPermission: {
    companyName: 'Empresa Test S.L.',
    companyCif: 'B11223344',
    signerName: 'Laura Ortiz'
  }
}

describe('AdminCaseStudyEditor.vue Component', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/admin/case-studies')) {
          return {
            ok: true,
            json: async () => ({
              cases: [adminSampleCase],
              total: 1
            })
          }
        }
        return { ok: true, json: async () => ({ success: true }) }
      })
    )
  })

  it('renders admin management table with cases and review statuses', async () => {
    const wrapper = await mountSuspended(AdminCaseStudyEditor)
    await flushPromises()

    expect(wrapper.text()).toContain('Gestión de Casos de Éxito de Clientes')
    expect(wrapper.text()).toContain('Caso de Prueba Admin')
    expect(wrapper.text()).toContain('Empresa Test S.L.')
    expect(wrapper.text()).toContain('draft')
    expect(wrapper.text()).toContain('Publicar')
    expect(wrapper.text()).toContain('Revisión periódica')
  })

  it('switches to creation form on "+ Nuevo caso de cliente" click', async () => {
    const wrapper = await mountSuspended(AdminCaseStudyEditor)
    await flushPromises()

    const newBtn = wrapper.findAll('button').find((b) => b.text().includes('Nuevo caso de cliente'))
    expect(newBtn).toBeDefined()
    await newBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Crear caso de cliente con evidencia')
    expect(wrapper.text()).toContain('Permiso Firmado por el Cliente')
    expect(wrapper.text()).toContain('Contexto, Solución y Métricas Verificables')
  })
})
