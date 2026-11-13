import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import ProductInfoTabs from '../../app/components/ProductInfoTabs.vue'

const tabs = [
  { id: 'descripcion', label: 'Descripción' },
  { id: 'opiniones', label: 'Reseñas y preguntas', count: 3 },
  { id: 'seguridad', label: 'Seguridad y fichas' }
]
const roots: Awaited<ReturnType<typeof mountSuspended>>[] = []
afterEach(() => roots.splice(0).forEach((root) => root.unmount()))
async function mount() {
  const root = await mountSuspended(ProductInfoTabs, {
    attachTo: document.body,
    props: { tabs },
    slots: {
      descripcion: '<p data-description>Texto publicado</p>',
      opiniones: '<p>Opiniones</p>',
      seguridad: '<p>FDS</p>'
    },
    global: { stubs: { UIcon: true } }
  })
  roots.push(root)
  return root
}

describe('product information tabs and accordion', () => {
  it('keeps one content DOM with labelled panels and one selected desktop tab', async () => {
    const root = await mount()
    expect(root.findAll('[data-description]')).toHaveLength(1)
    const buttons = root.findAll('[role="tab"]')
    expect(buttons.filter((tab) => tab.attributes('aria-selected') === 'true')).toHaveLength(1)
    expect(buttons[1]!.text()).toBe('Reseñas y preguntas (3)')
    for (const button of buttons) {
      const panel = root.get(`[id="${button.attributes('aria-controls')}"]`)
      expect(panel.attributes('aria-labelledby')).toBe(button.attributes('id'))
    }
  })

  it('uses arrows, Home and End for automatic activation and focus', async () => {
    const root = await mount()
    const buttons = root.findAll('[role="tab"]')
    await buttons[0]!.trigger('keydown', { key: 'End' })
    expect(buttons[2]!.attributes('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(buttons[2]!.element)
    await buttons[2]!.trigger('keydown', { key: 'ArrowRight' })
    expect(buttons[0]!.attributes('aria-selected')).toBe('true')
    await buttons[0]!.trigger('keydown', { key: 'ArrowLeft' })
    expect(buttons[2]!.attributes('aria-selected')).toBe('true')
    await buttons[2]!.trigger('keydown', { key: 'Home' })
    expect(buttons[0]!.attributes('aria-selected')).toBe('true')
  })

  it('starts the first mobile accordion open and toggles without duplicating content', async () => {
    const root = await mount()
    const buttons = root.findAll('button[aria-expanded]')
    expect(buttons[0]!.attributes('aria-expanded')).toBe('true')
    expect(buttons[1]!.attributes('aria-expanded')).toBe('false')
    await buttons[1]!.trigger('click')
    expect(buttons[1]!.attributes('aria-expanded')).toBe('true')
    await buttons[1]!.trigger('click')
    expect(buttons[1]!.attributes('aria-expanded')).toBe('false')
    expect(root.findAll('[data-description]')).toHaveLength(1)
  })

  it('selects and opens the remaining first section after the previous section is removed', async () => {
    const root = await mount()
    await root.setProps({ tabs: tabs.slice(1) })
    expect(root.findAll('[role="tab"]')[0]!.attributes('aria-selected')).toBe('true')
    expect(root.findAll('button[aria-expanded]')[0]!.attributes('aria-expanded')).toBe('true')
  })
})
