<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

export interface CatalogQualityPenaltyItem {
  code: string
  group: 'mandatory_fields' | 'recommended_fields' | 'typed_attributes' | 'images' | 'documents' | 'review'
  weight: number
  blocking: boolean
  message: string
}

export interface CatalogQualityMissingSummaryView {
  mandatoryFields: number
  recommendedFields: number
  typedAttributes: number
  images: number
  documents: number
  reviewIssues: number
}

export interface CatalogQualityReviewView {
  reviewVersion: number
  reviewedCatalogVersion: number
  reviewedScore: number
  penaltyCodes?: string[]
  note: string | null
  reviewedBy: string
  reviewedAt: string
  commandId?: string
}

export interface CatalogQualityQueueItemView {
  productId: number
  productUuid?: string
  sku: string | null
  slug: string
  name: string
  status: string
  categoryId: number | null
  categoryName: string
  categorySlug: string
  catalogVersion: number
  score: number
  publishable: boolean
  missingSummary: CatalogQualityMissingSummaryView
  penalties: CatalogQualityPenaltyItem[]
  review: CatalogQualityReviewView | null
}

export interface CatalogQualityQueueSummaryView {
  totalEvaluated: number
  matchingTotal: number
  averageScore: number
  unreviewedCount: number
  needsAttentionCount: number
  byGroup: Record<string, number>
}

export interface CatalogQualityQueuePaginationView {
  page: number
  perPage: number
  total: number
  pages: number
  nextCursor: string | null
}

const props = withDefaults(
  defineProps<{
    endpoint?: string
    reviewEndpointBase?: string
    categories?: Array<{ id: number; slug: string; name: string }>
    perPage?: number
    canWrite?: boolean
  }>(),
  {
    endpoint: '/api/admin/products/quality-queue',
    reviewEndpointBase: '/api/admin/products',
    categories: () => [],
    perPage: 25,
    canWrite: true
  }
)

const emit = defineEmits<{
  selectProduct: [productId: number]
  reviewed: [payload: { productId: number; reviewVersion: number; reviewedAt: string }]
}>()

const loading = ref(false)
const errorMessage = ref<string | null>(null)
const items = ref<CatalogQualityQueueItemView[]>([])
const summary = ref<CatalogQualityQueueSummaryView | null>(null)
const pagination = ref<CatalogQualityQueuePaginationView>({
  page: 1,
  perPage: props.perPage,
  total: 0,
  pages: 1,
  nextCursor: null
})

const filters = reactive({
  q: '',
  reason: '',
  status: '',
  category: ''
})

const activeReviewProductId = ref<number | null>(null)
const reviewNotes = reactive<Record<number, string>>({})
const reviewBusy = reactive<Record<number, boolean>>({})
const reviewErrors = reactive<Record<number, string | null>>({})
const uncertainKeys = reactive<Record<number, string | null>>({})
const stickyIdempotencyKeys = reactive<Record<string, string>>({})

const hasItems = computed(() => items.value.length > 0)

function buildQueueUrl(page = pagination.value.page): string {
  const params = new URLSearchParams()
  params.set('page', String(page))
  params.set('perPage', String(props.perPage))
  if (filters.q.trim()) params.set('q', filters.q.trim())
  if (filters.reason) params.set('reason', filters.reason)
  if (filters.status) params.set('status', filters.status)
  if (filters.category) params.set('category', filters.category)
  return `${props.endpoint}?${params.toString()}`
}

async function fetchQueue(page = 1): Promise<void> {
  loading.value = true
  errorMessage.value = null
  try {
    const response = await fetch(buildQueueUrl(page), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    })
    if (!response.ok) {
      errorMessage.value =
        response.status === 401 || response.status === 403
          ? 'No tienes permiso para consultar la calidad del catálogo.'
          : 'No se ha podido cargar la calidad del catálogo. Inténtalo de nuevo.'
      return
    }
    const data = (await response.json()) as {
      items?: CatalogQualityQueueItemView[]
      summary?: CatalogQualityQueueSummaryView
      pagination?: CatalogQualityQueuePaginationView
    }
    items.value = Array.isArray(data.items) ? data.items : []
    summary.value = data.summary ?? null
    if (data.pagination) {
      pagination.value = data.pagination
    } else {
      pagination.value = {
        page,
        perPage: props.perPage,
        total: items.value.length,
        pages: 1,
        nextCursor: null
      }
    }
  } catch {
    errorMessage.value = 'No hay conexión con el servidor. Comprueba tu red e inténtalo de nuevo.'
  } finally {
    loading.value = false
  }
}

