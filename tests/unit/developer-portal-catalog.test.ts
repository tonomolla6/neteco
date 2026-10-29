import { access } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { developerServices, developerTemplates, filterDeveloperServices } from '../../shared/developer-portal-catalog'

describe('CIC-034: catálogo interno', () => {
  it('ofrece servicios únicos y no vacíos', () => {
    expect(developerServices.length).toBeGreaterThanOrEqual(3)
    expect(new Set(developerServices.map((service) => service.id)).size).toBe(developerServices.length)
  })
  it.each(['catalog', 'checkout', 'operations'])('incluye %s', (id) => {
    expect(developerServices.some((service) => service.id === id)).toBe(true)
  })
  it('declara responsables sin inventar nombres de personas', () => {
    for (const service of developerServices) {
      expect(service.owner).toBeTruthy()
      expect(service.ownerStatus).toBe('pending_confirmation')
    }
  })
  it('refiere documentación y runbooks existentes', async () => {
    for (const service of developerServices) {
      for (const path of [service.documentation, service.runbook]) await expect(access(path)).resolves.toBeUndefined()
    }
  })
  it('no presenta objetivos SLO como métricas observadas', () => {
    for (const service of developerServices) {
      expect(service.metricStatus).toBe('not_connected')
      expect(service.metricDescription).toBeTruthy()
    }
  })
  it('devuelve el catálogo completo sin filtro', () => {
    expect(filterDeveloperServices('')).toEqual(developerServices)
  })
  it('busca sin distinguir mayúsculas ni espacios externos', () => {
    expect(filterDeveloperServices('  CHECKOUT  ').map((service) => service.id)).toEqual(['checkout'])
  })
  it('devuelve lista vacía sin coincidencias', () => {
    expect(filterDeveloperServices('xyz-no-existe')).toEqual([])
  })
  it('ofrece plantillas únicas y accionables', () => {
    expect(developerTemplates.length).toBeGreaterThanOrEqual(2)
    expect(new Set(developerTemplates.map((template) => template.id)).size).toBe(developerTemplates.length)
    for (const template of developerTemplates) {
      expect(template.steps.length).toBeGreaterThanOrEqual(2)
      expect(template.title).toBeTruthy()
    }
  })
  it('no recomienda runners alojados por GitHub ni despliegues', () => {
    const text = JSON.stringify(developerTemplates)
    expect(text).not.toMatch(/ubuntu-latest|windows-latest|macos-latest|wrangler deploy/i)
  })
})
