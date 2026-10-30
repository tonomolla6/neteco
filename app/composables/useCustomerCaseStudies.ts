import { ref } from 'vue'
import type {
  PublicCaseStudy,
  CreateCaseStudyInput,
  PerformPeriodicReviewInput
} from '../../shared/customer-case-studies'

export function useCustomerCaseStudies() {
  const cases = ref<PublicCaseStudy[]>([])
  const currentCase = ref<PublicCaseStudy | null>(null)
  const adminCases = ref<Array<Record<string, unknown>>>([])
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)

  const errorMessage = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

  const fetchPublicCases = async (sector?: string) => {
    loading.value = true
    error.value = null
    try {
      const url = sector ? `/api/case-studies?sector=${encodeURIComponent(sector)}` : '/api/case-studies'
      const response = await fetch(url)
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: { code?: string } }
        throw new Error(err?.error?.code ?? 'error_loading_cases')
      }
      const data = (await response.json()) as { cases?: PublicCaseStudy[] }
      cases.value = data.cases ?? []
    } catch (e: unknown) {
      error.value = errorMessage(e, 'error_loading_cases')
    } finally {
      loading.value = false
    }
  }

  const fetchCaseBySlug = async (slug: string) => {
    loading.value = true
    error.value = null
    try {
      const response = await fetch(`/api/case-studies/${encodeURIComponent(slug)}`)
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: { code?: string } }
        throw new Error(err?.error?.code ?? 'case_not_found')
      }
      const data = (await response.json()) as PublicCaseStudy
      currentCase.value = data
      return data
    } catch (e: unknown) {
      error.value = errorMessage(e, 'case_not_found')
      throw e
    } finally {
      loading.value = false
    }
  }

  const fetchAdminCases = async (filter: { publicationStatus?: string; reviewStatus?: string } = {}) => {
    loading.value = true
    error.value = null
    try {
      const params = new URLSearchParams()
      if (filter.publicationStatus) params.set('publicationStatus', filter.publicationStatus)
      if (filter.reviewStatus) params.set('reviewStatus', filter.reviewStatus)

      const response = await fetch(`/api/admin/case-studies?${params.toString()}`)
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: { code?: string } }
        throw new Error(err?.error?.code ?? 'error_loading_admin_cases')
      }
      const data = (await response.json()) as { cases?: Array<Record<string, unknown>> }
      adminCases.value = data.cases ?? []
    } catch (e: unknown) {
      error.value = errorMessage(e, 'error_loading_admin_cases')
    } finally {
      loading.value = false
    }
  }

  const createCase = async (input: CreateCaseStudyInput) => {
    saving.value = true
    error.value = null
    try {
      const response = await fetch('/api/admin/case-studies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      })
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: { code?: string } }
        throw new Error(err?.error?.code ?? 'error_creating_case')
      }
      return await response.json()
    } catch (e: unknown) {
      error.value = errorMessage(e, 'error_creating_case')
      throw e
    } finally {
      saving.value = false
    }
  }

  const publishCase = async (caseId: string, expectedVersion: number) => {
    saving.value = true
    error.value = null
    try {
      const response = await fetch(`/api/admin/case-studies/${encodeURIComponent(caseId)}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId,
          expectedVersion,
          commandId: `cmd-publish-${caseId}-${Date.now()}`
        })
      })
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: { code?: string } }
        throw new Error(err?.error?.code ?? 'error_publishing_case')
      }
      return await response.json()
    } catch (e: unknown) {
      error.value = errorMessage(e, 'error_publishing_case')
      throw e
    } finally {
      saving.value = false
    }
  }

  const performReview = async (input: PerformPeriodicReviewInput) => {
    saving.value = true
    error.value = null
    try {
      const response = await fetch(`/api/admin/case-studies/${encodeURIComponent(input.caseId)}/periodic-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      })
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: { code?: string } }
        throw new Error(err?.error?.code ?? 'error_performing_review')
      }
      return await response.json()
    } catch (e: unknown) {
      error.value = errorMessage(e, 'error_performing_review')
      throw e
    } finally {
      saving.value = false
    }
  }

  return {
    cases,
    currentCase,
    adminCases,
    loading,
    saving,
    error,
    fetchPublicCases,
    fetchCaseBySlug,
    fetchAdminCases,
    createCase,
    publishCase,
    performReview
  }
}
