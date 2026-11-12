import { OG_HEIGHT, OG_WIDTH } from '../../shared/og-image'
import { ARCHIVO_600_METRICS, INTER_400_METRICS } from './og-metrics'
import { fitText } from './og-text'

/** Foto ya validada y decodificada en tamaño (JPEG/PNG); el contenido viaja como data URI. */
export interface OgPhoto {
  dataUri: string
  width: number
  height: number
}

export type OgCardSpec =
  | {
      kind: 'producto'
      title: string
      brand: string | null
      formats: number
      /** Precio público mínimo con IVA, en céntimos; null cuando no hay precio público. */
      fromPriceCents: number | null
      reference: string | null
      photo: OgPhoto | null
    }
  | { kind: 'categoria'; title: string; productCount: number; photos: readonly OgPhoto[] }
  | {
      kind: 'plantilla' | 'contenido'
      title: string
      subtitle: string | null
      photo: OgPhoto | null
    }

/** Árbol mínimo compatible con satori (sin React). */
export interface OgNode {
  type: string
  props: {
    style?: Record<string, string | number>
    children?: OgNode | string | Array<OgNode | string>
    [key: string]: unknown
  }
}

export const OG_COLORS = {
  brand: '#0d455c',
  accent: '#038ecd',
  text: '#3b5966',
  white: '#ffffff',
  panelBorder: '#d3e3ec'
} as const

export const OG_MARGIN = 60
const LOGO = { height: 44, ratio: 181.63 / 36 }
const BLOCK_BOTTOM = 548
const BLOCK_TOP_LIMIT = 140
const PANEL = { x: 720, y: 130, width: 420, height: 420 }
const TEXT_WIDTH_WITH_PANEL = PANEL.x - OG_MARGIN - 60
const TEXT_WIDTH_FULL = OG_WIDTH - OG_MARGIN * 2
// Margen de seguridad frente a diferencias de kerning entre la medición y el dibujo.
const SAFETY = 0.97
const TITLE_SIZES = [64, 52, 44] as const
const TITLE_TRACKING = -0.012

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface TextLine {
  text: string
  top: number
  height: number
  size: number
  font: 'Archivo' | 'Inter'
  color: string
  letterSpacing: number
}

export interface CardLayout {
  textLines: TextLine[]
  accent: Box
  textWidth: number
  /** Cajas de las fotos ya ajustadas (contain) y los recuadros de fondo; vacío si no hay panel. */
  tiles: Array<{ tile: Box; photo: OgPhoto | null; image: Box | null }>
  textBlock: Box
}

