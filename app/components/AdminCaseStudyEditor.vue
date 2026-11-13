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
const actionError = ref('')

// Estado de interfaz: paneles laterales, confirmación y etiquetas legibles.
const createOpen = computed({
  get: () => view.value === 'create',
  set: (open: boolean) => {
    view.value = open ? 'create' : 'list'
  }
})
const reviewOpen = computed({
  get: () => view.value === 'review' && selectedCase.value !== null,
  set: (open: boolean) => {
    if (!open) view.value = 'list'
  }
})
function openCreate() {
  actionError.value = ''
  view.value = 'create'
}
const caseToPublish = ref<AdminCaseItem | null>(null)
const confirmPublish = computed({
  get: () => caseToPublish.value !== null,
  set: (open: boolean) => {
    if (!open) caseToPublish.value = null
  }
})
async function confirmPublishCase() {
  const item = caseToPublish.value
  caseToPublish.value = null
  if (item) await handlePublish(item)
}
const REVIEW: Record<string, [string, 'success' | 'warning' | 'danger']> = {
  current: ['Al día', 'success'],
  due_soon: ['Vence pronto', 'warning'],
  overdue: ['Vencida', 'danger']
}
const columns = [
  { key: 'title', label: 'Caso', sortable: true },
  { key: 'company', label: 'Cliente', value: (row: AdminCaseItem) => row.signedPermission.companyName },
  { key: 'publicationStatus', label: 'Publicación' },
  { key: 'reviewStatus', label: 'Revisión', hideOnMobile: true }
]

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
  actionError.value = ''
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

    notice.value = 'Caso guardado como borrador.'
    view.value = 'list'
    await fetchAdminCases()
  } catch {
    actionError.value = 'No se ha podido crear el caso. Revisa los datos y vuelve a intentarlo.'
  }
}

const handlePublish = async (c: AdminCaseItem) => {
  notice.value = null
  actionError.value = ''
  try {
    await publishCase(c.id, c.version)
    notice.value = `«${c.title}» ya está publicado.`
    await fetchAdminCases()
  } catch {
    actionError.value = 'No se ha podido publicar el caso. Vuelve a intentarlo.'
  }
}

const openReviewModal = (c: AdminCaseItem) => {
  actionError.value = ''
  selectedCase.value = c
  view.value = 'review'
}

