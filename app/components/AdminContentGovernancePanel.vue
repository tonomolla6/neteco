<script setup lang="ts">
/** Revisión de contenidos: calendario de revisión, autores y revisores, y recursos enlazables. */
import { computed, ref, onMounted } from 'vue'

interface Person {
  id: string
  displayName: string
  status: string
  version: number
}
interface Plan {
  slug: string
  ownerName: string
  sensitivity: 'regulation' | 'product' | 'general'
  nextReviewAt: string
  bucket: 'overdue' | 'due_30' | 'scheduled'
  authorId: string | null
  reviewerId: string | null
  sources: Array<{ label: string; url: string; kind: string }>
  claims: Array<{ text: string; category: string; sourceIndex: number | null }>
  retirement: { retireAt: string; redirectTo: string | null } | null
  signedOffAt: string | null
  version: number
  trust: { state: string; issues: string[] }
}
interface Asset {
  slug: string
  kind: string
  title: string
  summary: string
  methodology: string
  dataAsOf: string
  payload: Record<string, unknown>
  status: 'draft' | 'published' | 'retired'
  version: number
}
interface Overview {
  now: string
  authors: Person[]
  governance: Plan[]
  assets: Asset[]
  unmanagedResources: string[]
}
const ENDPOINT = '/api/admin/content-governance'
const request = useRequestFetch()
const overview = ref<Overview | null>(null)
const loading = ref(true)
const busy = ref(false)
const loadError = ref('')
const actionError = ref('')
const notice = ref('')

const ERRORS: Record<string, string> = {
  same_actor: 'La aprobación debe hacerla otra persona distinta de quien editó el plan.',
  incomplete_trust: 'Faltan autor, revisor técnico o evidencia para todas las afirmaciones.',
  version_conflict: 'Otra persona modificó este elemento; recarga e inténtalo de nuevo.',
  forbidden: 'No tienes permiso para esta acción.',
  unauthenticated: 'La sesión ha caducado.',
  unknown_page: 'La página indicada no existe.',
  unknown_person: 'El autor o revisor indicado no existe.',
  person_archived: 'El autor o revisor está archivado.',
  date_out_of_range: 'Fecha fuera del rango permitido.',
  invalid_input: 'Datos no válidos; revisa el formulario.',
  rate_limited: 'Demasiadas operaciones; espera un momento.',
  invalid_state: 'El elemento no está en un estado que permita esta acción.',
  idempotency_conflict: 'Operación repetida con datos distintos.'
}
const BUCKET: Record<string, string> = { overdue: 'Vencida', due_30: 'Próximos 30 días', scheduled: 'Programada' }
const KINDS = ['checklist', 'guide', 'comparison', 'study', 'calculator'] as const

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    overview.value = await request<Overview>(ENDPOINT, { method: 'GET' })
  } catch {
    overview.value = null
    loadError.value = 'No se ha podido cargar la revisión de contenidos.'
  } finally {
    loading.value = false
  }
}
function describe(error: unknown) {
  const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  return (code && ERRORS[code]) || 'No se pudo completar la operación.'
}
async function send(body: Record<string, unknown>) {
  if (busy.value) return false
  busy.value = true
  actionError.value = ''
  notice.value = ''
  try {
    await request(ENDPOINT, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body
    })
    notice.value = 'Cambios guardados.'
    await load()
    return true
  } catch (error) {
    actionError.value = describe(error)
    return false
  } finally {
    busy.value = false
  }
}

const author = ref({ name: '', bio: '', experience: '', credentials: '' })
async function submitAuthor() {
  const credentials = author.value.credentials.trim()
  const ok = await send({
    action: 'save_author',
    expectedVersion: 0,
    displayName: author.value.name,
    bio: author.value.bio,
    experience: author.value.experience,
    ...(credentials ? { credentials } : {})
  })
  if (ok) author.value = { name: '', bio: '', experience: '', credentials: '' }
}

