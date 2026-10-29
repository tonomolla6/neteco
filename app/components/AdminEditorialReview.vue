<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    operatorId?: string
    pageId?: string
  }>(),
  {
    operatorId: '',
    pageId: ''
  }
)

export interface ChecklistItem {
  id: string
  reviewId: string
  itemKey: string
  title: string
  completed: boolean
  completedBy: string | null
  completedAt: string | null
  createdAt: string
}

export interface ReviewComment {
  id: string
  reviewId: string
  authorId: string
  authorEmail?: string
  comment: string
  createdAt: string
}

export interface ReviewDetail {
  id: string
  pageId: string
  pageTitle: string
  pageSlug: string
  versionId: string
  versionNumber: number
  contentType: 'general' | 'legal' | 'chemical_safety' | 'pricing'
  status: 'draft' | 'in_review' | 'approved' | 'published' | 'rejected' | 'withdrawn'
  isCritical: boolean
  authorId: string
  authorEmail?: string
  assignedReviewerId: string | null
  assignedReviewerEmail?: string | null
  approvedBy: string | null
  approvedAt: string | null
  publishedBy: string | null
  publishedAt: string | null
  rejectionReason: string | null
  withdrawnReason: string | null
  version: number
  checklistCompletedCount: number
  checklistTotalCount: number
  createdAt: string
  updatedAt: string
  checklist: ChecklistItem[]
  comments: ReviewComment[]
  diff: {
    publishedVersionId: string | null
    publishedDocument: Record<string, unknown> | null
    proposedVersionId: string
    proposedDocument: Record<string, unknown>
  }
  capabilities: {
    canApprove: boolean
    canReject: boolean
    canAssign: boolean
    canComment: boolean
    canWithdraw: boolean
    canToggleChecklist: boolean
  }
}

export interface ReviewSummary {
  id: string
  pageId: string
  pageTitle: string
  pageSlug: string
  versionId: string
  versionNumber: number
  contentType: 'general' | 'legal' | 'chemical_safety' | 'pricing'
  status: 'draft' | 'in_review' | 'approved' | 'published' | 'rejected' | 'withdrawn'
  isCritical: boolean
  authorId: string
  authorEmail?: string
  assignedReviewerId: string | null
  assignedReviewerEmail?: string | null
  approvedBy: string | null
  approvedAt: string | null
  publishedBy: string | null
  publishedAt: string | null
  rejectionReason: string | null
  withdrawnReason: string | null
  version: number
  checklistCompletedCount: number
  checklistTotalCount: number
  createdAt: string
  updatedAt: string
}

const queueTab = ref<'mine' | 'all'>('all')
const statusFilter = ref<string>('all')
const reviews = ref<ReviewSummary[]>([])
const selectedReview = ref<ReviewDetail | null>(null)
const loading = ref(false)
const actionLoading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

// Action forms
const newComment = ref('')
const rejectReason = ref('')
const showRejectModal = ref(false)
const withdrawReason = ref('')
const showWithdrawModal = ref(false)
const approveNote = ref('')
const showApproveModal = ref(false)
const assignReviewerId = ref('')
const showAssignModal = ref(false)

const CONTENT_TYPE_LABELS: Record<string, string> = {
  general: 'General',
  legal: 'Legal',
  chemical_safety: 'Seguridad química',
  pricing: 'Precios y ofertas'
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  draft: { label: 'Borrador', color: 'bg-slate-100 text-slate-700 border-slate-300' },
  in_review: { label: 'En revisión', color: 'bg-amber-50 text-amber-800 border-amber-300' },
  approved: { label: 'Aprobado', color: 'bg-emerald-50 text-emerald-800 border-emerald-300' },
  published: { label: 'Publicado', color: 'bg-sky-50 text-sky-800 border-sky-300' },
  rejected: { label: 'Rechazado', color: 'bg-rose-50 text-rose-800 border-rose-300' },
  withdrawn: { label: 'Retirado', color: 'bg-slate-100 text-slate-500 border-slate-300' }
}

const isAuthorOfSelected = computed(() => {
  return !!props.operatorId && !!selectedReview.value && props.operatorId === selectedReview.value.authorId
})

const checklistIsComplete = computed(() => {
  if (!selectedReview.value?.checklist?.length) return false
  return selectedReview.value.checklist.every((item) => item.completed)
})

