// @vitest-environment nuxt
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import middleware from '../../app/middleware/published-sections.global'

const state = vi.hoisted(() => ({ published: '', abort: vi.fn((error: unknown) => ({ aborted: error })) }))
const nuxtRuntime = vi.hoisted(() => ({ original: null as null | (() => { public: Record<string, unknown> }) }))
mockNuxtImport('useRuntimeConfig', (original) => {
  nuxtRuntime.original = original as never
  return () => {
    const base = nuxtRuntime.original!()
    return { ...base, public: { ...base.public, publishedSections: state.published } }
  }
})
mockNuxtImport('abortNavigation', () => state.abort)

const visit = (path: string) =>
  (middleware as (to: { path: string }, from: { path: string }) => unknown)({ path }, { path: '/' })

beforeEach(() => {
  state.published = ''
  state.abort.mockClear()
})

describe('unpublished content sections answer 404', () => {
  it.each([
    '/certificaciones',
    '/marca',
    '/kits',
    '/eventos',
    '/plantillas/x',
    '/casos-exito',
    '/datos-y-herramientas'
  ])('%s does not exist until its section is published', (path) => {
    visit(path)
    expect(state.abort).toHaveBeenCalledOnce()
    expect(state.abort.mock.calls[0]![0]).toMatchObject({ statusCode: 404 })
  })

  it('lets a published section and the rest of the shop through', () => {
    state.published = 'certificaciones'
    expect(visit('/certificaciones')).toBeUndefined()
    expect(visit('/catalogo')).toBeUndefined()
    expect(visit('/pedido-rapido')).toBeUndefined()
    expect(visit('/recursos/guia')).toBeUndefined()
    expect(state.abort).not.toHaveBeenCalled()
    visit('/kits')
    expect(state.abort).toHaveBeenCalledOnce()
  })
})