function applyFilters(): void {
  void fetchQueue(1)
}

function resetFilters(): void {
  filters.q = ''
  filters.reason = ''
  filters.status = ''
  filters.category = ''
  void fetchQueue(1)
}

function goToPage(targetPage: number): void {
  if (targetPage < 1 || targetPage > pagination.value.pages || loading.value) return
  void fetchQueue(targetPage)
}

function startReview(item: CatalogQualityQueueItemView): void {
  activeReviewProductId.value = item.productId
  reviewErrors[item.productId] = null
  if (reviewNotes[item.productId] === undefined) {
    reviewNotes[item.productId] = item.review?.note ?? ''
  }
}

function cancelReview(productId: number): void {
  if (activeReviewProductId.value === productId) {
    activeReviewProductId.value = null
  }
  reviewErrors[productId] = null
}

function getOrCreateIdempotencyKey(item: CatalogQualityQueueItemView, note: string | null): string {
  const revVer = item.review?.reviewVersion ?? 0
  const intentSlot = `${item.productId}:${item.catalogVersion}:${revVer}:${note ?? ''}`
  const existing = stickyIdempotencyKeys[intentSlot]
  if (existing) return existing
  const generated = `qrev-${item.productId}-v${item.catalogVersion}-r${revVer}-${Date.now().toString(36)}`
  stickyIdempotencyKeys[intentSlot] = generated
  return generated
}

function applyConfirmedReceipt(
  item: CatalogQualityQueueItemView,
  receipt: {
    reviewVersion: number
    reviewedCatalogVersion: number
    score: number
    note: string | null
    reviewedBy: string
    reviewedAt: string
    commandId?: string
  }
): void {
  item.score = receipt.score
  item.penalties = item.penalties.filter((p) => p.group !== 'review')
  item.missingSummary.reviewIssues = 0
  item.review = {
    reviewVersion: receipt.reviewVersion,
    reviewedCatalogVersion: receipt.reviewedCatalogVersion,
    reviewedScore: receipt.score,
    note: receipt.note,
    reviewedBy: receipt.reviewedBy,
    reviewedAt: receipt.reviewedAt,
    commandId: receipt.commandId
  }
  uncertainKeys[item.productId] = null
  reviewErrors[item.productId] = null
  if (activeReviewProductId.value === item.productId) {
    activeReviewProductId.value = null
  }
  emit('reviewed', {
    productId: item.productId,
    reviewVersion: receipt.reviewVersion,
    reviewedAt: receipt.reviewedAt
  })
}

async function verifyUncertainCommand(item: CatalogQualityQueueItemView, idempotencyKey?: string): Promise<boolean> {
  const keyToVerify = idempotencyKey ?? uncertainKeys[item.productId]
  if (!keyToVerify) return false
  reviewBusy[item.productId] = true
  try {
    const res = await fetch(
      `${props.reviewEndpointBase}/${item.productId}/quality-review/commands/${encodeURIComponent(keyToVerify)}`,
      {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }
    )
    if (res.ok) {
      const payload = (await res.json()) as {
        status?: string
        review?: {
          reviewVersion: number
          reviewedCatalogVersion: number
          score: number
          note: string | null
          reviewedBy: string
          reviewedAt: string
          commandId?: string
        }
      }
      if (payload.review) {
        applyConfirmedReceipt(item, payload.review)
        return true
      }
    }
    if (res.status === 404) {
      // Server confirmed the command was never persisted; safe to clear uncertain lock
      uncertainKeys[item.productId] = null
      reviewErrors[item.productId] = 'La revisión no llegó a registrarse. Puedes volver a confirmarla.'
      return false
    }
    uncertainKeys[item.productId] = keyToVerify
    reviewErrors[item.productId] = 'No sabemos si la revisión se guardó. Compruébalo antes de volver a intentarlo.'
    return false
  } catch {
    uncertainKeys[item.productId] = keyToVerify
    reviewErrors[item.productId] = 'No se ha podido comprobar si la revisión se guardó. Pulsa «Comprobar si se guardó».'
    return false
  } finally {
    reviewBusy[item.productId] = false
  }
}

