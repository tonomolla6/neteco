import { z } from 'zod'

/**
 * Configuración efectiva de la tienda que el panel enseña en Ajustes (solo lectura).
 *
 * Se decide en el entorno de despliegue, no en la base de datos: aquí solo viajan
 * interruptores, entornos y remitentes. Nunca claves, códigos de comercio completos ni
 * ningún otro secreto: de lo sensible solo se dice si está puesto o no.
 */
export const adminSettingsSchema = z
  .object({
    source: z.literal('cloudflare'),
    environment: z.string().max(40),
    demo: z.boolean(),
    payments: z
      .object({
        cardEnabled: z.boolean(),
        cardEnvironment: z.enum(['sandbox', 'production', 'unknown']),
        /** Código de comercio, terminal y clave presentes (no se devuelven). */
        cardCredentialsSet: z.boolean(),
        bizumEnabled: z.boolean(),
        refundsEnabled: z.boolean(),
        storeCreditEnabled: z.boolean()
      })
      .strict(),
    billing: z
      .object({
        invoicingEnabled: z.boolean(),
        providerEnabled: z.boolean(),
        providerEnvironment: z.enum(['sandbox', 'production', 'unknown']),
        invoiceSeries: z.string().max(40),
        correctiveSeries: z.string().max(40),
        /** Tipos de IVA con código contable asignado en el programa de facturación. */
        taxRatesMapped: z.array(z.enum(['0', '10', '21'])).max(3),
        creditNotesEnabled: z.boolean()
      })
      .strict(),
    email: z
      .object({
        orderEmailsEnabled: z.boolean(),
        orderEmailsFrom: z.string().max(160),
        accountEmailsEnabled: z.boolean(),
        accountEmailsFrom: z.string().max(160),
        invoiceEmailsEnabled: z.boolean(),
        newsletterEnabled: z.boolean(),
        newsletterSendingEnabled: z.boolean(),
        newsletterFrom: z.string().max(160),
        stockAlertsEnabled: z.boolean(),
        cartRecoveryEnabled: z.boolean()
      })
      .strict(),
    services: z
      .object({
        support: z.boolean(),
        supportAttachments: z.boolean(),
        analytics: z.boolean(),
        newsletter: z.boolean(),
        newsletterEditorial: z.boolean(),
        quotes: z.boolean(),
        reviews: z.boolean(),
        media: z.boolean(),
        content: z.boolean(),
        publicApi: z.boolean()
      })
      .strict()
  })
  .strict()
export type AdminSettings = z.infer<typeof adminSettingsSchema>
export type AdminServiceKey = keyof AdminSettings['services']
