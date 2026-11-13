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

type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'
const STATUS_LABELS: Record<string, { label: string; tone: StatusTone }> = {
  draft: { label: 'Borrador', tone: 'neutral' },
  in_review: { label: 'En revisión', tone: 'warning' },
  approved: { label: 'Aprobado', tone: 'success' },
  published: { label: 'Publicado', tone: 'info' },
  rejected: { label: 'Rechazado', tone: 'danger' },
  withdrawn: { label: 'Retirado', tone: 'neutral' }
}

const DEFAULT_STATUS_LABEL: { label: string; tone: StatusTone } = { label: 'Borrador', tone: 'neutral' }
const STATUS_FILTERS = [
  { value: 'all', label: 'Todos los estados' },
  { value: 'in_review', label: 'En revisión' },
  { value: 'approved', label: 'Aprobados' },
  { value: 'published', label: 'Publicados' },
  { value: 'rejected', label: 'Rechazados' },
  { value: 'withdrawn', label: 'Retirados' },
  { value: 'draft', label: 'Borradores' }
]
const BLOCK_NAMES: Record<string, string> = {
  heading: 'Encabezado',
  paragraph: 'Párrafo',
  list: 'Lista',
  image: 'Imagen',
  callout: 'Aviso destacado',
  cta: 'Enlace'
}
/** Los errores del servidor llegan a veces como código interno: se muestra un texto legible en su lugar. */
function friendly(err: unknown, fallback: string) {
  const text = err instanceof Error ? err.message : String(err)
  return /^[a-z0-9_]+$/.test(text) ? fallback : text
}
const shortId = (id: string | null | undefined) => (id ? `#${id.slice(0, 8).toUpperCase()}` : '')
function blockSummary(block: Record<string, unknown>): string {
  const text = (key: string) => (typeof block[key] === 'string' ? (block[key] as string) : '')
  switch (block.type) {
    case 'cta':
      return `${text('label')} → ${text('href')}`
    case 'image':
      return text('alt') || text('caption')
    case 'list':
      return Array.isArray(block.items) ? block.items.join(' · ') : ''
    case 'callout':
      return [text('title'), text('text')].filter(Boolean).join(': ')
    default:
      return text('text')
  }
}
/** Convierte una versión de la página en filas legibles (título, buscadores y bloques). */
function documentRows(document: Record<string, unknown> | null): Array<{ label: string; text: string }> {
  if (!document) return []
  const rows: Array<{ label: string; text: string }> = []
  const add = (label: string, value: unknown) => {
    if (typeof value === 'string' && value.trim()) rows.push({ label, text: value })
  }
  add('Título', document.title)
  if (typeof document.slug === 'string') add('Dirección', `/${document.slug}`)
  const seo = document.seo
  if (seo && typeof seo === 'object') {
    add('Título en buscadores', (seo as Record<string, unknown>).title)
    add('Descripción en buscadores', (seo as Record<string, unknown>).description)
  }
  if (Array.isArray(document.blocks))
    for (const block of document.blocks as unknown[])
      if (block && typeof block === 'object') {
        const entry = block as Record<string, unknown>
        add(BLOCK_NAMES[String(entry.type)] ?? 'Bloque', blockSummary(entry))
      }
  add('Resumen del cambio', document.changeSummary)
  return rows
}
const publishedRows = computed(() => documentRows(selectedReview.value?.diff.publishedDocument ?? null))
const proposedRows = computed(() => {
  const known = new Set(publishedRows.value.map((row) => `${row.label}\n${row.text}`))
  return documentRows(selectedReview.value?.diff.proposedDocument ?? null).map((row) => ({
    ...row,
    changed: publishedRows.value.length > 0 && !known.has(`${row.label}\n${row.text}`)
  }))
})
function getStatusLabel(status: string) {
  return STATUS_LABELS[status] ?? DEFAULT_STATUS_LABEL
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
    const data = (await res.json()) as { items?: ReviewSummary[] }
    reviews.value = data.items || []

    // If reviews exist and nothing selected, select the first one
    if (reviews.value[0] && !selectedReview.value) {
      await selectReview(reviews.value[0].id)
    } else if (reviews.value.length === 0) {
      selectedReview.value = null
    }
  } catch {
    errorMessage.value = 'No se han podido cargar las revisiones.'
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
    selectedReview.value = (await res.json()) as ReviewDetail
  } catch {
    errorMessage.value = 'No se ha podido cargar el detalle de la revisión.'
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
      const errData = (await res.json().catch(() => ({}))) as { error?: { code?: string } }
      throw new Error(errData?.error?.code || 'error_updating_checklist')
    }
    selectedReview.value = (await res.json()) as ReviewDetail
  } catch (err: unknown) {
    errorMessage.value = friendly(err, 'No se ha podido actualizar la lista de comprobación. Vuelve a intentarlo.')
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
    const added = (await res.json()) as ReviewComment
    selectedReview.value.comments.push(added)
    newComment.value = ''
  } catch (err: unknown) {
    errorMessage.value = friendly(err, 'No se ha podido guardar el comentario. Vuelve a intentarlo.')
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
      const err = (await res.json().catch(() => ({}))) as { error?: { code?: string } }
      if (err?.error?.code === 'author_cannot_approve') {
        throw new Error('Separación de funciones: no puedes autoaprobar tu propio cambio crítico.')
      }
      if (err?.error?.code === 'checklist_incomplete') {
        throw new Error('La lista de comprobación está incompleta: marca todos los puntos antes de aprobar.')
      }
      if (err?.error?.code === 'mfa_expired') {
        throw new Error('Tu verificación en dos pasos ha caducado: vuelve a verificarte para aprobar cambios críticos.')
      }
      throw new Error(err?.error?.code || 'error_approving')
    }
    selectedReview.value = (await res.json()) as ReviewDetail
    showApproveModal.value = false
    approveNote.value = ''
    successMessage.value = 'Revisión aprobada correctamente.'
    await fetchReviews()
  } catch (err: unknown) {
    errorMessage.value = friendly(
      err,
      'No se ha podido completar la operación. Actualiza la revisión y vuelve a intentarlo.'
    )
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
      const err = (await res.json().catch(() => ({}))) as { error?: { code?: string } }
      throw new Error(err?.error?.code || 'error_rejecting')
    }
    selectedReview.value = (await res.json()) as ReviewDetail
    showRejectModal.value = false
    rejectReason.value = ''
    successMessage.value = 'Revisión rechazada con motivo.'
    await fetchReviews()
  } catch (err: unknown) {
    errorMessage.value = friendly(
      err,
      'No se ha podido completar la operación. Actualiza la revisión y vuelve a intentarlo.'
    )
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
      const err = (await res.json().catch(() => ({}))) as { error?: { code?: string } }
      throw new Error(err?.error?.code || 'error_withdrawing')
    }
    selectedReview.value = (await res.json()) as ReviewDetail
    showWithdrawModal.value = false
    withdrawReason.value = ''
    successMessage.value = 'Revisión retirada.'
    await fetchReviews()
  } catch (err: unknown) {
    errorMessage.value = friendly(
      err,
      'No se ha podido completar la operación. Actualiza la revisión y vuelve a intentarlo.'
    )
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
      const err = (await res.json().catch(() => ({}))) as { error?: { code?: string } }
      throw new Error(err?.error?.code || 'error_assigning')
    }
    selectedReview.value = (await res.json()) as ReviewDetail
    showAssignModal.value = false
    assignReviewerId.value = ''
    successMessage.value = 'Revisor asignado con éxito.'
    await fetchReviews()
  } catch (err: unknown) {
    errorMessage.value = friendly(
      err,
      'No se ha podido completar la operación. Actualiza la revisión y vuelve a intentarlo.'
    )
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
  <div class="adm-stack">
    <UAlert
      v-if="errorMessage && (reviews.length || selectedReview)"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
    />
    <UAlert
      v-if="successMessage"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="successMessage"
    />

    <div class="adm-toolbar">
      <div class="adm-segments" role="group" aria-label="Qué revisiones ver">
        <button type="button" class="adm-segment" :aria-pressed="queueTab === 'mine'" @click="queueTab = 'mine'">
          Pendientes de mi revisión
        </button>
        <button type="button" class="adm-segment" :aria-pressed="queueTab === 'all'" @click="queueTab = 'all'">
          Todas las revisiones
        </button>
      </div>
      <select v-model="statusFilter" class="adm-input" aria-label="Filtrar por estado" :disabled="queueTab === 'mine'">
        <option v-for="option in STATUS_FILTERS" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
      <div class="adm-toolbar__end">
        <button type="button" class="adm-btn adm-btn--secondary" :disabled="loading" @click="fetchReviews">
          Actualizar
        </button>
      </div>
    </div>

    <div class="grid grid-cols-1 items-start gap-5 lg:grid-cols-[19rem_minmax(0,1fr)]">
      <AdminCard flush>
        <template #title>
          Revisiones <span class="adm-segment__count">{{ reviews.length }}</span>
        </template>
        <div v-if="loading && !reviews.length" class="adm-table-skeleton" aria-busy="true">
          <span class="sr-only">Cargando revisiones…</span>
          <div v-for="row in 4" :key="row"><i /><i /></div>
        </div>
        <AdminEmptyState
          v-else-if="!reviews.length && errorMessage"
          variant="error"
          compact
          title="No se han podido cargar las revisiones"
          :description="errorMessage"
        >
          <button type="button" class="adm-btn adm-btn--secondary" @click="fetchReviews">Reintentar</button>
        </AdminEmptyState>
        <AdminEmptyState
          v-else-if="!reviews.length"
          compact
          icon="i-lucide-clipboard-check"
          title="No hay revisiones"
          :description="
            queueTab === 'mine'
              ? 'No tienes ninguna revisión asignada.'
              : 'Ningún cambio espera revisión con este filtro.'
          "
        />
        <ul v-else class="divide-y divide-[var(--border)]">
          <li v-for="rev in reviews" :key="rev.id">
            <button
              type="button"
              class="block w-full px-4 py-3 text-left transition-colors hover:bg-[var(--canvas)]"
              :class="selectedReview?.id === rev.id && 'bg-neteco-50'"
              :aria-current="selectedReview?.id === rev.id ? 'true' : undefined"
              @click="selectReview(rev.id)"
            >
              <span class="flex items-start justify-between gap-2">
                <span class="min-w-0 truncate font-semibold text-[var(--text-strong)]">{{ rev.pageTitle }}</span>
                <AdminBadge :tone="getStatusLabel(rev.status).tone">{{ getStatusLabel(rev.status).label }}</AdminBadge>
              </span>
              <span class="adm-help mt-0.5 block truncate">/{{ rev.pageSlug }} · versión {{ rev.versionNumber }}</span>
              <span class="mt-1.5 flex flex-wrap items-center gap-1.5">
                <AdminBadge v-if="rev.isCritical" tone="danger" plain>Crítico</AdminBadge>
                <AdminBadge plain>{{ CONTENT_TYPE_LABELS[rev.contentType] || 'General' }}</AdminBadge>
                <span class="adm-help">
                  {{ rev.checklistCompletedCount }} de {{ rev.checklistTotalCount }} comprobaciones
                </span>
              </span>
            </button>
          </li>
        </ul>
      </AdminCard>

      <section v-if="selectedReview" class="adm-stack min-w-0">
        <AdminCard>
          <div class="adm-stack">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="adm-section__title">{{ selectedReview.pageTitle }}</h3>
                  <AdminBadge :tone="getStatusLabel(selectedReview.status).tone">
                    {{ getStatusLabel(selectedReview.status).label }}
                  </AdminBadge>
                  <AdminBadge v-if="selectedReview.isCritical" tone="danger">Crítico</AdminBadge>
                </div>
                <p class="adm-help mt-1 break-all">
                  /{{ selectedReview.pageSlug }} · versión propuesta {{ selectedReview.versionNumber }} ·
                  {{ CONTENT_TYPE_LABELS[selectedReview.contentType] || 'General' }}
                </p>
              </div>
              <div class="flex flex-wrap gap-2">
                <button
                  v-if="selectedReview.status === 'in_review'"
                  type="button"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  :disabled="actionLoading"
                  @click="showAssignModal = true"
                >
                  Asignar revisor
                </button>
                <button
                  v-if="selectedReview.status !== 'withdrawn' && selectedReview.status !== 'published'"
                  type="button"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  :disabled="actionLoading"
                  @click="showWithdrawModal = true"
                >
                  Retirar
                </button>
                <button
                  v-if="selectedReview.status === 'in_review'"
                  type="button"
                  class="adm-btn adm-btn--danger-soft adm-btn--sm"
                  :disabled="actionLoading"
                  @click="showRejectModal = true"
                >
                  Rechazar
                </button>
                <button
                  v-if="selectedReview.status === 'in_review'"
                  data-test="approve-btn"
                  type="button"
                  class="adm-btn adm-btn--primary adm-btn--sm"
                  :disabled="!canApproveSelected || actionLoading"
                  @click="showApproveModal = true"
                >
                  Aprobar
                </button>
              </div>
            </div>

            <UAlert
              v-if="selectedReview.isCritical"
              color="warning"
              variant="subtle"
              icon="i-lucide-shield-alert"
              title="Separación de funciones"
            >
              <template #description>
                <p>
                  En los cambios críticos (seguridad química, contenido legal o precios), quien escribe
                  <strong>no puede autoaprobar ni autopublicar</strong> su propio cambio. Hace falta otra persona con
                  permiso para publicar y con la verificación en dos pasos reciente.
                </p>
                <p v-if="isAuthorOfSelected" class="mt-1 font-semibold">
                  Este borrador es tuyo: tiene que revisarlo y aprobarlo otra persona.
                </p>
              </template>
            </UAlert>

            <dl class="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <dt class="adm-help">Autor</dt>
                <dd class="break-all">{{ selectedReview.authorEmail || shortId(selectedReview.authorId) }}</dd>
              </div>
              <div>
                <dt class="adm-help">Revisor asignado</dt>
                <dd class="break-all">
                  {{
                    selectedReview.assignedReviewerEmail || shortId(selectedReview.assignedReviewerId) || 'Sin asignar'
                  }}
                </dd>
              </div>
              <div>
                <dt class="adm-help">Lista de comprobación</dt>
                <dd>
                  {{ selectedReview.checklistCompletedCount }} / {{ selectedReview.checklistTotalCount }} completados
                </dd>
              </div>
            </dl>
          </div>
        </AdminCard>

        <AdminCard
          title="Lista de comprobación"
          description="Hay que marcar todos los puntos antes de poder aprobar."
          flush
        >
          <template #actions>
            <AdminBadge :tone="checklistIsComplete ? 'success' : 'warning'">
              {{ selectedReview.checklistCompletedCount }} / {{ selectedReview.checklistTotalCount }} completados
            </AdminBadge>
          </template>
          <ul class="divide-y divide-[var(--border)]">
            <li v-for="item in selectedReview.checklist" :key="item.id" class="px-5 py-2.5">
              <label :for="`check-${item.id}`" class="adm-check">
                <input
                  :id="`check-${item.id}`"
                  type="checkbox"
                  :checked="item.completed"
                  :disabled="selectedReview.status !== 'in_review' || actionLoading"
                  @change="toggleChecklistItem(item)"
                />
                <span :class="item.completed && 'text-[var(--text-muted)] line-through'">{{ item.title }}</span>
              </label>
            </li>
          </ul>
        </AdminCard>

        <AdminCard
          title="Cambios entre la versión publicada y la propuesta"
          description="Compara lo que hoy ven los clientes con el borrador pendiente de aprobar."
        >
          <div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div class="min-w-0">
              <h4 class="mb-2">Publicada ahora</h4>
              <p v-if="!selectedReview.diff.publishedDocument" class="adm-help">
                Todavía no hay nada publicado: este borrador sería la primera publicación.
              </p>
              <ul v-else class="space-y-2">
                <li v-for="(row, index) in publishedRows" :key="index">
                  <p class="adm-help">{{ row.label }}</p>
                  <p class="whitespace-pre-wrap break-words">{{ row.text }}</p>
                </li>
              </ul>
            </div>
            <div class="min-w-0">
              <h4 class="mb-2">Propuesta (versión {{ selectedReview.versionNumber }})</h4>
              <ul class="space-y-2">
                <li v-for="(row, index) in proposedRows" :key="index">
                  <p class="adm-help">
                    {{ row.label }} <AdminBadge v-if="row.changed" tone="info" plain>Cambia</AdminBadge>
                  </p>
                  <p class="whitespace-pre-wrap break-words">{{ row.text }}</p>
                </li>
              </ul>
            </div>
          </div>
        </AdminCard>

        <AdminCard title="Comentarios" description="Quedan guardados y no se pueden editar ni borrar.">
          <div class="adm-stack">
            <p v-if="!selectedReview.comments.length" class="adm-help">Todavía no hay comentarios.</p>
            <ul v-else class="space-y-3">
              <li v-for="c in selectedReview.comments" :key="c.id">
                <p class="adm-help">
                  <span class="font-semibold text-[var(--text-strong)]">{{
                    c.authorEmail || shortId(c.authorId)
                  }}</span>
                  · {{ adminDate(c.createdAt, true) }}
                </p>
                <p class="whitespace-pre-wrap break-words">{{ c.comment }}</p>
              </li>
            </ul>
            <div class="flex flex-wrap items-end gap-2">
              <textarea
                v-model="newComment"
                data-test="new-comment"
                rows="2"
                class="adm-input min-w-0 flex-1"
                aria-label="Nuevo comentario"
                placeholder="Escribe un comentario para la revisión…"
              />
              <button
                data-test="send-comment"
                type="button"
                class="adm-btn adm-btn--secondary"
                :disabled="!newComment.trim() || actionLoading"
                @click="addComment"
              >
                Comentar
              </button>
            </div>
          </div>
        </AdminCard>
      </section>

      <AdminCard v-else>
        <AdminEmptyState
          icon="i-lucide-mouse-pointer-click"
          title="Elige una revisión"
          description="Verás su lista de comprobación, los cambios propuestos y las opciones para aprobarla o rechazarla."
        />
      </AdminCard>
    </div>

    <AdminConfirm
      v-model:open="showApproveModal"
      title="Aprobar la revisión"
      description="Confirmas que has revisado todos los puntos de la lista y autorizas la publicación."
      confirm-label="Aprobar"
      :loading="actionLoading"
      @confirm="approveReview"
    >
      <label class="adm-label" for="review-approve-note">Nota de aprobación (opcional)</label>
      <input
        id="review-approve-note"
        v-model="approveNote"
        type="text"
        class="adm-input mt-1 w-full"
        placeholder="Observaciones de la aprobación…"
      />
    </AdminConfirm>

    <AdminConfirm
      v-model:open="showRejectModal"
      title="Rechazar la revisión"
      description="Indica el motivo para que el autor pueda corregir el contenido."
      confirm-label="Rechazar"
      danger
      :loading="actionLoading"
      @confirm="rejectReason.trim().length >= 3 && rejectReview()"
    >
      <label class="adm-label" for="review-reject-reason">Motivo del rechazo (obligatorio, mínimo 3 caracteres)</label>
      <textarea
        id="review-reject-reason"
        v-model="rejectReason"
        rows="3"
        class="adm-input mt-1 w-full"
        placeholder="Describe qué hay que corregir…"
      />
    </AdminConfirm>

    <AdminConfirm
      v-model:open="showWithdrawModal"
      title="Retirar la revisión"
      description="Se cancela la revisión y se retira la propuesta."
      confirm-label="Retirar"
      danger
      :loading="actionLoading"
      @confirm="withdrawReason.trim().length >= 3 && withdrawReview()"
    >
      <label class="adm-label" for="review-withdraw-reason"
        >Motivo de la retirada (obligatorio, mínimo 3 caracteres)</label
      >
      <textarea
        id="review-withdraw-reason"
        v-model="withdrawReason"
        rows="3"
        class="adm-input mt-1 w-full"
        placeholder="Por qué se retira…"
      />
    </AdminConfirm>

    <AdminConfirm
      v-model:open="showAssignModal"
      title="Asignar revisor"
      description="Indica el identificador de la persona que hará la revisión técnica o legal."
      confirm-label="Asignar"
      :loading="actionLoading"
      @confirm="assignReviewerId.trim() && assignReviewer()"
    >
      <label class="adm-label" for="review-assign-id">Identificador del revisor</label>
      <input
        id="review-assign-id"
        v-model="assignReviewerId"
        type="text"
        class="adm-input mt-1 w-full font-mono"
        placeholder="00000000-0000-4000-8000-000000000000"
      />
    </AdminConfirm>
  </div>
</template>
