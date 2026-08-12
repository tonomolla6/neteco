// Sincronización de datos de producto desde eurosanex.com (el fabricante).
// 1) Crawlea las categorías públicas y construye un índice título→URL.
// 2) Casa los productos de nuestra BD (nombres del ERP) contra ese índice.
// 3) De cada acierto extrae descripción, modo de empleo, foto y ficha técnica PDF.
// 4) Normaliza las fotos a 800×800 sobre blanco y aplica todo a la BD.
// Uso: node scripts/eurosanex-sync.mjs [--dry] [--limit N]
import postgres from 'postgres'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const BASE = 'https://www.eurosanex.com'
const UA = 'NetecoShopSync/1.0 (tienda de distribuidor; contacto: administracion@neteco.es)'
const DELAY = 850
const DRY = process.argv.includes('--dry')
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit')
  return i > -1 ? Number(process.argv[i + 1]) : Infinity
})()

const OUT = {
  cache: '.cache/eurosanex',
  fichas: 'public/docs/fichas',
  imgs: 'public/img/products'
}
for (const d of Object.values(OUT)) fs.mkdirSync(d, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function get(url) {
  await sleep(DELAY)
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res
}
const norm = (s) =>
  s
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()

// ——— FASE 1: índice de productos por crawl de categorías ———
const EXCLUDE =
  /fregadoras|aspiradores|apiradores|rotativas|hidrolimpiadoras|secadores|equipos-de|maquinaria|barras|felpudos|carros|catalogo$/

async function buildIndex() {
  const cachePath = path.join(OUT.cache, 'index.json')
  if (fs.existsSync(cachePath)) {
    console.log('[índice] usando caché', cachePath)
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  }
  const seedHtml = await (await get(`${BASE}/es/13-productos-quimicos`)).text()
  const cats = [
    ...new Set([...seedHtml.matchAll(/https:\/\/www\.eurosanex\.com\/es\/(\d+-[a-z0-9-]+)/g)].map((m) => m[1]))
  ].filter((c) => !EXCLUDE.test(c))
  console.log(`[índice] ${cats.length} categorías a crawlear`)

  const index = {} // url → title
  for (const cat of cats) {
    const pagesSeen = new Set()
    const queue = [`${BASE}/es/${cat}`]
    while (queue.length) {
      const url = queue.shift()
      if (pagesSeen.has(url)) continue
      pagesSeen.add(url)
      let html
      try {
        html = await (await get(url)).text()
      } catch (e) {
        console.log(`[índice] fallo ${url}: ${e.message}`)
        continue
      }
      // productos: <a ... href="/es/{cat}/{id}-{slug}.html" ... title="TÍTULO">
      for (const m of html.matchAll(
        /<a[^>]+href="(https:\/\/www\.eurosanex\.com\/es\/[a-z0-9-]+\/\d+-[a-z0-9-]+\.html)"[^>]*title="([^"]+)"/g
      )) {
        if (!index[m[1]]) index[m[1]] = m[2]
      }
      // paginación de la propia categoría
      for (const m of html.matchAll(/href="(https:\/\/www\.eurosanex\.com\/es\/[0-9]+-[a-z0-9-]+\?p=\d+)"/g)) {
        if (m[1].includes(cat) && !pagesSeen.has(m[1])) queue.push(m[1])
      }
    }
    console.log(`[índice] ${cat} → ${Object.keys(index).length} acumulados`)
  }
  fs.writeFileSync(cachePath, JSON.stringify(index, null, 1))
  return index
}

