import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { getIconData } from '@iconify/utils/lib/icon-set/get-icon'
import type { IconifyJSON } from '@iconify/types'
import { ADMIN_NAVIGATION_PERMISSIONS, adminNavigationGroups } from '../../shared/admin-navigation'

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('defineNuxtConfig', (configuration: unknown) => configuration)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function loadConfiguration(runtime: string) {
  vi.stubEnv('NETECO_RUNTIME', runtime)
  return (await import('../../nuxt.config')).default
}

describe('isolated Cloudflare Nuxt profile', () => {
  it('explicitly bundles every dynamic admin navigation icon with real installed SVG data before any build', async () => {
    const config = await loadConfiguration('cloudflare')
    const links = adminNavigationGroups({
      source: 'cloudflare',
      identityId: '10000000-0000-4000-8000-000000000073',
      sessionId: '20000000-0000-4000-8000-000000000073',
      sessionVersion: 1,
      state: 'ready',
      permissions: [...ADMIN_NAVIGATION_PERMISSIONS]
    }).flatMap((group) => group.links)
    expect(links.length).toBeGreaterThan(0)
    const collection = JSON.parse(
      await readFile(new URL('../../node_modules/@iconify-json/lucide/icons.json', import.meta.url), 'utf8')
    ) as IconifyJSON
    expect(collection.prefix).toBe('lucide')
    const names = [
      ...new Set(
        links.map((link) => {
          expect(link.icon).toMatch(/^i-lucide-[a-z0-9-]+$/)
          const name = link.icon.slice('i-lucide-'.length)
          expect(getIconData(collection, name)?.body, `installed SVG for ${link.to}`).toMatch(
            /<(?:path|g|circle|rect|line|polyline|polygon|ellipse)\b/
          )
          return `lucide:${name}`
        })
      )
    ]
    // The scanner excludes this .ts registry. Do not depend on unrelated .vue
    // pages coincidentally referencing the same icon in a particular build.
    expect(config.icon.clientBundle.icons).toEqual(expect.arrayContaining(names))
  })

  it('bundles the dynamic promotion navigation icon without a runtime icon fetch', async () => {
    const config = await loadConfiguration('cloudflare')
    const promotion = adminNavigationGroups({
      source: 'cloudflare',
      identityId: '10000000-0000-4000-8000-000000000073',
      sessionId: '20000000-0000-4000-8000-000000000073',
      sessionVersion: 1,
      state: 'ready',
      permissions: ['administration.manage']
    })
      .flatMap((group) => group.links)
      .find((link) => link.to === '/admin/promociones')
    expect(promotion).toBeDefined()
    expect(promotion!.icon).toMatch(/^i-lucide-/)
    expect(config.icon.clientBundle.icons).toContain(promotion!.icon.replace(/^i-lucide-/, 'lucide:'))
  })

  it('keeps the existing Node profile opt-out and unchanged', async () => {
    const config = await loadConfiguration('node')
    expect(config.nitro.preset).toBeUndefined()
    expect(config.buildDir).toBeUndefined()
    expect(config.serverDir).toBeUndefined()
    expect(config.routeRules['/'].swr).toBe(300)
    expect(config.image.provider).toBeUndefined()
    const nitro = { scanDirs: ['server'], handlers: [{ route: '/api/_auth/session', handler: 'session' }] }
    config.hooks['nitro:config'](nitro)
    expect(nitro.scanDirs).toEqual(['server'])
    expect(nitro.handlers).toHaveLength(1)
  })

  it('isolates source/build/output paths, preserves SSR and avoids Sharp', async () => {
    const config = await loadConfiguration('cloudflare')
    expect(config.ssr).toBe(true)
    expect(config.buildDir).toBe('.nuxt-cloudflare')
    expect(config.serverDir).toMatch(/\/server-cloudflare\/$/)
    expect(config.nitro.preset).toBe('cloudflare-module')
    expect(config.nitro.srcDir).toBe(config.serverDir)
    expect(config.nitro.scanDirs).toEqual([config.serverDir])
    expect(config.nitro.output?.dir).toMatch(/\/\.output-cloudflare\/$/)
    expect(config.nitro.cloudflare?.deployConfig).toBe(false)
    expect(config.nitro.cloudflare?.nodeCompat).toBe(true)
    expect(config.image.provider).toBe('none')
    expect(config.icon.localApiEndpoint).toBe('/_icons')
    expect(config.runtimeConfig.databaseUrl).toBe('')
    expect(config.runtimeConfig.redisUrl).toBe('')
    expect(config.runtimeConfig.session.password).toBe('')
    expect(config.runtimeConfig.redsys.secretKey).toBe('')
    expect(config.runtimeConfig.beply.token).toBe('')
  })

  it('removes legacy session authority and all late merged shared HTML caches', async () => {
    const config = await loadConfiguration('cloudflare')
    const nitro = {
      srcDir: '/old/server',
      scanDirs: ['/old/server', '/layer/server'],
      handlers: [
        { route: '/api/_auth/session', method: 'get', handler: 'module/session' },
        { route: '/api/_auth/session', method: 'delete', handler: 'module/logout' },
        { route: '/_icons/:collection', handler: 'module/icons' }
      ],
      routeRules: {
        '/': { swr: 300 },
        '/late-module': { isr: 120, cache: { maxAge: 120 } },
        '/cuenta/**': { headers: { 'x-robots-tag': 'noindex' } }
      }
    }
    config.hooks['nitro:config'](nitro)
    expect(nitro.scanDirs).toEqual([config.serverDir])
    expect(nitro.srcDir).toBe(config.serverDir)
    expect(nitro.handlers).toEqual([{ route: '/_icons/:collection', handler: 'module/icons' }])
    expect(nitro.routeRules['/']).toEqual({ cache: false })
    expect(nitro.routeRules['/late-module']).toEqual({ cache: false })
    expect(nitro.routeRules['/cuenta/**'].headers).toEqual({ 'x-robots-tag': 'noindex' })
    expect(nitro.routeRules).toHaveProperty('/**.headers.cache-control', 'private, no-store')
  })
})