const canApproveSelected = computed(() => {
  if (!selectedReview.value) return false
  if (selectedReview.value.status !== 'in_review') return false
  if (!checklistIsComplete.value) return false
  if (selectedReview.value.isCritical && isAuthorOfSelected.value) return false
  return true
})

async function fetchReviews() {
  loading.value = true
  errorMessage.value = ''
  try {
    const params = new URLSearchParams()
    if (queueTab.value === 'mine') {
      params.set('assignedTo', 'me')
      params.set('status', 'in_review')
    } else if (statusFilter.value !== 'all') {
      params.set('status', statusFilter.value)
    }
    if (props.pageId) {
      params.set('pageId', props.pageId)
    }

    const query = params.toString() ? `?${params.toString()}` : ''
    const res = await fetch(`/api/admin/content/editorial-reviews${query}`)
    if (!res.ok) throw new Error('error_loading_reviews')
    const data = await res.json()
    reviews.value = data.items || []

    // If reviews exist and nothing selected, select the first one
    if (reviews.value.length > 0 && !selectedReview.value) {
      await selectReview(reviews.value[0].id)
    } else if (reviews.value.length === 0) {
      selectedReview.value = null
    }
  } catch {
    errorMessage.value = 'No se ha podido cargar la cola editorial.'
  } finally {
    loading.value = false
  }
}

async function selectReview(id: string) {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await fetch(`/api/admin/content/editorial-reviews/${id}`)
    if (!res.ok) throw new Error('error_loading_detail')
    selectedReview.value = await res.json()
  } catch {
    errorMessage.value = 'Error al cargar el detalle de la revisión.'
  } finally {
    loading.value = false
  }
}

async function toggleChecklistItem(item: ChecklistItem) {
  if (!selectedReview.value) return
  actionLoading.value = true
  errorMessage.value = ''
  try {
    const nextCompleted = !item.completed
    const res = await fetch(`/api/admin/content/editorial-reviews/${selectedReview.value.id}/checklist`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID()
      },
      body: JSON.stringify({
        itemKey: item.itemKey,
        completed: nextCompleted,
        expectedVersion: selectedReview.value.version
      })
    })
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}))
      throw new Error(errData?.error?.code || 'error_updating_checklist')
    }
    selectedReview.value = await res.json()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    errorMessage.value = `Error al actualizar checklist: ${msg}`
  } finally {
    actionLoading.value = false
  }
}

async function addComment() {
  if (!selectedReview.value || !newComment.value.trim()) return
  actionLoading.value = true
  errorMessage.value = ''
  try {
    const res = await fetch(`/api/admin/content/editorial-reviews/${selectedReview.value.id}/comments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID()
      },
      body: JSON.stringify({ comment: newComment.value.trim() })
    })
    if (!res.ok) throw new Error('error_adding_comment')
    const added = await res.json()
    selectedReview.value.comments.push(added)
    newComment.value = ''
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    errorMessage.value = `Error al guardar comentario: ${msg}`
  } finally {
    actionLoading.value = false
  }
}

async function approveReview() {
  if (!selectedReview.value) return
  actionLoading.value = true
  errorMessage.value = ''
  try {
    const res = await fetch(`/api/admin/content/editorial-reviews/${selectedReview.value.id}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID()
      },
      body: JSON.stringify({
        expectedVersion: selectedReview.value.version,
        note: approveNote.value.trim() || undefined
      })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      if (err?.error?.code === 'author_cannot_approve') {
        throw new Error('Separación de funciones: no puedes autoaprobar tu propio cambio crítico.')
      }
      if (err?.error?.code === 'checklist_incomplete') {
        throw new Error('Checklist incompleto: debes completar todos los puntos requeridos.')
      }
      if (err?.error?.code === 'mfa_expired') {
        throw new Error('MFA caducado: se requiere verificación MFA reciente para aprobar cambios críticos.')
      }
      throw new Error(err?.error?.code || 'error_approving')
    }
    selectedReview.value = await res.json()
    showApproveModal.value = false
    approveNote.value = ''
    successMessage.value = 'Revisión aprobada correctamente.'
    await fetchReviews()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionLoading.value = false
  }
}

