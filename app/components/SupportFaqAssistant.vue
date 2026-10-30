<script setup lang="ts">
import { randomId } from '../utils/uuid'

/**
 * SUP-012 limited FAQ assistant. It quotes approved help articles and says so when it cannot;
 * every non-answer leads to a person.
 */
interface Source {
  pageId: string
  versionId: string
  slug: string
  title: string
  category: string
  reviewedAt: string
}
interface Reply {
  turnId: string
  outcome: 'answered' | 'uncertain' | 'handoff_required'
  reason: string
  answer: string | null
  sources: Source[]
  notice: string | null
}
const request = useRequestFetch(),
  prefix = useId()
const question = ref(''),
  validation = ref(''),
  status = ref<'idle' | 'loading' | 'error'>('idle'),
  errorText = ref('')
const reply = ref<Reply | null>(null)
const handoffOpen = ref(false),
  email = ref(''),
  handoffState = ref<'idle' | 'sending' | 'done' | 'error'>('idle'),
  handoffError = ref('')
const feedbackSent = ref(false)

function messageOf(error: unknown): string {
  const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  if (code === 'knowledge_unavailable')
    return 'El asistente no está disponible ahora mismo. Puedes escribirnos desde la página de contacto.'
  if (code === 'rate_limited') return 'Demasiadas consultas seguidas. Espera un minuto e inténtalo de nuevo.'
  return 'No hemos podido procesar tu consulta. Inténtalo de nuevo o escríbenos.'
}
async function ask() {
  validation.value = ''
  const text = question.value.trim()
  if (text.length < 3 || text.length > 300) {
    validation.value = 'Escribe una pregunta de entre 3 y 300 caracteres.'
    return
  }
  status.value = 'loading'
  reply.value = null
  handoffOpen.value = false
  handoffState.value = 'idle'
  feedbackSent.value = false
  try {
    reply.value = (await request('/api/support/assistant/ask', {
      method: 'POST',
      headers: { 'idempotency-key': randomId() },
      body: { question: text }
    })) as Reply
    status.value = 'idle'
  } catch (error) {
    errorText.value = messageOf(error)
    status.value = 'error'
  }
}
async function handoff() {
  if (!reply.value) return
  handoffState.value = 'sending'
  handoffError.value = ''
  try {
    await request('/api/support/assistant/handoff', {
      method: 'POST',
      headers: { 'idempotency-key': randomId() },
      body: { turnId: reply.value.turnId, ...(email.value.trim() ? { contactEmail: email.value.trim() } : {}) }
    })
    handoffState.value = 'done'
  } catch (error) {
    handoffState.value = 'error'
    const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
    handoffError.value =
      code === 'invalid_input'
        ? 'Indica un correo válido para que podamos responderte.'
        : 'No hemos podido pasar tu consulta. Inténtalo de nuevo.'
  }
}
async function vote(helpful: boolean) {
  if (!reply.value) return
  try {
    await request('/api/support/assistant/feedback', {
      method: 'POST',
      headers: { 'idempotency-key': randomId() },
      body: { turnId: reply.value.turnId, helpful }
    })
    feedbackSent.value = true
  } catch {
    feedbackSent.value = false
  }
}
const uncertainText = computed(() =>
  reply.value?.reason === 'chemical_safety'
    ? 'Por seguridad no doy indicaciones sobre mezclas o dosis que no estén en nuestras guías aprobadas. Una persona del equipo puede ayudarte.'
    : reply.value?.reason === 'emergency'
      ? 'Esta consulta necesita a una persona.'
      : 'No tengo información aprobada para responder a esto con seguridad. Puedo pasar tu consulta a una persona del equipo.'
)
</script>

<template>
  <section class="rounded-2xl border border-slate-200 bg-white p-5" :aria-labelledby="`${prefix}-title`">
    <h2 :id="`${prefix}-title`" class="text-lg font-bold text-slate-900">Pregunta al asistente</h2>
    <p class="mt-1 text-sm text-slate-600">
      El asistente solo responde con información revisada de nuestro centro de ayuda y te indica la fuente. Si no la
      tiene, te pasa con una persona.
    </p>
    <form class="mt-4 space-y-2" novalidate @submit.prevent="ask">
      <label :for="`${prefix}-q`" class="block text-sm font-medium text-slate-700">Tu pregunta</label>
      <textarea
        :id="`${prefix}-q`"
        v-model="question"
        rows="2"
        maxlength="300"
        class="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        :aria-describedby="validation ? `${prefix}-err` : undefined"
        :aria-invalid="validation ? 'true' : undefined"
      />
      <p v-if="validation" :id="`${prefix}-err`" class="text-sm text-red-700">{{ validation }}</p>
      <button
        type="submit"
        class="rounded-lg bg-neteco-600 px-4 py-2 text-sm font-semibold text-white hover:bg-neteco-700 disabled:opacity-50"
        :disabled="status === 'loading'"
      >
        {{ status === 'loading' ? 'Buscando…' : 'Preguntar' }}
      </button>
    </form>

    <p v-if="status === 'error'" role="alert" class="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
      {{ errorText }}
    </p>

    <div v-if="reply" class="mt-4 space-y-3" aria-live="polite">
      <p
        v-if="reply.notice"
        data-test="notice"
        class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900"
      >
        {{ reply.notice }}
      </p>
      <template v-if="reply.outcome === 'answered' && reply.answer">
        <blockquote class="rounded-lg bg-slate-50 p-3 text-sm text-slate-800">{{ reply.answer }}</blockquote>
        <p v-for="source in reply.sources" :key="source.versionId" class="text-xs text-slate-500">
          Fuente: {{ source.title }} · revisado el {{ source.reviewedAt.slice(0, 10) }}
        </p>
        <div v-if="!feedbackSent" class="flex items-center gap-2 text-sm">
          <span>¿Te ha servido?</span>
          <button type="button" data-test="helpful-yes" class="rounded border px-2 py-1" @click="vote(true)">Sí</button>
          <button type="button" data-test="helpful-no" class="rounded border px-2 py-1" @click="vote(false)">No</button>
        </div>
        <p v-else class="text-sm text-slate-600">Gracias por tu valoración.</p>
      </template>
      <p v-else class="text-sm text-slate-800">{{ uncertainText }}</p>

      <div>
        <button
          v-if="!handoffOpen && handoffState !== 'done'"
          type="button"
          data-test="handoff-open"
          class="text-sm font-medium text-neteco-700 hover:underline"
          @click="handoffOpen = true"
        >
          Hablar con una persona
        </button>
        <form
          v-if="handoffOpen && handoffState !== 'done'"
          data-test="handoff-form"
          class="mt-2 space-y-2"
          @submit.prevent="handoff"
        >
          <label :for="`${prefix}-mail`" class="block text-sm font-medium text-slate-700"
            >Correo para responderte</label
          >
          <input
            :id="`${prefix}-mail`"
            v-model="email"
            type="email"
            autocomplete="email"
            class="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <p v-if="handoffError" role="alert" class="text-sm text-red-700">{{ handoffError }}</p>
          <button
            type="submit"
            class="rounded-lg border border-neteco-600 px-3 py-1.5 text-sm font-semibold text-neteco-700 disabled:opacity-50"
            :disabled="handoffState === 'sending'"
          >
            Enviar a una persona
          </button>
        </form>
        <p v-if="handoffState === 'done'" role="status" class="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
          Hemos pasado tu consulta a una persona del equipo. Te responderá por correo.
        </p>
      </div>
    </div>
  </section>
</template>