const plan = ref({
  slug: '',
  expectedVersion: 0,
  ownerName: '',
  sensitivity: 'regulation' as Plan['sensitivity'],
  nextReviewAt: '',
  authorId: '',
  reviewerId: '',
  sources: '',
  claims: '',
  retireAt: '',
  redirectTo: ''
})
function editPlan(item: Plan) {
  plan.value = {
    slug: item.slug,
    expectedVersion: item.version,
    ownerName: item.ownerName,
    sensitivity: item.sensitivity,
    nextReviewAt: item.nextReviewAt,
    authorId: item.authorId ?? '',
    reviewerId: item.reviewerId ?? '',
    sources: item.sources.map((s) => `${s.label} | ${s.url} | ${s.kind}`).join('\n'),
    claims: item.claims
      .map((c) => `${c.category} | ${c.text} | ${c.sourceIndex === null ? '' : c.sourceIndex + 1}`)
      .join('\n'),
    retireAt: item.retirement?.retireAt ?? '',
    redirectTo: item.retirement?.redirectTo ?? ''
  }
}
const lines = (value: string) =>
  value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
async function submitPlan() {
  const p = plan.value
  const sources = lines(p.sources).map((line) => {
    const [label = '', url = '', kind = 'other'] = line.split('|').map((part) => part.trim())
    return { label, url, kind }
  })
  const claims = lines(p.claims).map((line) => {
    const [category = '', text = '', index = ''] = line.split('|').map((part) => part.trim())
    return { category, text, sourceIndex: index === '' ? null : Number(index) - 1 }
  })
  await send({
    action: 'save_governance',
    slug: p.slug,
    expectedVersion: p.expectedVersion,
    ownerName: p.ownerName,
    sensitivity: p.sensitivity,
    nextReviewAt: p.nextReviewAt,
    authorId: p.authorId || null,
    reviewerId: p.reviewerId || null,
    sources,
    claims,
    retirement: p.retireAt ? { retireAt: p.retireAt, redirectTo: p.redirectTo || null } : null
  })
}
const signOff = (item: Plan) => send({ action: 'sign_off', slug: item.slug, expectedVersion: item.version })

const asset = ref({
  slug: '',
  expectedVersion: 0,
  kind: 'checklist',
  title: '',
  summary: '',
  methodology: '',
  dataAsOf: '',
  payload: ''
})
function editAsset(item: Asset) {
  asset.value = {
    slug: item.slug,
    expectedVersion: item.version,
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    methodology: item.methodology,
    dataAsOf: item.dataAsOf,
    payload: JSON.stringify(item.payload, null, 2)
  }
}
async function submitAsset() {
  let payload: unknown
  try {
    payload = JSON.parse(asset.value.payload)
  } catch {
    actionError.value = 'El contenido del recurso no tiene un formato válido.'
    return
  }
  const a = asset.value
  await send({
    action: 'save_asset',
    slug: a.slug,
    expectedVersion: a.expectedVersion,
    kind: a.kind,
    title: a.title,
    summary: a.summary,
    methodology: a.methodology,
    dataAsOf: a.dataAsOf,
    payload
  })
}
const transition = (action: 'publish_asset' | 'retire_asset', item: Asset) =>
  send({ action, slug: item.slug, expectedVersion: item.version })

