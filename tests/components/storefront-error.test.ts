import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ErrorPage from '../../app/error.vue'

const { clear } = vi.hoisted(() => ({ clear: vi.fn() }))
mockNuxtImport('clearError', () => clear)
const roots: Awaited<ReturnType<typeof mountSuspended>>[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => root.unmount())
  clear.mockReset()
})
async function page(statusCode: number) {
  const root = await mountSuspended(ErrorPage, {
    props: { error: { statusCode, statusMessage: 'Synthetic', name: 'Error', message: 'Synthetic error' } },
    global: { stubs: { UIcon: true, SearchBox: true } }
  })
  roots.push(root)
  return root
}

describe('storefront recovery pages', () => {
  it.each([
    [404, 'No encontramos esta página'],
    [410, 'Este producto ya no está en el catálogo'],
    [401, 'Inicia sesión para ver esta página'],
    [403, 'Esta página no está disponible con tu cuenta'],
    [503, 'La tienda vuelve en unos minutos'],
    [500, 'Algo ha fallado por nuestra parte']
  ])('explains status %i with useful shopping/contact exits', async (code, title) => {
    const root = await page(code as number)
    expect(root.get('h1').text()).toBe(title)
    expect(root.text()).toContain(`Error ${code}`)
    expect(root.find('a[href="/catalogo"]').exists()).toBe(true)
    expect(root.find('a[href^="mailto:"]').exists()).toBe(true)
    expect(root.text()).not.toContain('Synthetic error')
  })
  it('clears the previous error when the visitor chooses the catalog', async () => {
    const root = await page(404)
    const button = root.findAll('button').find((entry) => entry.text() === 'Ver el catálogo')!
    await button.trigger('click')
    expect(clear).toHaveBeenCalledWith({ redirect: '/catalogo' })
  })
})
