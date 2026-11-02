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

  it('creates a case with schema-valid operator-entered evidence and a unique command id, never fabricated values', async () => {
    const calls: { url: string; init?: { method?: string; body?: string } }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, init })
        return init?.method === 'POST'
          ? { ok: true, json: async () => ({ id: 'cs-new' }) }
          : { ok: true, json: async () => ({ cases: [], total: 0 }) }
      })
    )
    const wrapper = await mountSuspended(AdminCaseStudyEditor)
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('Nuevo caso de cliente'))!
      .trigger('click')
    await flushPromises()
    const form = wrapper.get('form')
    const fill = async (name: string, value: string) => wrapper.get(`[data-field="${name}"]`).setValue(value)
    for (const [name, value] of Object.entries({
      title: 'Caso de lavandería',
      slug: 'caso-lavanderia',
      companyName: 'Lavandería Turia SL',
      companyCif: 'B12345678',
      signerName: 'Laura Ortiz',
      signerRole: 'Directora',
      documentRef: 'DOC-AUTH-2026-01',
      signedDate: '2026-10-20',
      documentSha256: 'b'.repeat(64),
      evidenceSha256: 'c'.repeat(64),
      facilityDescription: 'Planta de lavado industrial',
      initialSituation: 'Consumo elevado de producto',
      dosageProtocol: 'Dosificación automática',
      solutionSummary: 'Cambio de producto y protocolo'
    }))
      await fill(name, value)
    await wrapper.get('[data-field="publishAuthorized"]').setValue(true)
    await form.trigger('submit')
    await flushPromises()
    const post = calls.find((call) => call.init?.method === 'POST')!
    const body = JSON.parse(post.init!.body!)
    expect(body.signedPermission.signedAt).toBe('2026-10-20T00:00:00Z')
    expect(body.signedPermission.documentSha256).toBe('b'.repeat(64))
    expect(body.signedPermission.publishAuthorized).toBe(true)
    expect(body.verifiableOutcome.evidenceSha256).toBe('c'.repeat(64))
    expect(body.commandId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('does not pre-authorize publication or pre-confirm a periodic review', async () => {
    const wrapper = await mountSuspended(AdminCaseStudyEditor)
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('Nuevo caso de cliente'))!
      .trigger('click')
    await flushPromises()
    expect((wrapper.get('[data-field="publishAuthorized"]').element as HTMLInputElement).checked).toBe(false)
    expect((wrapper.vm as unknown as { confirmedPermissionValid: boolean }).confirmedPermissionValid).toBe(false)
  })
})
