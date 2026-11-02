<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useCustomerCaseStudies } from '../composables/useCustomerCaseStudies'

const {
  adminCases: rawAdminCases,
  loading,
  saving,
  error,
  fetchAdminCases,
  createCase,
  publishCase,
  performReview
} = useCustomerCaseStudies()

interface AdminCaseItem {
  id: string
  version: number
  title: string
  slug: string
  publicationStatus?: string
  reviewStatus?: string
  nextReviewDueAt: string
  signedPermission: {
    companyName: string
    companyCif: string
    signerName: string
  }
  [key: string]: unknown
}

function isAdminCaseItem(c: Record<string, unknown>): c is AdminCaseItem {
  return (
    typeof c.id === 'string' &&
    typeof c.version === 'number' &&
    typeof c.title === 'string' &&
    typeof c.slug === 'string'
  )
}

const adminCases = computed<AdminCaseItem[]>(() => rawAdminCases.value.filter(isAdminCaseItem))

const view = ref<'list' | 'create' | 'review'>('list')
const selectedCase = ref<AdminCaseItem | null>(null)
const notice = ref<string | null>(null)

// Form fields
const title = ref('')
const subtitle = ref('')
const slug = ref('')
const signerName = ref('')
const signerRole = ref('')
const companyName = ref('')
const companyCif = ref('')
const documentRef = ref('')
const documentSha256 = ref('')
const signedDate = ref('')
const publishAuthorized = ref(false)
const sector = ref('Lavandería Industrial')
const facilityDescription = ref('')
const initialSituation = ref('')
const netecoProductsInput = ref('NET-LAV-OXIGEN, NET-ACID-NEUTRA')
const dosageProtocol = ref('')
const implementationWeeks = ref(3)
const solutionSummary = ref('')
const outcomeMetricName = ref('Ahorro económico mensual')
const outcomeBefore = ref('5000')
const outcomeAfter = ref('3500')
const outcomeUnit = ref('EUR/mes')
const outcomeImprovement = ref(30)
const verificationMethod = ref('Auditoría gravimétrica ISO 2267 y conciliación de facturas')
const verifierIdentity = ref('Instituto Tecnológico Textil Levante')
const evidenceSha256 = ref('')
const reviewIntervalMonths = ref<3 | 6 | 12 | 24>(12)
// One id per creation attempt: a retry after an ambiguous failure replays, a new case gets a new id.
const createCommandId = ref(crypto.randomUUID())
const reviewCommandId = ref(crypto.randomUUID())

// Review command form
const reviewNotes = ref('Revisión periódica anual efectuada con el cliente; condiciones y métricas vigentes.')
const confirmedPermissionValid = ref(false)
const nextReviewInterval = ref<3 | 6 | 12 | 24>(12)

onMounted(() => {
  fetchAdminCases()
})

const handleCreate = async () => {
  notice.value = null
  try {
    const netecoProducts = netecoProductsInput.value
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    const outcomeMetrics = [
      {
        metric: outcomeMetricName.value,
        before: outcomeBefore.value,
        after: outcomeAfter.value,
        unit: outcomeUnit.value,
        improvementPercent: Number(outcomeImprovement.value)
      }
    ]

    await createCase({
      title: title.value,
      subtitle: subtitle.value || undefined,
      slug: slug.value,
      signedPermission: {
        signerName: signerName.value,
        signerRole: signerRole.value,
        companyName: companyName.value,
        companyCif: companyCif.value,
        documentRef: documentRef.value,
        documentSha256: documentSha256.value.trim(),
        // Date of the signed document, entered by the operator (never the browser clock).
        signedAt: `${signedDate.value}T00:00:00Z`,
        scope: 'full_case_study_and_metrics',
        publishAuthorized: publishAuthorized.value
      },
      context: {
        sector: sector.value,
        facilityDescription: facilityDescription.value,
        initialSituation: initialSituation.value,
        baselineMetrics: []
      },
      solution: {
        netecoProducts,
        dosageProtocol: dosageProtocol.value,
        implementationDurationWeeks: Number(implementationWeeks.value),
        solutionSummary: solutionSummary.value
      },
      verifiableOutcome: {
        outcomeMetrics,
        verificationMethod: verificationMethod.value,
        verifierIdentity: verifierIdentity.value,
        evidenceSha256: evidenceSha256.value
      },
      reviewIntervalMonths: Number(reviewIntervalMonths.value) as 3 | 6 | 12 | 24,
      commandId: createCommandId.value
    })
    createCommandId.value = crypto.randomUUID()

    notice.value = 'Borrador de caso de estudio creado exitosamente.'
    view.value = 'list'
    await fetchAdminCases()
  } catch (e: unknown) {
    alert('Error al crear el caso: ' + (e instanceof Error ? e.message : 'error desconocido'))
  }
}

