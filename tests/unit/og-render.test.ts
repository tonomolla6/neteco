import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { beforeAll, describe, expect, it } from 'vitest'
import { layoutCard, containBox, type OgCardSpec, type OgPhoto, formatEuros } from '../../workers/seo/og-card'
import { toOgPhoto } from '../../workers/seo/og-photo'
import { OG_MAX_BYTES, createOgRenderer } from '../../workers/seo/og-render'
import { PNG_SIGNATURE, loadOgRenderAssets, pngSize, syntheticPhoto } from '../support/og-render-assets'

const MAX_BYTES = 300 * 1024
let renderer: ReturnType<typeof createOgRenderer>
beforeAll(async () => {
  renderer = createOgRenderer(await loadOgRenderAssets())
})

const product = (overrides: Partial<Extract<OgCardSpec, { kind: 'producto' }>> = {}): OgCardSpec => ({
  kind: 'producto',
  title: 'Guante de nitrilo azul caja 100 uds',
  brand: 'NETECO',
  formats: 3,
  fromPriceCents: 1250,
  reference: 'NET-GN-100',
  photo: null,
  ...overrides
})

async function expectValidCard(spec: OgCardSpec) {
  const png = await renderer.render(spec)
  expect(pngSize(png)).toEqual({ signature: PNG_SIGNATURE, width: 1200, height: 630 })
  expect(png.byteLength).toBeLessThanOrEqual(MAX_BYTES)
  return png
}

describe('Open Graph PNG rendering', () => {
  it('renders a 1200x630 PNG under 300 KB for a product without a photo', async () => {
    await expectValidCard(product())
  })

  it('renders vertical, horizontal, tiny and PNG photos without distortion or oversize output', async () => {
    for (const [width, height, format] of [
      [300, 900, 'jpeg'],
      [1200, 240, 'jpeg'],
      [24, 24, 'jpeg'],
      [640, 640, 'png']
    ] as const) {
      await expectValidCard(product({ photo: await syntheticPhoto(width, height, format) }))
    }
  })

  it('renders every supported kind and 0 to 5 category thumbnails', async () => {
    const photo = await syntheticPhoto(400, 400)
    for (const count of [0, 1, 2, 3, 4, 5]) {
      await expectValidCard({
        kind: 'categoria',
        title: 'Productos químicos',
        productCount: count,
        photos: Array(count).fill(photo)
      })
    }
    await expectValidCard({
      kind: 'plantilla',
      title: 'Checklist de limpieza APPCC',
      subtitle: 'Plantilla para hostelería',
      photo: null
    })
    await expectValidCard({ kind: 'contenido', title: 'Guía de dosificación', subtitle: null, photo })
  })

  it('renders extreme names: 180+ characters, a 40 character word, all caps, accents and symbols', async () => {
    const long = 'Desengrasante concentrado multiusos de alta espuma para cocinas industriales '.repeat(4)
    expect(long.length).toBeGreaterThan(180)
    await expectValidCard(product({ title: long, brand: 'Marca '.repeat(30), reference: 'REF'.repeat(40) }))
    await expectValidCard(product({ title: `Gel ${'Supercalifragilisticoespialidoso'.padEnd(40, 'x')}` }))
    await expectValidCard(product({ title: 'DESENGRASANTE CONCENTRADO PROFESIONAL ALTA ESPUMA 5 L' }))
    await expectValidCard(
      product({ title: 'Ácido peróxido “Ñandú” 90° 5,5 € NETECO® — 清洁 🧼', brand: 'Química Ñ&®' })
    )
    await expectValidCard(product({ title: '' }))
  })

  it('draws the title, not a placeholder: output differs between titles and is deterministic', async () => {
    const a = await renderer.render(product({ title: 'Alfa' }))
    const b = await renderer.render(product({ title: 'Beta' }))
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
    expect(Buffer.from(a).equals(Buffer.from(await renderer.render(product({ title: 'Alfa' }))))).toBe(true)
  })

  it('stays under budget with a real catalogue photo', async () => {
    const bytes = readFileSync(resolve(__dirname, '../../public/img/products/cristalin/cristalin.jpg'))
    const photo = toOgPhoto(new Uint8Array(bytes))!
    expect(photo).toBeTruthy()
    await expectValidCard(product({ photo }))
  })
})

