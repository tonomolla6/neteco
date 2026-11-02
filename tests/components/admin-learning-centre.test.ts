import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminLearningCentre from '../../app/components/AdminLearningCentre.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const sampleCourses = {
  courses: [
    {
      id: 'course-1',
      slug: 'manipulacion-quimica-segura',
      title: 'Manipulación Segura de Productos Químicos',
      description: 'Buenas prácticas y normativa ADR para almacenistas y operarios de limpieza industrial.',
      passingScorePercent: 80,
      status: 'published',
      modulesCount: 3,
      durationMinutes: 45
    }
  ]
}

const apiError = (code: string) => Object.assign(new Error(code), { data: { error: { code } } })

const mount = async () => {
  const wrapper = await mountSuspended(AdminLearningCentre)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  mocks.request.mockReset()
})

describe('AdminLearningCentre (MKT-033)', () => {
  it('loads and lists courses', async () => {
    mocks.request.mockResolvedValueOnce(sampleCourses)
    const wrapper = await mount()

    expect(wrapper.text()).toContain('Centro de formación y aprendizaje')
    expect(wrapper.text()).toContain('Manipulación Segura de Productos Químicos')
    expect(wrapper.text()).toContain('45 min')
  })

  it('shows error state when courses fetch fails', async () => {
    mocks.request.mockRejectedValueOnce(apiError('unauthorized'))
    const wrapper = await mount()

    expect(wrapper.find('[role="alert"]').text()).toContain('unauthorized')
  })

  it('creates a new course successfully', async () => {
    mocks.request.mockResolvedValueOnce(sampleCourses)
    const wrapper = await mount()

    mocks.request
      .mockResolvedValueOnce({
        course: {
          id: 'course-2',
          slug: 'dilucion-segura-desengrasantes',
          title: 'Guía de Dilución y Seguridad en Desengrasantes',
          status: 'draft'
        }
      })
      .mockResolvedValueOnce({
        courses: [
          ...sampleCourses.courses,
          {
            id: 'course-2',
            slug: 'dilucion-segura-desengrasantes',
            title: 'Guía de Dilución y Seguridad en Desengrasantes',
            description: 'Dosificación óptima según norma de vertido.',
            passingScorePercent: 75,
            status: 'draft',
            modulesCount: 2,
            durationMinutes: 30
          }
        ]
      })

    await wrapper.find('[data-test="course-title"]').setValue('Guía de Dilución y Seguridad en Desengrasantes')
    await wrapper.find('[data-test="course-slug"]').setValue('dilucion-segura-desengrasantes')
    await wrapper.find('[data-test="course-desc"]').setValue('Dosificación óptima según norma de vertido.')
    await wrapper.find('[data-test="save-course-btn"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="notice"]').text()).toContain('creado con éxito')
  })
})
