import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AddressPage from '../../app/pages/cuenta/direcciones.vue'
import type { Address } from '../../app/composables/useAccount'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, mutationMock, refreshMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  mutationMock: vi.fn(),
  refreshMock: vi.fn()
}))
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('$fetch', () => mutationMock)
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: 'synthetic-customer', role: 'customer' }),
  session: ref(null),
  clear: async () => undefined,
  openInPopup: () => undefined,
  fetch: async () => undefined
}))

const ADDRESS: Address = {
  id: 'synthetic-address-1',
  kind: 'both',
  label: 'Almacén de prueba',
  recipientName: ' Destinatario sintético ',
  companyName: 'Empresa de prueba',
  taxId: null,
  line1: ' Calle de prueba 1 ',
  line2: null,
  postalCode: '00000',
  city: 'POBLACIÓN sintética',
  region: 'Provincia de prueba',
  countryCode: 'ES',
  phone: null,
  instructions: ' Instrucción sintética ',
  isDefault: true
}
const Header = defineComponent({
  props: { title: String, count: Number },
  setup(props, { slots }) {
    return () => h('header', { 'data-count': props.count }, [h('h1', props.title), slots.actions?.()])
  }
})
const Surface = defineComponent({
  props: { as: String },
  setup(props, { slots }) {
    return () => h(props.as ?? 'section', slots.default?.())
  }
})
const EmptyState = defineComponent({
  props: { title: String, description: String },
  setup(props, { slots }) {
    return () => h('div', [h('h2', props.title), h('p', props.description), slots.default?.()])
  }
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { loading: Boolean, disabled: Boolean },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        'button',
        { ...attrs, type: attrs.type ?? 'button', disabled: props.disabled || props.loading },
        slots.default?.()
      )
  }
})
const Modal = defineComponent({
  props: { open: Boolean },
  setup(props, { slots }) {
    return () => (props.open ? h('dialog', { open: true }, [slots.body?.(), slots.footer?.()]) : null)
  }
})

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
let wrapper: Wrapper | undefined
let currentData: ReturnType<typeof ref<unknown>>
let currentStatus: ReturnType<typeof ref<string>>

async function render(options: { status?: string; data?: unknown } = {}) {
  currentData = ref(Object.hasOwn(options, 'data') ? options.data : { addresses: [] })
  currentStatus = ref(options.status ?? 'success')
  fetchMock.mockImplementation((path: string) => {
    if (path === '/api/account/addresses') {
      return { data: currentData, status: currentStatus, error: ref(null), refresh: refreshMock }
    }
    if (path === '/api/account') {
      return {
        data: ref({ profile: { name: null, phone: null, company: null, taxId: null } }),
        status: ref('success'),
        error: ref(null),
        refresh: vi.fn()
      }
    }
    throw new Error('Unexpected synthetic read')
  })
  wrapper = await mountSuspended(AddressPage, {
    global: {
      stubs: {
        UiPageHeader: Header,
        UiSurface: Surface,
        UiEmptyState: EmptyState,
        AccountFeedback: true,
        UButton: Button,
        UModal: Modal,
        UBadge: { template: '<span><slot /></span>' }
      }
    }
  })
  return wrapper
}

function retry(page: Wrapper) {
  return proxyRefs(page.setupState).retryRead as () => Promise<void>
}
function retryButton(page: Wrapper) {
  return page.findAll('button').find((button) => button.text() === 'Reintentar')
}
function expectNoWrites() {
  expect(mutationMock).not.toHaveBeenCalled()
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/account', '/api/account/addresses'])
}

