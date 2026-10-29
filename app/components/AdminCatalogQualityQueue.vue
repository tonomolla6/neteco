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
          ? 'No tienes permisos suficientes para consultar la cola de calidad de catálogo.'
          : 'No se ha podido cargar la cola de calidad del catálogo. Inténtalo de nuevo.'
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
    errorMessage.value = 'Error de red al consultar la cola de calidad del catálogo.'
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
    reviewErrors[item.productId] =
      'Respuesta incierta del servidor. Verifica el estado antes de reintentar para evitar duplicados.'
    return false
  } catch {
    uncertainKeys[item.productId] = keyToVerify
    reviewErrors[item.productId] = 'No se pudo verificar el estado de la revisión. Usa "Verificar estado sin reenviar".'
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
      reviewErrors[item.productId] = 'El producto ha cambiado de versión. Recarga la cola antes de revisar.'
      return
    }

    reviewErrors[item.productId] = 'No se ha podido registrar la revisión de calidad.'
  } catch {
    await verifyUncertainCommand(item, idempotencyKey)
  } finally {
    reviewBusy[item.productId] = false
  }
}

function scoreBadgeClass(score: number): string {
  if (score >= 85) return 'bg-emerald-100 text-emerald-800 border-emerald-300'
  if (score >= 60) return 'bg-amber-100 text-amber-800 border-amber-300'
  return 'bg-red-100 text-red-800 border-red-300'
}

function formatReviewDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10)
  } catch {
    return iso
  }
}

onMounted(() => {
  void fetchQueue(1)
})
</script>

