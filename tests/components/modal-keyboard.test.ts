import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import ConsentManager from '../../app/components/ConsentManager.vue'

const ButtonStub = defineComponent({
  inheritAttrs: false,
  setup(_, { attrs, slots }) {
    return () => h('button', attrs, slots.default?.())
  }
})

describe('critical modal keyboard behavior', () => {
  it('focuses the dialog, traps Tab in both directions and persists a choice', async () => {
    const wrapper = await mountSuspended(ConsentManager, {
      attachTo: document.body,
      global: { stubs: { UButton: ButtonStub } }
    })
    await nextTick()
    const dialog = wrapper.get('[role="dialog"]')
    const buttons = dialog.findAll('button')
    const firstFocusable = dialog.get('a')
    expect(document.activeElement).toBe(buttons[0]!.element)

    buttons.at(-1)!.element.focus()
    await dialog.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(firstFocusable.element)
    firstFocusable.element.focus()
    await dialog.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(buttons.at(-1)!.element)

    await buttons[1]!.trigger('click')
    await nextTick()
    const checkboxes = wrapper.findAll('input[type="checkbox"]')
    await checkboxes[1]!.setValue(true)
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Guardar'))!
      .trigger('click')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })
})