// ——— FASE 2: matching nombre ERP → producto EuroSanex ———
function searchKey(name) {
  // guantes y menaje renombrados por nosotros: usar la parte distintiva
  const glove = name.match(/^(?:Guante|Manopla)[a-zá-ú ]*? de [a-zá-ú]+ (.+?)(?: \(|$)/i)
  if (glove) return norm(glove[1])
  // EuroSanex escribe «BOX+C» como «boxc» (y el ERP tiene el typo «BOX+X»)
  return norm(name.replace(/\s*\(.*\)$/, '')).replace(/BOX [CX]\b/g, 'BOXC')
}

function matchProducts(products, index) {
  // el título fiable es el slug de la URL (los anchors capturan el botón «Ver»)
  const entries = Object.keys(index).map((url) => {
    const slug = url.match(/\/\d+-([a-z0-9-]+)\.html/)?.[1] ?? ''
    const title = slug.replace(/-/g, ' ')
    return { url, title, n: ` ${norm(title)} ` }
  })
  const matched = []
  const unmatched = []
  for (const p of products) {
    const key = ` ${searchKey(p.name)} `
    if (key.trim().length < 3) {
      unmatched.push({ name: p.name, reason: 'clave demasiado corta' })
      continue
    }
    let cands = entries.filter((e) => e.n.includes(key))
    if (!cands.length) {
      unmatched.push({ name: p.name, key: key.trim(), reason: 'sin candidatos' })
      continue
    }
    const ends = cands.filter((e) => e.n.trimEnd().endsWith(key.trimEnd()))
    if (ends.length) cands = ends
    cands.sort((a, b) => a.title.length - b.title.length)
    matched.push({ product: p, url: cands[0].url, title: cands[0].title, ambiguous: cands.length > 1 })
  }
  return { matched, unmatched }
}

// ——— FASE 3: extracción por producto ———
function textLines(html) {
  let body = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ' ').replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
  body = body.replace(/<(h[1-6]|p|div|li|tr|section|td|span|br)[^>]*>/g, '\n')
  const text = body
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&aacute;/g, 'á')
    .replace(/&eacute;/g, 'é')
    .replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó')
    .replace(/&uacute;/g, 'ú')
    .replace(/&ntilde;/g, 'ñ')
    .replace(/&deg;/g, 'º')
    .replace(/&ordm;/g, 'º')
  const seen = new Set()
  return text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 2 && !seen.has(l) && seen.add(l))
}

function extractProduct(html, pageUrl) {
  const pageSlug = pageUrl.match(/\/\d+-([a-z0-9-]+)\.html/)?.[1]
  const lines = textLines(html)
  const iRef = lines.findIndex((l) => /^Referencia\b/.test(l))
  const iModo = lines.findIndex((l) => /^Modo de empleo:?$/i.test(l))
  const iEnd = lines.findIndex((l) => /^(Descargar Ficha|La cantidad m[ií]nima)/i.test(l))
  const end = iEnd > -1 ? iEnd : lines.length
  const clean = (arr) => arr.filter((l) => l.length > 25 && !/^(Imprimir|Referencia)/.test(l))
  let description = null
  let usage = null
  if (iRef > -1) {
    description = clean(lines.slice(iRef + 1, iModo > -1 ? iModo : end)).join('\n\n') || null
    if (iModo > -1) usage = clean(lines.slice(iModo + 1, end)).join(' ') || null
  }
  let image =
    html.match(new RegExp(`https://www\\.eurosanex\\.com/(\\d+)-large_default/${pageSlug}\\.jpg`))?.[0] ??
    html.match(new RegExp(`https://www\\.eurosanex\\.com/(\\d+)-thickbox_default/${pageSlug}\\.jpg`))?.[0] ??
    null
  const datasheet = html.match(/href="(\/FICHAS-PRODUCTOS\/[^"]+\.pdf)"/)?.[1] ?? null
  return { description, usage, image, datasheet }
}

// ——— main ———
const connection = process.env.DATABASE_URL?.trim()
if (!connection) throw new Error('DATABASE_URL is required')
const db = postgres(connection, { max: 1, connect_timeout: 10 })
const products = await db`
  SELECT id, name, slug, attributes ->> 'image' AS image,
         attributes ->> 'datasheet' AS datasheet, usage
  FROM products ORDER BY legacy_id
`

const index = await buildIndex()
console.log(`[índice] ${Object.keys(index).length} productos EuroSanex indexados`)

const { matched, unmatched } = matchProducts(products, index)
console.log(`[match] ${matched.length} casados, ${unmatched.length} sin match (de ${products.length})`)

const report = {
  matchedCount: matched.length,
  unmatched,
  applied: [],
  errors: [],
  extraEurosanex: Object.keys(index).length
}
const toNormalize = []

