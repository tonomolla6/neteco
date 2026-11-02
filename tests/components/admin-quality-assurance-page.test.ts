import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminQualityAssurancePage from '../../app/pages/admin/garantia-calidad.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

describe('AdminQualityAssurancePage', () => {
  beforeEach(() => {
    mocks.request.mockResolvedValue({ success: true, summary: { totalCases: 18, passedCases: 18, coverage: {} } })
  })

  it('renders the QA suite page title and mounts the QA suite component', async () => {
    const wrapper = await mountSuspended(AdminQualityAssurancePage)
    await flushPromises()

    expect(wrapper.text()).toContain('Suite de Garantía de Calidad y Tests')
    expect(wrapper.text()).toContain('TST-041')
  })
})
