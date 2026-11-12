// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref, Teleport } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useDialogFocus } from '../../app/composables/useDialogFocus'

let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.replaceChildren()
})

async function fixture(empty = false) {
  const open = ref(false)
  const background = document.createElement('button')
  background.textContent = 'Background'
  document.body.appendChild(background)
  const Component = defineComponent({
    setup() {
      const dialog = ref<HTMLElement | null>(null)
      useDialogFocus(dialog, open)
      return () =>
        h('main', [
          h(
            'button',
            {
              id: 'opener',
              onClick: () => {
                open.value = true
              }
            },
            'Open'
          ),
          h(Teleport, { to: 'body' }, [
            open.value
              ? h(
                  'section',
                  { ref: dialog, role: 'dialog', tabindex: -1 },
                  empty
                    ? []
                    : [
                        h('button', { disabled: true }, 'Disabled'),
                        h('button', { id: 'first' }, 'First'),
                        h('input', { 'aria-label': 'Middle' }),
                        h('button', { id: 'last' }, 'Last')
                      ]
                )
              : null
          ])
        ])
    }
  })
  wrapper = mount(Component, { attachTo: document.body })
  const opener = wrapper.get<HTMLButtonElement>('#opener')
  opener.element.focus()
  await opener.trigger('click')
  await nextTick()
  await nextTick()
  return { open, opener, background }
}

const key = (value: string, shiftKey = false) => {
  const event = new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true })
  document.activeElement?.dispatchEvent(event)
  return event
}

it('moves focus into the dialog, cycles Tab in both directions, and prevents background focus', async () => {
  const { background, opener } = await fixture()
  expect(document.activeElement?.id).toBe('first')
  expect(background.hasAttribute('inert')).toBe(true)
  expect(opener.element.closest('[inert]')).not.toBeNull()
  document.querySelector<HTMLButtonElement>('#last')!.focus()
  expect(key('Tab').defaultPrevented).toBe(true)
  expect(document.activeElement?.id).toBe('first')
  expect(key('Tab', true).defaultPrevented).toBe(true)
  expect(document.activeElement?.id).toBe('last')
  background.focus()
  expect(document.activeElement).not.toBe(background)
  // Focus redirection still protects the dialog if another script removes inert.
  background.removeAttribute('inert')
  background.focus()
  expect(document.activeElement?.id).toBe('first')
})

it('closes on Escape, restores the opener and preserves existing background state', async () => {
  const preserved = document.createElement('aside')
  preserved.setAttribute('inert', '')
  document.body.appendChild(preserved)
  const { open, opener, background } = await fixture()
  expect(document.body.style.overflow).toBe('hidden')
  key('Escape')
  await nextTick()
  await nextTick()
  expect(open.value).toBe(false)
  expect(document.activeElement).toBe(opener.element)
  expect(background.hasAttribute('inert')).toBe(false)
  expect(preserved.hasAttribute('inert')).toBe(true)
  expect(document.body.style.overflow).toBe('')
})

it('focuses an empty dialog and restores background state when it is unmounted', async () => {
  const { background } = await fixture(true)
  expect(document.activeElement?.getAttribute('role')).toBe('dialog')
  expect(key('Tab').defaultPrevented).toBe(true)
  wrapper!.unmount()
  wrapper = undefined
  expect(background.hasAttribute('inert')).toBe(false)
  expect(document.body.style.overflow).toBe('')
})
