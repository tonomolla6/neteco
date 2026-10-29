<script setup lang="ts">
import {
  supportKnowledgeListSchema,
  supportKnowledgeQuerySchema,
  supportKnowledgeFeedbackInputSchema,
  supportKnowledgeFeedbackReceiptSchema,
  type SupportKnowledgeList,
  type SupportKnowledgeItem,
  type SupportKnowledgeQuery
} from '~~/shared/support-knowledge'
import { randomId } from '../utils/uuid'

const props = defineProps<{ runtime: unknown }>()
const request = useRequestFetch(),
  prefix = useId()
const query = ref(''),
  category = ref(''),
  validation = ref('')
const applied = ref<SupportKnowledgeQuery>({ q: '', page: 1, perPage: 10 })
const results = shallowRef<SupportKnowledgeList | null>(null)
const categories = shallowRef<SupportKnowledgeList['categories']>([])
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
type FeedbackIntent = Readonly<{ key: string; body: string; pageId: string; versionId: string; helpful: boolean }>
type FeedbackState = {
  intent: FeedbackIntent
  status: 'sending' | 'confirmed' | 'unknown' | 'rejected' | 'looking'
  message: string
}
const feedback = ref<Record<string, FeedbackState>>({})
let alive = true,
  generation = 0,
  readSequence = 0
function live(epoch: number) {
  return alive && props.runtime === 'cloudflare' && generation === epoch
}
watch(
  () => props.runtime,
  () => {
    generation++
    readSequence++
    results.value = null
    categories.value = []
    status.value = 'idle'
    feedback.value = {}
    validation.value = ''
    if (props.runtime === 'cloudflare') void read()
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  generation++
  readSequence++
})

