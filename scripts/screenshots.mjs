import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = 'http://localhost:3000'
const OUT =
  process.env.SHOTS_OUT ??
  '/tmp/claude-1000/-workspaces-neteco-shop/55295886-1a81-42d8-9a45-a0d117e3ded8/scratchpad/shots/'
mkdirSync(OUT, { recursive: true })

const cart = JSON.stringify([
  {
    productId: 1,
    slug: 'desengrasante-energico-dg-40',
    name: 'Desengrasante enérgico DG-40',
    brand: 'NETTION',
    variantId: 1,
    format: 'Garrafa 5 L',
    sku: 'NE-001-1',
    price: 1890,
    qty: 2,
    visual: { type: 'garrafa', color: '#f97316' }
  },
  {
    productId: 3,
    slug: 'lavavajillas-manual-extra',
    name: 'Lavavajillas manual Extra',
    brand: 'NETTION',
    variantId: 6,
    format: 'Botella 1 L',
    sku: 'NE-003-1',
    price: 320,
    qty: 6,
    visual: { type: 'botella', color: '#009ac9' }
  }
])

const PAGES = [
  ['home', '/', false],
  ['catalogo', '/catalogo', false],
  ['categoria', '/categoria/desengrasantes', false],
  ['categoria-raiz', '/categoria/productos-quimicos', false],
  ['producto', '/producto/desengrasante-energico-dg-40', false],
  ['carrito', '/carrito', true],
  ['checkout', '/checkout', true],
  ['login', '/login', false],
  ['pedido', '/pedido/NE-MSNJ6TEF5W?token=ab3bb0e8-3f47-4d55-8725-898640ce096a', false]
]

const browser = await chromium.launch()
for (const [vp, width, height] of [
  ['desktop', 1440, 900],
  ['mobile', 390, 844]
]) {
  const ctx = await browser.newContext({ viewport: { width, height } })
  for (const [name, path, needCart] of PAGES) {
    const page = await ctx.newPage()
    if (needCart) await page.addInitScript((c) => localStorage.setItem('neteco-cart', c), cart)
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(700)
    await page.screenshot({ path: `${OUT}${name}-${vp}.png`, fullPage: true })
    await page.close()
    console.log(`${name}-${vp} ok`)
  }
  // mega-menú desplegado (solo escritorio)
  if (vp === 'desktop') {
    const page = await ctx.newPage()
    await page.goto(BASE + '/', { waitUntil: 'networkidle' })
    await page.hover('nav .group > a')
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${OUT}megamenu-desktop.png` })
    await page.close()
    console.log('megamenu-desktop ok')
  }
  await ctx.close()
}
await browser.close()