const handleExecuteReview = async () => {
  if (!selectedCase.value || !confirmedPermissionValid.value) return
  notice.value = null
  actionError.value = ''
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
    notice.value = `Revisión renovada para «${selectedCase.value.title}».`
    view.value = 'list'
    selectedCase.value = null
    await fetchAdminCases()
  } catch {
    actionError.value = 'No se ha podido registrar la revisión. Vuelve a intentarlo.'
  }
}
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <AdminButton variant="primary" icon="i-lucide-plus" @click="openCreate">Nuevo caso de cliente</AdminButton>
    </AdminPageActions>

    <UAlert v-if="notice" role="status" color="success" variant="subtle" icon="i-lucide-circle-check" :title="notice" />
    <UAlert
      v-if="actionError && view === 'list'"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="actionError"
    />

    <AdminTable
      :rows="adminCases"
      :columns="columns"
      :row-key="(row) => row.id"
      :status="loading ? 'pending' : error && !adminCases.length ? 'error' : 'success'"
      empty-title="Todavía no hay casos de cliente"
      empty-description="Cuenta cómo ha ayudado NETECO a un cliente, con su permiso firmado y resultados comprobables."
      empty-icon="i-lucide-award"
      caption="Casos de cliente"
      @retry="fetchAdminCases"
    >
      <template #cell-title="{ row }">
        <p class="font-semibold text-[var(--text-strong)]">{{ row.title }}</p>
        <p class="adm-help">/{{ row.slug }}</p>
      </template>
      <template #cell-company="{ row }">
        <p>{{ row.signedPermission.companyName }}</p>
        <p class="adm-help">
          CIF {{ row.signedPermission.companyCif }} · firmado por {{ row.signedPermission.signerName }}
        </p>
      </template>
      <template #cell-publicationStatus="{ row }">
        <AdminBadge :status="row.publicationStatus ?? 'draft'" />
      </template>
      <template #cell-reviewStatus="{ row }">
        <AdminBadge :tone="REVIEW[row.reviewStatus ?? '']?.[1] ?? 'neutral'">
          {{ REVIEW[row.reviewStatus ?? '']?.[0] ?? adminHumanize(row.reviewStatus ?? 'sin revisar') }}
        </AdminBadge>
        <span class="adm-help ml-1">hasta el {{ adminDate(row.nextReviewDueAt) }}</span>
      </template>
      <template #actions="{ row }">
        <AdminButton v-if="row.publicationStatus === 'draft'" size="sm" @click="caseToPublish = row">
          Publicar
        </AdminButton>
        <AdminButton variant="ghost" size="sm" @click="openReviewModal(row)">Renovar revisión</AdminButton>
      </template>
      <template #empty-action>
        <AdminButton icon="i-lucide-plus" @click="openCreate">Nuevo caso de cliente</AdminButton>
      </template>
    </AdminTable>

    <!-- Crear caso -->
    <AdminDrawer v-model:open="createOpen" title="Nuevo caso de cliente" wide>
      <form id="case-study-create-form" class="adm-stack" @submit.prevent="handleCreate">
        <UAlert
          v-if="actionError"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="actionError"
        />
        <fieldset class="adm-stack">
          <legend class="adm-section__title">1. Título y dirección</legend>
          <div class="adm-form-grid">
            <AdminFormField v-slot="{ id }" label="Título" required>
              <input
                :id="id"
                v-model="title"
                data-field="title"
                type="text"
                required
                placeholder="Ej.: un 35 % menos de costes en Lavanderías Turia"
              />
            </AdminFormField>
            <AdminFormField
              v-slot="{ id }"
              label="Dirección de la página"
              help="Solo minúsculas, números y guiones."
              required
            >
              <input
                :id="id"
                v-model="slug"
                data-field="slug"
                type="text"
                required
                pattern="[a-z0-9-]+"
                placeholder="reduccion-costes-lavanderias-turia"
              />
            </AdminFormField>
          </div>
          <AdminFormField v-slot="{ id }" label="Subtítulo">
            <input :id="id" v-model="subtitle" type="text" placeholder="Resumen del reto y de la solución" />
          </AdminFormField>
        </fieldset>

        <fieldset class="adm-stack">
          <legend class="adm-section__title">2. Permiso firmado por el cliente</legend>
          <div class="adm-form-grid">
            <AdminFormField v-slot="{ id }" label="Empresa cliente" required>
              <input
                :id="id"
                v-model="companyName"
                data-field="companyName"
                type="text"
                required
                placeholder="Ej.: Lavanderías Industriales Turia S.L."
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="CIF del cliente" required>
              <input
                :id="id"
                v-model="companyCif"
                data-field="companyCif"
                type="text"
                required
                placeholder="Ej.: B98765432"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Persona que firma" required>
              <input
                :id="id"
                v-model="signerName"
                data-field="signerName"
                type="text"
                required
                placeholder="Ej.: Elena Gómez"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Cargo de quien firma" required>
              <input
                :id="id"
                v-model="signerRole"
                data-field="signerRole"
                type="text"
                required
                placeholder="Ej.: directora de operaciones"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Referencia del documento" required>
              <input
                :id="id"
                v-model="documentRef"
                data-field="documentRef"
                type="text"
                required
                placeholder="Ej.: autorización Turia 2026-01"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Fecha de firma" required>
              <input :id="id" v-model="signedDate" data-field="signedDate" type="date" required />
            </AdminFormField>
          </div>
          <AdminFormField
            v-slot="{ id }"
            label="Huella digital del documento"
            help="Código de 64 caracteres que identifica el fichero firmado."
            required
          >
            <input
              :id="id"
              v-model="documentSha256"
              data-field="documentSha256"
              type="text"
              required
              pattern="[0-9a-fA-F]{64}"
              class="w-full font-mono"
            />
          </AdminFormField>
          <label class="adm-check">
            <input v-model="publishAuthorized" data-field="publishAuthorized" type="checkbox" />
            El cliente ha autorizado expresamente publicar el caso y sus resultados.
          </label>
        </fieldset>

        <fieldset class="adm-stack">
          <legend class="adm-section__title">3. Situación, solución y resultados</legend>
          <div class="adm-form-grid">
            <AdminFormField v-slot="{ id }" label="Sector" required>
              <input :id="id" v-model="sector" type="text" required />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Descripción de la instalación" required>
              <input
                :id="id"
                v-model="facilityDescription"
                data-field="facilityDescription"
                type="text"
                required
                minlength="5"
              />
            </AdminFormField>
          </div>
          <AdminFormField
            v-slot="{ id }"
            label="Productos NETECO utilizados"
            help="Referencias separadas por comas."
            required
          >
            <input :id="id" v-model="netecoProductsInput" type="text" required class="w-full" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Situación inicial" required>
            <textarea
              :id="id"
              v-model="initialSituation"
              data-field="initialSituation"
              required
              rows="2"
              class="w-full"
            ></textarea>
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Cómo se dosifica" required>
            <input :id="id" v-model="dosageProtocol" data-field="dosageProtocol" type="text" required class="w-full" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Resumen de la solución" required>
            <textarea
              :id="id"
              v-model="solutionSummary"
              data-field="solutionSummary"
              required
              rows="2"
              class="w-full"
            ></textarea>
          </AdminFormField>
        </fieldset>

        <fieldset class="adm-stack">
          <legend class="adm-section__title">4. Resultado comprobable</legend>
          <AdminFormField v-slot="{ id }" label="Qué se ha medido">
            <input :id="id" v-model="outcomeMetricName" class="w-full" />
          </AdminFormField>
          <div class="adm-form-grid">
            <AdminFormField v-slot="{ id }" label="Antes">
              <input :id="id" v-model="outcomeBefore" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Después">
              <input :id="id" v-model="outcomeAfter" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Unidad">
              <input :id="id" v-model="outcomeUnit" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Mejora (%)">
              <input :id="id" v-model.number="outcomeImprovement" type="number" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Quién lo ha comprobado">
              <input :id="id" v-model="verifierIdentity" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Cómo se ha medido">
              <input :id="id" v-model="verificationMethod" />
            </AdminFormField>
          </div>
          <AdminFormField
            v-slot="{ id }"
            label="Huella digital de la prueba"
            help="Código de 64 caracteres del informe o fichero que demuestra el resultado."
            required
          >
            <input
              :id="id"
              v-model="evidenceSha256"
              data-field="evidenceSha256"
              required
              pattern="[0-9a-fA-F]{64}"
              class="w-full font-mono"
            />
          </AdminFormField>
        </fieldset>
      </form>
      <template #footer>
        <AdminButton @click="view = 'list'">Cancelar</AdminButton>
        <button type="submit" form="case-study-create-form" :disabled="saving" class="adm-btn adm-btn--primary">
          Guardar borrador
        </button>
      </template>
    </AdminDrawer>

    <!-- Renovar revisión -->
    <AdminDrawer v-model:open="reviewOpen" title="Renovar la revisión del caso" :description="selectedCase?.title">
      <form id="case-study-review-form" class="adm-stack" @submit.prevent="handleExecuteReview">
        <UAlert
          v-if="actionError"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="actionError"
        />
        <p class="adm-help">
          Cada caso se revisa cada cierto tiempo para confirmar que el permiso y los datos siguen siendo correctos. Si
          pasa la fecha sin renovarlo, deja de mostrarse en la tienda.
        </p>
        <AdminFormField v-slot="{ id }" label="Notas de la revisión" required>
          <textarea :id="id" v-model="reviewNotes" required rows="3" class="w-full"></textarea>
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Volver a revisar dentro de">
          <select :id="id" v-model.number="nextReviewInterval">
            <option :value="3">3 meses</option>
            <option :value="6">6 meses</option>
            <option :value="12">1 año</option>
            <option :value="24">2 años</option>
          </select>
        </AdminFormField>
        <label class="adm-check">
          <input v-model="confirmedPermissionValid" type="checkbox" required />
          He hablado con el cliente y confirmo que el permiso firmado y los resultados siguen en vigor.
        </label>
      </form>
      <template #footer>
        <AdminButton @click="view = 'list'">Cancelar</AdminButton>
        <button type="submit" form="case-study-review-form" :disabled="saving" class="adm-btn adm-btn--primary">
          Confirmar revisión
        </button>
      </template>
    </AdminDrawer>

    <AdminConfirm
      v-model:open="confirmPublish"
      title="Publicar caso de cliente"
      :description="`«${caseToPublish?.title ?? ''}» se mostrará en la tienda.`"
      confirm-label="Publicar"
      @confirm="confirmPublishCase"
    />
  </div>
</template>
