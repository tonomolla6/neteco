import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OrderSaveAsList from '../../app/components/OrderSaveAsList.vue'
import OrderGuestAccount from '../../app/components/OrderGuestAccount.vue'
import RegisterPage from '../../app/pages/registro.vue'
import type { OrderLine } from '../../app/composables/useAccount'
import '#app/nuxt-vitest-app-entry'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
mockNuxtImport('$fetch', () => fetchMock)

const line = (overrides: Partial<OrderLine>): OrderLine => ({
  sku: 'S-1',
  name: 'Lejía',
  format: '5 L',
  quantity: 2,
  unitGross: 500,
  lineGross: 1000,
  variantId: 11,
  slug: 'lejia',
  image: null,
  visual: null,
  available: true,
  reason: null,
  ...overrides
})
const lines = [
  line({}),
  line({ sku: 'S-2', variantId: 12, quantity: 6 }),
  line({ sku: 'S-3', variantId: null, available: false, reason: 'retirado' })
]

beforeEach(() => {
  fetchMock.mockReset()
})

describe('order confirmation: save the order as a list', () => {
  it('creates a list named after the order and saves every available line with its quantity', async () => {
    fetchMock.mockImplementation(async (path: string) =>
      path === '/api/account/favorites/lists' ? { ok: true, id: 'list-1' } : { listId: 'list-1' }
    )
    const wrapper = await mountSuspended(OrderSaveAsList, { props: { orderId: 'NE-1', lines, cloudflare: true } })
    await wrapper.get('[data-order-save-list]').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls.map(([path, options]) => [path, options.body])).toEqual([
      ['/api/account/favorites/lists', { name: 'Pedido NE-1' }],
      ['/api/account/favorites', { variantId: 11, quantity: 2, listId: 'list-1' }],
      ['/api/account/favorites', { variantId: 12, quantity: 6, listId: 'list-1' }]
    ])
    const status = wrapper.get('[data-order-save-list-status]')
    expect(status.text()).toContain('2 referencias')
    expect(status.text()).toContain('1 ya no está disponible')
    expect(status.find('a[href="/cuenta/listas"]').exists()).toBe(true)
  })

  it('saves to the single list where named lists do not exist', async () => {
    fetchMock.mockResolvedValue({ listId: 'default' })
    const wrapper = await mountSuspended(OrderSaveAsList, {
      props: { orderId: 'NE-2', lines: lines.slice(0, 1), cloudflare: false }
    })
    await wrapper.get('[data-order-save-list]').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls.map(([path, options]) => [path, options.body])).toEqual([
      ['/api/account/favorites', { variantId: 11, quantity: 2 }]
    ])
  })

  it('says so when the list already exists instead of failing silently', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('conflict'), { statusCode: 409 }))
    const wrapper = await mountSuspended(OrderSaveAsList, { props: { orderId: 'NE-1', lines, cloudflare: true } })
    await wrapper.get('[data-order-save-list]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Ya tienes una lista de este pedido')
  })
})

describe('order confirmation: a guest creates the account with the order data', () => {
  it('links to the sign-up with email, name, phone and company already filled', async () => {
    const wrapper = await mountSuspended(OrderGuestAccount, {
      props: {
        order: {
          id: 'NE-3',
          email: 'ana@example.invalid',
          name: 'Ana Pérez',
          phone: '600000000',
          company: 'Bar Central'
        }
      }
    })
    const href = wrapper.get('a[data-order-create-account]').attributes('href')!
    const query = new URL(href, 'https://neteco.invalid').searchParams
    expect(Object.fromEntries(query)).toEqual({
      email: 'ana@example.invalid',
      nombre: 'Ana Pérez',
      telefono: '600000000',
      empresa: 'Bar Central',
      pedido: 'NE-3'
    })
    expect(wrapper.text()).toContain('solo falta una contraseña')
  })

  it('the sign-up page arrives filled and only asks for the password', async () => {
    const page = await mountSuspended(RegisterPage, {
      route:
        '/registro?email=ana%40example.invalid&nombre=Ana%20P%C3%A9rez&telefono=600000000&empresa=Bar%20Central&pedido=NE-3'
    })
    const state = page.vm.$.setupState as { form: Record<string, string> }
    expect(state.form).toMatchObject({
      email: 'ana@example.invalid',
      name: 'Ana Pérez',
      phone: '600000000',
      company: 'Bar Central'
    })
    expect(page.get('[data-register-from-order]').text()).toContain('NE-3')
  })
})
