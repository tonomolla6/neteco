import { ref } from 'vue'
import type { PublicUgcReview, SubmitUgcReviewInput, ModerateUgcReviewInput } from '~~/shared/ugc-reviews'

export interface UgcReviewItem {
  id: string
  productId: string
  rating: number
  title: string
  content: string
  displayName: string
  isVerifiedBuyer: boolean
  photos: Array<{
    id: string
    photoUrl: string
    mimeType: string
    width: number
    height: number
    sortOrder: number
  }>
  incentiveBadge: string
  incentiveDisclosure: string | null
  createdAt: string
}

export function useUgcReviews() {
  const reviews = ref<PublicUgcReview[]>([])
  const adminReviews = ref<Array<Record<string, unknown>>>([])
  const total = ref(0)
  const loading = ref(false)
  const submitting = ref(false)
  const error = ref<string | null>(null)

  const errorMessage = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

  const fetchPublicReviews = async (productId: string, page = 1) => {
    loading.value = true
    error.value = null
    try {
      const response = await fetch(`/api/products/${encodeURIComponent(productId)}/ugc-reviews?page=${page}`)
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: { code?: string } }
        throw new Error(err?.error?.code ?? 'error_loading_reviews')
      }
      const data = (await response.json()) as { reviews?: PublicUgcReview[]; total?: number }
      reviews.value = data.reviews ?? []
      total.value = data.total ?? 0
    } catch (e: unknown) {
      error.value = errorMessage(e, 'error_loading_reviews')
    } finally {
      loading.value = false
    }
  }

  const submitReview = async (input: SubmitUgcReviewInput) => {
    submitting.value = true
    error.value = null
    try {
      const response = await fetch(`/api/products/${encodeURIComponent(input.productId)}/ugc-reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      })
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: { code?: string } }
        throw new Error(err?.error?.code ?? 'error_submitting_review')
      }
      return await response.json()
    } catch (e: unknown) {
      error.value = errorMessage(e, 'error_submitting_review')
      throw e
    } finally {
      submitting.value = false
    }
  }

  const withdrawReview = async (reviewId: string, reason: string, expectedVersion: number) => {
    submitting.value = true
    error.value = null
    try {
      const response = await fetch(`/api/ugc-reviews/${encodeURIComponent(reviewId)}/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewId,
          reason,
          expectedVersion,
          commandId: `cmd-withdraw-${reviewId}-${Date.now()}`
        })
      })
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: { code?: string } }
        throw new Error(err?.error?.code ?? 'error_withdrawing_review')
      }
      return await response.json()
    } catch (e: unknown) {
      error.value = errorMessage(e, 'error_withdrawing_review')
      throw e
    } finally {
      submitting.value = false
    }
  }

  const fetchAdminReviews = async (filter: { status?: string; pii?: boolean; incentive?: boolean } = {}) => {
    loading.value = true
    error.value = null
    try {
      const params = new URLSearchParams()
      if (filter.status) params.set('status', filter.status)
      if (filter.pii) params.set('pii', 'true')
      if (filter.incentive) params.set('incentive', 'true')

      const response = await fetch(`/api/admin/ugc-reviews?${params.toString()}`)
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: { code?: string } }
        throw new Error(err?.error?.code ?? 'error_loading_admin_reviews')
      }
      const data = (await response.json()) as { reviews?: Array<Record<string, unknown>>; total?: number }
      adminReviews.value = data.reviews ?? []
      total.value = data.total ?? 0
    } catch (e: unknown) {
      error.value = errorMessage(e, 'error_loading_admin_reviews')
    } finally {
      loading.value = false
    }
  }

  const moderateReview = async (input: ModerateUgcReviewInput) => {
    submitting.value = true
    error.value = null
    try {
      const response = await fetch(`/api/admin/ugc-reviews/${encodeURIComponent(input.reviewId)}/moderate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      })
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: { code?: string } }
        throw new Error(err?.error?.code ?? 'error_moderating_review')
      }
      return await response.json()
    } catch (e: unknown) {
      error.value = errorMessage(e, 'error_moderating_review')
      throw e
    } finally {
      submitting.value = false
    }
  }

  return {
    reviews,
    adminReviews,
    total,
    loading,
    submitting,
    error,
    fetchPublicReviews,
    submitReview,
    withdrawReview,
    fetchAdminReviews,
    moderateReview
  }
}