beforeEach(() => {
  fetchMock.mockReset()
  mutationMock.mockReset()
  refreshMock.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('account address agenda read state', () => {
  it.each(['idle', 'pending'])(
    'announces %s as loading, not an empty agenda, and blocks retry callbacks',
    async (status) => {
      const page = await render({ status, data: { addresses: [ADDRESS] } })
      expect(page.get('[role="status"]').text()).toBe('Cargando tus direcciones.')
      expect(page.get('[aria-busy]').attributes('aria-busy')).toBe('true')
      expect(page.find('[role="alert"]').exists()).toBe(false)
      expect(page.text()).not.toContain('Todavía no has guardado ninguna dirección')
      expect(page.text()).not.toContain(ADDRESS.label)
      expect(page.get('header').attributes('data-count')).toBeUndefined()
      expect(retryButton(page)).toBeUndefined()
      await retry(page)()
      expect(refreshMock).not.toHaveBeenCalled()
      expectNoWrites()
    }
  )

  it('shows the empty agenda only after a successful array read', async () => {
    const page = await render()
    expect(page.text()).toContain('Todavía no has guardado ninguna dirección')
    expect(page.find('[role="alert"]').exists()).toBe(false)
    expect(page.find('[role="status"]').exists()).toBe(false)
    expect(page.get('header').attributes('data-count')).toBe('0')
    expect(page.get('[aria-busy]').attributes('aria-busy')).toBe('false')
    await retry(page)()
    expect(refreshMock).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it('renders a successful populated agenda without changing the personal data', async () => {
    const page = await render({ data: { addresses: [ADDRESS] } })
    expect(page.get('article').text()).toContain(ADDRESS.label)
    expect(page.get('article').text()).toContain(ADDRESS.city)
    expect(page.get('header').attributes('data-count')).toBe('1')
    expect(page.find('[role="alert"]').exists()).toBe(false)
    expect(retryButton(page)).toBeUndefined()
    expect(currentData.value).toEqual({ addresses: [ADDRESS] })
    expectNoWrites()
  })

  it.each([undefined, { addresses: [] }, { addresses: [ADDRESS] }])(
    'shows a read error instead of trusting cached data: %#',
    async (data) => {
      const page = await render({ status: 'error', data })
      expect(page.get('[role="alert"]').text()).toBe('No hemos podido cargar tus direcciones. Vuelve a intentarlo.')
      expect(page.get('[aria-busy]').attributes('aria-busy')).toBe('false')
      expect(page.get('header').attributes('data-count')).toBeUndefined()
      expect(page.text()).not.toContain('Todavía no has guardado ninguna dirección')
      expect(page.text()).not.toContain(ADDRESS.label)
      expect(page.find('article').exists()).toBe(false)
      expect(retryButton(page)?.attributes('type')).toBe('button')
      expect(refreshMock).not.toHaveBeenCalled()
      expectNoWrites()
    }
  )

  it.each([undefined, null, {}, [], { addresses: null }, { addresses: {} }, { addresses: 'invalid' }])(
    'requires the minimum object + addresses-array read contract: %#',
    async (data) => {
      const page = await render({ status: 'success', data })
      expect(page.get('[role="alert"]').text()).toContain('No hemos podido cargar tus direcciones')
      expect(page.text()).not.toContain('Todavía no has guardado ninguna dirección')
      expect(page.get('header').attributes('data-count')).toBeUndefined()
      expect(retryButton(page)).toBeDefined()
      expectNoWrites()
    }
  )

  it.each([{ addresses: [] }, { addresses: [ADDRESS] }])(
    'recovers through an explicit refresh read with no writes: %#',
    async (recovered) => {
      const page = await render({ status: 'error', data: { addresses: [ADDRESS] } })
      refreshMock.mockImplementationOnce(async () => {
        currentData.value = recovered
        currentStatus.value = 'success'
      })
      await retryButton(page)!.trigger('click')
      await flushPromises()
      expect(refreshMock).toHaveBeenCalledExactlyOnceWith()
      expect(page.find('[role="alert"]').exists()).toBe(false)
      expect(page.get('header').attributes('data-count')).toBe(String(recovered.addresses.length))
      expect(page.text()).toContain(
        recovered.addresses.length ? ADDRESS.label : 'Todavía no has guardado ninguna dirección'
      )
      expectNoWrites()
    }
  )

  it('synchronously blocks double retry and a cached callback during the pending read', async () => {
    let resolve!: () => void
    refreshMock.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const page = await render({ status: 'error' })
    const callback = retry(page)
    const first = callback()
    await callback()
    await nextTick()
    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(page.get('[aria-busy]').attributes('aria-busy')).toBe('true')
    expect(page.get('[role="status"]').text()).toBe('Cargando tus direcciones.')
    expect(retryButton(page)).toBeUndefined()
    currentStatus.value = 'pending'
    resolve()
    await first
    await callback()
    expect(refreshMock).toHaveBeenCalledTimes(1)
    currentData.value = { addresses: [] }
    currentStatus.value = 'success'
    await nextTick()
    expect(page.text()).toContain('Todavía no has guardado ninguna dirección')
    expectNoWrites()
  })

  it('keeps retry failure generic and permits another deliberate read attempt', async () => {
    const page = await render({ status: 'error', data: { addresses: [ADDRESS] } })
    refreshMock.mockRejectedValueOnce(new Error('synthetic-private-response-detail'))
    await retry(page)()
    await nextTick()
    expect(page.get('[role="alert"]').text()).toContain('No hemos podido cargar tus direcciones')
    expect(page.text()).not.toContain('synthetic-private-response-detail')
    expect(page.text()).not.toContain(ADDRESS.label)
    expect(retryButton(page)).toBeDefined()
    expect(refreshMock).toHaveBeenCalledTimes(1)
    await retry(page)()
    expect(refreshMock).toHaveBeenCalledTimes(2)
    expectNoWrites()
  })
})
