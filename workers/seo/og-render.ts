import satori, { init as initSatori } from 'satori/wasm'
import initYoga from 'yoga-wasm-web'
import { initWasm, Resvg } from '@resvg/resvg-wasm'
import { OG_HEIGHT, OG_WIDTH } from '../../shared/og-image'
import { buildCardTree, type OgCardSpec } from './og-card'

export interface OgRenderAssets {
  archivo600: ArrayBuffer
  inter400: ArrayBuffer
  /** SVG del logotipo horizontal oficial. */
  logoSvg: string
  yogaWasm: WebAssembly.Module
  resvgWasm: WebAssembly.Module
}

/** Las redes sociales rechazan o recortan tarjetas pesadas: tope duro de 300 KB. */
export const OG_MAX_BYTES = 300 * 1024

let wasmReady: Promise<void> | null = null

function ensureWasm(assets: OgRenderAssets) {
  // Un fallo de inicialización no se memoriza: el siguiente intento vuelve a probar.
  wasmReady ??= Promise.all([initYoga(assets.yogaWasm).then(initSatori), initWasm(assets.resvgWasm)])
    .then(() => undefined)
    .catch((error: unknown) => {
      wasmReady = null
      throw error
    })
  return wasmReady
}

function logoDataUri(svg: string) {
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

/** Satori (maquetación a SVG) + resvg-wasm (SVG a PNG) sobre fuentes y logotipo empaquetados. */
export function createOgRenderer(assets: OgRenderAssets) {
  const fonts = [
    { name: 'Archivo', data: assets.archivo600, weight: 600 as const, style: 'normal' as const },
    { name: 'Inter', data: assets.inter400, weight: 400 as const, style: 'normal' as const }
  ]
  const logo = logoDataUri(assets.logoSvg)
  async function renderOnce(spec: OgCardSpec): Promise<Uint8Array> {
    await ensureWasm(assets)
    const svg = await satori(buildCardTree(spec, logo) as Parameters<typeof satori>[0], {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      fonts
    })
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } })
    try {
      const image = resvg.render()
      try {
        return image.asPng()
      } finally {
        image.free()
      }
    } finally {
      resvg.free()
    }
  }
  return {
    /** Si las fotos hacen pasar el PNG de OG_MAX_BYTES se redibuja la misma tarjeta sin fotos (el texto manda). */
    async render(spec: OgCardSpec): Promise<Uint8Array> {
      const png = await renderOnce(spec)
      if (png.byteLength <= OG_MAX_BYTES) return png
      const photoless: OgCardSpec = spec.kind === 'categoria' ? { ...spec, photos: [] } : { ...spec, photo: null }
      const fallback = await renderOnce(photoless)
      if (fallback.byteLength > OG_MAX_BYTES) throw new Error('og_image_over_budget')
      return fallback
    }
  }
}
