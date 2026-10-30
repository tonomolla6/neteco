import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminUgcModeration from '../../app/components/AdminUgcModeration.vue'
import '#app/nuxt-vitest-app-entry'

const adminSampleReviews = [
  {
    id: 'rev-mod-1',
    productId: 'prod-alk-5l',
    rating: 5,
    title: 'Buen desengrasante pero pongo teléfono',
    content: 'Llamadme al 612345678 para más datos.',
    displayName: 'Taller Alfa',
    isVerifiedBuyer: true,
    moderationStatus: 'pending',
    hasIncentive: false,
    incentiveType: 'none',
    hiddenIncentiveSuspected: false,
    piiDetected: true,
    piiDetails: [{ type: 'phone', match: '612345678' }],
    piiRedactedContent: 'Llamadme al [TELÉFONO REDACTADO] para más datos.',
    version: 1,
    photos: [
      {
        id: 'photo-1',
        photoUrl: 'https://media.neteco.es/p1.png',
        mimeType: 'image/png',
        width: 800,
        height: 600,
        antivirusStatus: 'clean',
        moderationStatus: 'pending'
      }
    ],
    createdAt: '2026-10-29T10:00:00Z'
  }
]

describe('AdminUgcModeration.vue Component', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/admin/ugc-reviews')) {
          return {
            ok: true,
            json: async () => ({
              reviews: adminSampleReviews,
              total: 1
            })
          }
        }
        return { ok: true, json: async () => ({ success: true }) }
      })
    )
  })

  it('renders moderation workbench with tabs, PII alert, and antivirus indicator', async () => {
    const wrapper = await mountSuspended(AdminUgcModeration)
    await flushPromises()

    expect(wrapper.text()).toContain('Moderación de UGC y Reseñas con Fotos')
    expect(wrapper.text()).toContain('Pendientes de moderación')
    expect(wrapper.text()).toContain('Datos de identificación personal detectados en el texto')
    expect(wrapper.text()).toContain('🛡️ Antivirus: clean')
    expect(wrapper.text()).toContain('Aprobar')
    expect(wrapper.text()).toContain('Rechazar')
    expect(wrapper.text()).toContain('Cuarentena')
  })

  it('triggers moderation action and displays confirmation notice', async () => {
    const wrapper = await mountSuspended(AdminUgcModeration)
    await flushPromises()

    const approveBtn = wrapper.findAll('button').find((b) => b.text().includes('Aprobar'))
    expect(approveBtn).toBeDefined()
    await approveBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('procesada con acción "approve"')
  })
})
