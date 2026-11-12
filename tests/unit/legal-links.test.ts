import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEGAL_PAGES } from '../../shared/legal-pages'
import { defaultRouteSeo, isPrivateSeoPath } from '../../app/utils/seo'

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return vueFiles(path)
    return path.endsWith('.vue') ? [path] : []
  })
}

const LEGAL_PATHS = LEGAL_PAGES.map((page) => page.path)

describe('legal links across the shop', () => {
  it('every internal legal link in app/ points to an existing legal page', () => {
    const internal =
      /(?:to|href)="(\/(?:aviso-legal|privacidad|cookies|condiciones-generales|legal|terminos|politica[a-z-]*)[^"#?]*)/g
    const broken = vueFiles('app').flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(internal)]
        .map((match) => match[1]!)
        .filter((path) => !LEGAL_PATHS.includes(path))
        .map((path) => `${file}: ${path}`)
    )
    expect(broken).toEqual([])
  })

  it('no screen sends the customer to the external legal URLs any more', () => {
    const offenders = vueFiles('app').filter((file) =>
      /legalTermsUrl|privacyUrl|cookiesUrl|neteco\.es\/(?:legal|cookies)/.test(readFileSync(file, 'utf8'))
    )
    expect(offenders).toEqual([])
  })

  it.each([
    ['app/pages/checkout.vue', ['/condiciones-generales', '/privacidad']],
    ['app/layouts/checkout.vue', ['/condiciones-generales', '/privacidad', '/aviso-legal', '/cookies']],
    ['app/pages/registro.vue', ['/condiciones-generales', '/privacidad']],
    ['app/pages/contacto.vue', ['/privacidad']],
    ['app/components/ConsentManager.vue', ['/cookies']]
  ])('%s links the legal pages it relies on', (file, paths) => {
    const source = readFileSync(file, 'utf8')
    for (const path of paths) expect(source).toContain(`"${path}`)
  })
})

describe('legal pages in SEO and sitemaps', () => {
  it.each(['server/routes/sitemaps/pages.xml.get.ts', 'workers/catalog/seo-http.ts'])(
    '%s lists the legal pages',
    (file) => {
      expect(readFileSync(file, 'utf8')).toMatch(/LEGAL_PAGES|LEGAL_PATHS/)
    }
  )

  it.each(LEGAL_PATHS)('%s is indexable with its own title and description', (path) => {
    expect(isPrivateSeoPath(path)).toBe(false)
    const seo = defaultRouteSeo(path)
    const page = LEGAL_PAGES.find((entry) => entry.path === path)!
    expect(seo.robots).toBe('index, follow')
    expect(seo.title).toBe(page.title)
    expect(seo.description).toBe(page.description)
  })
})
