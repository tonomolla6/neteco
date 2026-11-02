import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminSearchGapProgramme from '../../app/components/AdminSearchGapProgramme.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const sampleBacklog = {
  source: 'cloudflare',
  items: [
    {
      term: 'lejia concentrada',
      searches: 120,
      zeroResults: 110,
      zeroRate: 0.916,
      existingAction: 'none'
    }
  ]
}

const sampleCases = {
  source: 'cloudflare',
  items: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      termNormalized: 'cloro pastillas',
      termDisplay: 'cloro pastillas',
      status: 'open',
      actionType: null,
      baselineZeroRate: 0.85,
      outcomeZeroRate: null,
      verdict: null,
      version: 1,
      createdAt: '2026-11-01T10:00:00Z',
      updatedAt: '2026-11-01T10:00:00Z'
    }
  ]
}

const apiError = (code: string) => Object.assign(new Error(code), { data: { error: { code } } })

const mount = async () => {
  const wrapper = await mountSuspended(AdminSearchGapProgramme)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  mocks.request.mockReset()
})

describe('AdminSearchGapProgramme (SEO-025)', () => {
  it('loads backlog and open cases', async () => {
    mocks.request.mockResolvedValueOnce(sampleBacklog).mockResolvedValueOnce(sampleCases)

    const wrapper = await mount()
    expect(wrapper.text()).toContain('Programa de búsquedas sin resultado')
    expect(wrapper.text()).toContain('lejia concentrada')
    expect(wrapper.text()).toContain('cloro pastillas')
    expect(wrapper.text()).toContain('91.6%')
  })

  it('shows error state when backlog fails', async () => {
    mocks.request.mockRejectedValueOnce(apiError('forbidden'))
    const wrapper = await mount()
    expect(wrapper.find('[role="alert"]').text()).toContain('forbidden')
  })

  it('opens a case from a backlog term', async () => {
    mocks.request.mockResolvedValueOnce(sampleBacklog).mockResolvedValueOnce(sampleCases)

    const wrapper = await mount()

    mocks.request
      .mockResolvedValueOnce({
        item: {
          id: '22222222-2222-4222-8222-222222222222',
          termNormalized: 'lejia concentrada',
          termDisplay: 'lejia concentrada',
          status: 'open',
          actionType: null,
          baselineZeroRate: 0.916,
          outcomeZeroRate: null,
          verdict: null,
          version: 1,
          createdAt: '2026-11-01T10:00:00Z',
          updatedAt: '2026-11-01T10:00:00Z'
        }
      })
      .mockResolvedValueOnce(sampleBacklog)
      .mockResolvedValueOnce(sampleCases)

    await wrapper.find('[data-test="open-case-btn"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="notice"]').text()).toContain('Caso abierto')
  })
})