async function read() {
  if (!alive || props.runtime !== 'cloudflare') return
  const epoch = generation,
    sequence = ++readSequence,
    submitted = { ...applied.value }
  status.value = 'loading'
  results.value = null
  try {
    const raw = await request<unknown>('/api/support/knowledge', {
      method: 'GET',
      query: submitted,
      retry: 0,
      cache: 'no-store'
    })
    if (!live(epoch) || sequence !== readSequence) return
    const parsed = supportKnowledgeListSchema.safeParse(raw)
    if (
      !parsed.success ||
      parsed.data.page !== submitted.page ||
      parsed.data.perPage !== submitted.perPage ||
      (submitted.category && parsed.data.items.some((item) => item.category !== submitted.category))
    )
      throw new Error('unconfirmed_knowledge')
    results.value = parsed.data
    categories.value = parsed.data.categories
    status.value = 'ready'
  } catch {
    if (live(epoch) && sequence === readSequence) {
      status.value = 'error'
      results.value = null
    }
  }
}
function search() {
  if (!alive || props.runtime !== 'cloudflare') return
  const parsed = supportKnowledgeQuerySchema.safeParse({
    q: query.value.trim(),
    page: 1,
    perPage: 10,
    ...(category.value ? { category: category.value } : {})
  })
  if (!parsed.success) {
    validation.value = 'Revisa la búsqueda: máximo 160 caracteres y un tema disponible.'
    return
  }
  validation.value = ''
  applied.value = parsed.data
  void read()
}
function move(delta: number) {
  const data = results.value
  if (status.value !== 'ready' || !data) return
  const page = data.page + delta
  if (page < 1 || page > Math.max(1, Math.ceil(data.total / data.perPage))) return
  applied.value = { ...applied.value, page }
  void read()
}
function feedbackKey(item: SupportKnowledgeItem) {
  return item.id + ':' + item.versionId
}
function feedbackState(item: SupportKnowledgeItem) {
  return feedback.value[feedbackKey(item)]
}
function canFeedback(item: SupportKnowledgeItem) {
  return (
    alive &&
    props.runtime === 'cloudflare' &&
    status.value === 'ready' &&
    results.value?.feedbackEnabled === true &&
    results.value.items.some((current) => current.id === item.id && current.versionId === item.versionId)
  )
}
function confirmFeedback(raw: unknown, intent: FeedbackIntent) {
  const parsed = supportKnowledgeFeedbackReceiptSchema.safeParse(raw)
  return (
    parsed.success &&
    parsed.data.pageId === intent.pageId &&
    parsed.data.versionId === intent.versionId &&
    parsed.data.helpful === intent.helpful
  )
}
function errorCode(error: unknown) {
  try {
    return (error as { data?: { error?: { code?: unknown } } })?.data?.error?.code
  } catch {
    return undefined
  }
}
const noFeedbackEffect = new Set([
  'article_unavailable',
  'idempotency_conflict',
  'feedback_capacity',
  'invalid_input',
  'csrf_rejected',
  'rate_limited'
])
async function vote(item: SupportKnowledgeItem, helpful: boolean) {
  const key = feedbackKey(item)
  if (!canFeedback(item) || feedback.value[key]) return
  const parsed = supportKnowledgeFeedbackInputSchema.safeParse({ pageId: item.id, versionId: item.versionId, helpful })
  if (!parsed.success) return
  const intent = Object.freeze({ key: randomId(), body: JSON.stringify(parsed.data), ...parsed.data }),
    epoch = generation
  feedback.value[key] = { intent, status: 'sending', message: 'Registrando valoración…' }
  try {
    const raw = await request<unknown>('/api/support/knowledge/feedback', {
      method: 'POST',
      body: JSON.parse(intent.body),
      headers: { 'Idempotency-Key': intent.key },
      retry: 0
    })
    if (!live(epoch)) return
    if (!confirmFeedback(raw, intent)) throw new Error('unconfirmed_feedback')
    feedback.value[key]!.status = 'confirmed'
    feedback.value[key]!.message = 'Gracias. Tu valoración se ha registrado.'
  } catch (error) {
    if (!live(epoch)) return
    const code = errorCode(error)
    if (typeof code === 'string' && noFeedbackEffect.has(code)) {
      feedback.value[key]!.status = 'rejected'
      feedback.value[key]!.message =
        'No se ha registrado la valoración. El artículo o el servicio de valoración no están disponibles; puedes actualizar la búsqueda o contactar.'
    } else {
      feedback.value[key]!.status = 'unknown'
      feedback.value[key]!.message =
        'No se ha confirmado la valoración. No se reenviará automáticamente. Puedes consultar su recibo.'
    }
  }
}
async function lookupFeedback(item: SupportKnowledgeItem) {
  const key = feedbackKey(item),
    state = feedback.value[key]
  if (!canFeedback(item) || !state || state.status !== 'unknown') return
  const intent = state.intent,
    epoch = generation
  feedback.value[key]!.status = 'looking'
  feedback.value[key]!.message = 'Consultando el recibo de la valoración…'
  try {
    const raw = await request<unknown>('/api/support/knowledge/feedback/' + encodeURIComponent(intent.key), {
      method: 'GET',
      retry: 0,
      cache: 'no-store'
    })
    if (!live(epoch)) return
    if (!confirmFeedback(raw, intent)) throw new Error('unconfirmed_feedback')
    feedback.value[key]!.status = 'confirmed'
    feedback.value[key]!.message = 'Gracias. Tu valoración se ha registrado.'
  } catch {
    if (!live(epoch)) return
    // A missing receipt does not prove that an in-flight command did not commit.
    feedback.value[key]!.status = 'unknown'
    feedback.value[key]!.message =
      'No se ha podido confirmar el recibo. Puedes volver a consultar; no se enviará otra valoración automáticamente.'
  }
}
</script>
<template>
  <section
    aria-label="Buscar en el centro de ayuda"
    class="min-w-0 space-y-4 rounded-2xl border border-slate-200 p-4 sm:p-6"
  >
    <h2 :id="prefix + '-heading'" class="text-xl font-semibold">Busca una respuesta</h2>
    <template v-if="runtime === 'cloudflare'">
      <form data-help-form class="flex min-w-0 flex-wrap items-end gap-3" @submit.prevent="search">
        <div class="min-w-0 flex-1">
          <label :for="prefix + '-query'" class="block font-medium">¿En qué necesitas ayuda?</label>
          <input
            :id="prefix + '-query'"
            v-model="query"
            data-help-query
            type="search"
            maxlength="160"
            :aria-describedby="prefix + '-hint'"
            class="mt-1 block w-full min-w-0 rounded border p-2"
          />
        </div>
        <div class="min-w-0">
          <label :for="prefix + '-category'" class="block font-medium">Tema</label>
          <select
            :id="prefix + '-category'"
            v-model="category"
            data-help-category
            class="mt-1 max-w-full rounded border p-2"
          >
            <option value="">Todos los temas</option>
            <option v-for="option in categories" :key="option.id" :value="option.id">{{ option.label }}</option>
          </select>
        </div>
        <button type="submit" class="rounded border border-neteco-700 px-4 py-2 text-neteco-700">Buscar</button>
      </form>
      <p :id="prefix + '-hint'" class="text-sm text-slate-600">
        Busca una pregunta o tema sin incluir datos personales ni datos de pago.
      </p>
      <p v-if="validation" role="alert">{{ validation }}</p>
      <p v-if="status === 'loading'" data-help-loading role="status" aria-live="polite">
        Buscando artículos publicados…
      </p>
      <div v-else-if="status === 'error'" data-help-error role="alert" class="space-y-2">
        <p>No se ha podido confirmar el centro de ayuda publicado. Un error no significa que no existan respuestas.</p>
        <button data-help-retry type="button" class="rounded border p-2" @click="read">Reintentar búsqueda</button>
      </div>
      <div v-else-if="status === 'ready' && results" class="space-y-4">
        <p role="status" aria-live="polite">
          {{ results.total }} artículos{{ applied.q ? ` para «${applied.q}»` : '' }} · Página {{ results.page }}
        </p>
        <p v-if="!results.items.length" data-help-empty>
          No hay artículos publicados que coincidan con esta búsqueda. Prueba otras palabras o consulta los enlaces
          útiles de esta página.
        </p>
        <ul data-help-results class="min-w-0 space-y-4 break-words">
          <li
            v-for="item in results.items"
            :key="item.id + ':' + item.versionId"
            class="min-w-0 rounded border p-4 [overflow-wrap:anywhere]"
          >
            <h3 class="font-semibold">
              <NuxtLink data-help-article :to="'/contenido/' + item.slug" class="text-neteco-700 underline">{{
                item.title
              }}</NuxtLink>
            </h3>
            <p class="mt-2">{{ item.excerpt }}</p>
            <p class="mt-2 text-sm text-slate-600">
              Revisión editorial: <time :datetime="item.reviewedAt">{{ item.reviewedAt.slice(0, 10) }}</time> · Fecha
              límite de revisión: <time :datetime="item.reviewDueAt">{{ item.reviewDueAt.slice(0, 10) }}</time>
            </p>
            <fieldset v-if="results.feedbackEnabled" data-help-feedback class="mt-3 space-y-2">
              <legend class="text-sm font-medium">¿Te ha resultado útil este artículo?</legend>
              <div
                v-if="!feedbackState(item) || feedbackState(item)?.status === 'sending'"
                class="flex flex-wrap gap-2"
              >
                <button
                  data-help-yes
                  type="button"
                  :disabled="!!feedbackState(item)"
                  class="rounded border px-3 py-2"
                  @click="vote(item, true)"
                >
                  Sí, me ha ayudado
                </button>
                <button
                  data-help-no
                  type="button"
                  :disabled="!!feedbackState(item)"
                  class="rounded border px-3 py-2"
                  @click="vote(item, false)"
                >
                  No ha resuelto mi duda
                </button>
              </div>
              <p v-if="feedbackState(item)" role="status" aria-live="polite">{{ feedbackState(item)?.message }}</p>
              <button
                v-if="feedbackState(item)?.status === 'unknown' || feedbackState(item)?.status === 'looking'"
                data-help-feedback-lookup
                type="button"
                :disabled="feedbackState(item)?.status === 'looking'"
                class="rounded border p-2"
                @click="lookupFeedback(item)"
              >
                Consultar recibo de mi valoración
              </button>
            </fieldset>
          </li>
        </ul>
        <nav aria-label="Páginas de artículos de ayuda" class="flex flex-wrap items-center gap-3">
          <button type="button" :disabled="results.page <= 1" class="rounded border p-2" @click="move(-1)">
            Anterior
          </button>
          <span>Página {{ results.page }} de {{ Math.max(1, Math.ceil(results.total / results.perPage)) }}</span>
          <button
            data-help-next
            type="button"
            :disabled="results.page * results.perPage >= results.total"
            class="rounded border p-2"
            @click="move(1)"
          >
            Siguiente
          </button>
        </nav>
        <p class="text-sm text-slate-600">La revisión editorial no implica aprobación química ni legal.</p>
      </div>
    </template>
    <p v-else>Consulta los enlaces útiles de esta página para encontrar ayuda.</p>
    <p>
      ¿No encuentras respuesta?
      <NuxtLink data-help-contact to="/contacto" class="font-medium text-neteco-700 underline"
        >Contacta con NETECO</NuxtLink
      >.
    </p>
  </section>
</template>
