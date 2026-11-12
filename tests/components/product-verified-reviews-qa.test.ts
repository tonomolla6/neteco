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

    expect(wrapper.text()).toContain('Opiniones y preguntas')
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

  it('requires explicit, unticked consent before publishing a review (GDPR)', async () => {
    mocks.request.mockReset()
    mocks.request.mockImplementation((url: string) => {
      if (url.includes('/reviews')) return Promise.resolve({ items: [], total: 0, averageRating: 0 })
      if (url.includes('/questions')) return Promise.resolve({ items: [], total: 0 })
      return Promise.resolve({ items: [] })
    })
    const wrapper = await mountSuspended(ProductVerifiedReviewsQa, {
      props: { productId: 'p-1', productName: 'Desengrasante Ultra' }
    })
    await flushPromises()
    expect(wrapper.find('#consent-rev').exists()).toBe(false)
    // nothing published yet: the module opens from its one-line invitation
    await wrapper.get('[data-reviews-invite] button').trigger('click')
    await wrapper.find('[data-testid="open-review-form"]').trigger('click')
    const consent = wrapper.find('#consent-rev')
    expect((consent.element as HTMLInputElement).checked).toBe(false)
    const form = wrapper.find('form')
    await form.find('input[type="text"]').setValue('Buen producto')
    await form.find('textarea').setValue('Limpia bien la grasa de la plancha.')
    await consent.setValue(true)
    await form.trigger('submit')
    await flushPromises()
    const post = mocks.request.mock.calls.find(([, options]) => options?.method === 'POST')
    expect(post?.[1]?.body?.consentAccepted).toBe(true)
  })

  it('shows a neutral notice instead of an error alert when Q&A cannot load', async () => {
    mocks.request.mockReset()
    mocks.request.mockImplementation((url: string) => {
      if (url.includes('/reviews')) return Promise.resolve({ items: [], total: 0, averageRating: 0 })
      return Promise.reject(new Error('unavailable'))
    })
    const wrapper = await mountSuspended(ProductVerifiedReviewsQa, {
      props: { productId: 'p-1', productName: 'Desengrasante Ultra' }
    })
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('does not paint an empty reviews module: with nothing published it offers one compact invitation', async () => {
    mocks.request.mockReset()
    mocks.request.mockImplementation((url: string) =>
      Promise.resolve(url.includes('/reviews') ? { items: [], total: 0, averageRating: 0 } : { items: [], total: 0 })
    )
    const wrapper = await mountSuspended(ProductVerifiedReviewsQa, {
      props: { productId: 'p-1', productName: 'Desengrasante Ultra' }
    })
    await flushPromises()
    expect(wrapper.find('[role="tablist"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Opiniones (0)')
    expect(wrapper.text()).not.toContain('Aún no hay opiniones')
    const invite = wrapper.get('[data-reviews-invite]')
    expect(invite.text()).toContain('¿Lo usas?')
    await invite.get('button').trigger('click')
    expect(wrapper.find('[role="tablist"]').exists()).toBe(true)
  })

  it('titles the module in sentence case once there is something to read', async () => {
    mocks.request.mockReset()
    mocks.request.mockImplementation((url: string) =>
      Promise.resolve(url.includes('/reviews') ? sampleReviews : sampleQuestions)
    )
    const wrapper = await mountSuspended(ProductVerifiedReviewsQa, {
      props: { productId: 'p-1', productName: 'Desengrasante Ultra' }
    })
    await flushPromises()
    expect(wrapper.get('h2').text()).toBe('Opiniones y preguntas')
    expect(wrapper.get('section').attributes('aria-label')).toBe('Opiniones y preguntas de clientes')
    expect(wrapper.find('[data-reviews-invite]').exists()).toBe(false)
  })
})