const handlePublish = async (c: AdminCaseItem) => {
  if (!confirm(`¿Publicar caso "${c.title}" en la tienda online?`)) return
  notice.value = null
  try {
    await publishCase(c.id, c.version)
    notice.value = `Caso "${c.title}" publicado con éxito.`
    await fetchAdminCases()
  } catch (e: unknown) {
    alert('No se pudo publicar: ' + (e instanceof Error ? e.message : 'error desconocido'))
  }
}

const openReviewModal = (c: AdminCaseItem) => {
  selectedCase.value = c
  view.value = 'review'
}

const handleExecuteReview = async () => {
  if (!selectedCase.value || !confirmedPermissionValid.value) return
  notice.value = null
  try {
    await performReview({
      caseId: selectedCase.value.id,
      reviewNotes: reviewNotes.value,
      confirmedPermissionValid: confirmedPermissionValid.value,
      nextReviewIntervalMonths: Number(nextReviewInterval.value) as 3 | 6 | 12 | 24,
      expectedVersion: selectedCase.value.version,
      commandId: reviewCommandId.value
    })
    reviewCommandId.value = crypto.randomUUID()
    notice.value = `Revisión periódica completada para "${selectedCase.value.title}". Vigencia renovada.`
    view.value = 'list'
    selectedCase.value = null
    await fetchAdminCases()
  } catch (e: unknown) {
    alert('Error al registrar revisión: ' + (e instanceof Error ? e.message : 'error desconocido'))
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-4 border-b border-gray-200 pb-4 dark:border-gray-800">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
          Gestión de Casos de Éxito de Clientes (MED-020 & MKT-031)
        </h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Permisos firmados, contexto operativo, dosificación, resultados auditables y revisión periódica de vigencia.
        </p>
      </div>

      <div class="flex gap-2">
        <button
          v-if="view !== 'list'"
          type="button"
          class="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
          @click="view = 'list'"
        >
          Volver a la lista
        </button>
        <button
          v-if="view === 'list'"
          type="button"
          class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-emerald-700"
          @click="view = 'create'"
        >
          + Nuevo caso de cliente
        </button>
      </div>
    </div>

    <div
      v-if="notice"
      role="status"
      class="rounded-lg bg-emerald-50 p-4 text-sm font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
    >
      {{ notice }}
    </div>
    <div
      v-if="error"
      role="alert"
      class="rounded-lg bg-rose-50 p-4 text-sm font-medium text-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
    >
      {{ error }}
    </div>

    <!-- VISTA LISTA -->
    <div v-if="view === 'list'" class="space-y-4">
      <div v-if="loading" role="status" class="py-12 text-center text-sm text-gray-500">Cargando casos…</div>

      <div
        v-else-if="adminCases.length === 0"
        class="rounded-xl border border-dashed border-gray-300 py-12 text-center dark:border-gray-800"
      >
        <p class="text-sm font-medium text-gray-600 dark:text-gray-400">No hay casos de cliente registrados.</p>
      </div>

      <div
        v-else
        class="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900"
      >
        <table class="w-full text-left text-sm">
          <thead class="border-b bg-gray-50 text-xs font-semibold uppercase text-gray-500 dark:bg-gray-800">
            <tr>
              <th class="p-4">Título / Slug</th>
              <th class="p-4">Empresa / CIF</th>
              <th class="p-4">Estado Publicación</th>
              <th class="p-4">Revisión Periódica</th>
              <th class="p-4 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
            <tr v-for="c in adminCases" :key="c.id" class="hover:bg-gray-50/50 dark:hover:bg-gray-800/50">
              <td class="p-4">
                <div class="font-bold text-gray-900 dark:text-gray-100">{{ c.title }}</div>
                <div class="text-xs text-gray-500 font-mono">{{ c.slug }}</div>
              </td>
              <td class="p-4">
                <div class="font-medium">{{ c.signedPermission.companyName }}</div>
                <div class="text-xs text-gray-500">
                  CIF: {{ c.signedPermission.companyCif }} &bull; Firmado: {{ c.signedPermission.signerName }}
                </div>
              </td>
              <td class="p-4">
                <span
                  class="rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize"
                  :class="{
                    'bg-yellow-100 text-yellow-800': c.publicationStatus === 'draft',
                    'bg-emerald-100 text-emerald-800': c.publicationStatus === 'published',
                    'bg-gray-100 text-gray-800': c.publicationStatus === 'archived'
                  }"
                >
                  {{ c.publicationStatus }}
                </span>
              </td>
              <td class="p-4">
                <span
                  class="rounded-full px-2.5 py-0.5 text-xs font-semibold"
                  :class="{
                    'bg-emerald-100 text-emerald-800': c.reviewStatus === 'current',
                    'bg-yellow-100 text-yellow-800': c.reviewStatus === 'due_soon',
                    'bg-rose-100 text-rose-800': c.reviewStatus === 'overdue'
                  }"
                >
                  {{ c.reviewStatus }}
                </span>
                <div class="mt-1 text-[11px] text-gray-500">Vence: {{ c.nextReviewDueAt.split('T')[0] }}</div>
              </td>
              <td class="p-4 text-right space-x-2">
                <button
                  v-if="c.publicationStatus === 'draft'"
                  type="button"
                  class="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white shadow hover:bg-emerald-700"
                  @click="handlePublish(c)"
                >
                  Publicar
                </button>
                <button
                  type="button"
                  class="rounded border border-gray-300 px-3 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300"
                  @click="openReviewModal(c)"
                >
                  Revisión periódica
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- VISTA FORMULARIO CREAR -->
    <div
      v-else-if="view === 'create'"
      class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900"
    >
      <h2 class="text-lg font-bold text-gray-900 dark:text-gray-100">Crear caso de cliente con evidencia</h2>
      <form class="mt-6 space-y-6" @submit.prevent="handleCreate">
        <fieldset class="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <legend class="px-2 text-xs font-bold uppercase text-gray-600 dark:text-gray-400">
            1. Datos Editoriales
          </legend>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">Título</label>
              <input
                v-model="title"
                data-field="title"
                type="text"
                required
                class="mt-1 block w-full rounded border p-2 text-sm"
                placeholder="Ej: Reducción del 35% de costes en Lavanderías Turia"
              />
            </div>
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">Slug (URL amigable)</label>
              <input
                v-model="slug"
                data-field="slug"
                type="text"
                required
                pattern="[a-z0-9-]+"
                class="mt-1 block w-full rounded border p-2 text-sm font-mono"
                placeholder="ej: reduccion-costes-lavanderias-turia"
              />
            </div>
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">Subtítulo</label>
            <input
              v-model="subtitle"
              type="text"
              class="mt-1 block w-full rounded border p-2 text-sm"
              placeholder="Resumen del reto y tecnología"
            />
          </div>
        </fieldset>

        <fieldset class="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <legend class="px-2 text-xs font-bold uppercase text-gray-600 dark:text-gray-400">
            2. Permiso Firmado por el Cliente (MED-020)
          </legend>
          <div class="grid gap-4 sm:grid-cols-3">
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">Empresa Cliente</label>
              <input
                v-model="companyName"
                data-field="companyName"
                type="text"
                required
                class="mt-1 block w-full rounded border p-2 text-sm"
                placeholder="Ej: Lavanderías Industriales Turia S.L."
              />
            </div>
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">CIF Cliente</label>
              <input
                v-model="companyCif"
                data-field="companyCif"
                type="text"
                required
                class="mt-1 block w-full rounded border p-2 text-sm"
                placeholder="Ej: B98765432"
              />
            </div>
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">Firmante Autorizado</label>
              <input
                v-model="signerName"
                data-field="signerName"
                type="text"
                required
                class="mt-1 block w-full rounded border p-2 text-sm"
                placeholder="Ej: Elena Gómez"
              />
            </div>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">Cargo del Firmante</label>
              <input
                v-model="signerRole"
                data-field="signerRole"
                type="text"
                required
                class="mt-1 block w-full rounded border p-2 text-sm"
                placeholder="Ej: Directora de Operaciones"
              />
            </div>
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">Referencia Documental</label>
              <input
                v-model="documentRef"
                data-field="documentRef"
                type="text"
                required
                class="mt-1 block w-full rounded border p-2 text-sm"
                placeholder="Ej: DOC-AUTH-TURIA-2026-01"
              />
            </div>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">Fecha de firma</label>
              <input
                v-model="signedDate"
                data-field="signedDate"
                type="date"
                required
                class="mt-1 block w-full rounded border p-2 text-sm"
              />
            </div>
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">SHA-256 del documento</label>
              <input
                v-model="documentSha256"
                data-field="documentSha256"
                type="text"
                required
                pattern="[0-9a-fA-F]{64}"
                class="mt-1 block w-full rounded border p-2 font-mono text-sm"
              />
            </div>
          </div>
          <label class="flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-300">
            <input
              v-model="publishAuthorized"
              data-field="publishAuthorized"
              type="checkbox"
              class="h-4 w-4 rounded border-gray-300 text-emerald-600"
            />
            El cliente ha autorizado expresamente la publicación del caso y los resultados técnicos (MKT-031).
          </label>
        </fieldset>

        <fieldset class="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <legend class="px-2 text-xs font-bold uppercase text-gray-600 dark:text-gray-400">
            3. Contexto, Solución y Métricas Verificables
          </legend>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">Sector Industrial</label>
              <input v-model="sector" type="text" required class="mt-1 block w-full rounded border p-2 text-sm" />
            </div>
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300"
                >Descripción de la instalación</label
              >
              <input
                v-model="facilityDescription"
                data-field="facilityDescription"
                type="text"
                required
                minlength="5"
                class="mt-1 block w-full rounded border p-2 text-sm"
              />
            </div>
            <div>
              <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300"
                >Productos Neteco (separados por coma)</label
              >
              <input
                v-model="netecoProductsInput"
                type="text"
                required
                class="mt-1 block w-full rounded border p-2 text-sm"
              />
            </div>
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">Situación inicial</label>
            <textarea
              v-model="initialSituation"
              data-field="initialSituation"
              required
              rows="2"
              class="mt-1 block w-full rounded border p-2 text-sm"
            ></textarea>
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300"
              >Protocolo de dosificación</label
            >
            <input
              v-model="dosageProtocol"
              data-field="dosageProtocol"
              type="text"
              required
              class="mt-1 block w-full rounded border p-2 text-sm"
            />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">Resumen de la solución</label>
            <textarea
              v-model="solutionSummary"
              data-field="solutionSummary"
              required
              rows="2"
              class="mt-1 block w-full rounded border p-2 text-sm"
            ></textarea>
          </div>

          <div class="border-t pt-3 space-y-3">
            <h4 class="text-xs font-bold text-gray-700 dark:text-gray-300">Métrica clave verificable</h4>
            <div class="grid gap-3 sm:grid-cols-5">
              <input v-model="outcomeMetricName" placeholder="Métrica" class="rounded border p-2 text-xs" />
              <input v-model="outcomeBefore" placeholder="Antes" class="rounded border p-2 text-xs" />
              <input v-model="outcomeAfter" placeholder="Después" class="rounded border p-2 text-xs" />
              <input v-model="outcomeUnit" placeholder="Unidad" class="rounded border p-2 text-xs" />
              <input
                v-model.number="outcomeImprovement"
                type="number"
                placeholder="Mejora %"
                class="rounded border p-2 text-xs"
              />
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <input
                v-model="verifierIdentity"
                placeholder="Entidad auditora / inspector"
                class="rounded border p-2 text-xs"
              />
              <input
                v-model="verificationMethod"
                placeholder="Método de ensayo / medición"
                class="rounded border p-2 text-xs"
              />
              <input
                v-model="evidenceSha256"
                data-field="evidenceSha256"
                placeholder="SHA-256 de la evidencia"
                required
                pattern="[0-9a-fA-F]{64}"
                class="rounded border p-2 font-mono text-xs sm:col-span-2"
              />
            </div>
          </div>
        </fieldset>

        <div class="flex justify-end gap-3">
          <button type="button" class="rounded border px-4 py-2 text-sm text-gray-700" @click="view = 'list'">
            Cancelar
          </button>
          <button
            type="submit"
            :disabled="saving"
            class="rounded bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow hover:bg-emerald-700 disabled:opacity-50"
          >
            Guardar borrador
          </button>
        </div>
      </form>
    </div>

    <!-- VISTA REVISIÓN PERIÓDICA -->
    <div
      v-else-if="view === 'review' && selectedCase"
      class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900"
    >
      <h2 class="text-lg font-bold text-gray-900 dark:text-gray-100">
        Revisión Periódica de Vigencia: {{ selectedCase.title }}
      </h2>
      <p class="mt-1 text-xs text-gray-500">
        Conforme al requisito MED-020, los casos de cliente deben revalidarse periódicamente para confirmar que el
        permiso y los datos se mantienen exactos. Si vence el plazo, el caso se oculta automáticamente de la web
        pública.
      </p>

      <form class="mt-6 space-y-4" @submit.prevent="handleExecuteReview">
        <div>
          <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300">Notas de la revisión</label>
          <textarea
            v-model="reviewNotes"
            required
            rows="3"
            class="mt-1 block w-full rounded border p-2 text-sm"
          ></textarea>
        </div>

        <div>
          <label class="block text-xs font-semibold text-gray-700 dark:text-gray-300"
            >Próximo intervalo de revisión</label
          >
          <select v-model.number="nextReviewInterval" class="mt-1 block w-48 rounded border p-2 text-sm">
            <option :value="3">3 meses</option>
            <option :value="6">6 meses</option>
            <option :value="12">12 meses (1 año)</option>
            <option :value="24">24 meses (2 años)</option>
          </select>
        </div>

        <label class="flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-300">
          <input
            v-model="confirmedPermissionValid"
            type="checkbox"
            required
            class="h-4 w-4 rounded border-gray-300 text-emerald-600"
          />
          He contactado con el cliente y confirmo que el permiso firmado y las métricas continúan en vigor.
        </label>

        <div class="flex justify-end gap-3 pt-4">
          <button type="button" class="rounded border px-4 py-2 text-sm text-gray-700" @click="view = 'list'">
            Cancelar
          </button>
          <button
            type="submit"
            :disabled="saving"
            class="rounded bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow hover:bg-emerald-700 disabled:opacity-50"
          >
            Confirmar revisión periódica
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
