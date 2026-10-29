import { z } from 'zod'

/**
 * MKT-029 professional lead magnets.
 *
 * The checklist, calculator and guide are PUBLIC: the visitor gets the full value on
 * the page with no form. The only form requests an e-mailed copy, asks for the e-mail
 * alone and treats marketing consent as a separate, optional, unchecked box that never
 * conditions the delivery. Content is general good practice and always defers to the
 * product label / technical data sheet.
 */

export const LEAD_MAGNET_CONSENT_VERSION = 'lead-magnet-2026-10'
export const LEAD_MAGNET_CONSENT_TEXT =
  'Quiero recibir también novedades y consejos profesionales de Neteco por e-mail. Es opcional: recibirás el recurso aunque no lo marques. Puedes darte de baja en cualquier momento.'
export const LEAD_FORM_DEFAULTS = { marketingConsent: false } as const

export interface ChecklistItem {
  id: string
  action: string
  why: string
}
export interface GuideSection {
  id: string
  heading: string
  body: string
}
interface MagnetBase {
  slug: string
  title: string
  description: string
  gated: false
}
export type LeadMagnet =
  | (MagnetBase & { kind: 'checklist'; items: ChecklistItem[] })
  | (MagnetBase & { kind: 'calculator' })
  | (MagnetBase & { kind: 'guide'; sections: GuideSection[] })

export const LEAD_MAGNETS: readonly LeadMagnet[] = Object.freeze([
  {
    slug: 'checklist-seguridad-productos-quimicos',
    kind: 'checklist',
    gated: false,
    title: 'Checklist de seguridad con productos químicos de limpieza',
    description:
      'Diez comprobaciones para almacenar, dosificar y usar productos de limpieza profesional con seguridad.',
    items: [
      {
        id: 'fds',
        action: 'Tener la ficha de datos de seguridad de cada producto impresa o accesible en el punto de uso.',
        why: 'Recoge primeros auxilios, incompatibilidades y equipos de protección que hay que conocer antes de un incidente.'
      },
      {
        id: 'etiquetado',
        action: 'Comprobar que todos los envases, también los trasvasados, llevan etiqueta con nombre y pictogramas.',
        why: 'Un envase sin identificar es la causa habitual de usos erróneos y de intoxicaciones accidentales.'
      },
      {
        id: 'no-mezclar',
        action: 'No mezclar nunca productos distintos, en especial lejía con ácidos o con amoníaco.',
        why: 'Algunas mezclas desprenden gases tóxicos incluso en cantidades pequeñas.'
      },
      {
        id: 'almacenamiento',
        action:
          'Almacenar separados ácidos, álcalis y oxidantes, en lugar fresco, ventilado y fuera de la luz directa.',
        why: 'La separación evita reacciones por fugas y alarga la vida útil de los productos.'
      },
      {
        id: 'epi',
        action: 'Usar los guantes y la protección ocular que indique la ficha de datos de seguridad.',
        why: 'Las salpicaduras de concentrados son la lesión más frecuente en el uso profesional.'
      },
      {
        id: 'dosificacion',
        action: 'Dosificar con medidor o dosificador y respetar la dilución indicada en la etiqueta.',
        why: 'Más producto no limpia mejor: aumenta el coste, los residuos y el riesgo.'
      },
      {
        id: 'ventilacion',
        action:
          'Ventilar el espacio mientras se aplican productos y no aplicarlos en espacios cerrados sin salida de aire.',
        why: 'Reduce la exposición a vapores durante el uso.'
      },
      {
        id: 'registro',
        action: 'Registrar qué producto, dilución y fecha se usan en zonas críticas como cocinas y aseos.',
        why: 'Permite demostrar el plan de limpieza y detectar desviaciones en una inspección.'
      },
      {
        id: 'derrames',
        action: 'Tener material absorbente y el procedimiento de derrame visible junto al almacén.',
        why: 'Una respuesta rápida limita el daño y evita improvisar con productos incompatibles.'
      },
      {
        id: 'formacion',
        action: 'Formar al personal nuevo en estas normas y guardar constancia de la formación recibida.',
        why: 'La mayoría de los incidentes ocurren en las primeras semanas de un puesto.'
      }
    ]
  },
  {
    slug: 'calculadora-dilucion',
    kind: 'calculator',
    gated: false,
    title: 'Calculadora de dilución y coste por uso',
    description:
      'Calcula cuánto producto y cuánta agua necesitas para un volumen final y cuánto cuesta cada litro preparado.'
  },
  {
    slug: 'guia-limpieza-desinfeccion-hosteleria',
    kind: 'guide',
    gated: false,
    title: 'Guía práctica de limpieza y desinfección en hostelería',
    description: 'Orden de trabajo, tiempos de contacto y registros esenciales para cocinas y zonas de servicio.',
    sections: [
      {
        id: 'diferencia',
        heading: 'Limpiar y desinfectar no es lo mismo',
        body: 'Limpiar retira la suciedad visible; desinfectar reduce los microorganismos. Un desinfectante aplicado sobre suciedad pierde eficacia, por eso la limpieza va siempre primero.'
      },
      {
        id: 'orden',
        heading: 'Orden correcto de trabajo',
        body: 'Retirar residuos, aplicar el detergente, dejar actuar, aclarar, aplicar el desinfectante, respetar el tiempo de contacto y aclarar si la etiqueta lo exige en superficies que tocan alimentos.'
      },
      {
        id: 'concentracion',
        heading: 'Concentración y tiempo de contacto',
        body: 'Los valores correctos están en la etiqueta y en la ficha técnica de cada producto. No los sustituyas por una regla general: la dilución y el tiempo de contacto dependen del producto y del uso.'
      },
      {
        id: 'zonas',
        heading: 'Zonas críticas',
        body: 'Superficies de contacto con alimentos, tablas, cámaras, desagües, tiradores y baños de personal y clientes concentran la mayor parte del riesgo y merecen frecuencia propia.'
      },
      {
        id: 'registros',
        heading: 'Qué registrar',
        body: 'Fecha, zona, producto, dilución y responsable. Un registro sencillo y constante vale más que uno detallado que se abandona.'
      },
      {
        id: 'asesoramiento',
        heading: 'Cuándo pedir asesoramiento',
        body: 'Ante superficies delicadas, cambios de producto, un brote o una inspección próxima, consulta con el fabricante o con un técnico antes de modificar el protocolo.'
      }
    ]
  }
])

