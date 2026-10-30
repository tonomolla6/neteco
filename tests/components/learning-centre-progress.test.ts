import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LearningCentreProgress from '../../app/components/LearningCentreProgress.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const mockCourseData = {
  course: {
    id: 'crs-1',
    slug: 'manejo-seguro-quimicos',
    title: 'Manejo Seguro de Químicos y FDS en Lavandería Industrial',
    description: 'Protocolos de manipulación segura de peróxidos y álcalis.',
    category: 'chemical_safety',
    targetSector: 'lavanderia_industrial',
    estimatedDurationMinutes: 45,
    passingScorePercent: 80,
    status: 'published',
    version: 1,
    createdAt: '2026-10-29T10:00:00Z',
    updatedAt: '2026-10-29T10:00:00Z',
    lessons: [
      {
        id: 'lsn-1',
        courseId: 'crs-1',
        sortOrder: 1,
        slug: 'lectura-fds-y-epis',
        title: 'Interpretación de Fichas de Datos de Seguridad (FDS)',
        summary: 'Pictogramas de peligro y selección de EPIs adecuados.',
        contentMarkdown: '# FDS\nUso obligatorio de gafas y guantes de nitrilo.',
        linkedProductIds: ['prod-detergente-alcalino'],
        supportTopic: 'Seguridad Química',
        supportActionLabel: 'Contactar Especialista Químico',
        supportActionUrl: '/soporte/contacto-tecnico?asunto=seguridad',
        quizQuestions: [
          {
            id: 'q1',
            question: '¿Qué EPI es obligatorio para álcalis?',
            options: [
              { id: 'opt-a', text: 'Guantes de nitrilo y gafas' },
              { id: 'opt-b', text: 'Sin protección' }
            ],
            correctOptionId: 'opt-a',
            explanation: 'Protección ocular y dérmica obligatoria.'
          }
        ],
        progress: {
          quizScorePercent: 100,
          passed: true,
          completedAt: '2026-10-29T11:00:00Z'
        }
      }
    ]
  }
}

describe('LearningCentreProgress.vue', () => {
  beforeEach(() => mocks.request.mockReset())

  it('renders loading state, course details, lessons and non-official disclaimer', async () => {
    mocks.request.mockResolvedValueOnce(mockCourseData)

    const wrapper = await mountSuspended(LearningCentreProgress, {
      props: { courseSlug: 'manejo-seguro-quimicos' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Manejo Seguro de Químicos')
    expect(wrapper.text()).toContain('Interpretación de Fichas de Datos de Seguridad')
    expect(wrapper.text()).toContain('Contactar Especialista Químico')
    expect(wrapper.text()).toContain('sin valor de titulación oficial')
  })

  it('handles error state and provides retry capability', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Network error'))

    const wrapper = await mountSuspended(LearningCentreProgress, {
      props: { courseSlug: 'curso-inexistente' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Error al cargar')
    const retryBtn = wrapper.find('button[data-test="retry-btn"]')
    expect(retryBtn.exists()).toBe(true)

    mocks.request.mockResolvedValueOnce(mockCourseData)
    await retryBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Manejo Seguro de Químicos')
  })
})