<template>
  <section class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" aria-label="Cola de calidad de catálogo">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold text-slate-900">Calidad de catálogo y cola de revisión</h2>
        <p class="text-sm text-slate-600">
          Priorización por campos, documentos e imágenes faltantes y antigüedad de última revisión.
        </p>
      </div>
    </div>

    <div v-if="summary" data-testid="quality-summary" class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <div class="text-xs font-medium text-slate-500">Productos evaluados</div>
        <div class="mt-1 text-xl font-bold text-slate-900">{{ summary.totalEvaluated }}</div>
      </div>
      <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <div class="text-xs font-medium text-slate-500">Score medio</div>
        <div class="mt-1 text-xl font-bold text-slate-900">{{ summary.averageScore }} / 100</div>
      </div>
      <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <div class="text-xs font-medium text-slate-500">Nunca revisados</div>
        <div class="mt-1 text-xl font-bold text-amber-700">{{ summary.unreviewedCount }}</div>
      </div>
      <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <div class="text-xs font-medium text-slate-500">Con tareas pendientes</div>
        <div class="mt-1 text-xl font-bold text-red-700">{{ summary.needsAttentionCount }}</div>
      </div>
    </div>

    <form
      data-testid="quality-filters"
      class="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-5"
      @submit.prevent="applyFilters"
    >
      <input
        v-model="filters.q"
        data-testid="quality-filter-q"
        type="search"
        placeholder="Buscar por nombre o SKU…"
        aria-label="Buscar por nombre o SKU"
        class="rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />

      <select
        v-model="filters.reason"
        data-testid="quality-filter-reason"
        aria-label="Filtrar por motivo de calidad"
        class="rounded-lg border border-slate-300 px-3 py-2 text-sm"
      >
        <option value="">Todos los motivos</option>
        <option value="mandatory_fields">Campos obligatorios</option>
        <option value="recommended_fields">Campos recomendados</option>
        <option value="typed_attributes">Atributos tipados</option>
        <option value="images">Imágenes y derechos</option>
        <option value="documents">Documentos (Ficha / FDS)</option>
        <option value="review">Revisión pendiente o caducada</option>
        <option value="unreviewed">Nunca revisados</option>
      </select>

      <select
        v-model="filters.status"
        data-testid="quality-filter-status"
        aria-label="Filtrar por estado editorial"
        class="rounded-lg border border-slate-300 px-3 py-2 text-sm"
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
        aria-label="Filtrar por categoría"
        class="rounded-lg border border-slate-300 px-3 py-2 text-sm"
      >
        <option value="">Todas las categorías</option>
        <option v-for="cat in categories" :key="cat.id" :value="cat.slug">
          {{ cat.name }}
        </option>
      </select>

      <div class="flex items-center gap-2">
        <button
          data-testid="quality-filter-submit"
          type="submit"
          class="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
          @click.prevent="applyFilters"
        >
          Filtrar
        </button>
        <button
          data-testid="quality-filter-reset"
          type="button"
          class="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
          @click="resetFilters"
        >
          Limpiar
        </button>
      </div>
    </form>

    <div
      v-if="loading"
      data-testid="quality-loading"
      role="status"
      class="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-600"
    >
      Cargando cola de calidad de catálogo…
    </div>

    <div
      v-else-if="errorMessage"
      data-testid="quality-error"
      role="alert"
      class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
    >
      <p class="font-medium">{{ errorMessage }}</p>
      <button
        data-testid="quality-retry"
        type="button"
        class="mt-2 rounded-md bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800"
        @click="fetchQueue(pagination.page)"
      >
        Reintentar carga
      </button>
    </div>

    <div
      v-else-if="!hasItems"
      data-testid="quality-empty"
      class="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-600"
    >
      No hay productos que coincidan con los filtros de calidad seleccionados.
    </div>

    <div v-else class="overflow-x-auto">
      <table data-testid="quality-table" class="min-w-full divide-y divide-slate-200 text-sm">
        <thead class="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-600">
          <tr>
            <th class="px-3 py-2">Score</th>
            <th class="px-3 py-2">Producto</th>
            <th class="px-3 py-2">Incidencias / Faltantes</th>
            <th class="px-3 py-2">Última revisión</th>
            <th class="px-3 py-2 text-right">Acciones</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-200">
          <tr
            v-for="item in items"
            :key="item.productId"
            :data-testid="`quality-row-${item.productId}`"
            class="align-top"
          >
            <td class="px-3 py-3 whitespace-nowrap">
              <span
                class="inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-bold"
                :class="scoreBadgeClass(item.score)"
              >
                {{ item.score }} / 100
              </span>
              <div class="mt-1 text-xs text-slate-500">
                {{ item.publishable ? 'Apto publicación' : 'Bloqueado' }}
              </div>
            </td>

            <td class="px-3 py-3">
              <div class="font-medium text-slate-900">{{ item.name }}</div>
              <div class="text-xs text-slate-500">
                SKU: {{ item.sku ?? 'Sin SKU' }} · {{ item.categoryName }} · Estado: {{ item.status }} · v{{
                  item.catalogVersion
                }}
              </div>
            </td>

            <td class="px-3 py-3" :data-testid="`quality-penalties-${item.productId}`">
              <div v-if="item.penalties.length === 0" class="text-xs text-emerald-700">Sin brechas detectadas</div>
              <ul v-else class="space-y-1 text-xs">
                <li v-for="penalty in item.penalties" :key="penalty.code" class="flex items-start gap-1.5">
                  <span
                    class="rounded px-1.5 py-0.5 font-mono text-[11px]"
                    :class="penalty.blocking ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'"
                  >
                    -{{ penalty.weight }} · {{ penalty.code }}
                  </span>
                  <span class="text-slate-700">{{ penalty.message }}</span>
                </li>
              </ul>
            </td>

            <td class="px-3 py-3 text-xs text-slate-700">
              <template v-if="item.review">
                <div class="font-medium">Revisado: {{ formatReviewDate(item.review.reviewedAt) }}</div>
                <div class="text-slate-500">
                  Versión revisada: v{{ item.review.reviewedCatalogVersion }} (rev #{{ item.review.reviewVersion }})
                </div>
                <div v-if="item.review.note" class="mt-1 italic text-slate-600">"{{ item.review.note }}"</div>
              </template>
              <span v-else class="font-medium text-amber-700">Nunca revisado</span>
            </td>

            <td class="px-3 py-3 text-right">
              <div class="flex flex-wrap justify-end gap-2">
                <button
                  :data-testid="`quality-open-${item.productId}`"
                  type="button"
                  class="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  @click="emit('selectProduct', item.productId)"
                >
                  Abrir ficha
                </button>
                <button
                  v-if="canWrite && activeReviewProductId !== item.productId"
                  :data-testid="`quality-review-start-${item.productId}`"
                  type="button"
                  class="rounded bg-emerald-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-800"
                  @click="startReview(item)"
                >
                  Marcar revisado
                </button>
              </div>

              <div
                v-if="activeReviewProductId === item.productId"
                :data-testid="`quality-review-form-${item.productId}`"
                class="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-left"
              >
                <label class="block text-xs font-medium text-slate-700">
                  Nota de revisión (opcional)
                  <input
                    v-model="reviewNotes[item.productId]"
                    :data-testid="`quality-review-note-${item.productId}`"
                    type="text"
                    maxlength="500"
                    placeholder="Ej.: Documentación verificada…"
                    class="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                  />
                </label>

                <div
                  v-if="uncertainKeys[item.productId]"
                  :data-testid="`quality-review-uncertain-${item.productId}`"
                  role="alert"
                  class="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
                >
                  <p>{{ reviewErrors[item.productId] }}</p>
                  <button
                    :data-testid="`quality-review-verify-${item.productId}`"
                    type="button"
                    :disabled="reviewBusy[item.productId]"
                    class="mt-1.5 rounded bg-amber-800 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-900 disabled:opacity-50"
                    @click="verifyUncertainCommand(item)"
                  >
                    Verificar estado sin reenviar
                  </button>
                </div>

                <p v-else-if="reviewErrors[item.productId]" class="mt-1.5 text-xs text-red-700" role="alert">
                  {{ reviewErrors[item.productId] }}
                </p>

                <div class="mt-2 flex justify-end gap-2">
                  <button
                    :data-testid="`quality-review-cancel-${item.productId}`"
                    type="button"
                    class="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
                    @click="cancelReview(item.productId)"
                  >
                    Cancelar
                  </button>
                  <button
                    v-if="!uncertainKeys[item.productId]"
                    :data-testid="`quality-review-confirm-${item.productId}`"
                    type="button"
                    :disabled="reviewBusy[item.productId]"
                    class="rounded bg-emerald-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
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

      <div
        data-testid="quality-pagination"
        class="mt-4 flex items-center justify-between border-t border-slate-200 pt-3 text-xs text-slate-600"
      >
        <div>Página {{ pagination.page }} de {{ pagination.pages }} ({{ pagination.total }} productos)</div>
        <div class="flex items-center gap-2">
          <button
            data-testid="quality-prev-page"
            type="button"
            :disabled="pagination.page <= 1 || loading"
            class="rounded border border-slate-300 px-2.5 py-1 disabled:opacity-50"
            @click="goToPage(pagination.page - 1)"
          >
            Anterior
          </button>
          <button
            data-testid="quality-next-page"
            type="button"
            :disabled="pagination.page >= pagination.pages || loading"
            class="rounded border border-slate-300 px-2.5 py-1 disabled:opacity-50"
            @click="goToPage(pagination.page + 1)"
          >
            Siguiente
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