async function confirmReview(item: CatalogQualityQueueItemView): Promise<void> {
  if (reviewBusy[item.productId]) return
  if (uncertainKeys[item.productId]) {
    await verifyUncertainCommand(item)
    return
  }

  const rawNote = (reviewNotes[item.productId] ?? '').trim()
  const note = rawNote.length > 0 ? rawNote : null
  if (note !== null && (note.length < 3 || note.length > 500)) {
    reviewErrors[item.productId] = 'La nota opcional debe tener entre 3 y 500 caracteres.'
    return
  }

  const idempotencyKey = getOrCreateIdempotencyKey(item, note)
  reviewBusy[item.productId] = true
  reviewErrors[item.productId] = null

  try {
    const origin =
      typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'https://neteco.invalid'
    const response = await fetch(`${props.reviewEndpointBase}/${item.productId}/quality-review`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: origin,
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        expectedCatalogVersion: item.catalogVersion,
        expectedReviewVersion: item.review?.reviewVersion ?? 0,
        note
      })
    })

    if (response.ok) {
      const payload = (await response.json()) as {
        review?: {
          reviewVersion: number
          reviewedCatalogVersion: number
          score: number
          note: string | null
          reviewedBy: string
          reviewedAt: string
          commandId?: string
        }
      }
      if (payload.review) {
        applyConfirmedReceipt(item, payload.review)
      }
      return
    }

    if (response.status === 502 || response.status === 503 || response.status === 504) {
      await verifyUncertainCommand(item, idempotencyKey)
      return
    }

    if (response.status === 409) {
      reviewErrors[item.productId] =
        'El producto ha cambiado mientras lo revisabas. Vuelve a cargar la lista antes de revisarlo.'
      return
    }

    reviewErrors[item.productId] = 'No se ha podido guardar la revisión.'
  } catch {
    await verifyUncertainCommand(item, idempotencyKey)
  } finally {
    reviewBusy[item.productId] = false
  }
}

function scoreTone(score: number): 'success' | 'warning' | 'danger' {
  if (score >= 85) return 'success'
  if (score >= 60) return 'warning'
  return 'danger'
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  review: 'En revisión',
  published: 'Publicado',
  hidden: 'Oculto',
  discontinued: 'Descatalogado'
}
const hasFilters = computed(() => Boolean(filters.q.trim() || filters.reason || filters.status || filters.category))

onMounted(() => {
  void fetchQueue(1)
})
</script>

