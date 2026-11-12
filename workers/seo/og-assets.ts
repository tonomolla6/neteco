import yogaWasm from 'yoga-wasm-web/dist/yoga.wasm'
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'
import archivo600 from './og-assets/archivo-600.bin'
import inter400 from './og-assets/inter-400.bin'
import { NETECO_LOGO_SVG } from './og-logo'
import type { OgRenderAssets } from './og-render'

/** Activos empaquetados con el Worker: fuentes latinas (Archivo 600, Inter 400), logotipo y wasm de satori/resvg. */
export const OG_RENDER_ASSETS: OgRenderAssets = {
  archivo600,
  inter400,
  logoSvg: NETECO_LOGO_SVG,
  yogaWasm,
  resvgWasm
}
