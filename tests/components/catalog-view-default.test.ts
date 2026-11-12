// @vitest-environment nuxt
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { useNuxtApp } from '#app'
import { nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ViewToggle from '../../app/components/ViewToggle.vue'

const mounted: Array<{ unmount: () => void }> = []
const auth = vi.hoisted(() => ({ company: null as string | null, loggedIn: false }))
mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(auth.loggedIn),
  user: ref(auth.loggedIn ? { company: auth.company } : null),
  ready: ref(true),
  session: ref(null)
}))

afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  document.cookie = 'catalog_view=; max-age=0; path=/'
  delete useNuxtApp().payload.state['$scatalog-view-hydration']
  auth.company = null
  auth.loggedIn = false
})

async function pressed() {
  const wrapper = await mountSuspended(ViewToggle)
  mounted.push(wrapper)
  await nextTick()
  const view = wrapper.get('[aria-label="Vista de lista"]').attributes('aria-pressed') === 'true' ? 'list' : 'grid'
  return { wrapper, view }
}

describe('default catalog view', () => {
  it('is the grid for visitors and personal accounts', async () => {
    expect((await pressed()).view).toBe('grid')
    auth.loggedIn = true
    expect((await pressed()).view).toBe('grid')
  })

  it('is the ordering list for company accounts on their first visit', async () => {
    auth.loggedIn = true
    auth.company = 'Bar Central S.L.'
    const { view } = await pressed()
    expect(view).toBe('list')
    // A default is not a choice: nothing is stored until the visitor picks a view.
    expect(document.cookie).not.toContain('catalog_view=')
  })

  it('remembers an explicit choice over the account default', async () => {
    auth.loggedIn = true
    auth.company = 'Bar Central S.L.'
    const { wrapper } = await pressed()
    await wrapper.get('[aria-label="Vista de cuadrícula"]').trigger('click')
    await nextTick()
    expect(document.cookie).toContain('catalog_view=grid')
    mounted.splice(0).forEach((item) => item.unmount())
    delete useNuxtApp().payload.state['$scatalog-view-hydration']
    expect((await pressed()).view).toBe('grid')
  })
})
