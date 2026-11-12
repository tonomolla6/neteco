import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  GATED_SECTIONS,
  gatedSectionForPath,
  isPathPublished,
  parsePublishedSections
} from '../../shared/published-sections'

describe('content sections are published only when they have content', () => {
  it('gates the sections that were public without content', () => {
    expect([...GATED_SECTIONS].sort()).toEqual([
      'casos-exito',
      'certificaciones',
      'datos-y-herramientas',
      'eventos',
      'kits',
      'marca',
      'plantillas'
    ])
    // The resource hub has its own CMS publication gate and sitemap shard.
    expect(gatedSectionForPath('/recursos/guia')).toBeNull()
  })

  it('publishes nothing by default and ignores unknown names', () => {
    expect(parsePublishedSections('')).toEqual([])
    expect(parsePublishedSections(undefined)).toEqual([])
    expect(parsePublishedSections(' kits , MARCA,admin,../x ')).toEqual(['kits', 'marca'])
  })

  it('maps a path and its children to its section, and leaves the shop alone', () => {
    expect(gatedSectionForPath('/certificaciones')).toBe('certificaciones')
    expect(gatedSectionForPath('/plantillas/checklist-appcc/')).toBe('plantillas')
    expect(gatedSectionForPath('/casos-exito/bar-central?utm=1')).toBe('casos-exito')
    expect(gatedSectionForPath('/marcas')).toBeNull()
    expect(gatedSectionForPath('/catalogo')).toBeNull()
    expect(gatedSectionForPath('/')).toBeNull()
  })

  it('a gated path is reachable only when its section is published', () => {
    expect(isPathPublished('/certificaciones', [])).toBe(false)
    expect(isPathPublished('/certificaciones', ['kits'])).toBe(false)
    expect(isPathPublished('/certificaciones', ['certificaciones'])).toBe(true)
    expect(isPathPublished('/catalogo', [])).toBe(true)
    expect(isPathPublished('/admin/kits', [])).toBe(true)
  })
})

describe('no certification is claimed before it can be shown', () => {
  it.each(['app/pages/certificaciones.vue', 'app/pages/marca.vue', 'app/utils/seo.ts'])(
    '%s does not name ISO or Ecolabel in its metadata',
    (file) => {
      expect(readFileSync(file, 'utf8')).not.toMatch(/\bISO\b|Ecolabel/)
    }
  )

  it.each(['server/routes/sitemaps/pages.xml.get.ts', 'workers/catalog/seo-http.ts'])(
    '%s lists a gated section in the sitemap only through the published set',
    (file) => {
      const source = readFileSync(file, 'utf8')
      for (const section of GATED_SECTIONS) expect(source).not.toContain(`'/${section}'`)
    }
  )
})