<template>
  <section class="adm-stack" aria-label="Calidad de las fichas del catálogo">
    <div v-if="summary" data-testid="quality-summary" class="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <AdminStat label="Productos revisables" :value="summary.totalEvaluated" icon="i-lucide-package" />
      <AdminStat label="Nota media" :value="`${summary.averageScore} / 100`" icon="i-lucide-gauge" />
      <AdminStat label="Nunca revisados" :value="summary.unreviewedCount" icon="i-lucide-eye-off" />
      <AdminStat label="Con tareas pendientes" :value="summary.needsAttentionCount" icon="i-lucide-list-todo" />
    </div>

    <div class="adm-card adm-tablecard">
      <div class="adm-tablecard__bar">
        <form data-testid="quality-filters" class="adm-toolbar" role="search" @submit.prevent="applyFilters">
          <label class="adm-toolbar__search">
            <span class="sr-only">Buscar por nombre o referencia</span>
            <UIcon name="i-lucide-search" class="size-4" />
            <input
              v-model="filters.q"
              data-testid="quality-filter-q"
              type="search"
              placeholder="Buscar por nombre o referencia…"
              aria-label="Buscar por nombre o referencia"
            />
          </label>

          <select
            v-model="filters.reason"
            data-testid="quality-filter-reason"
            aria-label="Filtrar por lo que falta"
            class="adm-input"
          >
            <option value="">Todo lo que falta</option>
            <option value="mandatory_fields">Datos obligatorios</option>
            <option value="recommended_fields">Datos recomendados</option>
            <option value="typed_attributes">Características</option>
            <option value="images">Imágenes</option>
            <option value="documents">Documentos (ficha técnica o de seguridad)</option>
            <option value="review">Revisión pendiente o caducada</option>
            <option value="unreviewed">Nunca revisados</option>
          </select>

          <select
            v-model="filters.status"
            data-testid="quality-filter-status"
            aria-label="Filtrar por estado del producto"
            class="adm-input"
          >
            <option value="">Todos los estados</option>
            <option value="draft">Borrador</option>
            <option value="review">En revisión</option>
            <option value="published">Publicado</option>
            <option value="hidden">Oculto</option>
            <option value="discontinued">Descatalogado</option>
          </select>

          <select
            v-model="filters.category"
            data-testid="quality-filter-category"
            aria-label="Filtrar por familia"
            class="adm-input"
          >
            <option value="">Todas las familias</option>
            <option v-for="cat in categories" :key="cat.id" :value="cat.slug">
              {{ cat.name }}
            </option>
          </select>

          <div class="adm-toolbar__end">
            <button
              data-testid="quality-filter-reset"
              type="button"
              class="adm-btn adm-btn--ghost adm-btn--sm"
              @click="resetFilters"
            >
              Quitar filtros
            </button>
            <button
              data-testid="quality-filter-submit"
              type="submit"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              @click.prevent="applyFilters"
            >
              Filtrar
            </button>
          </div>
        </form>
      </div>

      <div v-if="loading" data-testid="quality-loading" role="status" class="adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Cargando las fichas…</span>
        <div v-for="row in 6" :key="row"><i /><i /><i /><i /></div>
      </div>

      <div v-else-if="errorMessage" data-testid="quality-error" role="alert">
        <AdminEmptyState variant="error" title="No se han podido cargar los datos" :description="errorMessage">
          <button
            data-testid="quality-retry"
            type="button"
            class="adm-btn adm-btn--secondary"
            @click="fetchQueue(pagination.page)"
          >
            <UIcon name="i-lucide-rotate-cw" class="size-4" />Reintentar
          </button>
        </AdminEmptyState>
      </div>

      <div v-else-if="!hasItems" data-testid="quality-empty">
        <AdminEmptyState
          :variant="hasFilters ? 'filtered' : 'empty'"
          icon="i-lucide-badge-check"
          :title="hasFilters ? 'No hay productos que coincidan con los filtros' : 'No hay fichas pendientes de mejorar'"
          :description="
            hasFilters
              ? 'Prueba con otra búsqueda o quita algún filtro.'
              : 'Cuando a un producto le falten datos, imágenes o documentos aparecerá aquí.'
          "
        />
      </div>

      <template v-else>
        <div class="adm-table-wrap" :aria-busy="loading">
          <table data-testid="quality-table" class="adm-table">
            <thead>
              <tr>
                <th scope="col" style="width: 7rem">Nota</th>
                <th scope="col">Producto</th>
                <th scope="col">Qué le falta</th>
                <th scope="col">Última revisión</th>
                <th scope="col" data-numeric><span class="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in items" :key="item.productId" :data-testid="`quality-row-${item.productId}`">
                <td class="whitespace-nowrap align-top">
                  <AdminBadge :tone="scoreTone(item.score)">{{ item.score }} / 100</AdminBadge>
                  <p class="adm-help mt-1">{{ item.publishable ? 'Se puede publicar' : 'No se puede publicar' }}</p>
                </td>

                <td class="align-top">
                  <p class="font-medium text-[var(--text-strong)]">{{ item.name }}</p>
                  <p class="adm-help">
                    {{ item.sku ?? 'Sin referencia' }} · {{ item.categoryName }} ·
                    {{ STATUS_LABELS[item.status] ?? adminStatusLabel(item.status) }}
                  </p>
                </td>

                <td class="align-top" :data-testid="`quality-penalties-${item.productId}`">
                  <p v-if="item.penalties.length === 0" class="adm-help">Ficha completa</p>
                  <ul v-else class="space-y-1 text-[0.8125rem]">
                    <li v-for="penalty in item.penalties" :key="penalty.code" class="flex items-start gap-2">
                      <UIcon
                        :name="penalty.blocking ? 'i-lucide-circle-x' : 'i-lucide-circle-alert'"
                        class="mt-0.5 size-4 shrink-0"
                        :class="penalty.blocking ? 'text-red-700' : 'text-[var(--text-muted)]'"
                        :aria-label="penalty.blocking ? 'Impide publicar' : 'Recomendado'"
                      />
                      <span>{{ penalty.message }}</span>
                    </li>
                  </ul>
                </td>

                <td class="align-top text-[0.8125rem]">
                  <template v-if="item.review">
                    <p class="text-[var(--text-strong)]">{{ adminDate(item.review.reviewedAt) }}</p>
                    <p v-if="item.review.reviewedCatalogVersion !== item.catalogVersion" class="adm-help">
                      La ficha ha cambiado desde entonces
                    </p>
                    <p v-if="item.review.note" class="adm-help mt-1 italic">«{{ item.review.note }}»</p>
                  </template>
                  <AdminBadge v-else tone="warning">Nunca revisado</AdminBadge>
                </td>

                <td data-numeric class="adm-table__actions align-top">
                  <div class="flex flex-wrap justify-end gap-2">
                    <button
                      :data-testid="`quality-open-${item.productId}`"
                      type="button"
                      class="adm-btn adm-btn--secondary adm-btn--sm"
                      @click="emit('selectProduct', item.productId)"
                    >
                      Abrir ficha
                    </button>
                    <button
                      v-if="canWrite && activeReviewProductId !== item.productId"
                      :data-testid="`quality-review-start-${item.productId}`"
                      type="button"
                      class="adm-btn adm-btn--secondary adm-btn--sm"
                      @click="startReview(item)"
                    >
                      <UIcon name="i-lucide-check" class="size-4" />Marcar como revisado
                    </button>
                  </div>

                  <div
                    v-if="activeReviewProductId === item.productId"
                    :data-testid="`quality-review-form-${item.productId}`"
                    class="mt-3 ml-auto w-full min-w-64 max-w-sm space-y-3 rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--canvas)] p-3 text-left whitespace-normal"
                  >
                    <label class="adm-label block">
                      Nota de la revisión (opcional)
                      <input
                        v-model="reviewNotes[item.productId]"
                        :data-testid="`quality-review-note-${item.productId}`"
                        type="text"
                        maxlength="500"
                        placeholder="Por ejemplo: documentación comprobada"
                        class="adm-input mt-1 w-full font-normal"
                      />
                    </label>

                    <div
                      v-if="uncertainKeys[item.productId]"
                      :data-testid="`quality-review-uncertain-${item.productId}`"
                      role="alert"
                    >
                      <UAlert
                        color="warning"
                        variant="subtle"
                        icon="i-lucide-triangle-alert"
                        :description="reviewErrors[item.productId] ?? undefined"
                      />
                      <button
                        :data-testid="`quality-review-verify-${item.productId}`"
                        type="button"
                        :disabled="reviewBusy[item.productId]"
                        class="adm-btn adm-btn--secondary adm-btn--sm mt-2"
                        @click="verifyUncertainCommand(item)"
                      >
                        Comprobar si se guardó
                      </button>
                    </div>

                    <p v-else-if="reviewErrors[item.productId]" class="adm-field__error" role="alert">
                      {{ reviewErrors[item.productId] }}
                    </p>

                    <div class="flex justify-end gap-2">
                      <button
                        :data-testid="`quality-review-cancel-${item.productId}`"
                        type="button"
                        class="adm-btn adm-btn--secondary adm-btn--sm"
                        @click="cancelReview(item.productId)"
                      >
                        Cancelar
                      </button>
                      <button
                        v-if="!uncertainKeys[item.productId]"
                        :data-testid="`quality-review-confirm-${item.productId}`"
                        type="button"
                        :disabled="reviewBusy[item.productId]"
                        class="adm-btn adm-btn--primary adm-btn--sm"
                        @click="confirmReview(item)"
                      >
                        {{ reviewBusy[item.productId] ? 'Guardando…' : 'Confirmar revisión' }}
                      </button>
                    </div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div data-testid="quality-pagination" class="adm-pagination">
          <p>
            Página {{ pagination.page }} de {{ pagination.pages }} · {{ pagination.total }}
            {{ pagination.total === 1 ? 'producto' : 'productos' }}
          </p>
          <div class="flex items-center gap-2">
            <button
              data-testid="quality-prev-page"
              type="button"
              :disabled="pagination.page <= 1 || loading"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              @click="goToPage(pagination.page - 1)"
            >
              <UIcon name="i-lucide-chevron-left" class="size-4" />Anterior
            </button>
            <button
              data-testid="quality-next-page"
              type="button"
              :disabled="pagination.page >= pagination.pages || loading"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              @click="goToPage(pagination.page + 1)"
            >
              Siguiente<UIcon name="i-lucide-chevron-right" class="size-4" />
            </button>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>