describe('card layout', () => {
  const photo: OgPhoto = { dataUri: 'data:image/png;base64,AA==', width: 400, height: 400 }

  it('never lets text overlap the photo panel or leave the safety margin, for hostile inputs', () => {
    const titles = [
      '',
      'A',
      'x '.repeat(200),
      'W'.repeat(200),
      'Desengrasante concentrado multiusos de alta espuma para cocinas industriales '.repeat(4),
      'MAYÚSCULAS COMPLETAS DE UN NOMBRE MUY LARGO PARA UN PRODUCTO DE HOSTELERÍA'
    ]
    for (const title of titles) {
      for (const withPhoto of [true, false]) {
        const layout = layoutCard(
          product({ title, brand: 'B'.repeat(80), reference: 'R'.repeat(80), photo: withPhoto ? photo : null })
        )
        const right = layout.textBlock.x + layout.textBlock.width
        const panelLeft = layout.tiles[0]?.tile.x ?? 1200 - 60
        expect(right).toBeLessThanOrEqual(withPhoto ? panelLeft : 1140)
        expect(layout.textBlock.x).toBe(60)
        expect(layout.textBlock.y).toBeGreaterThanOrEqual(140)
        const last = layout.textLines.at(-1)
        if (last) expect(last.top + last.height).toBeLessThanOrEqual(560)
      }
    }
  })

  it('fits photos with contain semantics: never deformed, never larger than 3x, centred in the box', () => {
    const tile = { x: 720, y: 130, width: 420, height: 420 }
    for (const [width, height] of [
      [300, 900],
      [1200, 240],
      [24, 24],
      [800, 800]
    ]) {
      const box = containBox({ ...photo, width, height }, tile, 20)
      expect(box.width / box.height).toBeCloseTo(width / height, 1)
      expect(box.width).toBeLessThanOrEqual(380)
      expect(box.height).toBeLessThanOrEqual(380)
      expect(box.width).toBeLessThanOrEqual(width * 3 + 1)
      expect(box.x).toBeGreaterThanOrEqual(tile.x + 20 - 1)
      expect(box.x + box.width).toBeLessThanOrEqual(tile.x + tile.width - 20 + 1)
    }
  })

  it('shows a price only when it is public, and pluralises counts', () => {
    const lines = (spec: OgCardSpec) => layoutCard(spec).textLines.map((line) => line.text)
    expect(lines(product({ fromPriceCents: null, formats: 1 }))).toContain('1 formato')
    expect(lines(product({ fromPriceCents: null })).join('|')).not.toMatch(/€|desde/)
    // catálogo importado sin tarifa: un precio 0 no se dibuja nunca como «0,00 €»
    expect(lines(product({ fromPriceCents: 0 })).join('|')).not.toMatch(/€|desde|0,00/)
    expect(lines(product({ fromPriceCents: 123456 })).join('|')).toContain('desde 1.234,56 € IVA incl.')
    expect(lines({ kind: 'categoria', title: 'Guantes', productCount: 1, photos: [] })).toContain('1 producto')
    expect(lines({ kind: 'categoria', title: 'Guantes', productCount: 0, photos: [] })).not.toContain('0 productos')
  })

  it('formats euros the Spanish way', () => {
    expect(formatEuros(5)).toBe('0,05 €')
    expect(formatEuros(1250)).toBe('12,50 €')
    expect(formatEuros(100000000)).toBe('1.000.000,00 €')
  })
})

describe('photo validation', () => {
  it('rejects non-image bytes, oversized files and unknown formats (no photo instead of a broken card)', () => {
    expect(toOgPhoto(new Uint8Array([1, 2, 3, 4]))).toBeNull()
    expect(toOgPhoto(new Uint8Array(0))).toBeNull()
    expect(toOgPhoto(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull()
    expect(toOgPhoto(new Uint8Array(1_500_001).fill(0xff))).toBeNull()
  })
})

describe('size budget', () => {
  it('drops the photos, keeping the text, when a noisy photo would push the PNG over 300 KB', async () => {
    expect(OG_MAX_BYTES).toBe(MAX_BYTES)
    const noise = Buffer.alloc(800 * 800 * 3)
    for (let index = 0; index < noise.length; index++) noise[index] = (index * 2654435761) >>> 24
    const bytes = new Uint8Array(
      await sharp(noise, { raw: { width: 800, height: 800, channels: 3 } })
        .jpeg({ quality: 95 })
        .toBuffer()
    )
    const photo = toOgPhoto(bytes)!
    const png = await renderer.render(product({ photo }))
    expect(pngSize(png).width).toBe(1200)
    expect(png.byteLength).toBeLessThanOrEqual(MAX_BYTES)
    const photoless = await renderer.render(product({ photo: null }))
    expect(Buffer.from(png).equals(Buffer.from(photoless))).toBe(true)
  })
})
