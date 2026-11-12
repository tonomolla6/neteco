import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { NETECO_LOGO_SVG } from '../../workers/seo/og-logo'
import { toOgPhoto } from '../../workers/seo/og-photo'
import type { OgPhoto } from '../../workers/seo/og-card'
import type { OgRenderAssets } from '../../workers/seo/og-render'

const root = fileURLToPath(new URL('../..', import.meta.url))
const arrayBuffer = (path: string) => {
  const bytes = readFileSync(resolve(root, path))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

let cached: Promise<OgRenderAssets> | undefined
/** Mismos activos que el Worker (fuentes, logotipo, wasm), cargados desde disco para Node. */
export function loadOgRenderAssets(): Promise<OgRenderAssets> {
  cached ??= (async () => ({
    archivo600: arrayBuffer('workers/seo/og-assets/archivo-600.bin'),
    inter400: arrayBuffer('workers/seo/og-assets/inter-400.bin'),
    logoSvg: NETECO_LOGO_SVG,
    yogaWasm: await WebAssembly.compile(readFileSync(resolve(root, 'node_modules/yoga-wasm-web/dist/yoga.wasm'))),
    resvgWasm: await WebAssembly.compile(readFileSync(resolve(root, 'node_modules/@resvg/resvg-wasm/index_bg.wasm')))
  }))()
  return cached
}

export function pngSize(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const signature = [...png.subarray(0, 8)].join(',')
  return { signature, width: view.getUint32(16), height: view.getUint32(20) }
}
export const PNG_SIGNATURE = '137,80,78,71,13,10,26,10'

/** Foto sintética: fondo blanco con un rectángulo de color, en JPEG, a cualquier proporción. */
export async function syntheticPhoto(width: number, height: number, format: 'jpeg' | 'png' = 'jpeg'): Promise<OgPhoto> {
  const base = sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).composite([
    {
      input: {
        create: {
          width: Math.max(1, Math.round(width * 0.6)),
          height: Math.max(1, Math.round(height * 0.7)),
          channels: 3,
          background: '#1c7ab5'
        }
      },
      gravity: 'center'
    }
  ])
  const bytes = new Uint8Array(await (format === 'jpeg' ? base.jpeg({ quality: 80 }) : base.png()).toBuffer())
  return toOgPhoto(bytes)!
}
