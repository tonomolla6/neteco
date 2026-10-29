import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminSupportLiveChat from '../../app/components/AdminSupportLiveChat.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  fetch: vi.fn()
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('$fetch', () => mocks.fetch)

describe('Componente AdminSupportLiveChat.vue (SUP-011)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('monta el panel y muestra la cola de espera de chats con contexto', async () => {
    mocks.request.mockResolvedValueOnce({
      queue: [
        {
          id: '11111111-2222-3333-4444-555555555555',
          publicRef: 'CHAT-0000000000000000001',
          department: 'technical',
          currentVersion: 1,
          context: {
            productSlug: 'desengrasante-industrial-5l',
            orderReference: 'ORD-2026-99'
          },
          waitedSeconds: 45,
          createdAt: '2026-10-28T10:00:00Z'
        }
      ]
    })

    const wrapper = await mountSuspended(AdminSupportLiveChat)
    await flushPromises()

    expect(wrapper.text()).toContain('Panel de Chat Humano (SUP-011)')
    expect(wrapper.text()).toContain('CHAT-0000000000000000001')
    expect(wrapper.text()).toContain('desengrasante-industrial-5l')
    expect(wrapper.text()).toContain('ORD-2026-99')
    expect(wrapper.text()).toContain('Atender')
  })
})