// Estado de interfaz: pestañas locales, paneles laterales y etiquetas legibles.
const view = ref('calendar')
const viewTabs = computed(() => [
  { value: 'calendar', label: 'Calendario de revisión', count: overview.value?.governance.length ?? null },
  { value: 'people', label: 'Autores y revisores', count: overview.value?.authors.length ?? null },
  { value: 'assets', label: 'Recursos descargables', count: overview.value?.assets.length ?? null }
])
const planOpen = ref(false)
const authorOpen = ref(false)
const assetOpen = ref(false)
const drawerOpen = computed(() => planOpen.value || authorOpen.value || assetOpen.value)
const BUCKET_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = {
  overdue: 'danger',
  due_30: 'warning',
  scheduled: 'neutral'
}
const TRUST: Record<string, [string, 'success' | 'warning' | 'danger']> = {
  verified: ['Verificado', 'success'],
  incomplete: ['Incompleto', 'warning'],
  overdue: ['Revisión vencida', 'danger']
}
const TRUST_ISSUES: Record<string, string> = {
  no_author: 'Falta autor',
  author_archived: 'El autor ya no está activo',
  no_reviewer: 'Falta revisor',
  reviewer_archived: 'El revisor ya no está activo',
  not_signed_off: 'Pendiente de dar por revisada',
  no_sources: 'Faltan fuentes',
  claim_without_evidence: 'Hay afirmaciones sin fuente',
  review_overdue: 'Revisión vencida'
}
const issueLabel = (code: string) => TRUST_ISSUES[code] ?? adminHumanize(code)
const KIND_LABELS: Record<string, string> = {
  checklist: 'Lista de comprobación',
  guide: 'Guía',
  comparison: 'Comparativa',
  study: 'Estudio',
  calculator: 'Calculadora'
}
const ASSET_STATUS: Record<string, [string, 'neutral' | 'success']> = {
  draft: ['Borrador', 'neutral'],
  published: ['Publicado', 'success'],
  retired: ['Retirado', 'neutral']
}
function newPlan() {
  actionError.value = ''
  plan.value = {
    slug: '',
    expectedVersion: 0,
    ownerName: '',
    sensitivity: 'regulation',
    nextReviewAt: '',
    authorId: '',
    reviewerId: '',
    sources: '',
    claims: '',
    retireAt: '',
    redirectTo: ''
  }
  planOpen.value = true
}
function openPlan(item: Plan) {
  actionError.value = ''
  editPlan(item)
  planOpen.value = true
}
async function savePlan() {
  await submitPlan()
  if (!actionError.value) planOpen.value = false
}
async function saveAuthor() {
  await submitAuthor()
  if (!actionError.value) authorOpen.value = false
}
function newAsset() {
  actionError.value = ''
  asset.value = {
    slug: '',
    expectedVersion: 0,
    kind: 'checklist',
    title: '',
    summary: '',
    methodology: '',
    dataAsOf: '',
    payload: ''
  }
  assetOpen.value = true
}
function openAsset(item: Asset) {
  actionError.value = ''
  editAsset(item)
  assetOpen.value = true
}
async function saveAsset() {
  await submitAsset()
  if (!actionError.value) assetOpen.value = false
}
const assetToRetire = ref<Asset | null>(null)
const confirmRetire = computed({
  get: () => assetToRetire.value !== null,
  set: (open: boolean) => {
    if (!open) assetToRetire.value = null
  }
})
async function retireAsset() {
  const item = assetToRetire.value
  assetToRetire.value = null
  if (item) await transition('retire_asset', item)
}

onMounted(load)
</script>

