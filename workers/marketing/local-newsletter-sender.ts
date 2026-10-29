import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { editorialHash, editorialSource, NewsletterEditorialError, stableJson } from './newsletter-editorial-core'
import {
  editorialMailbox,
  type NewsletterEditorialMessage,
  type NewsletterEditorialSender
} from './newsletter-campaign-transport'

const syntheticMailbox = z.string().refine((value) => editorialMailbox(value) && /\.(test|invalid)$/i.test(value))
const messageSchema = z.preprocess(
  (value) => {
    try {
      return catalogPolicyOwnJson(value)
    } catch {
      return undefined
    }
  },
  z
    .object({
      deliveryId: catalogPolicyUuidSchema,
      to: syntheticMailbox,
      from: syntheticMailbox,
      subject: z
        .string()
        .min(1)
        .max(200)
        .refine((value) => !/[\r\n]/.test(value)),
      html: z.string().min(1).max(262144),
      text: z.string().min(1).max(262144),
      headers: z
        .object({
          'List-Unsubscribe': z
            .string()
            .max(4096)
            .refine((value) => {
              try {
                if (!value.startsWith('<') || !value.endsWith('>')) return false
                const url = new URL(value.slice(1, -1))
                return (
                  url.protocol === 'https:' &&
                  /\.(test|invalid)$/.test(url.hostname) &&
                  !url.username &&
                  !url.password &&
                  !url.hash &&
                  url.pathname === '/newsletter/baja'
                )
              } catch {
                return false
              }
            })
        })
        .strict()
    })
    .strict()
)

/** Durable synthetic receipt, not delivery. Never resolves an external binding,
 * sends a request, persists an address/body/token, or represents provider proof. */
export class PersistentLocalNewsletterSender implements NewsletterEditorialSender {
  readonly kind = 'local-fake' as const
  constructor(private readonly database: D1Database) {}
  async send(input: NewsletterEditorialMessage) {
    const message = editorialSource(messageSchema, input),
      fingerprint = await editorialHash(stableJson(message)),
      messageId = `SYNTHETIC-NEWSLETTER-${fingerprint}`
    const inserted = await this.database
      .prepare(
        'INSERT INTO newsletter_editorial_fake_receipts(delivery_id,message_fingerprint,provider_message_id) VALUES(?1,?2,?3) ON CONFLICT(delivery_id) DO NOTHING'
      )
      .bind(message.deliveryId, fingerprint, messageId)
      .run()
    if (inserted.success !== true) throw new NewsletterEditorialError('read_unconfirmed')
    const row = await this.database
      .prepare(
        'SELECT message_fingerprint,provider_message_id FROM newsletter_editorial_fake_receipts WHERE delivery_id=?'
      )
      .bind(message.deliveryId)
      .first()
    const checked = editorialSource(
      z.object({ message_fingerprint: z.string(), provider_message_id: z.string() }).strict(),
      row
    )
    if (checked.message_fingerprint !== fingerprint || checked.provider_message_id !== messageId)
      throw new NewsletterEditorialError('read_unconfirmed')
    return { messageId }
  }
}