export function findLeadMagnet(slug: string): LeadMagnet | null {
  return LEAD_MAGNETS.find((magnet) => magnet.slug === slug) ?? null
}

// ---------------------------------------------------------------- calculator
const dilutionInputSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('percent'),
    percent: z.number().min(0.1).max(100),
    finalVolumeMl: z.number().min(1).max(1_000_000),
    productPricePerLiterCents: z.number().int().min(0).max(10_000_000).optional()
  }),
  z.object({
    mode: z.literal('ratio'),
    /** 1 part of product for `waterParts` parts of water. */
    waterParts: z.number().min(1).max(1000),
    finalVolumeMl: z.number().min(1).max(1_000_000),
    productPricePerLiterCents: z.number().int().min(0).max(10_000_000).optional()
  })
])
export type DilutionInput = z.input<typeof dilutionInputSchema>

export interface DilutionPlan {
  productMl: number
  waterMl: number
  finalVolumeMl: number
  productCostCents: number | null
  costPerLiterCents: number | null
  notice: string
}

const round1 = (value: number) => Math.round(value * 10) / 10

export function dilutionPlan(input: DilutionInput): DilutionPlan {
  const parsed = dilutionInputSchema.safeParse(input)
  if (!parsed.success) throw new Error('invalid_dilution_input')
  const value = parsed.data
  const productMl = round1(
    value.mode === 'percent'
      ? (value.finalVolumeMl * value.percent) / 100
      : value.finalVolumeMl / (1 + value.waterParts)
  )
  const price = value.productPricePerLiterCents
  const productCostCents = price === undefined ? null : Math.round((productMl / 1000) * price)
  return {
    productMl,
    waterMl: round1(value.finalVolumeMl - productMl),
    finalVolumeMl: value.finalVolumeMl,
    productCostCents,
    costPerLiterCents: productCostCents === null ? null : Math.round(productCostCents / (value.finalVolumeMl / 1000)),
    notice:
      'Resultado orientativo: sigue siempre la dilución indicada en la etiqueta y en la ficha técnica del producto.'
  }
}

// ---------------------------------------------------------------- request form
export function normalizeLeadEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase()
  if (email.length < 6 || email.length > 254) return null
  if (email.includes('..')) return null
  return /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(email) ? email : null
}

export const leadRequestSchema = z
  .object({
    magnetSlug: z.string().min(3).max(80),
    email: z.string().max(400),
    marketingConsent: z.boolean().default(false),
    /** Honeypot: humans leave it empty. */
    website: z.string().max(200).optional()
  })
  .strict()
  .transform((value, ctx) => {
    const email = normalizeLeadEmail(value.email)
    if (!email) {
      ctx.addIssue({ code: 'custom', path: ['email'], message: 'invalid_email' })
      return z.NEVER
    }
    return { ...value, email }
  })
export type LeadRequest = z.output<typeof leadRequestSchema>

// ---------------------------------------------------------------- e-mailed copy
/** Plain-text transactional copy: only the requested resource, no promotion, no tracking. */
export function renderLeadMagnetEmail(magnet: LeadMagnet, publicOrigin: string): { subject: string; text: string } {
  const webUrl = `${publicOrigin}/herramientas/${magnet.slug}`
  const lines: string[] = [magnet.title, '', magnet.description, '']
  if (magnet.kind === 'checklist') {
    magnet.items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.action}`, `   Por qué: ${item.why}`, '')
    })
  } else if (magnet.kind === 'guide') {
    for (const section of magnet.sections) lines.push(section.heading, section.body, '')
  } else {
    lines.push(
      'La calculadora está disponible en línea, sin registro:',
      webUrl,
      '',
      'Resultado orientativo: sigue siempre la dilución indicada en la etiqueta y en la ficha técnica del producto.',
      ''
    )
  }
  lines.push(`Versión en línea: ${webUrl}`, '', 'Recibes este mensaje porque lo solicitaste en Neteco.')
  return { subject: magnet.title, text: lines.join('\n') }
}
