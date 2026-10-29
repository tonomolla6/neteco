import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  executeSeoTechnicalCrawl,
  getSeoCrawlRunDetail,
  listSeoCrawlRuns,
  listSeoCrawlIssues,
  type PageFetcher
} from '../../workers/seo/crawler'

const NOW = '2026-10-29T12:00:00Z'

async function setupCrawlerDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0117_seo_technical_bot_logs_ai_search.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)
  return sqlite
}

describe('SEO-023: Monitorización SEO técnica continua', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupCrawlerDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('runs a scheduled technical crawl detecting 200 pages, links, depth and schema', async () => {
    const mockFetcher: PageFetcher = async (url: string) => {
      if (url === '/') {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: `
            <html>
              <head>
                <title>Neteco Químicos - Inicio</title>
                <link rel="canonical" href="https://neteco.beply.es/" />
                <script type="application/ld+json">
                  {"@context":"https://schema.org","@type":"Organization","name":"Neteco"}
                </script>
              </head>
              <body>
                <a href="/categorias/desengrasantes">Desengrasantes</a>
                <a href="/quienes-somos">Quiénes Somos</a>
              </body>
            </html>
          `
        }
      }
      if (url === '/categorias/desengrasantes') {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: `
            <html>
              <head>
                <title>Desengrasantes Industriales | Neteco</title>
                <link rel="canonical" href="https://neteco.beply.es/categorias/desengrasantes" />
              </head>
              <body>
                <a href="/producto/desengrasante-alcalino-5l">Producto 1</a>
              </body>
            </html>
          `
        }
      }
      if (url === '/producto/desengrasante-alcalino-5l') {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: `
            <html>
              <head>
                <title>Desengrasante Alcalino 5L | Neteco</title>
                <link rel="canonical" href="https://neteco.beply.es/producto/desengrasante-alcalino-5l" />
                <script type="application/ld+json">
                  {"@context":"https://schema.org","@type":"Product","name":"Desengrasante Alcalino 5L"}
                </script>
              </head>
              <body>
                <h1>Desengrasante Alcalino 5L</h1>
              </body>
            </html>
          `
        }
      }
      if (url === '/quienes-somos') {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: `
            <html>
              <head>
                <title>Quiénes Somos | Neteco</title>
                <link rel="canonical" href="https://neteco.beply.es/quienes-somos" />
              </head>
              <body><p>Empresa líder en higiene industrial.</p></body>
            </html>
          `
        }
      }
      return { status: 404, headers: {}, body: 'Not found' }
    }

    const result = await executeSeoTechnicalCrawl(db, {
      triggerType: 'scheduled',
      seedUrls: ['/'],
      maxDepth: 3,
      pageFetcher: mockFetcher,
      now: () => NOW
    })

    expect(result.status).toBe('completed')
    expect(result.totalUrlsScanned).toBe(4)
    expect(result.status2xxCount).toBe(4)
    expect(result.status4xxCount).toBe(0)
    expect(result.status5xxCount).toBe(0)
    expect(result.maxDepthReached).toBe(2) // / -> /categorias/desengrasantes -> /producto/...

    const run = await getSeoCrawlRunDetail(db, result.id)
    expect(run).toBeDefined()
    expect(run?.totalUrlsScanned).toBe(4)

    const runsList = await listSeoCrawlRuns(db)
    expect(runsList.length).toBe(1)
    expect(runsList[0]?.id).toBe(result.id)
  })

  it('detects 4xx and 5xx errors and records critical issues', async () => {
    const mockFetcher: PageFetcher = async (url: string) => {
      if (url === '/') {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: `
            <html>
              <body>
                <a href="/broken-404">Enlace roto</a>
                <a href="/crash-500">Error servidor</a>
              </body>
            </html>
          `
        }
      }
      if (url === '/broken-404') {
        return { status: 404, headers: {}, body: 'Not Found' }
      }
      if (url === '/crash-500') {
        return { status: 500, headers: {}, body: 'Server Error' }
      }
      return { status: 404, headers: {}, body: 'Not found' }
    }

    const result = await executeSeoTechnicalCrawl(db, {
      triggerType: 'manual',
      seedUrls: ['/'],
      pageFetcher: mockFetcher,
      now: () => NOW
    })

    expect(result.status4xxCount).toBe(1)
    expect(result.status5xxCount).toBe(1)

    const issues = await listSeoCrawlIssues(db, result.id)
    const err4xx = issues.find((i) => i.issueType === 'http_4xx')
    const err5xx = issues.find((i) => i.issueType === 'http_5xx')

    expect(err4xx).toBeDefined()
    expect(err4xx?.url).toBe('/broken-404')
    expect(err4xx?.severity).toBe('critical')

    expect(err5xx).toBeDefined()
    expect(err5xx?.url).toBe('/crash-500')
    expect(err5xx?.severity).toBe('critical')
  })

  it('detects canonical tag issues (missing, mismatch, relative)', async () => {
    const mockFetcher: PageFetcher = async (url: string) => {
      if (url === '/') {
        return {
          status: 200,
          headers: {},
          body: `
            <html>
              <body>
                <a href="/missing-canon">Sin canon</a>
                <a href="/mismatch-canon">Mismatch canon</a>
              </body>
            </html>
          `
        }
      }
      if (url === '/missing-canon') {
        return {
          status: 200,
          headers: {},
          body: `<html><head><title>No canonical</title></head><body>No canonical</body></html>`
        }
      }
      if (url === '/mismatch-canon') {
        return {
          status: 200,
          headers: {},
          body: `
            <html>
              <head>
                <link rel="canonical" href="https://neteco.beply.es/completely-different-target" />
              </head>
              <body>Mismatch</body>
            </html>
          `
        }
      }
      return { status: 404, headers: {}, body: 'Not found' }
    }

    const result = await executeSeoTechnicalCrawl(db, {
      triggerType: 'manual',
      seedUrls: ['/'],
      pageFetcher: mockFetcher,
      now: () => NOW
    })

    expect(result.canonicalIssuesCount).toBeGreaterThanOrEqual(2)

    const issues = await listSeoCrawlIssues(db, result.id)
    const missing = issues.find((i) => i.issueType === 'canonical_missing' && i.url === '/missing-canon')
    const mismatch = issues.find((i) => i.issueType === 'canonical_mismatch' && i.url === '/mismatch-canon')

    expect(missing).toBeDefined()
    expect(mismatch).toBeDefined()
  })

  it('detects noindex directives in both HTML meta and HTTP headers', async () => {
    const mockFetcher: PageFetcher = async (url: string) => {
      if (url === '/') {
        return {
          status: 200,
          headers: {},
          body: `
            <html>
              <body>
                <a href="/meta-noindex">Meta noindex</a>
                <a href="/header-noindex">Header noindex</a>
              </body>
            </html>
          `
        }
      }
      if (url === '/meta-noindex') {
        return {
          status: 200,
          headers: {},
          body: `
            <html>
              <head>
                <meta name="robots" content="noindex, follow" />
              </head>
              <body>Meta noindex content</body>
            </html>
          `
        }
      }
      if (url === '/header-noindex') {
        return {
          status: 200,
          headers: { 'x-robots-tag': 'noindex, noarchive' },
          body: `<html><body>Header noindex content</body></html>`
        }
      }
      return { status: 404, headers: {}, body: 'Not found' }
    }

    const result = await executeSeoTechnicalCrawl(db, {
      triggerType: 'manual',
      seedUrls: ['/'],
      pageFetcher: mockFetcher,
      now: () => NOW
    })

    expect(result.noindexCount).toBe(2)
  })

  it('detects orphan pages when compared against known catalog or sitemap URLs', async () => {
    const mockFetcher: PageFetcher = async (url: string) => {
      if (url === '/') {
        return {
          status: 200,
          headers: {},
          body: `<html><body><a href="/categoria/desinfeccion">Desinfección</a></body></html>`
        }
      }
      if (url === '/categoria/desinfeccion') {
        return {
          status: 200,
          headers: {},
          body: `<html><body><p>Categoria</p></body></html>`
        }
      }
      return { status: 404, headers: {}, body: 'Not found' }
    }

    const knownCatalogUrls = [
      '/',
      '/categoria/desinfeccion',
      '/producto/lejia-pura-1l', // Orphan: in catalog/sitemap but never linked internally
      '/producto/oxigeno-activo-5l' // Orphan
    ]

    const result = await executeSeoTechnicalCrawl(db, {
      triggerType: 'scheduled',
      seedUrls: ['/'],
      knownCatalogUrls,
      pageFetcher: mockFetcher,
      now: () => NOW
    })

    expect(result.orphanCount).toBe(2)

    const issues = await listSeoCrawlIssues(db, result.id)
    const orphans = issues.filter((i) => i.issueType === 'orphan_page')
    expect(orphans.length).toBe(2)
    expect(orphans.map((o) => o.url).sort()).toEqual(['/producto/lejia-pura-1l', '/producto/oxigeno-activo-5l'])
  })

  it('detects crawl depth and flags excessive depth (> 3 levels)', async () => {
    const mockFetcher: PageFetcher = async (url: string) => {
      if (url === '/') return { status: 200, headers: {}, body: `<a href="/l1">L1</a>` }
      if (url === '/l1') return { status: 200, headers: {}, body: `<a href="/l2">L2</a>` }
      if (url === '/l2') return { status: 200, headers: {}, body: `<a href="/l3">L3</a>` }
      if (url === '/l3') return { status: 200, headers: {}, body: `<a href="/l4">L4</a>` }
      if (url === '/l4') return { status: 200, headers: {}, body: `Deep page` }
      return { status: 404, headers: {}, body: 'Not found' }
    }

    const result = await executeSeoTechnicalCrawl(db, {
      triggerType: 'manual',
      seedUrls: ['/'],
      maxDepth: 5,
      pageFetcher: mockFetcher,
      now: () => NOW
    })

    expect(result.maxDepthReached).toBe(4)

    const issues = await listSeoCrawlIssues(db, result.id)
    const depthIssues = issues.filter((i) => i.issueType === 'excessive_depth')
    expect(depthIssues.length).toBeGreaterThanOrEqual(1)
    expect(depthIssues[0]?.url).toBe('/l4')
  })

  it('detects accidental changes and regressions against a baseline crawl', async () => {
    // 1. Baseline crawl: healthy
    const baselineFetcher: PageFetcher = async (url: string) => {
      if (url === '/') {
        return {
          status: 200,
          headers: {},
          body: `
            <html>
              <head><link rel="canonical" href="https://neteco.beply.es/" /><title>Inicio</title></head>
              <body>
                <a href="/producto/desengrasante">Desengrasante</a>
                <a href="/contacto">Contacto</a>
              </body>
            </html>
          `
        }
      }
      if (url === '/producto/desengrasante') {
        return {
          status: 200,
          headers: {},
          body: `
            <html>
              <head>
                <link rel="canonical" href="https://neteco.beply.es/producto/desengrasante" />
                <title>Desengrasante Original</title>
                <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Desengrasante"}</script>
              </head>
              <body><h1>Desengrasante</h1></body>
            </html>
          `
        }
      }
      if (url === '/contacto') {
        return {
          status: 200,
          headers: {},
          body: `<html><head><link rel="canonical" href="https://neteco.beply.es/contacto" /><title>Contacto</title></head><body>Contacto</body></html>`
        }
      }
      return { status: 404, headers: {}, body: 'Not found' }
    }

    const baselineRun = await executeSeoTechnicalCrawl(db, {
      triggerType: 'scheduled',
      seedUrls: ['/'],
      pageFetcher: baselineFetcher,
      now: () => '2026-10-28T12:00:00Z'
    })

    // 2. Current crawl with accidental regressions:
    // - /contacto regressed to 404!
    // - /producto/desengrasante accidentally got noindex and schema removed!
    const regressionFetcher: PageFetcher = async (url: string) => {
      if (url === '/') {
        return {
          status: 200,
          headers: {},
          body: `
            <html>
              <head><link rel="canonical" href="https://neteco.beply.es/" /><title>Inicio</title></head>
              <body>
                <a href="/producto/desengrasante">Desengrasante</a>
                <a href="/contacto">Contacto</a>
              </body>
            </html>
          `
        }
      }
      if (url === '/producto/desengrasante') {
        return {
          status: 200,
          headers: {},
          body: `
            <html>
              <head>
                <meta name="robots" content="noindex" />
                <link rel="canonical" href="https://neteco.beply.es/producto/desengrasante" />
                <title>Desengrasante Modificado Accidentalmente</title>
              </head>
              <body><h1>Desengrasante</h1></body>
            </html>
          `
        }
      }
      if (url === '/contacto') {
        return { status: 404, headers: {}, body: 'Accidental 404' }
      }
      return { status: 404, headers: {}, body: 'Not found' }
    }

    const currentRun = await executeSeoTechnicalCrawl(db, {
      triggerType: 'scheduled',
      seedUrls: ['/'],
      baselineRunId: baselineRun.id,
      pageFetcher: regressionFetcher,
      now: () => NOW
    })

    expect(currentRun.accidentalChangesCount).toBeGreaterThanOrEqual(2)

    const issues = await listSeoCrawlIssues(db, currentRun.id)
    const statusRegression = issues.find((i) => i.issueType === 'status_regression' && i.url === '/contacto')
    const accidentalNoindex = issues.find(
      (i) => i.issueType === 'accidental_noindex' && i.url === '/producto/desengrasante'
    )

    expect(statusRegression).toBeDefined()
    expect(statusRegression?.severity).toBe('critical')
    expect(accidentalNoindex).toBeDefined()
    expect(accidentalNoindex?.severity).toBe('critical')
  })
})
