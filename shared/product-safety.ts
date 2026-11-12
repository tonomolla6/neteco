/**
 * Qué enseña la ficha sobre seguridad química, a partir de los datos regulatorios publicados.
 *
 * - Producto no químico (menaje, celulosa, utensilios): nada. Ningún aviso genérico.
 * - Químico (necesita ficha de datos de seguridad o tiene clasificación de peligro): pictogramas,
 *   palabra de advertencia, frases H y P tal como están publicadas, y su FDS.
 * - Químico sin FDS publicada: no se inventan avisos; se ofrece la ficha bajo petición.
 */

export interface ProductRegulatoryData {
  productType?: unknown
  requiresSds?: unknown
  signalWord?: unknown
  ufi?: unknown
  registrationNumber?: unknown
  hazardStatements?: unknown
  precautionaryStatements?: unknown
  pictograms?: unknown
  safetyInstructions?: unknown
}

export interface SafetyDocument {
  role: 'datasheet' | 'sds' | 'certificate' | 'label'
  url: string
  version: string
  language: string | null
  name: string
}

export interface ProductSafety {
  /** Requiere FDS o tiene cualquier dato de peligro. */
  chemical: boolean
  /** Tiene clasificación de peligro publicada (palabra, frases H o pictogramas). */
  hazardous: boolean
  signalWord: string | null
  pictograms: string[]
  hazardStatements: string[]
  precautionaryStatements: string[]
  ufi: string | null
  registrationNumber: string | null
  safetyInstructions: string | null
  sds: SafetyDocument | null
  /** Ficha técnica, etiqueta y certificados. */
  otherDocuments: SafetyDocument[]
}

const PICTOGRAM = /^GHS0[1-9]$/

function text(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean && clean.length <= max && clean.toUpperCase() !== 'NONE' ? clean : null
}

/** Las frases llegan como lista o como un texto con una por línea (o separadas por «;»). */
export function statementList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n|;\s*/) : []
  return [...new Set(raw.map((entry) => text(entry, 400)).filter((entry): entry is string => Boolean(entry)))].slice(
    0,
    40
  )
}

export function productSafety(
  regulatory: ProductRegulatoryData | null | undefined,
  documents: readonly SafetyDocument[] = []
): ProductSafety {
  const info = regulatory ?? {}
  const pictograms = (Array.isArray(info.pictograms) ? info.pictograms : [])
    .map((code) => (typeof code === 'string' ? code.trim().toUpperCase() : ''))
    .filter((code, index, all) => PICTOGRAM.test(code) && all.indexOf(code) === index)
  const signalWord = text(info.signalWord, 40)
  const hazardStatements = statementList(info.hazardStatements)
  const precautionaryStatements = statementList(info.precautionaryStatements)
  const hazardous = Boolean(signalWord || hazardStatements.length || pictograms.length)
  const sds = documents.find((document) => document.role === 'sds') ?? null
  const chemical = hazardous || info.requiresSds === true || Boolean(sds)
  return {
    chemical,
    hazardous,
    signalWord,
    pictograms,
    hazardStatements,
    precautionaryStatements,
    ufi: text(info.ufi, 40),
    registrationNumber: text(info.registrationNumber, 80),
    safetyInstructions: text(info.safetyInstructions, 2000),
    sds,
    otherDocuments: documents.filter((document) => document.role !== 'sds')
  }
}

/** Nombre de cada pictograma CLP: un código suelto no dice nada a quien manipula el producto. */
export const PICTOGRAM_NAMES: Record<string, string> = {
  GHS01: 'Explosivo',
  GHS02: 'Inflamable',
  GHS03: 'Comburente',
  GHS04: 'Gas a presión',
  GHS05: 'Corrosivo',
  GHS06: 'Toxicidad aguda',
  GHS07: 'Nocivo o irritante',
  GHS08: 'Peligro grave para la salud',
  GHS09: 'Peligroso para el medio ambiente'
}
