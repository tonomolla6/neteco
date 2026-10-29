import { describe, expect, it } from 'vitest'
import { b2bPublicOpenApi } from '../../workers/developer-platform/b2b-public-contract'

describe('contrato público B2B v1', () => {
  it('declara OpenAPI y versión estable', () => {
    expect(b2bPublicOpenApi.openapi).toMatch(/^3\./)
    expect(b2bPublicOpenApi.info.version).toBe('1.0.0')
  })
  it('describe operaciones implementadas y autenticación bearer', () => {
    expect(b2bPublicOpenApi.paths['/api/b2b/v1/requests'].get.security).toEqual([{ bearerAuth: [] }])
    expect(b2bPublicOpenApi.paths['/api/b2b/v1/requests'].post.security).toEqual([{ bearerAuth: [] }])
    expect(b2bPublicOpenApi.paths['/api/b2b/v1/sandbox/catalog'].get.security).toEqual([{ bearerAuth: [] }])
    expect(b2bPublicOpenApi.components.securitySchemes.bearerAuth.scheme).toBe('bearer')
  })
  it('exige idempotencia para crear y documenta límites y conflicto', () => {
    const post = b2bPublicOpenApi.paths['/api/b2b/v1/requests'].post
    expect(post.parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key', required: true }))
    expect(post.responses).toHaveProperty('409')
    expect(post.responses).toHaveProperty('429')
  })
  it('describe reset UTC, scopes y ausencia de pedidos reales', () => {
    expect(b2bPublicOpenApi.info.description).toContain('UTC')
    expect(b2bPublicOpenApi.info.description).toContain('requests.write')
    expect(b2bPublicOpenApi.info.description).toContain('pedidos')
  })
})