async function rejectReview() {
  if (!selectedReview.value || !rejectReason.value.trim()) return
  actionLoading.value = true
  errorMessage.value = ''
  try {
    const res = await fetch(`/api/admin/content/editorial-reviews/${selectedReview.value.id}/reject`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID()
      },
      body: JSON.stringify({
        expectedVersion: selectedReview.value.version,
        reason: rejectReason.value.trim()
      })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.code || 'error_rejecting')
    }
    selectedReview.value = await res.json()
    showRejectModal.value = false
    rejectReason.value = ''
    successMessage.value = 'Revisión rechazada con motivo.'
    await fetchReviews()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionLoading.value = false
  }
}

async function withdrawReview() {
  if (!selectedReview.value || !withdrawReason.value.trim()) return
  actionLoading.value = true
  errorMessage.value = ''
  try {
    const res = await fetch(`/api/admin/content/editorial-reviews/${selectedReview.value.id}/withdraw`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID()
      },
      body: JSON.stringify({
        expectedVersion: selectedReview.value.version,
        reason: withdrawReason.value.trim()
      })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.code || 'error_withdrawing')
    }
    selectedReview.value = await res.json()
    showWithdrawModal.value = false
    withdrawReason.value = ''
    successMessage.value = 'Revisión retirada.'
    await fetchReviews()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionLoading.value = false
  }
}

async function assignReviewer() {
  if (!selectedReview.value || !assignReviewerId.value.trim()) return
  actionLoading.value = true
  errorMessage.value = ''
  try {
    const res = await fetch(`/api/admin/content/editorial-reviews/${selectedReview.value.id}/assign`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID()
      },
      body: JSON.stringify({
        assignedReviewerId: assignReviewerId.value.trim(),
        expectedVersion: selectedReview.value.version
      })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.code || 'error_assigning')
    }
    selectedReview.value = await res.json()
    showAssignModal.value = false
    assignReviewerId.value = ''
    successMessage.value = 'Revisor asignado con éxito.'
    await fetchReviews()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionLoading.value = false
  }
}

watch([queueTab, statusFilter], () => {
  void fetchReviews()
})

onMounted(() => {
  void fetchReviews()
})
</script>