<template>
  <div class="adm-stack" data-testid="admin-content-governance-panel">
    <AdminPageActions>
      <AdminButton
        v-if="view === 'calendar'"
        variant="primary"
        icon="i-lucide-plus"
        :disabled="!overview"
        @click="newPlan"
      >
        Nuevo plan de revisión
      </AdminButton>
      <AdminButton
        v-else-if="view === 'people'"
        variant="primary"
        icon="i-lucide-plus"
        :disabled="!overview"
        @click="authorOpen = true"
      >
        Añadir persona
      </AdminButton>
      <AdminButton v-else variant="primary" icon="i-lucide-plus" :disabled="!overview" @click="newAsset">
        Nuevo recurso
      </AdminButton>
    </AdminPageActions>

    <div v-if="loading && !overview" class="adm-card adm-table-skeleton" role="status" aria-busy="true">
      <span class="sr-only">Cargando…</span>
      <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
    </div>
    <AdminCard v-else-if="loadError" flush>
      <AdminEmptyState
        role="alert"
        variant="error"
        title="No se ha podido cargar la revisión de contenidos"
        description="Comprueba la conexión y vuelve a intentarlo."
      >
        <button type="button" class="adm-btn adm-btn--secondary" data-testid="governance-retry" @click="load">
          <UIcon name="i-lucide-rotate-cw" class="size-4 shrink-0" />
          Reintentar
        </button>
      </AdminEmptyState>
    </AdminCard>
    <UAlert
      v-if="actionError && !drawerOpen"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="actionError"
    />
    <UAlert v-if="notice" role="status" color="success" variant="subtle" icon="i-lucide-circle-check" :title="notice" />

    <template v-if="overview">
      <AdminTabs v-model="view" :tabs="viewTabs" label="Apartados de revisión" />

      <template v-if="view === 'calendar'">
        <UAlert
          v-if="overview.unmanagedResources.length"
          color="warning"
          variant="subtle"
          icon="i-lucide-calendar-x"
          title="Hay páginas sin responsable ni revisión planificada"
          :description="overview.unmanagedResources.join(', ')"
        />
        <AdminCard aria-labelledby="calendar-title" flush>
          <template #title><span id="calendar-title">Calendario de revisión</span></template>
          <AdminEmptyState
            v-if="!overview.governance.length"
            data-testid="governance-empty"
            icon="i-lucide-calendar-check"
            title="Todavía no hay planes de revisión"
            description="Asigna a cada página un responsable y una fecha para volver a revisarla."
          >
            <AdminButton icon="i-lucide-plus" @click="newPlan">Nuevo plan de revisión</AdminButton>
          </AdminEmptyState>
          <div v-else class="adm-table-wrap">
            <table class="adm-table">
              <caption class="sr-only">
                Planes de revisión de contenido
              </caption>
              <thead>
                <tr>
                  <th scope="col">Página</th>
                  <th scope="col">Responsable</th>
                  <th scope="col">Próxima revisión</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Retirada</th>
                  <th scope="col" data-numeric><span class="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in overview.governance" :key="item.slug" :data-testid="`governance-row-${item.slug}`">
                  <th scope="row" class="font-semibold text-[var(--text-strong)]">{{ item.slug }}</th>
                  <td>{{ item.ownerName }}</td>
                  <td>
                    {{ adminDate(item.nextReviewAt) }}
                    <AdminBadge :tone="BUCKET_TONE[item.bucket] ?? 'neutral'" plain class="ml-1">
                      {{ BUCKET[item.bucket] }}
                    </AdminBadge>
                  </td>
                  <td>
                    <AdminBadge :tone="TRUST[item.trust.state]?.[1] ?? 'neutral'">
                      {{ TRUST[item.trust.state]?.[0] ?? adminHumanize(item.trust.state) }}
                    </AdminBadge>
                    <span v-if="item.trust.issues.length" class="adm-help block">{{
                      item.trust.issues.map(issueLabel).join(' · ')
                    }}</span>
                  </td>
                  <td>
                    <template v-if="item.retirement">
                      {{ adminDate(item.retirement.retireAt) }}
                      <span class="adm-help block">
                        {{ item.retirement.redirectTo ? `Llevará a ${item.retirement.redirectTo}` : 'Sin redirección' }}
                      </span>
                    </template>
                    <template v-else>—</template>
                  </td>
                  <td data-numeric class="adm-table__actions">
                    <button
                      v-if="!item.signedOffAt"
                      type="button"
                      class="adm-btn adm-btn--secondary adm-btn--sm"
                      :disabled="busy"
                      :data-testid="`signoff-${item.slug}`"
                      @click="signOff(item)"
                    >
                      Dar por revisada
                    </button>
                    <button
                      type="button"
                      class="adm-btn adm-btn--ghost adm-btn--sm"
                      :data-testid="`edit-${item.slug}`"
                      @click="openPlan(item)"
                    >
                      Editar
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </AdminCard>
      </template>

      <AdminCard v-else-if="view === 'people'" aria-labelledby="authors-title" flush>
        <template #title><span id="authors-title">Autores y revisores</span></template>
        <AdminEmptyState
          v-if="!overview.authors.length"
          icon="i-lucide-user-pen"
          title="Todavía no hay autores ni revisores"
          description="Añade a las personas que firman o revisan los contenidos."
        >
          <AdminButton icon="i-lucide-plus" @click="authorOpen = true">Añadir persona</AdminButton>
        </AdminEmptyState>
        <ul v-else class="adm-list">
          <li v-for="a in overview.authors" :key="a.id">
            <p class="adm-list__title min-w-0 flex-1">{{ a.displayName }}</p>
            <AdminBadge :status="a.status" />
          </li>
        </ul>
      </AdminCard>

      <AdminCard
        v-else
        aria-labelledby="assets-title"
        description="Listas, guías, comparativas y estudios que otras webs pueden enlazar."
        flush
      >
        <template #title><span id="assets-title">Recursos descargables</span></template>
        <AdminEmptyState
          v-if="!overview.assets.length"
          icon="i-lucide-file-chart-column"
          title="Todavía no hay recursos"
          description="Crea el primero: se guarda como borrador hasta que lo publiques."
        >
          <AdminButton icon="i-lucide-plus" @click="newAsset">Nuevo recurso</AdminButton>
        </AdminEmptyState>
        <ul v-else class="adm-list">
          <li v-for="a in overview.assets" :key="a.slug">
            <div class="min-w-0 flex-1">
              <p class="adm-list__title">
                {{ a.title }}
                <AdminBadge :tone="ASSET_STATUS[a.status]?.[1] ?? 'neutral'">
                  {{ ASSET_STATUS[a.status]?.[0] ?? adminHumanize(a.status) }}
                </AdminBadge>
              </p>
              <p class="adm-help">
                {{ KIND_LABELS[a.kind] ?? adminHumanize(a.kind) }} · datos del {{ adminDate(a.dataAsOf) }}
              </p>
            </div>
            <button
              v-if="a.status === 'draft'"
              type="button"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :disabled="busy"
              :data-testid="`publish-${a.slug}`"
              @click="transition('publish_asset', a)"
            >
              Publicar
            </button>
            <button
              v-if="a.status !== 'retired'"
              type="button"
              class="adm-btn adm-btn--ghost adm-btn--sm"
              :disabled="busy"
              :data-testid="`retire-${a.slug}`"
              @click="assetToRetire = a"
            >
              Retirar
            </button>
            <button type="button" class="adm-btn adm-btn--ghost adm-btn--sm" @click="openAsset(a)">Editar</button>
          </li>
        </ul>
      </AdminCard>

      <AdminDrawer
        v-model:open="planOpen"
        :title="plan.expectedVersion ? 'Editar plan de revisión' : 'Nuevo plan de revisión'"
        wide
      >
        <form
          id="governance-plan-form"
          class="adm-stack"
          aria-labelledby="plan-title"
          data-testid="plan-form"
          @submit.prevent="savePlan"
        >
          <span id="plan-title" class="sr-only">Plan de revisión</span>
          <UAlert
            v-if="actionError"
            role="alert"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="actionError"
          />
          <div class="adm-form-grid">
            <AdminFormField
              v-slot="{ id }"
              label="Página"
              help="El final de su dirección, por ejemplo: guia-desinfeccion."
              required
            >
              <input :id="id" v-model="plan.slug" required data-testid="plan-slug" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Responsable" required>
              <input :id="id" v-model="plan.ownerName" required />
            </AdminFormField>
            <AdminFormField
              v-slot="{ id }"
              label="Tipo de contenido"
              help="Los de normativa se revisan con más frecuencia."
            >
              <select :id="id" v-model="plan.sensitivity">
                <option value="regulation">Normativa</option>
                <option value="product">Producto</option>
                <option value="general">General</option>
              </select>
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Próxima revisión" required>
              <input :id="id" v-model="plan.nextReviewAt" type="date" required />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Autor">
              <select :id="id" v-model="plan.authorId">
                <option value="">Sin asignar</option>
                <option v-for="a in overview.authors" :key="a.id" :value="a.id">{{ a.displayName }}</option>
              </select>
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Revisor técnico">
              <select :id="id" v-model="plan.reviewerId">
                <option value="">Sin asignar</option>
                <option v-for="a in overview.authors" :key="a.id" :value="a.id">{{ a.displayName }}</option>
              </select>
            </AdminFormField>
          </div>
          <AdminFormField v-slot="{ id }" label="Fuentes" help="Una por línea: nombre | https://direccion | tipo">
            <textarea :id="id" v-model="plan.sources" rows="3" class="w-full" />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id }"
            label="Afirmaciones que hay que respaldar"
            help="Una por línea: categoría | texto | n.º de la fuente que la respalda"
          >
            <textarea :id="id" v-model="plan.claims" rows="3" class="w-full" />
          </AdminFormField>
          <div class="adm-form-grid">
            <AdminFormField v-slot="{ id }" label="Fecha de retirada" help="Opcional.">
              <input :id="id" v-model="plan.retireAt" type="date" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Página a la que llevar después" help="Opcional.">
              <input :id="id" v-model="plan.redirectTo" placeholder="/recursos/nueva" />
            </AdminFormField>
          </div>
        </form>
        <template #footer>
          <AdminButton @click="planOpen = false">Cancelar</AdminButton>
          <button type="submit" form="governance-plan-form" :disabled="busy" class="adm-btn adm-btn--primary">
            Guardar plan
          </button>
        </template>
      </AdminDrawer>

      <AdminDrawer v-model:open="authorOpen" title="Añadir autor o revisor">
        <form id="governance-author-form" class="adm-stack" data-testid="author-form" @submit.prevent="saveAuthor">
          <UAlert
            v-if="actionError"
            role="alert"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="actionError"
          />
          <AdminFormField v-slot="{ id }" label="Nombre" required>
            <input :id="id" v-model="author.name" required data-testid="author-name" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Biografía" required>
            <textarea :id="id" v-model="author.bio" required class="w-full" data-testid="author-bio" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Experiencia relevante" required>
            <textarea :id="id" v-model="author.experience" required class="w-full" data-testid="author-experience" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Titulación" help="Solo si la aporta la propia persona.">
            <input :id="id" v-model="author.credentials" data-testid="author-credentials" />
          </AdminFormField>
        </form>
        <template #footer>
          <AdminButton @click="authorOpen = false">Cancelar</AdminButton>
          <button type="submit" form="governance-author-form" :disabled="busy" class="adm-btn adm-btn--primary">
            Añadir persona
          </button>
        </template>
      </AdminDrawer>

      <AdminDrawer v-model:open="assetOpen" :title="asset.expectedVersion ? 'Editar recurso' : 'Nuevo recurso'" wide>
        <form id="governance-asset-form" class="adm-stack" data-testid="asset-form" @submit.prevent="saveAsset">
          <UAlert
            v-if="actionError"
            role="alert"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="actionError"
          />
          <div class="adm-form-grid">
            <AdminFormField
              v-slot="{ id }"
              label="Dirección"
              help="Solo minúsculas y guiones: comparativa-desengrasantes."
              required
            >
              <input :id="id" v-model="asset.slug" required data-testid="asset-slug" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Tipo">
              <select :id="id" v-model="asset.kind">
                <option v-for="k in KINDS" :key="k" :value="k">{{ KIND_LABELS[k] }}</option>
              </select>
            </AdminFormField>
          </div>
          <AdminFormField v-slot="{ id }" label="Título" required>
            <input :id="id" v-model="asset.title" required />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Resumen" required>
            <input :id="id" v-model="asset.summary" required />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Cómo se han obtenido los datos" required>
            <textarea :id="id" v-model="asset.methodology" required class="w-full" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Fecha de los datos" required>
            <input :id="id" v-model="asset.dataAsOf" type="date" required />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id }"
            label="Contenido"
            help="Formato técnico estructurado. Si no lo conoces, pide ayuda a quien mantiene la tienda."
            required
          >
            <textarea
              :id="id"
              v-model="asset.payload"
              rows="8"
              required
              class="w-full font-mono text-[0.8125rem]"
              data-testid="asset-payload"
            />
          </AdminFormField>
        </form>
        <template #footer>
          <AdminButton @click="assetOpen = false">Cancelar</AdminButton>
          <button type="submit" form="governance-asset-form" :disabled="busy" class="adm-btn adm-btn--primary">
            Guardar como borrador
          </button>
        </template>
      </AdminDrawer>

      <AdminConfirm
        v-model:open="confirmRetire"
        title="Retirar recurso"
        :description="`«${assetToRetire?.title ?? ''}» dejará de estar disponible en la tienda.`"
        confirm-label="Retirar"
        danger
        @confirm="retireAsset"
      />
    </template>
  </div>
</template>
