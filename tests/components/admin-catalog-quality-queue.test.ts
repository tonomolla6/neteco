// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import AdminCatalogQualityQueue from '../../app/components/AdminCatalogQualityQueue.vue'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const sampleQueueResponse = {
  source: 'cloudflare',
  evaluatedAt: '2026-09-30T10:00:00Z',
  summary: {
    totalEvaluated: 2,
    matchingTotal: 2,
    averageScore: 52,
    unreviewedCount: 1,
    needsAttentionCount: 2,
    byGroup: {
      mandatory_fields: 0,
      recommended_fields: 1,
      typed_attributes: 1,
      images: 1,
      documents: 1,
      review: 1
    }
  },
  items: [
    {
      productId: 102,
      sku: 'NET-102',
      slug: 'cloro-activo-102',
      name: 'Desinfectante Clorado Industrial',
      status: 'draft',
      categoryId: 7,
      categoryName: 'Químicos',
      categorySlug: 'quimicos',
      catalogVersion: 1,
      score: 13,
      publishable: false,
      missingSummary: {
        mandatoryFields: 0,
        recommendedFields: 2,
        typedAttributes: 1,
        images: 1,
        documents: 2,
        reviewIssues: 1
      },
      penalties: [
        {
          code: 'media.primary',
          group: 'images',
          weight: 20,
          blocking: true,
          message: 'Falta imagen principal aprobada.'
        },
        {
          code: 'regulatory.sds',
          group: 'documents',
          weight: 20,
          blocking: true,
          message: 'Falta ficha de datos de seguridad (FDS/SDS) vigente.'
        },
        {
          code: 'review.missing',
          group: 'review',
          weight: 10,
          blocking: false,
          message: 'El producto nunca ha sido revisado por calidad.'
        }
      ],
      review: null
    },
    {
      productId: 101,
      sku: 'NET-101',
      slug: 'desengrasante-101',
      name: 'Desengrasante Neutro 5L',
      status: 'published',
      categoryId: 7,
      categoryName: 'Químicos',
      categorySlug: 'quimicos',
      catalogVersion: 2,
      score: 90,
      publishable: true,
      missingSummary: {
        mandatoryFields: 0,
        recommendedFields: 0,
        typedAttributes: 0,
        images: 0,
        documents: 0,
        reviewIssues: 0
      },
      penalties: [],
      review: {
        reviewVersion: 1,
        reviewedCatalogVersion: 2,
        reviewedScore: 90,
        reviewedBy: 'usr_reviewer',
        reviewedAt: '2026-09-25T10:00:00Z',
        note: 'Revisión inicial completada.'
      }
    }
  ],
  pagination: {
    page: 1,
    perPage: 25,
    total: 2,
    pages: 1,
    nextCursor: null
  }
}

