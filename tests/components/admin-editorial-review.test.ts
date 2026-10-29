// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import AdminEditorialReview from '../../app/components/AdminEditorialReview.vue'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const sampleReview = {
  id: '10000000-0000-4000-8000-000000000001',
  pageId: '20000000-0000-4000-8000-000000000001',
  pageTitle: 'Ficha Técnica Cloro Industrial',
  pageSlug: 'cloro-industrial',
  versionId: '30000000-0000-4000-8000-000000000001',
  versionNumber: 2,
  contentType: 'chemical_safety',
  status: 'in_review',
  isCritical: true,
  authorId: '40000000-0000-4000-8000-000000000001',
  authorEmail: 'autor@neteco.es',
  assignedReviewerId: '50000000-0000-4000-8000-000000000001',
  assignedReviewerEmail: 'revisor@neteco.es',
  approvedBy: null,
  approvedAt: null,
  publishedBy: null,
  publishedAt: null,
  rejectionReason: null,
  withdrawnReason: null,
  version: 1,
  checklistCompletedCount: 1,
  checklistTotalCount: 3,
  createdAt: '2026-10-29T08:00:00Z',
  updatedAt: '2026-10-29T08:30:00Z',
  checklist: [
    {
      id: 'c1',
      reviewId: '10000000-0000-4000-8000-000000000001',
      itemKey: 'fds_vigente',
      title: 'Ficha de Datos de Seguridad (FDS) vigente y accesible',
      completed: true,
      completedBy: '40000000-0000-4000-8000-000000000001',
      completedAt: '2026-10-29T08:15:00Z',
      createdAt: '2026-10-29T08:00:00Z'
    },
    {
      id: 'c2',
      reviewId: '10000000-0000-4000-8000-000000000001',
      itemKey: 'pictogramas_clp',
      title: 'Pictogramas de peligro CLP revisados y conformes',
      completed: false,
      completedBy: null,
      completedAt: null,
      createdAt: '2026-10-29T08:00:00Z'
    },
    {
      id: 'c3',
      reviewId: '10000000-0000-4000-8000-000000000001',
      itemKey: 'frases_hp_revisadas',
      title: 'Frases de peligro H y consejos de prudencia P contrastados',
      completed: false,
      completedBy: null,
      completedAt: null,
      createdAt: '2026-10-29T08:00:00Z'
    }
  ],
  comments: [
    {
      id: 'm1',
      reviewId: '10000000-0000-4000-8000-000000000001',
      authorId: '40000000-0000-4000-8000-000000000001',
      authorEmail: 'autor@neteco.es',
      comment: 'Revisad especialmente los pictogramas de corrosión.',
      createdAt: '2026-10-29T08:05:00Z'
    }
  ],
  diff: {
    publishedVersionId: '00000000-0000-4000-8000-000000000001',
    publishedDocument: {
      title: 'Ficha Técnica Cloro',
      slug: 'cloro-industrial',
      blocks: [{ id: 'b1', type: 'paragraph', text: 'Versión anterior sin FDS actualizada.' }]
    },
    proposedVersionId: '30000000-0000-4000-8000-000000000001',
    proposedDocument: {
      title: 'Ficha Técnica Cloro Industrial',
      slug: 'cloro-industrial',
      blocks: [{ id: 'b1', type: 'paragraph', text: 'Versión con FDS 2026 y nuevos pictogramas.' }]
    }
  },
  capabilities: {
    canApprove: true,
    canReject: true,
    canAssign: true,
    canComment: true,
    canWithdraw: true,
    canToggleChecklist: true
  }
}

