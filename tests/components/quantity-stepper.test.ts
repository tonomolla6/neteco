// @vitest-environment nuxt
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import QuantityStepper from '../../app/components/QuantityStepper.vue'

async function mountStepper(props: Record<string, unknown>) {
  return mountSuspended(QuantityStepper, { props: { modelValue: 1, ...props } })
}
const last = (wrapper: Awaited<ReturnType<typeof mountStepper>>) => wrapper.emitted('update:modelValue')?.at(-1)?.[0]

describe('QuantityStepper', () => {
  it('offers a directly editable numeric field with a numeric keypad', async () => {
    const wrapper = await mountStepper({ modelValue: 2, label: 'Guante' })
    const input = wrapper.get('input')
    expect(input.attributes('inputmode')).toBe('numeric')
    expect(input.attributes('aria-label')).toBe('Cantidad de Guante')
    expect((input.element as HTMLInputElement).value).toBe('2')
    await input.setValue('7')
    await input.trigger('change')
    expect(last(wrapper)).toBe(7)
  })

  it('never goes below the minimum and jumps by the increment', async () => {
    const wrapper = await mountStepper({ modelValue: 10, minimum: 10, step: 10 })
    const [minus, plus] = wrapper.findAll('button')
    expect(minus!.attributes('disabled')).toBeDefined()
    await plus!.trigger('click')
    expect(last(wrapper)).toBe(20)
    await wrapper.setProps({ modelValue: 20 })
    await wrapper.get('input').setValue('3')
    await wrapper.get('input').trigger('change')
    expect(last(wrapper)).toBe(10)
  })

  it('snaps a typed quantity to the nearest valid increment and caps at the maximum', async () => {
    const wrapper = await mountStepper({ modelValue: 10, minimum: 10, step: 10, maximum: 50 })
    const input = wrapper.get('input')
    await input.setValue('27')
    await input.trigger('change')
    expect(last(wrapper)).toBe(30)
    await input.setValue('999')
    await input.trigger('change')
    expect(last(wrapper)).toBe(50)
  })

  it('restores the current value when the typed text is not a quantity', async () => {
    const wrapper = await mountStepper({ modelValue: 4 })
    const input = wrapper.get('input')
    await input.setValue('abc')
    await input.trigger('change')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect((input.element as HTMLInputElement).value).toBe('4')
  })

  it('supports the arrow keys', async () => {
    const wrapper = await mountStepper({ modelValue: 4, step: 2, minimum: 2 })
    await wrapper.get('input').trigger('keydown', { key: 'ArrowUp' })
    expect(last(wrapper)).toBe(6)
    await wrapper.get('input').trigger('keydown', { key: 'ArrowDown' })
    expect(last(wrapper)).toBe(2)
  })

  it('allows zero when the minimum is zero (per-row format tables)', async () => {
    const wrapper = await mountStepper({ modelValue: 0, minimum: 5, step: 5, allowZero: true })
    const [minus, plus] = wrapper.findAll('button')
    expect(minus!.attributes('disabled')).toBeDefined()
    await plus!.trigger('click')
    expect(last(wrapper)).toBe(5)
    await wrapper.setProps({ modelValue: 5 })
    await minus!.trigger('click')
    expect(last(wrapper)).toBe(0)
  })

  it('uses 44 px touch targets by default and 36 px only in the compact variant', async () => {
    const normal = await mountStepper({})
    expect(normal.findAll('button').every((button) => button.classes().includes('size-11'))).toBe(true)
    expect(normal.get('input').classes()).toContain('h-11')
    const compact = await mountStepper({ compact: true })
    expect(compact.findAll('button').every((button) => button.classes().includes('size-9'))).toBe(true)
  })
})
