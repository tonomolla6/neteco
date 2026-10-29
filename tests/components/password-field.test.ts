import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import PasswordField from '../../app/components/PasswordField.vue'
import '#app/nuxt-vitest-app-entry'

const mounted: Array<{ wrapper: Awaited<ReturnType<typeof mountSuspended>>; host: HTMLElement }> = []
type FieldProps = InstanceType<typeof PasswordField>['$props']

async function render(props: FieldProps = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const wrapper = await mountSuspended(PasswordField, {
    props,
    attachTo: host,
    global: { stubs: { UIcon: true } }
  })
  mounted.push({ wrapper, host })
  return wrapper
}

function referencedDescriptions(input: HTMLInputElement) {
  return (input.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => {
      const node = document.getElementById(id)
      expect(node, `Accessible description ${id} must exist`).not.toBeNull()
      return node!
    })
}

afterEach(() => {
  for (const { wrapper, host } of mounted.splice(0)) {
    wrapper.unmount()
    host.remove()
  }
})

describe('real Nuxt PasswordField native input and accessible password policy', () => {
  it('forwards native required and leaves it absent by default', async () => {
    const optional = await render()
    expect((optional.get('input').element as HTMLInputElement).required).toBe(false)
    const required = await render({ required: true, label: 'Nueva contraseña', showRules: true })
    const native = required.get('input').element as HTMLInputElement
    expect(native.required).toBe(true)
    expect(native.checkValidity()).toBe(false)
    expect(required.get('label').attributes('for')).toBe(native.id)
    await required.get('input').setValue('Synthetic-password-123')
    expect(native.validity.valueMissing).toBe(false)
  })

  it('limits new-password fields only when explicitly showing new-password rules', async () => {
    const wrapper = await render({ showRules: true, required: true })
    const input = wrapper.get('input')
    expect(input.attributes('minlength')).toBe('12')
    expect(input.attributes('maxlength')).toBe('128')
    expect(input.attributes('autocomplete')).toBe('new-password')
    const descriptions = referencedDescriptions(input.element as HTMLInputElement)
    expect(descriptions.map((node) => node.textContent).join(' ')).toContain('128')
    expect(wrapper.find('ul').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('La contraseña cumple los requisitos.')
  })

  it.each([
    { autocomplete: 'current-password', showRules: false },
    { autocomplete: 'current-password', showRules: true },
    { autocomplete: 'section-account current-password', showRules: true },
    { showRules: false },
    { showRules: true, matches: 'old' }
  ])('does not impose new-password policy on current, login or repeated values: %j', async (props) => {
    const wrapper = await render({ ...props, modelValue: 'old' })
    const input = wrapper.get('input')
    expect(input.attributes('minlength')).toBeUndefined()
    expect(input.attributes('maxlength')).toBeUndefined()
    expect((input.element as HTMLInputElement).value).toBe('old')
    expect(wrapper.find('ul').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('La contraseña cumple los requisitos.')
    expect(wrapper.text()).not.toContain('Al menos 12 caracteres')
    expect(input.attributes('aria-invalid')).toBe('false')
  })

  it.each([' old ', `${'x'.repeat(200)}1`, '  Contraseña-é-12  '])(
    'preserves exact existing password input and reveal state without truncation or normalization',
    async (value) => {
      const wrapper = await render({ autocomplete: 'current-password', modelValue: value })
      const input = wrapper.get('input')
      expect((input.element as HTMLInputElement).value).toBe(value)
      await wrapper.get('button').trigger('click')
      expect(input.attributes('type')).toBe('text')
      expect((input.element as HTMLInputElement).value).toBe(value)
      await wrapper.get('button').trigger('click')
      expect(input.attributes('type')).toBe('password')
      expect((input.element as HTMLInputElement).value).toBe(value)
      const changed = ` ${value} `
      await input.setValue(changed)
      expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([changed])
      expect((input.element as HTMLInputElement).value).toBe(changed)
    }
  )

  it('updates a new password without trim or character normalization', async () => {
    const wrapper = await render({ showRules: true })
    const exact = '  Aa-éñ-123456  '
    await wrapper.get('input').setValue(exact)
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([exact])
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe(exact)
    expect(wrapper.text()).toContain('La contraseña cumple los requisitos.')
  })

  it.each([
    ['a1'.repeat(5), false],
    ['a1'.repeat(6), true],
    [`${'a'.repeat(127)}1`, true],
    [`${'a'.repeat(128)}1`, false],
    ['aaaaaaaaaaaa', false],
    ['123456789012', false],
    ['Áéíóúñabcdef1', true],
    ['ΩΩΩΩΩΩΩΩΩΩΩ1', false],
    ['aaaaaaaaaaa١', false],
    ['😀😀😀😀😀a1', true]
  ])('matches the existing backend policy for synthetic password %j', async (value, valid) => {
    const wrapper = await render({ showRules: true, modelValue: value as string })
    expect(wrapper.text().includes('La contraseña cumple los requisitos.')).toBe(valid)
    expect(wrapper.findAll('li')).toHaveLength(4)
    for (const rule of wrapper.findAll('li')) expect(rule.text()).toMatch(/^(?:Cumplido|Pendiente):/)
    expect(
      referencedDescriptions(wrapper.get('input').element as HTMLInputElement)
        .map((node) => node.textContent)
        .join(' ')
    ).toContain('128 caracteres')
  })

  it('never truncates a supplied overlength new password or announces it as compliant', async () => {
    const value = `${'a'.repeat(128)}1`
    const wrapper = await render({ showRules: true, modelValue: value })
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe(value)
    expect(wrapper.text()).not.toContain('La contraseña cumple los requisitos.')
    expect(
      wrapper
        .findAll('li')
        .find((item) => item.text().includes('128 caracteres'))!
        .text()
    ).toContain('Pendiente:')
  })

  it('provides a keyboard-focusable non-submit reveal button with scoped control/pressed labels', async () => {
    let submissions = 0
    const model = ref('Synthetic-password-123')
    const Form = defineComponent({
      setup() {
        return () =>
          h(
            'form',
            {
              onSubmit: (event: Event) => {
                event.preventDefault()
                submissions++
              }
            },
            [
              h(PasswordField, {
                modelValue: model.value,
                'onUpdate:modelValue': (value: string) => {
                  model.value = value
                },
                label: 'Nueva contraseña',
                required: true,
                showRules: true
              })
            ]
          )
      }
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = await mountSuspended(Form, { attachTo: host, global: { stubs: { UIcon: true } } })
    mounted.push({ wrapper, host })
    const button = wrapper.get('button')
    const native = button.element as HTMLButtonElement
    const input = wrapper.get('input')
    expect(native).toBeInstanceOf(HTMLButtonElement)
    expect(native.type).toBe('button')
    expect(native.tabIndex).toBe(0)
    expect(button.attributes('aria-controls')).toBe(input.attributes('id'))
    expect(button.attributes('aria-label')).toContain('Nueva contraseña')
    expect(button.attributes('aria-pressed')).toBe('false')
    native.focus()
    expect(document.activeElement).toBe(native)
    await button.trigger('keydown', { key: 'Enter' })
    // Happy DOM does not synthesize keyboard activation; native button click is
    // the browser activation action, not a component-only click-handler stub.
    native.click()
    await nextTick()
    expect(button.attributes('aria-pressed')).toBe('true')
    expect(button.attributes('aria-label')).toContain('Ocultar')
    expect(input.attributes('type')).toBe('text')
    expect(model.value).toBe('Synthetic-password-123')
    expect(submissions).toBe(0)
    native.click()
    await nextTick()
    expect(button.attributes('aria-pressed')).toBe('false')
    expect(input.attributes('type')).toBe('password')
    expect(submissions).toBe(0)
  })

  it('reports only exact mismatch for repeat fields and scopes each error/hint/label to its own input', async () => {
    const repeatedModel = ref('')
    const Fields = defineComponent({
      setup() {
        return () =>
          h('form', [
            h(PasswordField, { showRules: true, label: 'Nueva contraseña', modelValue: 'Synthetic-password-123' }),
            h(PasswordField, {
              label: 'Repite la contraseña',
              required: true,
              matches: 'old',
              modelValue: repeatedModel.value,
              'onUpdate:modelValue': (value: string) => {
                repeatedModel.value = value
              }
            })
          ])
      }
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = await mountSuspended(Fields, { attachTo: host, global: { stubs: { UIcon: true } } })
    mounted.push({ wrapper, host })
    const [first, repeated] = wrapper.findAllComponents(PasswordField)
    expect(first).toBeDefined()
    expect(repeated).toBeDefined()
    const firstInput = first!.get('input')
    const repeatInput = repeated!.get('input')
    expect(firstInput.attributes('id')).not.toBe(repeatInput.attributes('id'))
    expect(first!.get('label').attributes('for')).toBe(firstInput.attributes('id'))
    expect(repeated!.get('label').attributes('for')).toBe(repeatInput.attributes('id'))
    expect(repeatInput.attributes('aria-invalid')).toBe('false')
    await repeatInput.setValue('old ')
    expect(repeatInput.attributes('aria-invalid')).toBe('true')
    const errorNodes = referencedDescriptions(repeatInput.element as HTMLInputElement)
    expect(errorNodes.map((node) => node.textContent).join(' ')).toContain('Las dos contraseñas no coinciden.')
    for (const error of errorNodes) expect(repeated!.element.contains(error)).toBe(true)
    for (const hint of referencedDescriptions(firstInput.element as HTMLInputElement))
      expect(first!.element.contains(hint)).toBe(true)
    expect(repeated!.text()).not.toContain('La contraseña cumple los requisitos.')
    await repeatInput.setValue('old')
    expect(repeatInput.attributes('aria-invalid')).toBe('false')
    expect(repeated!.text()).not.toContain('Las dos contraseñas no coinciden.')
    expect((repeatInput.element as HTMLInputElement).value).toBe('old')
  })
})
