<script setup lang="ts">
import {
  supportMacroLibrarySchema,
  supportMacroCommandSchema,
  supportMacroContentSchema,
  supportMacroReceiptSchema,
  supportMacroPreviewSchema,
  type SupportMacroLibrary
} from '~~/shared/support-macros'
import { supportUuid } from '~~/shared/support-operations'
const props = defineProps<{
  publicRef: string
  operatorId: string
  runtime: unknown
  authorize: () => boolean
  disabled?: boolean
}>()
const emit = defineEmits<{
  selected: [preview: ReturnType<typeof supportMacroPreviewSchema.parse>]
  pending: [value: boolean]
}>()
const library = shallowRef<SupportMacroLibrary | null>(null),
  busy = ref(false),
  status = ref(''),
  selectedId = ref(''),
  preview = shallowRef<ReturnType<typeof supportMacroPreviewSchema.parse> | null>(null)
const personalizations = reactive<Record<string, string>>({})
const form = reactive({
  title: '',
  body: '',
  tone: '',
  slots: '',
  reason: '',
  operationalReference: '',
  legalReference: '',
  reviewedAt: '',
  expiresAt: ''
})
const intent = shallowRef<Readonly<{ macroId: string; body: Record<string, unknown>; key: string }> | null>(null),
  uncertain = ref(false)
let active = true
const allowed = () =>
  active &&
  props.runtime === 'cloudflare' &&
  props.authorize() === true &&
  supportUuid.safeParse(props.operatorId).success &&
  !props.disabled
