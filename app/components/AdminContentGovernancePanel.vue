<script setup lang="ts">
/** SEO-029/030/031 admin surface: review calendar, authorship/technical review, linkable assets. */
import { ref, onMounted } from 'vue'

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
  unknown_page: 'La página indicada no existe en el CMS.',
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
    loadError.value = 'No se pudo cargar el gobierno de contenido.'
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
    actionError.value = 'El contenido del activo no es JSON válido.'
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

onMounted(load)
</script>

<template>
  <div class="space-y-8" data-testid="admin-content-governance-panel">
    <header>
      <h1 class="text-2xl font-bold text-slate-900">Gobierno de contenido</h1>
      <p class="text-sm text-slate-600">
        Propietarios y calendario de revisión, autoría con revisión técnica y evidencia, y activos enlazables con
        metodología. Los datos de autores y revisores los introduce administración.
      </p>
    </header>

    <p v-if="loading" role="status" class="text-sm text-slate-600">Cargando…</p>
    <div v-else-if="loadError" role="alert" class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
      {{ loadError }}
      <button type="button" class="ml-2 underline" data-testid="governance-retry" @click="load">Reintentar</button>
    </div>
    <p v-if="actionError" role="alert" class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
      {{ actionError }}
    </p>
    <p v-if="notice" role="status" class="rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-800">
      {{ notice }}
    </p>

    <template v-if="overview">
      <section aria-labelledby="calendar-title" class="space-y-3">
        <h2 id="calendar-title" class="text-lg font-semibold">Calendario de revisión</h2>
        <p v-if="!overview.governance.length" data-testid="governance-empty" class="text-sm text-slate-600">
          Sin planes de contenido todavía.
        </p>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <caption class="sr-only">
              Planes de revisión de contenido
            </caption>
            <thead>
              <tr>
                <th scope="col">Recurso</th>
                <th scope="col">Propietario</th>
                <th scope="col">Próxima revisión</th>
                <th scope="col">Confianza</th>
                <th scope="col">Retirada</th>
                <th scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in overview.governance" :key="item.slug" :data-testid="`governance-row-${item.slug}`">
                <th scope="row">{{ item.slug }}</th>
                <td>{{ item.ownerName }}</td>
                <td>{{ item.nextReviewAt }} · {{ BUCKET[item.bucket] }}</td>
                <td>
                  {{ item.trust.state }}
                  <span v-if="item.trust.issues.length" class="block text-xs text-slate-600">{{
                    item.trust.issues.join(', ')
                  }}</span>
                </td>
                <td>
                  <template v-if="item.retirement"
                    >{{ item.retirement.retireAt }} → {{ item.retirement.redirectTo ?? 'sin redirect' }}</template
                  >
                  <template v-else>—</template>
                </td>
                <td class="space-x-2">
                  <button type="button" :data-testid="`edit-${item.slug}`" @click="editPlan(item)">Editar</button>
                  <button
                    v-if="!item.signedOffAt"
                    type="button"
                    :disabled="busy"
                    :data-testid="`signoff-${item.slug}`"
                    @click="signOff(item)"
                  >
                    Aprobar revisión técnica
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="overview.unmanagedResources.length" class="text-sm">
          Recursos sin propietario ni revisión planificada:
          <strong>{{ overview.unmanagedResources.join(', ') }}</strong>
        </p>
      </section>

      <section aria-labelledby="plan-title" class="space-y-3">
        <h2 id="plan-title" class="text-lg font-semibold">Plan de contenido</h2>
        <form class="grid gap-3 sm:grid-cols-2" data-testid="plan-form" @submit.prevent="submitPlan">
          <label class="block text-sm"
            >Slug del recurso<input
              v-model="plan.slug"
              required
              class="block w-full rounded border p-2"
              data-testid="plan-slug"
          /></label>
          <label class="block text-sm"
            >Propietario<input v-model="plan.ownerName" required class="block w-full rounded border p-2"
          /></label>
          <label class="block text-sm"
            >Sensibilidad
            <select v-model="plan.sensitivity" class="block w-full rounded border p-2">
              <option value="regulation">Normativa</option>
              <option value="product">Producto</option>
              <option value="general">General</option>
            </select>
          </label>
          <label class="block text-sm"
            >Próxima revisión<input
              v-model="plan.nextReviewAt"
              type="date"
              required
              class="block w-full rounded border p-2"
          /></label>
          <label class="block text-sm"
            >Autor
            <select v-model="plan.authorId" class="block w-full rounded border p-2">
              <option value="">Sin asignar</option>
              <option v-for="a in overview.authors" :key="a.id" :value="a.id">{{ a.displayName }}</option>
            </select>
          </label>
          <label class="block text-sm"
            >Revisor técnico
            <select v-model="plan.reviewerId" class="block w-full rounded border p-2">
              <option value="">Sin asignar</option>
              <option v-for="a in overview.authors" :key="a.id" :value="a.id">{{ a.displayName }}</option>
            </select>
          </label>
          <label class="block text-sm sm:col-span-2"
            >Fuentes (una por línea: etiqueta | https://url | tipo)
            <textarea v-model="plan.sources" rows="3" class="block w-full rounded border p-2" />
          </label>
          <label class="block text-sm sm:col-span-2"
            >Afirmaciones (categoría | texto | nº de fuente)
            <textarea v-model="plan.claims" rows="3" class="block w-full rounded border p-2" />
          </label>
          <label class="block text-sm"
            >Retirada planificada<input v-model="plan.retireAt" type="date" class="block w-full rounded border p-2"
          /></label>
          <label class="block text-sm"
            >Redirect interno<input
              v-model="plan.redirectTo"
              placeholder="/recursos/nueva"
              class="block w-full rounded border p-2"
          /></label>
          <button type="submit" :disabled="busy" class="rounded bg-blue-600 px-4 py-2 text-white sm:col-span-2">
            Guardar plan
          </button>
        </form>
      </section>

      <section aria-labelledby="authors-title" class="space-y-3">
        <h2 id="authors-title" class="text-lg font-semibold">Autores y revisores</h2>
        <ul class="text-sm">
          <li v-for="a in overview.authors" :key="a.id">{{ a.displayName }} · {{ a.status }}</li>
        </ul>
        <form class="grid gap-3" data-testid="author-form" @submit.prevent="submitAuthor">
          <label class="block text-sm"
            >Nombre<input
              v-model="author.name"
              required
              class="block w-full rounded border p-2"
              data-testid="author-name"
          /></label>
          <label class="block text-sm"
            >Biografía<textarea
              v-model="author.bio"
              required
              class="block w-full rounded border p-2"
              data-testid="author-bio"
            />
          </label>
          <label class="block text-sm"
            >Experiencia relevante<textarea
              v-model="author.experience"
              required
              class="block w-full rounded border p-2"
              data-testid="author-experience"
            />
          </label>
          <label class="block text-sm"
            >Credenciales (solo si las aporta la persona)<input
              v-model="author.credentials"
              class="block w-full rounded border p-2"
              data-testid="author-credentials"
          /></label>
          <button type="submit" :disabled="busy" class="rounded bg-blue-600 px-4 py-2 text-white">
            Añadir persona
          </button>
        </form>
      </section>

      <section aria-labelledby="assets-title" class="space-y-3">
        <h2 id="assets-title" class="text-lg font-semibold">Activos enlazables</h2>
        <ul class="space-y-1 text-sm">
          <li v-for="a in overview.assets" :key="a.slug">
            {{ a.title }} ({{ a.kind }}) · {{ a.status }} · datos a {{ a.dataAsOf }}
            <button type="button" @click="editAsset(a)">Editar</button>
            <button
              v-if="a.status === 'draft'"
              type="button"
              :disabled="busy"
              :data-testid="`publish-${a.slug}`"
              @click="transition('publish_asset', a)"
            >
              Publicar
            </button>
            <button
              v-if="a.status !== 'retired'"
              type="button"
              :disabled="busy"
              :data-testid="`retire-${a.slug}`"
              @click="transition('retire_asset', a)"
            >
              Retirar
            </button>
          </li>
        </ul>
        <form class="grid gap-3" data-testid="asset-form" @submit.prevent="submitAsset">
          <label class="block text-sm"
            >Slug<input v-model="asset.slug" required class="block w-full rounded border p-2" data-testid="asset-slug"
          /></label>
          <label class="block text-sm"
            >Tipo
            <select v-model="asset.kind" class="block w-full rounded border p-2">
              <option v-for="k in KINDS" :key="k" :value="k">{{ k }}</option>
            </select>
          </label>
          <label class="block text-sm"
            >Título<input v-model="asset.title" required class="block w-full rounded border p-2"
          /></label>
          <label class="block text-sm"
            >Resumen<input v-model="asset.summary" required class="block w-full rounded border p-2"
          /></label>
          <label class="block text-sm"
            >Metodología<textarea v-model="asset.methodology" required class="block w-full rounded border p-2" />
          </label>
          <label class="block text-sm"
            >Datos a fecha de<input
              v-model="asset.dataAsOf"
              type="date"
              required
              class="block w-full rounded border p-2"
          /></label>
          <label class="block text-sm"
            >Contenido (JSON)<textarea
              v-model="asset.payload"
              rows="6"
              required
              class="block w-full rounded border p-2 font-mono"
              data-testid="asset-payload"
            />
          </label>
          <button type="submit" :disabled="busy" class="rounded bg-blue-600 px-4 py-2 text-white">
            Guardar activo (borrador)
          </button>
        </form>
      </section>
    </template>
  </div>
</template>