<template>
  <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <div class="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
      <div>
        <h2 class="text-xl font-bold text-slate-900">Workflow editorial de aprobación</h2>
        <p class="text-xs text-slate-500">
          Supervisión de cambios, checklist de verificación técnica/legal y separación de funciones.
        </p>
      </div>

      <div class="flex items-center gap-2">
        <button
          type="button"
          class="rounded-lg px-3 py-1.5 text-xs font-semibold transition"
          :class="queueTab === 'mine' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'"
          @click="queueTab = 'mine'"
        >
          Pendientes de mi revisión
        </button>
        <button
          type="button"
          class="rounded-lg px-3 py-1.5 text-xs font-semibold transition"
          :class="queueTab === 'all' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'"
          @click="queueTab = 'all'"
        >
          Todas las revisiones
        </button>
      </div>
    </div>

    <!-- Feedback messages -->
    <div
      v-if="errorMessage"
      class="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-800"
    >
      {{ errorMessage }}
    </div>
    <div
      v-if="successMessage"
      class="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-medium text-emerald-800"
    >
      {{ successMessage }}
    </div>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-[18rem_1fr]">
      <!-- Queue Sidebar -->
      <aside class="h-fit rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div class="mb-3 flex items-center justify-between text-xs font-bold text-slate-700">
          <span>Cola de revisiones</span>
          <span class="rounded bg-slate-200 px-1.5 py-0.5 text-[11px]">{{ reviews.length }}</span>
        </div>

        <div v-if="loading && !reviews.length" class="py-6 text-center text-xs text-slate-500">Cargando cola...</div>

        <div v-else-if="!reviews.length" class="py-6 text-center text-xs text-slate-500">
          No hay revisiones en esta cola.
        </div>

        <div v-else class="space-y-1.5">
          <button
            v-for="rev in reviews"
            :key="rev.id"
            type="button"
            class="w-full rounded-lg border p-2.5 text-left transition"
            :class="
              selectedReview?.id === rev.id
                ? 'border-indigo-400 bg-indigo-50/50 shadow-sm'
                : 'border-slate-200 bg-white hover:border-slate-300'
            "
            @click="selectReview(rev.id)"
          >
            <div class="flex items-center justify-between gap-1">
              <span class="truncate font-semibold text-slate-900 text-xs">{{ rev.pageTitle }}</span>
              <span
                class="rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
                :class="(STATUS_LABELS[rev.status] || STATUS_LABELS.draft).color"
              >
                {{ (STATUS_LABELS[rev.status] || STATUS_LABELS.draft).label }}
              </span>
            </div>

            <div class="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500 font-mono">
              <span>/{{ rev.pageSlug }}</span>
              <span>· v{{ rev.versionNumber }}</span>
            </div>

            <div class="mt-2 flex flex-wrap items-center gap-1">
              <span v-if="rev.isCritical" class="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-800">
                Crítico
              </span>
              <span v-else class="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600"> Estándar </span>
              <span class="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-700">
                {{ CONTENT_TYPE_LABELS[rev.contentType] || rev.contentType }}
              </span>
            </div>

            <div class="mt-2 text-[11px] text-slate-500">
              Checklist: {{ rev.checklistCompletedCount }} / {{ rev.checklistTotalCount }}
            </div>
          </button>
        </div>
      </aside>

      <!-- Review Detail Section -->
      <section v-if="selectedReview" class="space-y-6">
        <!-- Review Header Card -->
        <div class="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div class="flex items-center gap-2">
                <h3 class="text-lg font-bold text-slate-900">{{ selectedReview.pageTitle }}</h3>
                <span
                  class="rounded-full border px-2 py-0.5 text-xs font-semibold"
                  :class="(STATUS_LABELS[selectedReview.status] || STATUS_LABELS.draft).color"
                >
                  {{ (STATUS_LABELS[selectedReview.status] || STATUS_LABELS.draft).label }}
                </span>
                <span
                  v-if="selectedReview.isCritical"
                  class="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-bold text-rose-800 border border-rose-300"
                >
                  Crítico
                </span>
              </div>
              <div class="mt-1 text-xs text-slate-500 font-mono">
                Ruta: /{{ selectedReview.pageSlug }} · Versión propuesta: v{{ selectedReview.versionNumber }} · Tipo:
                {{ CONTENT_TYPE_LABELS[selectedReview.contentType] || selectedReview.contentType }}
              </div>
            </div>

            <!-- Actions Bar -->
            <div class="flex flex-wrap gap-2">
              <button
                v-if="selectedReview.status === 'in_review'"
                data-test="approve-btn"
                type="button"
                class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="!canApproveSelected || actionLoading"
                @click="showApproveModal = true"
              >
                Aprobar
              </button>

              <button
                v-if="selectedReview.status === 'in_review'"
                type="button"
                class="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-bold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
                :disabled="actionLoading"
                @click="showRejectModal = true"
              >
                Rechazar
              </button>

              <button
                v-if="selectedReview.status !== 'withdrawn' && selectedReview.status !== 'published'"
                type="button"
                class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
                :disabled="actionLoading"
                @click="showWithdrawModal = true"
              >
                Retirar
              </button>

              <button
                v-if="selectedReview.status === 'in_review'"
                type="button"
                class="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-50 disabled:opacity-50"
                :disabled="actionLoading"
                @click="showAssignModal = true"
              >
                Asignar revisor
              </button>
            </div>
          </div>

          <!-- Separation of duties critical alert -->
          <div
            v-if="selectedReview.isCritical"
            class="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900"
          >
            <div class="font-bold flex items-center gap-1.5">
              <span>Separación de funciones</span>
            </div>
            <p class="mt-1 text-slate-700">
              Para cambios críticos (datos regulatorios/seguridad química, contenido legal o precios), quien escribe
              <strong>no puede autoaprobar ni autopublicar</strong> su propio cambio. Se exige un revisor con permiso de
              publicador (<code>catalog.publish</code>) e inicio de sesión con MFA reciente.
            </p>
            <p v-if="isAuthorOfSelected" class="mt-1 font-semibold text-rose-700">
              Eres el autor de este borrador. Debes esperar la revisión y aprobación de otro operador.
            </p>
          </div>

          <!-- Metadata info -->
          <div class="mt-3 grid grid-cols-1 gap-2 text-xs text-slate-600 sm:grid-cols-3">
            <div>
              <span class="font-semibold">Autor:</span> {{ selectedReview.authorEmail || selectedReview.authorId }}
            </div>
            <div>
              <span class="font-semibold">Revisor asignado:</span>
              {{ selectedReview.assignedReviewerEmail || selectedReview.assignedReviewerId || 'Sin asignar' }}
            </div>
            <div>
              <span class="font-semibold">Checklist:</span> {{ selectedReview.checklistCompletedCount }} /
              {{ selectedReview.checklistTotalCount }} completados
            </div>
          </div>
        </div>

        <!-- Checklist Section -->
        <div class="rounded-xl border border-slate-200 bg-white p-4">
          <div class="flex items-center justify-between">
            <h4 class="font-bold text-slate-900 text-sm">Checklist de verificación editorial</h4>
            <span
              class="rounded-full px-2 py-0.5 text-xs font-semibold"
              :class="checklistIsComplete ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'"
            >
              {{ selectedReview.checklistCompletedCount }} / {{ selectedReview.checklistTotalCount }} completados
            </span>
          </div>

          <p class="mt-1 text-xs text-slate-500">
            Todos los puntos deben verificarse y marcarse como completados antes de permitir la aprobación.
          </p>

          <div class="mt-3 divide-y divide-slate-100">
            <div v-for="item in selectedReview.checklist" :key="item.id" class="flex items-start gap-3 py-2.5">
              <input
                :id="`check-${item.id}`"
                type="checkbox"
                class="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                :checked="item.completed"
                :disabled="selectedReview.status !== 'in_review' || actionLoading"
                @change="toggleChecklistItem(item)"
              />
              <label :for="`check-${item.id}`" class="cursor-pointer text-xs text-slate-800">
                <span class="font-medium" :class="item.completed ? 'line-through text-slate-400' : ''">
                  {{ item.title }}
                </span>
                <span v-if="item.completed" class="ml-2 text-[11px] text-emerald-600"> (Completado) </span>
              </label>
            </div>
          </div>
        </div>

        <!-- Diff Section -->
        <div class="rounded-xl border border-slate-200 bg-white p-4">
          <h4 class="font-bold text-slate-900 text-sm">Diff entre versión publicada y propuesta</h4>
          <p class="mt-1 text-xs text-slate-500">
            Compara el contenido actualmente público con el borrador pendiente de aprobación.
          </p>

          <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <!-- Published version -->
            <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div class="font-bold text-xs text-slate-700">Versión actualmente publicada</div>
              <div v-if="!selectedReview.diff.publishedDocument" class="mt-3 text-xs text-slate-400 italic">
                No hay versión previa publicada (este borrador será la primera publicación).
              </div>
              <pre
                v-else
                class="mt-2 max-h-64 overflow-auto rounded bg-white p-2 font-mono text-[11px] text-slate-800 border"
                >{{ JSON.stringify(selectedReview.diff.publishedDocument, null, 2) }}</pre>
            </div>

            <!-- Proposed version -->
            <div class="rounded-lg border border-indigo-200 bg-indigo-50/30 p-3">
              <div class="font-bold text-xs text-indigo-900">
                Versión propuesta (v{{ selectedReview.versionNumber }})
              </div>
              <pre
                class="mt-2 max-h-64 overflow-auto rounded bg-white p-2 font-mono text-[11px] text-slate-800 border"
                >{{ JSON.stringify(selectedReview.diff.proposedDocument, null, 2) }}</pre>
            </div>
          </div>
        </div>

        <!-- Append-only Comments Thread -->
        <div class="rounded-xl border border-slate-200 bg-white p-4">
          <h4 class="font-bold text-slate-900 text-sm">Comentarios de revisión (historial inmutable)</h4>
          <p class="text-xs text-slate-500">
            Observaciones registradas de forma inmutable para auditoría y trazabilidad editorial.
          </p>

          <div class="mt-3 space-y-2">
            <div
              v-for="c in selectedReview.comments"
              :key="c.id"
              class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs"
            >
              <div class="flex items-center justify-between text-slate-500 text-[11px]">
                <span class="font-semibold text-slate-700">{{ c.authorEmail || c.authorId }}</span>
                <span>{{ new Date(c.createdAt).toLocaleString('es-ES') }}</span>
              </div>
              <p class="mt-1 text-slate-800 whitespace-pre-wrap">{{ c.comment }}</p>
            </div>
          </div>

          <!-- Add comment input -->
          <div class="mt-4 flex gap-2">
            <textarea
              v-model="newComment"
              data-test="new-comment"
              rows="2"
              class="w-full rounded-lg border border-slate-300 p-2 text-xs focus:border-indigo-500 focus:outline-none"
              placeholder="Escribe un comentario para la revisión..."
            />
            <button
              data-test="send-comment"
              type="button"
              class="h-fit rounded-lg bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-indigo-700 disabled:opacity-50"
              :disabled="!newComment.trim() || actionLoading"
              @click="addComment"
            >
              Comentar
            </button>
          </div>
        </div>
      </section>

      <div v-else class="rounded-xl border border-dashed border-slate-300 p-8 text-center text-xs text-slate-500">
        Selecciona una revisión de la cola para ver su checklist, diff y opciones de aprobación.
      </div>
    </div>

    <!-- Approve Modal -->
    <div v-if="showApproveModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h3 class="text-base font-bold text-slate-900">Aprobar revisión editorial</h3>
        <p class="mt-1 text-xs text-slate-500">
          Confirmas que todos los puntos de la checklist han sido revisados y autorizas la publicación.
        </p>

        <div class="mt-4">
          <label class="block text-xs font-semibold text-slate-700">Nota de aprobación (opcional)</label>
          <input
            v-model="approveNote"
            type="text"
            class="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"
            placeholder="Observaciones de la aprobación..."
          />
        </div>

        <div class="mt-6 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            @click="showApproveModal = false"
          >
            Cancelar
          </button>
          <button
            type="button"
            class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700"
            :disabled="actionLoading"
            @click="approveReview"
          >
            Confirmar aprobación
          </button>
        </div>
      </div>
    </div>

    <!-- Reject Modal -->
    <div v-if="showRejectModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h3 class="text-base font-bold text-slate-900">Rechazar revisión editorial</h3>
        <p class="mt-1 text-xs text-slate-500">
          Indica el motivo del rechazo para que el autor pueda corregir el contenido.
        </p>

        <div class="mt-4">
          <label class="block text-xs font-semibold text-slate-700"
            >Motivo del rechazo (obligatorio, mín. 3 caracteres)</label
          >
          <textarea
            v-model="rejectReason"
            rows="3"
            class="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"
            placeholder="Describe qué requiere corrección..."
          />
        </div>

        <div class="mt-6 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            @click="showRejectModal = false"
          >
            Cancelar
          </button>
          <button
            type="button"
            class="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50"
            :disabled="rejectReason.trim().length < 3 || actionLoading"
            @click="rejectReview"
          >
            Confirmar rechazo
          </button>
        </div>
      </div>
    </div>

    <!-- Withdraw Modal -->
    <div v-if="showWithdrawModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h3 class="text-base font-bold text-slate-900">Retirar revisión editorial</h3>
        <p class="mt-1 text-xs text-slate-500">Cancela el proceso de revisión y retira la propuesta.</p>

        <div class="mt-4">
          <label class="block text-xs font-semibold text-slate-700">Motivo de retirada (obligatorio)</label>
          <textarea
            v-model="withdrawReason"
            rows="3"
            class="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"
            placeholder="Motivo por el que se retira..."
          />
        </div>

        <div class="mt-6 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            @click="showWithdrawModal = false"
          >
            Cancelar
          </button>
          <button
            type="button"
            class="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-900 disabled:opacity-50"
            :disabled="withdrawReason.trim().length < 3 || actionLoading"
            @click="withdrawReview"
          >
            Confirmar retirada
          </button>
        </div>
      </div>
    </div>

    <!-- Assign Modal -->
    <div v-if="showAssignModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h3 class="text-base font-bold text-slate-900">Asignar revisor</h3>
        <p class="mt-1 text-xs text-slate-500">Especifica el UUID de la identidad del revisor técnico o legal.</p>

        <div class="mt-4">
          <label class="block text-xs font-semibold text-slate-700">ID del revisor (UUID)</label>
          <input
            v-model="assignReviewerId"
            type="text"
            class="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs font-mono"
            placeholder="00000000-0000-4000-8000-000000000000"
          />
        </div>

        <div class="mt-6 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            @click="showAssignModal = false"
          >
            Cancelar
          </button>
          <button
            type="button"
            class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
            :disabled="!assignReviewerId.trim() || actionLoading"
            @click="assignReviewer"
          >
            Asignar
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