describe('AdminCatalogQualityQueue.vue (CAT-017)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('distinguishes between empty state and error state and allows retrying on error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'service_unavailable' } }, 503))
      .mockResolvedValueOnce(
        jsonResponse({
          ...sampleQueueResponse,
          items: [],
          pagination: { page: 1, perPage: 25, total: 0, pages: 1, nextCursor: null }
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mount(AdminCatalogQualityQueue)
    await flushPromises()

    // Error state is shown, empty state is NOT shown
    expect(wrapper.find('[data-testid="quality-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="quality-empty"]').exists()).toBe(false)

    // Retry loads the empty state
    await wrapper.get('[data-testid="quality-retry"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="quality-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="quality-empty"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="quality-empty"]').text()).toContain(
      'No hay productos que coincidan con los filtros'
    )
  })

  it('renders prioritized queue items in order, applies filters, and navigates pages', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('reason=documents')) {
        return Promise.resolve(
          jsonResponse({
            ...sampleQueueResponse,
            items: [sampleQueueResponse.items[0]],
            pagination: { page: 1, perPage: 25, total: 1, pages: 1, nextCursor: null }
          })
        )
      }
      if (url.includes('page=2')) {
        return Promise.resolve(
          jsonResponse({
            ...sampleQueueResponse,
            items: [sampleQueueResponse.items[1]],
            pagination: { page: 2, perPage: 1, total: 2, pages: 2, nextCursor: null }
          })
        )
      }
      return Promise.resolve(
        jsonResponse({
          ...sampleQueueResponse,
          pagination: { page: 1, perPage: 1, total: 2, pages: 2, nextCursor: '13::102' }
        })
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mount(AdminCatalogQualityQueue, {
      props: { perPage: 1 }
    })
    await flushPromises()

    const rows = wrapper.findAll('[data-testid^="quality-row-"]')
    expect(rows).toHaveLength(2)
    // First row is product 102 (score 13, unreviewed), second is product 101 (score 90, reviewed)
    expect(rows[0]?.attributes('data-testid')).toBe('quality-row-102')
    expect(rows[0]?.text()).toContain('Desinfectante Clorado Industrial')
    expect(rows[0]?.text()).toContain('13')
    expect(rows[0]?.text()).toContain('Nunca revisado')
    expect(rows[1]?.attributes('data-testid')).toBe('quality-row-101')

    // Pagination next page
    await wrapper.get('[data-testid="quality-next-page"]').trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('page=2'), expect.any(Object))

    // Filter by reason
    await wrapper.get('[data-testid="quality-filter-reason"]').setValue('documents')
    await wrapper.get('[data-testid="quality-filter-submit"]').trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('reason=documents'), expect.any(Object))
  })

  it('marks a product as reviewed with two-step confirmation and recovers from uncertain response without double POST', async () => {
    let postCount = 0
    let commandCheckCount = 0

    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? 'GET'

      if (method === 'POST' && url.endsWith('/api/admin/products/102/quality-review')) {
        postCount += 1
        // Simulate uncertain network timeout / 503 on first POST
        return Promise.resolve(jsonResponse({ error: { code: 'service_unavailable' } }, 503))
      }

      if (method === 'GET' && url.includes('/api/admin/products/102/quality-review/commands/')) {
        commandCheckCount += 1
        if (commandCheckCount === 1) {
          // First automatic check still uncertain (503)
          return Promise.resolve(jsonResponse({ error: { code: 'service_unavailable' } }, 503))
        }
        // Second check (when user clicks "Verificar estado sin reenviar") confirms the command was recorded!
        return Promise.resolve(
          jsonResponse({
            status: 'replayed',
            review: {
              source: 'cloudflare',
              commandId: 'cmd-102',
              productId: 102,
              reviewVersion: 1,
              reviewedCatalogVersion: 1,
              score: 23,
              penaltyCodes: ['media.primary', 'regulatory.sds'],
              note: 'Revisado tras verificar documentos.',
              reviewedBy: 'usr_reviewer',
              reviewedAt: '2026-09-30T10:05:00Z',
              payloadHash: 'a'.repeat(64)
            }
          })
        )
      }

      return Promise.resolve(jsonResponse(sampleQueueResponse))
    })
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mount(AdminCatalogQualityQueue)
    await flushPromises()

    // Step 1: open inline review confirmation for product 102
    await wrapper.get('[data-testid="quality-review-start-102"]').trigger('click')
    expect(wrapper.find('[data-testid="quality-review-form-102"]').exists()).toBe(true)

    await wrapper.get('[data-testid="quality-review-note-102"]').setValue('Revisado tras verificar documentos.')

    // Step 2: submit review -> receives uncertain 503 -> shows uncertain state banner
    await wrapper.get('[data-testid="quality-review-confirm-102"]').trigger('click')
    await flushPromises()

    expect(postCount).toBe(1)
    expect(commandCheckCount).toBe(1)
    expect(wrapper.find('[data-testid="quality-review-uncertain-102"]').exists()).toBe(true)

    // Clicking "Verificar estado sin reenviar" checks the command receipt via GET without sending another POST
    await wrapper.get('[data-testid="quality-review-verify-102"]').trigger('click')
    await flushPromises()

    expect(postCount).toBe(1)
    expect(commandCheckCount).toBe(2)
    expect(wrapper.find('[data-testid="quality-review-uncertain-102"]').exists()).toBe(false)
    expect(wrapper.emitted('reviewed')?.[0]?.[0]).toMatchObject({
      productId: 102,
      reviewVersion: 1
    })
  })
})