let processed = 0
for (const m of matched) {
  if (processed >= LIMIT) break
  processed++
  const { product, url } = m
  try {
    const html = await (await get(url)).text()
    const data = extractProduct(html, url)
    const entry = { name: product.name, slug: product.slug, url, got: [] }

    if (data.image) {
      const raw = path.join(OUT.cache, `${product.slug}.jpg`)
      if (!fs.existsSync(raw)) {
        const buf = Buffer.from(await (await get(data.image)).arrayBuffer())
        if (buf.length > 3000) fs.writeFileSync(raw, buf)
      }
      if (fs.existsSync(raw)) {
        toNormalize.push(product.slug)
        entry.got.push('foto')
      }
    }
    let datasheetPath = null
    if (data.datasheet) {
      datasheetPath = `/docs/fichas/${product.slug}-ft.pdf`
      const dest = path.join('public', datasheetPath)
      if (!fs.existsSync(dest)) {
        const buf = Buffer.from(await (await get(BASE + data.datasheet.replace(/ /g, '%20'))).arrayBuffer())
        if (buf.subarray(0, 4).toString() === '%PDF') fs.writeFileSync(dest, buf)
        else datasheetPath = null
      }
      if (datasheetPath) entry.got.push('ficha')
    }
    if (data.description) entry.got.push('descripción')
    if (data.usage) entry.got.push('modo de empleo')

    if (!DRY) {
      await db`
        UPDATE products SET
          description = COALESCE(${data.description}, description),
          usage = COALESCE(${data.usage}, usage),
          attributes = CASE WHEN ${datasheetPath}::text IS NULL THEN attributes
                            ELSE jsonb_set(attributes, '{datasheet}', to_jsonb(${datasheetPath}::text), true) END,
          updated_at = now()
        WHERE id = ${product.id}
      `
    }
    report.applied.push(entry)
    console.log(`[ok ${processed}/${matched.length}] ${product.name} → ${entry.got.join(', ') || 'nada'}`)
  } catch (e) {
    report.errors.push({ name: product.name, url, error: e.message })
    console.log(`[error] ${product.name}: ${e.message}`)
  }
}

// ——— FASE 4: normalizar fotos y aplicarlas ———
if (!DRY && toNormalize.length) {
  console.log(`[fotos] normalizando ${toNormalize.length} imágenes…`)
  const browser = await chromium.launch({
    args: ['--disable-dev-shm-usage', '--no-sandbox', '--renderer-process-limit=1']
  })
  const page = await (await browser.newContext({ viewport: { width: 800, height: 800 } })).newPage()
  for (const slug of toNormalize) {
    const raw = path.resolve(OUT.cache, `${slug}.jpg`)
    const html = path.resolve(OUT.cache, 'norm.html')
    fs.writeFileSync(
      html,
      `<body style="margin:0"><div style="width:800px;height:800px;background:#fff;display:flex;align-items:center;justify-content:center"><img src="file://${raw}" style="max-width:88%;max-height:88%;object-fit:contain"></div></body>`
    )
    try {
      await page.goto('file://' + html, { waitUntil: 'networkidle', timeout: 30000 })
      await page.waitForTimeout(250)
      await page.screenshot({ path: path.join(OUT.imgs, `${slug}.jpg`), type: 'jpeg', quality: 84 })
      await db`
        UPDATE products
        SET attributes = jsonb_set(attributes, '{image}', to_jsonb(${`/img/products/${slug}.jpg`}::text), true),
            updated_at = now()
        WHERE slug = ${slug}
      `
    } catch (e) {
      console.log(`[fotos] fallo ${slug}: ${e.message}`)
    }
  }
  await browser.close()
}

fs.writeFileSync(path.join(OUT.cache, 'report.json'), JSON.stringify(report, null, 1))
console.log('\n=== RESUMEN ===')
console.log('Índice EuroSanex:', report.extraEurosanex, 'productos')
console.log('Casados:', report.matchedCount, '| Aplicados:', report.applied.length, '| Errores:', report.errors.length)
console.log('Sin match:', report.unmatched.length)
report.unmatched.slice(0, 40).forEach((u) => console.log('  -', u.name, u.reason ? `(${u.reason})` : ''))
console.log('Informe completo: .cache/eurosanex/report.json')
await db.end({ timeout: 5 })
