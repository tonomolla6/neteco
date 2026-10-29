import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ProductVerifiedReviewsQa from '../../app/components/ProductVerifiedReviewsQa.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  userSession: vi.fn(() => ({
    loggedIn: { value: true },
    user: { value: { id: 'cust-1', email: 'test@example.com' } }
  }))
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => mocks.userSession)

const sampleReviews = {
  items: [
    {
      id: 'rev-1',
      productId: 'p-1',
      rating: 5,
      title: 'Excelente limpiador industrial',
      content: 'Eficaz eliminando grasas persistentes en maquinaria pesada.',
      isVerifiedBuyer: true,
      displayName: 'Carlos M.',
      createdAt: '2026-10-29T10:00:00Z',
      merchantResponse: 'Gracias por su reseña, nos alegra su satisfacción.',
      merchantRespondedAt: '2026-10-29T11:00:00Z'
    },
    {
      id: 'rev-2',
      productId: 'p-1',
      rating: 4,
      title: 'Buen rendimiento',
      content: 'Cumple lo especificado, aroma agradable.',
      isVerifiedBuyer: false,
      displayName: 'Visitante',
      createdAt: '2026-10-28T10:00:00Z',
      merchantResponse: null,
      merchantRespondedAt: null
    }
  ],
  total: 2,
  averageRating: 4.5
}

const sampleQuestions = {
  items: [
    {
      id: 'q-1',
      productId: 'p-1',
      title: '¿Se puede utilizar en acero inoxidable?',
      content: 'Queremos comprobar si mancha o deja residuo en planchas de acero.',
      isVerifiedBuyer: true,
      displayName: 'Carlos M.',
      createdAt: '2026-10-29T09:00:00Z',
      officialAnswer: 'Sí, es seguro en acero inox aclarando con abundante agua después de 5 minutos.',
      answeredAt: '2026-10-29T10:00:00Z'
    }
  ],
  total: 1
}

describe('PDP-016: ProductVerifiedReviewsQa accessible component', () => {
  it('renders reviews with verified buyer badge only for verified buyers', async () => {
    mocks.request.mockImplementation((url: string) => {
      if (url.includes('/reviews')) return Promise.resolve(sampleReviews)
      if (url.includes('/questions')) return Promise.resolve(sampleQuestions)
      return Promise.resolve({ items: [] })
    })

    const wrapper = await mountSuspended(ProductVerifiedReviewsQa, {
      props: {
        productId: 'p-1',
        productName: 'Desengrasante Ultra'
      }
    })

    await flushPromises()

    expect(wrapper.text()).toContain('Opiniones y Preguntas')
    expect(wrapper.text()).toContain('Excelente limpiador industrial')
    // "Comprador verificado" badge rendered for rev-1
    const verifiedBadges = wrapper.findAll('[data-testid="verified-buyer-badge"]')
    expect(verifiedBadges.length).toBe(1)
    expect(verifiedBadges[0]?.text()).toContain('Comprador verificado')

    // Merchant response is rendered
    expect(wrapper.text()).toContain('Respuesta oficial de Neteco')
    expect(wrapper.text()).toContain('nos alegra su satisfacción')
  })

  it('switches to Q&A tab and displays official answer', async () => {
    mocks.request.mockImplementation((url: string) => {
      if (url.includes('/reviews')) return Promise.resolve(sampleReviews)
      if (url.includes('/questions')) return Promise.resolve(sampleQuestions)
      return Promise.resolve({ items: [] })
    })

    const wrapper = await mountSuspended(ProductVerifiedReviewsQa, {
      props: {
        productId: 'p-1',
        productName: 'Desengrasante Ultra'
      }
    })

    await flushPromises()

    const qaTab = wrapper.find('[data-testid="tab-questions"]')
    expect(qaTab.exists()).toBe(true)
    await qaTab.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('¿Se puede utilizar en acero inoxidable?')
    expect(wrapper.text()).toContain('Respuesta oficial de Neteco')
    expect(wrapper.text()).toContain('seguro en acero inox aclarando')
  })
})
