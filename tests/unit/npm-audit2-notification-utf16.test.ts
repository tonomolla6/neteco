import { describe, expect, it } from 'vitest'
import { accountNotificationItemSchema, createNotificationInputSchema } from '../../shared/account-notifications'

describe('notification text limits preserve Zod 3 UTF-16 validation', () => {
  for (const schema of [accountNotificationItemSchema, createNotificationInputSchema]) {
    it('retains the declared string-limit metadata', () => {
      expect(schema.shape.title.maxLength).toBe(200)
      expect(schema.shape.body.maxLength).toBe(2000)
      expect(schema.shape.link.unwrap().maxLength).toBe(500)
      expect(schema.shape.dedupKey.unwrap().maxLength).toBe(150)
    })
    for (const [field, maximum] of [
      ['title', 200],
      ['body', 2000],
      ['link', 500],
      ['dedupKey', 150]
    ] as const) {
      it(`${field} accepts the limit and rejects the next UTF-16 unit`, () => {
        const validator = schema.shape[field]
        expect(validator.safeParse('😀'.repeat(maximum / 2)).success).toBe(true)
        const result = validator.safeParse('😀'.repeat(maximum / 2) + 'a')
        expect(result.success).toBe(false)
        if (!result.success) {
          expect(result.error.issues[0]).toMatchObject({
            code: 'too_big',
            message: `String must contain at most ${maximum} character(s)`
          })
        }
        const ascii = validator.safeParse('x'.repeat(maximum + 1))
        expect(ascii.success).toBe(false)
        if (!ascii.success) {
          expect(ascii.error.issues).toHaveLength(1)
          expect(ascii.error.issues[0]).toMatchObject({
            code: 'too_big',
            message: `String must contain at most ${maximum} character(s)`
          })
        }
      })
    }
    for (const field of ['title', 'body'] as const) {
      it(`${field} keeps the previous diagnostic for empty text`, () => {
        const result = schema.shape[field].safeParse('')
        expect(result.success).toBe(false)
        if (!result.success) {
          expect(result.error.issues[0]).toMatchObject({
            code: 'too_small',
            message: 'String must contain at least 1 character(s)'
          })
        }
      })
    }
  }
})
