import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AdminDeveloperPortal from '../../app/components/AdminDeveloperPortal.vue'

describe('CIC-034: portal interno', () => {
  it('muestra servicios, plantillas y el estado real de métricas', () => {
    const wrapper = mount(AdminDeveloperPortal)
    expect(wrapper.text()).toContain('Catálogo de servicios')
    expect(wrapper.text()).toContain('Checkout')
    expect(wrapper.text()).toContain('Plantillas')
    expect(wrapper.text()).toContain('Métricas no conectadas')
    expect(wrapper.text()).toContain('Responsable pendiente de confirmar')
  })
  it('filtra y comunica una búsqueda sin resultados', async () => {
    const wrapper = mount(AdminDeveloperPortal)
    await wrapper.get('input').setValue('xyz-no-existe')
    expect(wrapper.text()).toContain('Sin servicios para esta búsqueda')
    expect(wrapper.text()).not.toContain('Checkout')
  })
})