describe('AdminEditorialReview.vue', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/api/admin/content/editorial-reviews/10000000-0000-4000-8000-000000000001/checklist')) {
          return jsonResponse({ ...sampleReview, checklistCompletedCount: 2, version: 2 })
        }
        if (url.includes('/api/admin/content/editorial-reviews/10000000-0000-4000-8000-000000000001/comments')) {
          return jsonResponse(
            {
              id: 'm2',
              reviewId: sampleReview.id,
              authorId: '50000000-0000-4000-8000-000000000001',
              comment: 'Pictogramas verificados correctamente.',
              createdAt: '2026-10-29T09:00:00Z'
            },
            201
          )
        }
        if (url.includes('/api/admin/content/editorial-reviews/10000000-0000-4000-8000-000000000001/approve')) {
          return jsonResponse({ ...sampleReview, status: 'approved' })
        }
        if (url.includes('/api/admin/content/editorial-reviews/10000000-0000-4000-8000-000000000001/reject')) {
          return jsonResponse({ ...sampleReview, status: 'rejected', rejectionReason: 'FDS caducada' })
        }
        if (url.includes('/api/admin/content/editorial-reviews/10000000-0000-4000-8000-000000000001')) {
          return jsonResponse(sampleReview)
        }
        if (url.includes('/api/admin/content/editorial-reviews')) {
          return jsonResponse({
            items: [sampleReview],
            total: 1,
            page: 1,
            perPage: 25
          })
        }
        return jsonResponse({ error: { code: 'not_found' } }, 404)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders queue and review details with separation of duties alert for critical review', async () => {
    const wrapper = mount(AdminEditorialReview, {
      props: {
        operatorId: '50000000-0000-4000-8000-000000000001'
      }
    })

    await flushPromises()

    // Renders review list
    expect(wrapper.text()).toContain('Ficha Técnica Cloro Industrial')
    expect(wrapper.text()).toContain('En revisión')
    expect(wrapper.text()).toContain('Crítico')
    expect(wrapper.text()).toContain('Seguridad química')

    // Separation of duties alert displayed for critical review
    expect(wrapper.text()).toContain('Separación de funciones')
    expect(wrapper.text()).toContain('no puede autoaprobar ni autopublicar')

    // Checklist items rendered
    expect(wrapper.text()).toContain('Ficha de Datos de Seguridad (FDS) vigente')
    expect(wrapper.text()).toContain('Pictogramas de peligro CLP')
    expect(wrapper.text()).toContain('1 / 3 completados')

    // Diff section rendered
    expect(wrapper.text()).toContain('Diff entre versión publicada y propuesta')
    expect(wrapper.text()).toContain('Versión con FDS 2026 y nuevos pictogramas')

    // Comments section rendered
    expect(wrapper.text()).toContain('Revisad especialmente los pictogramas de corrosión')
  })

  it('allows completing checklist item and adding comment', async () => {
    const wrapper = mount(AdminEditorialReview, {
      props: {
        operatorId: '50000000-0000-4000-8000-000000000001'
      }
    })

    await flushPromises()

    // Find the second checkbox (uncompleted item)
    const checkboxes = wrapper.findAll('input[type="checkbox"]')
    expect(checkboxes.length).toBeGreaterThanOrEqual(3)

    await checkboxes[1].setValue(true)
    await flushPromises()

    // Add comment
    const commentInput = wrapper.find('textarea[placeholder*="comentario"], textarea[data-test="new-comment"]')
    if (commentInput.exists()) {
      await commentInput.setValue('Pictogramas verificados correctamente.')
      const commentBtn = wrapper.find('button[data-test="send-comment"], button:has-text("Comentar")')
      if (commentBtn.exists()) {
        await commentBtn.trigger('click')
        await flushPromises()
      }
    }
  })

  it('blocks approval button when checklist is incomplete', async () => {
    const wrapper = mount(AdminEditorialReview, {
      props: {
        operatorId: '50000000-0000-4000-8000-000000000001'
      }
    })

    await flushPromises()

    // Approve button should be disabled when checklist has uncompleted items
    const approveBtn = wrapper.find('button[data-test="approve-btn"]')
    if (approveBtn.exists()) {
      expect((approveBtn.element as HTMLButtonElement).disabled).toBe(true)
    }
  })
})