const selected = computed(() => library.value?.macros.find((m) => m.macroId === selectedId.value) ?? null)
let generation = 0
onBeforeUnmount(() => {
  active = false
  generation++
  intent.value = null
  preview.value = null
  library.value = null
  emit('pending', false)
})
watch(
  () => [props.operatorId, props.publicRef, props.runtime, props.authorize()],
  () => {
    generation++
    library.value = null
    selectedId.value = ''
    preview.value = null
    intent.value = null
    uncertain.value = false
    status.value = ''
    for (const key of Object.keys(personalizations)) Reflect.deleteProperty(personalizations, key)
    Object.assign(form, {
      title: '',
      body: '',
      tone: '',
      slots: '',
      reason: '',
      operationalReference: '',
      legalReference: '',
      reviewedAt: '',
      expiresAt: ''
    })
  }
)
watch(intent, (value) => emit('pending', value !== null), { flush: 'sync' })
watch(selectedId, () => {
  preview.value = null
  for (const key of Object.keys(personalizations)) Reflect.deleteProperty(personalizations, key)
  if (selected.value) {
    const content = selected.value.snapshot.content
    Object.assign(form, {
      title: content.title,
      body: content.body,
      tone: content.tone,
      slots: content.personalizations
        .map((s) => s.key + '|' + s.label + '|' + (s.required ? 'required' : 'optional'))
        .join('\n')
    })
  }
})
watch(personalizations, () => {
  preview.value = null
})
async function read(path = '/api/admin/support/macros') {
  const parsed = supportMacroLibrarySchema.safeParse(await $fetch<unknown>(path, { retry: 0 }))
  if (!parsed.success) throw new Error('invalid_library')
  return parsed.data
}
async function load(afterMacroId?: string) {
  if (!allowed() || busy.value || intent.value || preview.value) return
  const epoch = generation
  busy.value = true
  status.value = ''
  try {
    const data = await read('/api/admin/support/macros' + (afterMacroId ? '?afterMacroId=' + afterMacroId : ''))
    if (epoch === generation && allowed()) {
      library.value = data
      selectedId.value = ''
    }
  } catch {
    if (epoch === generation && allowed()) status.value = 'No se ha podido confirmar la biblioteca. Vuelve a cargarla.'
  } finally {
    if (active) busy.value = false
  }
}
async function loadHistory(beforeVersion?: number) {
  const current = selected.value
  if (!allowed() || busy.value || intent.value || preview.value || !current) return
  const epoch = generation
  busy.value = true
  try {
    const data = await read(
      '/api/admin/support/macros/' + current.macroId + (beforeVersion ? '?beforeVersion=' + beforeVersion : '')
    )
    if (epoch !== generation || !allowed() || selectedId.value !== current.macroId) return
    const detail = data.macros[0]
    if (!detail || detail.macroId !== current.macroId) throw new Error('history_unconfirmed')
    if (library.value)
      library.value = {
        ...library.value,
        macros: library.value.macros.map((m) => (m.macroId === detail.macroId ? detail : m))
      }
  } catch {
    if (epoch === generation && allowed()) status.value = 'No se ha confirmado el historial. Vuelve a consultarlo.'
  } finally {
    if (active) busy.value = false
  }
}
function prepare(action: 'draft' | 'approve' | 'withdraw') {
  if (!allowed() || busy.value || intent.value) return
  try {
    const macroId = selected.value?.macroId ?? crypto.randomUUID(),
      expectedVersion = selected.value?.version ?? 0
    const common = { action, expectedVersion, reason: form.reason.trim() }
    const body = supportMacroCommandSchema.parse(
      action === 'draft'
        ? {
            ...common,
            ...supportMacroContentSchema.parse({
              title: form.title.trim(),
              body: form.body.trim(),
              tone: form.tone.trim(),
              personalizations: form.slots.trim()
                ? form.slots
                    .trim()
                    .split('\n')
                    .map((line) => {
                      const parts = line.split('|')
                      if (parts.length !== 3 || !['required', 'optional'].includes(parts[2]!))
                        throw new Error('invalid_slots')
                      return { key: parts[0], label: parts[1], required: parts[2] === 'required' }
                    })
                : []
            })
          }
        : action === 'approve'
          ? {
              ...common,
              operationalReference: form.operationalReference.trim(),
              legalReference: form.legalReference.trim(),
              reviewedAt: form.reviewedAt,
              expiresAt: form.expiresAt
            }
          : common
    )
    intent.value = Object.freeze({
      macroId,
      body: Object.freeze(JSON.parse(JSON.stringify(body))),
      key: crypto.randomUUID()
    })
    uncertain.value = false
    status.value = ''
  } catch {
    status.value =
      'Revisa contenido, variables, campos declarados y referencias/fechas UTC. No se ha preparado ninguna operación.'
  }
}
async function dispatch(recovery = false) {
  const pending = intent.value
  if (!pending || busy.value || !allowed()) return
  const epoch = generation
  busy.value = true
  let sent = false
  try {
    const fresh = await read('/api/admin/support/macros/' + pending.macroId)
    if (epoch !== generation || !allowed()) return
    if (
      !recovery &&
      (fresh.macros.find((m) => m.macroId === pending.macroId)?.version ?? 0) !== pending.body.expectedVersion
    ) {
      intent.value = null
      status.value = 'La versión ha cambiado. Revisa la biblioteca antes de preparar otra operación.'
      return
    }
    sent = true
    uncertain.value = true
    const raw = await $fetch<unknown>('/api/admin/support/macros/' + pending.macroId, {
      method: 'PUT',
      body: pending.body,
      headers: { 'Idempotency-Key': pending.key },
      retry: 0
    })
    if (epoch !== generation || !allowed()) return
    const receipt = supportMacroReceiptSchema.parse(raw)
    if (receipt.macroId !== pending.macroId || receipt.version !== Number(pending.body.expectedVersion) + 1)
      throw new Error('receipt_unconfirmed')
    intent.value = null
    uncertain.value = false
    status.value = 'Operación registrada. La referencia de revisión no sustituye una aprobación legal real.'
    const latest = await read('/api/admin/support/macros/' + pending.macroId)
    if (epoch !== generation || !allowed()) return
    library.value = latest
    selectedId.value = pending.macroId
  } catch {
    if (epoch === generation && allowed())
      status.value = sent
        ? 'Resultado incierto. No cambies el contenido: recupera manualmente el mismo intento tras consultar la biblioteca.'
        : 'No se ha confirmado la biblioteca; no se ha enviado la operación.'
  } finally {
    if (active) busy.value = false
  }
}
async function makePreview() {
  if (!allowed() || busy.value || !selected.value || intent.value) return
  const epoch = generation,
    selection = {
      macroId: selected.value.macroId,
      revisionId: selected.value.revisionId,
      personalizations: { ...personalizations }
    }
  busy.value = true
  preview.value = null
  try {
    const raw = await $fetch<unknown>('/api/admin/support/' + props.publicRef + '/macro-preview', {
      method: 'POST',
      body: selection,
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      retry: 0
    })
    if (epoch !== generation || !allowed()) return
    if (
      selected.value?.macroId !== selection.macroId ||
      selected.value?.revisionId !== selection.revisionId ||
      JSON.stringify(personalizations) !== JSON.stringify(selection.personalizations)
    )
      return
    preview.value = supportMacroPreviewSchema.parse(raw)
  } catch {
    if (epoch === generation && allowed())
      status.value =
        'No se ha confirmado la plantilla. Comprueba personalización, revisión vigente y contexto del ticket.'
  } finally {
    if (active) busy.value = false
  }
}
function usePreview() {
  if (allowed() && preview.value && !intent.value) emit('selected', preview.value)
}
</script>
<template>
  <UiSurface v-if="allowed()" class="space-y-3" aria-label="Plantillas de soporte revisadas">
    <h3 class="text-lg font-semibold">Plantillas revisadas</h3>
    <p class="text-sm">
      Sin envío automático. Sólo se permiten variables del ticket y campos declarados; no incluyas secretos ni datos
      personales innecesarios. No hay textos legales preaprobados.
    </p>
    <button
      type="button"
      data-testid="macros-load"
      :disabled="busy || !!intent || !!preview"
      class="rounded border p-2"
      @click="load()"
    >
      {{ busy ? 'Cargando…' : 'Consultar biblioteca' }}
    </button>
    <p v-if="status" role="status">{{ status }}</p>
    <template v-if="library">
      <p v-if="!library.macros.length">
        No hay plantillas. Crea un borrador y solicita una revisión operativa y legal real.
      </p>
      <p v-if="library.truncated" role="status">Página parcial: se muestran hasta 50 plantillas.</p>
      <button
        v-if="library.nextMacroId"
        type="button"
        data-testid="macros-next"
        :disabled="busy || !!intent || !!preview"
        class="rounded border p-2"
        @click="load(library.nextMacroId)"
      >
        Siguiente página de plantillas
      </button>
      <label class="block"
        >Plantilla<select v-model="selectedId" :disabled="!!intent || busy || !!preview" class="rounded border p-2">
          <option value="">Nuevo borrador</option>
          <option v-for="macro in library.macros" :key="macro.macroId" :value="macro.macroId">
            {{ macro.snapshot.content.title }} · {{ macro.state }} · v{{ macro.version }}
          </option>
        </select></label
      >
      <template v-if="selected?.state === 'approved' && !intent">
        <p>Tono: {{ selected.snapshot.content.tone }}</p>
        <p>Revisión: {{ selected.snapshot.review?.reviewedAt }} · Caduca: {{ selected.snapshot.review?.expiresAt }}</p>
        <label v-for="field in selected.snapshot.content.personalizations" :key="field.key" class="block"
          >{{ field.label }} {{ field.required ? '(obligatorio)' : '(opcional)'
          }}<input
            v-model="personalizations[field.key]"
            :required="field.required"
            maxlength="300"
            class="w-full rounded border p-2"
        /></label>
        <button
          type="button"
          :disabled="busy"
          data-testid="macro-preview"
          class="rounded border p-2"
          @click="makePreview"
        >
          Previsualizar en este ticket
        </button>
        <div v-if="preview" class="space-y-2">
          <p class="whitespace-pre-wrap">{{ preview.message }}</p>
          <button type="button" data-testid="macro-use" class="rounded border p-2" @click="usePreview">
            Usar esta respuesta y revisar envío
          </button>
          <button type="button" class="rounded border p-2" @click="preview = null">Descartar previsualización</button>
        </div>
      </template>
      <details v-if="!intent">
        <summary>Editar borrador y documentar revisión</summary>
        <div class="space-y-3">
          <label class="block"
            >Título<input v-model="form.title" maxlength="120" class="w-full rounded border p-2"
          /></label>
          <label class="block"
            >Texto fijo revisable<textarea
              v-model="form.body"
              rows="5"
              maxlength="4000"
              class="w-full rounded border p-2"
            />
          </label>
          <p class="text-sm">
            Variables: ticket.reference, ticket.category, ticket.state y personal.clave, entre dobles llaves. Sólo los
            campos personales se editan al responder; alterar texto fijo exige nueva revisión.
          </p>
          <label class="block"
            >Guía de tono<input v-model="form.tone" maxlength="300" class="w-full rounded border p-2"
          /></label>
          <label class="block"
            >Campos: clave|Etiqueta|required u optional (una línea por campo)<textarea
              v-model="form.slots"
              rows="3"
              class="w-full rounded border p-2"
            />
          </label>
          <label class="block"
            >Motivo documentado<input v-model="form.reason" maxlength="500" class="w-full rounded border p-2"
          /></label>
          <button type="button" data-testid="macro-draft" class="rounded border p-2" @click="prepare('draft')">
            Preparar borrador
          </button>
          <template v-if="selected?.state === 'draft'">
            <p>
              La revisión aprueba el borrador guardado, no las ediciones sin guardar de este formulario. Verifica el
              historial antes de confirmar.
            </p>
            <label class="block"
              >Referencia operativa<input
                v-model="form.operationalReference"
                maxlength="300"
                class="w-full rounded border p-2"
            /></label>
            <label class="block"
              >Referencia de revisión legal<input
                v-model="form.legalReference"
                maxlength="300"
                class="w-full rounded border p-2"
            /></label>
            <label class="block"
              >Fecha revisión UTC<input
                v-model="form.reviewedAt"
                placeholder="2026-10-08T10:00:00Z"
                class="w-full rounded border p-2"
            /></label>
            <label class="block"
              >Caducidad UTC<input
                v-model="form.expiresAt"
                placeholder="2026-11-08T10:00:00Z"
                class="w-full rounded border p-2"
            /></label>
            <button type="button" data-testid="macro-approve" class="rounded border p-2" @click="prepare('approve')">
              Preparar aprobación documentada
            </button>
          </template>
          <button
            v-if="selected?.state === 'approved'"
            type="button"
            data-testid="macro-withdraw"
            class="rounded border p-2"
            @click="prepare('withdraw')"
          >
            Preparar retirada
          </button>
        </div>
      </details>
      <details v-if="selected">
        <summary>Historial inmutable · {{ selected.history.length }} revisiones</summary>
        <p v-if="selected.historyTruncated">Historial parcial. Consulta hasta 20 versiones por página.</p>
        <button
          type="button"
          data-testid="macro-history-load"
          :disabled="busy || !!intent || !!preview"
          class="rounded border p-2"
          @click="loadHistory()"
        >
          Consultar historial actual
        </button>
        <button
          v-if="selected.historyNextBefore"
          type="button"
          data-testid="macro-history-older"
          :disabled="busy || !!intent || !!preview"
          class="rounded border p-2"
          @click="loadHistory(selected.historyNextBefore)"
        >
          Cargar versiones anteriores
        </button>
        <article v-for="entry in selected.history" :key="entry.commandId" class="border-b py-3">
          <p>v{{ entry.version }} · {{ entry.state }} · {{ entry.createdAt }} · {{ entry.reason }}</p>
          <p class="whitespace-pre-wrap">{{ entry.snapshot.content.body }}</p>
          <p v-if="entry.snapshot.review">
            Operación: {{ entry.snapshot.review.operationalReference }} · Legal:
            {{ entry.snapshot.review.legalReference }}
          </p>
        </article>
      </details>
    </template>
    <div v-if="intent" class="rounded border p-3 space-y-2">
      <p>Acción: {{ intent.body.action }} · versión {{ intent.body.expectedVersion }}. Contenido y clave congelados.</p>
      <pre class="whitespace-pre-wrap break-words">{{ JSON.stringify(intent.body, null, 2) }}</pre>
      <button
        type="button"
        data-testid="macro-confirm"
        :disabled="busy"
        class="rounded border p-2"
        @click="dispatch(uncertain)"
      >
        {{ uncertain ? 'Consultar y recuperar mismo intento' : 'Confirmar operación de plantilla' }}</button
      ><button v-if="!uncertain" type="button" :disabled="busy" class="rounded border p-2" @click="intent = null">
        Cancelar sin enviar
      </button>
    </div>
  </UiSurface>
</template>