export function formatEuros(cents: number): string {
  const whole = Math.floor(cents / 100)
  const decimals = String(Math.abs(cents % 100)).padStart(2, '0')
  return `${String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${decimals} €`
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** Encaja la foto dentro de la caja sin deformarla ni ampliarla más de 3 veces su tamaño real. */
export function containBox(photo: OgPhoto, box: Box, padding: number): Box {
  const availableWidth = Math.max(1, box.width - padding * 2)
  const availableHeight = Math.max(1, box.height - padding * 2)
  const scale = Math.min(availableWidth / photo.width, availableHeight / photo.height, 3)
  const width = Math.max(1, Math.round(photo.width * scale))
  const height = Math.max(1, Math.round(photo.height * scale))
  return {
    x: Math.round(box.x + (box.width - width) / 2),
    y: Math.round(box.y + (box.height - height) / 2),
    width,
    height
  }
}

function tilesFor(photos: readonly OgPhoto[]): Box[] {
  const gap = 12
  const { x, y, width, height } = PANEL
  const half = (width - gap) / 2
  const rows = (height - gap) / 2
  const left = { x, y, width: half, height }
  const topRight = { x: x + half + gap, y, width: half, height: rows }
  const bottomRight = { x: x + half + gap, y: y + rows + gap, width: half, height: rows }
  const bottomLeft = { x, y: y + rows + gap, width: half, height: rows }
  const topLeft = { x, y, width: half, height: rows }
  if (photos.length <= 1) return [PANEL]
  if (photos.length === 2) return [left, { ...left, x: x + half + gap }]
  if (photos.length === 3) return [left, topRight, bottomRight]
  return [topLeft, topRight, bottomLeft, bottomRight]
}

/** Calcula, sin dibujar, dónde va cada línea de texto y cada foto. Es la fuente de verdad del diseño. */
export function layoutCard(spec: OgCardSpec): CardLayout {
  const photos: readonly OgPhoto[] =
    spec.kind === 'categoria' ? spec.photos.slice(0, 4) : spec.photo ? [spec.photo] : []
  const hasPanel = photos.length > 0
  const textWidth = hasPanel ? TEXT_WIDTH_WITH_PANEL : TEXT_WIDTH_FULL
  const usable = textWidth * SAFETY

  const secondary: Array<{ text: string; size: number; color: string; lineHeight: number; maxLines: number }> = []
  const addSecondary = (
    text: string | null | undefined,
    sizes: readonly number[],
    maxLines = 1,
    color: string = OG_COLORS.text
  ) => {
    const fitted = fitText(text ?? '', { metrics: INTER_400_METRICS, sizes, maxWidth: usable, maxLines })
    for (const line of fitted.lines)
      secondary.push({ text: line, size: fitted.size, color, lineHeight: Math.round(fitted.size * 1.43), maxLines })
  }

  if (spec.kind === 'producto') {
    addSecondary(spec.brand, [28, 24])
    const meta = [plural(spec.formats, 'formato', 'formatos')]
    if (spec.fromPriceCents !== null && spec.fromPriceCents > 0)
      meta.push(`desde ${formatEuros(spec.fromPriceCents)} IVA incl.`)
    if (spec.formats > 0) addSecondary(meta.join(' · '), [28, 24, 20])
    addSecondary(spec.reference ? `Ref. ${spec.reference}` : null, [24, 20])
  } else if (spec.kind === 'categoria') {
    addSecondary(
      spec.productCount > 0 ? plural(spec.productCount, 'producto', 'productos') : 'Catálogo profesional',
      [28]
    )
  } else {
    addSecondary(spec.subtitle, [28, 24], 3)
  }

  const title = fitText(spec.title, {
    metrics: ARCHIVO_600_METRICS,
    sizes: TITLE_SIZES,
    maxWidth: usable,
    maxLines: 3,
    letterSpacingEm: TITLE_TRACKING
  })
  const titleLineHeight = Math.round(title.size * 1.12)
  const accentHeight = 6
  const gapAccent = 30
  const gapTitle = secondary.length ? 24 : 0
  const secondaryHeight = secondary.reduce((sum, line) => sum + line.lineHeight, 0)
  const blockHeight = accentHeight + gapAccent + title.lines.length * titleLineHeight + gapTitle + secondaryHeight
  const top = Math.max(BLOCK_TOP_LIMIT, BLOCK_BOTTOM - blockHeight)

  const textLines: TextLine[] = []
  let y = top + accentHeight + gapAccent
  title.lines.forEach((text) => {
    textLines.push({
      text,
      top: y,
      height: titleLineHeight,
      size: title.size,
      font: 'Archivo',
      color: OG_COLORS.brand,
      letterSpacing: Math.round(TITLE_TRACKING * title.size * 100) / 100
    })
    y += titleLineHeight
  })
  y += gapTitle
  for (const line of secondary) {
    textLines.push({
      text: line.text,
      top: y,
      height: line.lineHeight,
      size: line.size,
      font: 'Inter',
      color: line.color,
      letterSpacing: 0
    })
    y += line.lineHeight
  }

  const boxes = hasPanel ? tilesFor(photos) : []
  const tiles = boxes.map((tile, index) => {
    const photo = photos[index] ?? null
    return {
      tile,
      photo,
      image: photo ? containBox(photo, tile, spec.kind === 'categoria' && photos.length > 1 ? 14 : 20) : null
    }
  })
  return {
    textLines,
    accent: { x: OG_MARGIN, y: top, width: 64, height: accentHeight },
    textWidth,
    tiles,
    textBlock: { x: OG_MARGIN, y: top, width: textWidth, height: Math.max(y - top, blockHeight) }
  }
}

const box = (value: Box) => ({
  position: 'absolute',
  left: value.x,
  top: value.y,
  width: value.width,
  height: value.height
})

export function buildCardTree(spec: OgCardSpec, logoDataUri: string): OgNode {
  const layout = layoutCard(spec)
  const logoWidth = Math.round(LOGO.height * LOGO.ratio * 100) / 100
  const children: OgNode[] = [
    {
      type: 'img',
      props: {
        src: logoDataUri,
        width: logoWidth,
        height: LOGO.height,
        style: { position: 'absolute', left: OG_MARGIN, top: OG_MARGIN }
      }
    },
    { type: 'div', props: { style: { ...box(layout.accent), backgroundColor: OG_COLORS.accent } } }
  ]
  for (const { tile, photo, image } of layout.tiles) {
    children.push({
      type: 'div',
      props: {
        style: {
          ...box(tile),
          backgroundColor: OG_COLORS.white,
          border: `2px solid ${OG_COLORS.panelBorder}`,
          borderRadius: 8
        }
      }
    })
    if (photo && image)
      children.push({
        type: 'img',
        props: { src: photo.dataUri, width: image.width, height: image.height, style: box(image) }
      })
  }
  for (const line of layout.textLines) {
    children.push({
      type: 'div',
      props: {
        style: {
          position: 'absolute',
          left: OG_MARGIN,
          top: line.top,
          width: layout.textWidth,
          height: line.height,
          display: 'flex',
          alignItems: 'center',
          whiteSpace: 'nowrap',
          fontFamily: line.font,
          fontWeight: line.font === 'Archivo' ? 600 : 400,
          fontSize: line.size,
          letterSpacing: line.letterSpacing,
          color: line.color
        },
        children: line.text
      }
    })
  }
  children.push({
    type: 'div',
    props: {
      style: {
        position: 'absolute',
        left: 0,
        top: OG_HEIGHT - 10,
        width: OG_WIDTH,
        height: 10,
        backgroundColor: OG_COLORS.brand
      }
    }
  })
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'relative',
        width: OG_WIDTH,
        height: OG_HEIGHT,
        backgroundColor: OG_COLORS.white
      },
      children
    }
  }
}
