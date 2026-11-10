import { expect, it } from 'vitest'
import { adminSatisfactionQuerySchema } from '../../shared/support-satisfaction'

it('parses the default and explicit satisfaction comment filters as booleans', () => {
  expect(adminSatisfactionQuerySchema.parse({}).comments).toBe(false)
  expect(adminSatisfactionQuerySchema.parse({ comments: 'true' }).comments).toBe(true)
  expect(adminSatisfactionQuerySchema.parse({ comments: 'false' }).comments).toBe(false)
  expect(adminSatisfactionQuerySchema.safeParse({ comments: 'yes' }).success).toBe(false)
})
