import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import AdminOrderTable from '../../app/components/AdminOrderTable.vue'
import LoginForm from '../../app/components/LoginForm.vue'
import RoleGate from '../../app/components/RoleGate.vue'
import type { AdminOrderSummary } from '../../shared/types/admin'

const InputStub = defineComponent({
  inheritAttrs: false,
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () =>
      h('input', {
        ...attrs,
        value: props.modelValue,
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)
      })
  }
})
const passthrough = defineComponent({ template: '<div><slot /></div>' })
const ButtonStub = defineComponent({
  inheritAttrs: false,
  setup(_, { attrs, slots }) {
    return () => h('button', attrs, slots.default?.())
  }
})
const AlertStub = defineComponent({ props: { title: String }, template: '<div role="alert">{{ title }}</div>' })

describe('critical form, table and permission states', () => {
  it('submits login by keyboard and switches to visible MFA/error states', async () => {
    const wrapper = await mountSuspended(LoginForm, {
      props: { email: '', password: '', error: 'Credenciales incorrectas' },
      global: { stubs: { UInput: InputStub, UFormField: passthrough, UAlert: AlertStub, UButton: ButtonStub } }
    })
    const inputs = wrapper.findAll('input')
    await inputs[0]!.setValue('cliente@integration.invalid')
    await inputs[1]!.setValue('password')
    expect(wrapper.emitted('update:email')).toEqual([['cliente@integration.invalid']])
    expect(wrapper.get('[role="alert"]').text()).toContain('Credenciales incorrectas')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('submit')).toHaveLength(1)

    await wrapper.setProps({ mfaChallenge: 'challenge', error: '' })
    await nextTick()
    expect(wrapper.findAll('input')).toHaveLength(1)
    expect(wrapper.text()).toContain('Confirmar código')
  })

  it('renders table loading, error, empty and actionable rows with keyboard events', async () => {
    const wrapper = await mountSuspended(AdminOrderTable, { props: { items: [], loading: true } })
    expect(wrapper.get('[role="status"]').text()).toContain('Cargando pedidos')
    await wrapper.setProps({ loading: false, error: 'No disponible' })
    expect(wrapper.get('[role="alert"]').text()).toBe('No disponible')
    await wrapper.setProps({ error: '', items: [] })
    expect(wrapper.text()).toContain('Todavía no hay pedidos')

    const order = {
      id: 'NE-1',
      createdAt: '2026-08-13T12:00:00.000Z',
      name: 'Cliente',
      company: null,
      email: 'cliente@integration.invalid',
      city: 'Xàtiva',
      lines: 1,
      total: 1210,
      status: 'pagado',
      shippingMethod: 'envio',
      shipmentId: null,
      shipmentStatus: null,
      trackingNumber: null
    } as AdminOrderSummary
    await wrapper.setProps({ items: [order] })
    const create = wrapper.get('button')
    await create.trigger('keydown', { key: 'Enter' })
    await create.trigger('click')
    expect(wrapper.emitted('createShipment')?.[0]?.[0]).toEqual(order)
  })

  it('hides privileged UI unless the explicit role is allowed', async () => {
    const wrapper = await mountSuspended(RoleGate, {
      props: { role: 'customer', allow: ['admin'] },
      slots: { default: '<a href="/admin">Panel</a>' }
    })
    expect(wrapper.find('a').exists()).toBe(false)
    await wrapper.setProps({ role: 'admin' })
    expect(wrapper.get('a').text()).toBe('Panel')
  })
})
