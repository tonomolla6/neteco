import { describe, expect, it } from 'vitest'
import { generateD1CatalogContent } from '../../workers/catalog/ai-generation'

describe('catalog AI input errors across the Zod migration', () => {
  it('keeps the invalid-input code and minimum-size message for sources without claims', async () => {
    await expect(
      generateD1CatalogContent(
        {} as D1Database,
        { identityId: 'identity', sessionId: 'session', sessionVersion: 1 },
        {
          productName: 'Producto Sin Claims',
          targetScope: 'description',
          prompt: 'Generar ficha sin claims',
          sources: [
            {
              id: 'source',
              title: 'Documento sin claims',
              type: 'tech_sheet',
              verifiedClaims: [],
              textSnippet: 'Texto sin ningun claim verificado'
            }
          ]
        },
        { idempotencyKey: 'no-claims' }
      )
    ).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('at least 1') })
  })
})
