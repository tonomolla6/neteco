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
const uid = useId()
const stateLabels: Record<string, string> = {
  draft: 'Borrador',
  approved: 'Aprobada',
  withdrawn: 'Retirada',
  expired: 'Caducada'
}
const stateTones: Record<string, 'neutral' | 'success' | 'warning'> = {
  draft: 'warning',
  approved: 'success',
  withdrawn: 'neutral'
}
const actionLabels: Record<string, string> = {
  draft: 'Guardar borrador',
  approve: 'Aprobar borrador',
  withdraw: 'Retirar respuesta guardada'
}
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
    if (epoch === generation && allowed())
      status.value = 'No se han podido cargar las respuestas guardadas. Vuelve a intentarlo.'
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
    if (epoch === generation && allowed()) status.value = 'No se ha podido cargar el historial. Vuelve a intentarlo.'
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
              reviewedAt: adminLocalToIso(form.reviewedAt) ?? '',
              expiresAt: adminLocalToIso(form.expiresAt) ?? ''
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
      'Revisa el texto, los campos, las referencias y las fechas (formato 2026-10-08T10:00:00Z). No se ha guardado nada.'
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
      status.value =
        'Otra persona ha cambiado esta respuesta guardada. Actualiza la lista antes de volver a intentarlo.'
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
    status.value = 'Cambio guardado. Anotar una referencia no sustituye a la revisión legal real.'
    const latest = await read('/api/admin/support/macros/' + pending.macroId)
    if (epoch !== generation || !allowed()) return
    library.value = latest
    selectedId.value = pending.macroId
  } catch {
    if (epoch === generation && allowed())
      status.value = sent
        ? 'Resultado incierto: no sabemos si se ha guardado. No cambies nada y pulsa «Comprobar y recuperar el envío».'
        : 'No se han podido comprobar las respuestas guardadas; no se ha enviado nada.'
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
        'No se ha podido previsualizar. Revisa los campos y que la respuesta guardada siga aprobada y vigente.'
  } finally {
    if (active) busy.value = false
  }
}
function usePreview() {
  if (allowed() && preview.value && !intent.value) emit('selected', preview.value)
}
</script>
<template>
  <AdminCard
    v-if="allowed()"
    aria-label="Plantillas de soporte revisadas"
    title="Respuestas guardadas"
    description="Textos revisados para contestar más rápido. Nada se envía sin que lo confirmes."
  >
    <template #actions>
      <button
        type="button"
        data-testid="macros-load"
        :disabled="busy || !!intent || !!preview"
        class="adm-btn adm-btn--secondary adm-btn--sm"
        @click="load()"
      >
        {{ busy ? 'Cargando…' : library ? 'Actualizar lista' : 'Ver respuestas guardadas' }}
      </button>
    </template>
    <div class="adm-stack">
      <UAlert v-if="status" role="status" color="info" variant="subtle" icon="i-lucide-info" :title="status" />
      <template v-if="library">
        <p v-if="!library.macros.length" class="adm-help">
          Todavía no hay respuestas guardadas. Crea un borrador y pide que lo revisen.
        </p>
        <p v-if="library.truncated" role="status" class="adm-help">Se muestran las primeras 50 respuestas guardadas.</p>
        <div class="adm-field">
          <label :for="`${uid}-macro`" class="adm-label">Respuesta guardada</label>
          <div class="flex flex-wrap items-center gap-2">
            <select
              :id="`${uid}-macro`"
              v-model="selectedId"
              :disabled="!!intent || busy || !!preview"
              class="min-w-0 flex-1"
            >
              <option value="">Nuevo borrador</option>
              <option v-for="macro in library.macros" :key="macro.macroId" :value="macro.macroId">
                {{ macro.snapshot.content.title }} · {{ stateLabels[macro.state] ?? 'Otro estado' }}
              </option>
            </select>
            <button
              v-if="library.nextMacroId"
              type="button"
              data-testid="macros-next"
              :disabled="busy || !!intent || !!preview"
              class="adm-btn adm-btn--ghost adm-btn--sm"
              @click="load(library.nextMacroId)"
            >
              Ver más
            </button>
          </div>
        </div>
        <template v-if="selected?.state === 'approved' && !intent">
          <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
            <dt class="text-[var(--text-muted)]">Tono</dt>
            <dd>{{ selected.snapshot.content.tone }}</dd>
            <dt class="text-[var(--text-muted)]">Revisada</dt>
            <dd>{{ adminDate(selected.snapshot.review?.reviewedAt, true) }}</dd>
            <dt class="text-[var(--text-muted)]">Válida hasta</dt>
            <dd>{{ adminDate(selected.snapshot.review?.expiresAt, true) }}</dd>
          </dl>
          <label v-for="field in selected.snapshot.content.personalizations" :key="field.key" class="adm-field">
            <span class="adm-label">{{ field.label }} {{ field.required ? '(obligatorio)' : '(opcional)' }}</span>
            <input v-model="personalizations[field.key]" :required="field.required" maxlength="300" class="w-full" />
          </label>
          <div>
            <button
              type="button"
              :disabled="busy"
              data-testid="macro-preview"
              class="adm-btn adm-btn--secondary"
              @click="makePreview"
            >
              Previsualizar en esta consulta
            </button>
          </div>
          <div
            v-if="preview"
            class="adm-stack rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3"
          >
            <p class="whitespace-pre-wrap break-words">{{ preview.message }}</p>
            <div class="flex flex-wrap justify-end gap-2">
              <button type="button" class="adm-btn adm-btn--ghost adm-btn--sm" @click="preview = null">
                Descartar
              </button>
              <button
                type="button"
                data-testid="macro-use"
                class="adm-btn adm-btn--primary adm-btn--sm"
                @click="usePreview"
              >
                Usar esta respuesta
              </button>
            </div>
          </div>
        </template>
        <details v-if="!intent">
          <summary class="adm-btn adm-btn--ghost adm-btn--sm">Crear o editar una respuesta guardada</summary>
          <div class="adm-stack mt-3">
            <label class="adm-field">
              <span class="adm-label">Título</span>
              <input v-model="form.title" maxlength="120" class="w-full" />
            </label>
            <label class="adm-field">
              <span class="adm-label">Texto de la respuesta</span>
              <textarea v-model="form.body" rows="5" maxlength="4000" class="w-full" />
              <span class="adm-help">
                Puedes insertar entre dobles llaves la referencia, el motivo y el estado de la consulta
                (ticket.reference, ticket.category, ticket.state) y tus campos propios (personal.clave). Cambiar el
                texto exige una nueva revisión.
              </span>
            </label>
            <label class="adm-field">
              <span class="adm-label">Tono recomendado</span>
              <input v-model="form.tone" maxlength="300" class="w-full" />
            </label>
            <label class="adm-field">
              <span class="adm-label">Campos que se rellenan al responder</span>
              <textarea v-model="form.slots" rows="3" class="w-full" placeholder="paso|Siguiente paso|required" />
              <span class="adm-help">
                Uno por línea, con este formato: clave|Nombre del campo|required (obligatorio) u optional (opcional).
              </span>
            </label>
            <label class="adm-field">
              <span class="adm-label">Motivo del cambio</span>
              <input v-model="form.reason" maxlength="500" class="w-full" />
            </label>
            <div class="flex flex-wrap justify-end gap-2">
              <button
                v-if="selected?.state === 'approved'"
                type="button"
                data-testid="macro-withdraw"
                class="adm-btn adm-btn--danger-soft"
                @click="prepare('withdraw')"
              >
                Retirar respuesta
              </button>
              <button
                type="button"
                data-testid="macro-draft"
                class="adm-btn adm-btn--secondary"
                @click="prepare('draft')"
              >
                Guardar borrador
              </button>
            </div>
            <template v-if="selected?.state === 'draft'">
              <p class="adm-help">
                Se aprueba el borrador guardado, no los cambios sin guardar de este formulario. Repasa el historial
                antes de aprobar.
              </p>
              <div class="adm-form-grid">
                <label class="adm-field">
                  <span class="adm-label">Quién la ha revisado (atención al cliente)</span>
                  <input v-model="form.operationalReference" maxlength="300" class="w-full" />
                </label>
                <label class="adm-field">
                  <span class="adm-label">Referencia de la revisión legal</span>
                  <input v-model="form.legalReference" maxlength="300" class="w-full" />
                </label>
                <label class="adm-field">
                  <span class="adm-label">Fecha de la revisión</span>
                  <input v-model="form.reviewedAt" type="datetime-local" class="adm-input w-full" />
                </label>
                <label class="adm-field">
                  <span class="adm-label">Válida hasta</span>
                  <input v-model="form.expiresAt" type="datetime-local" class="adm-input w-full" />
                </label>
              </div>
              <div class="flex justify-end">
                <button
                  type="button"
                  data-testid="macro-approve"
                  class="adm-btn adm-btn--secondary"
                  @click="prepare('approve')"
                >
                  Aprobar borrador
                </button>
              </div>
            </template>
          </div>
        </details>
        <details v-if="selected">
          <summary class="adm-btn adm-btn--ghost adm-btn--sm">
            Historial de cambios ({{ selected.history.length }})
          </summary>
          <div class="adm-stack mt-3">
            <p v-if="selected.historyTruncated" class="adm-help">Se muestran hasta 20 cambios por página.</p>
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="macro-history-load"
                :disabled="busy || !!intent || !!preview"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                @click="loadHistory()"
              >
                Actualizar historial
              </button>
              <button
                v-if="selected.historyNextBefore"
                type="button"
                data-testid="macro-history-older"
                :disabled="busy || !!intent || !!preview"
                class="adm-btn adm-btn--ghost adm-btn--sm"
                @click="loadHistory(selected.historyNextBefore)"
              >
                Ver cambios anteriores
              </button>
            </div>
            <article
              v-for="entry in selected.history"
              :key="entry.commandId"
              class="border-t border-[var(--border)] pt-3"
            >
              <p class="flex flex-wrap items-center gap-2">
                <AdminBadge :tone="stateTones[entry.state] ?? 'neutral'">
                  {{ stateLabels[entry.state] ?? 'Otro estado' }}
                </AdminBadge>
                <span class="adm-help">{{ adminDate(entry.createdAt, true) }}</span>
              </p>
              <p class="mt-1 break-words">{{ entry.reason }}</p>
              <p class="mt-1 whitespace-pre-wrap break-words text-[var(--text-muted)]">
                {{ entry.snapshot.content.body }}
              </p>
              <p v-if="entry.snapshot.review" class="adm-help mt-1 break-words">
                Revisión de atención al cliente: {{ entry.snapshot.review.operationalReference }} · revisión legal:
                {{ entry.snapshot.review.legalReference }}
              </p>
            </article>
          </div>
        </details>
      </template>
      <div
        v-if="intent"
        class="adm-stack rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3"
      >
        <p class="font-semibold text-[var(--text-strong)]">
          {{ uncertain ? 'No sabemos si se ha guardado' : 'Revisa y confirma' }}
        </p>
        <p class="break-words">
          {{ actionLabels[String(intent.body.action)] ?? 'Cambio' }}
          <template v-if="typeof intent.body.title === 'string'">: «{{ intent.body.title }}»</template>
          <template v-if="typeof intent.body.reason === 'string'"> · Motivo: {{ intent.body.reason }}</template>
        </p>
        <p v-if="typeof intent.body.body === 'string'" class="whitespace-pre-wrap break-words text-[var(--text-muted)]">
          {{ intent.body.body }}
        </p>
        <div class="flex flex-wrap justify-end gap-2">
          <button
            v-if="!uncertain"
            type="button"
            :disabled="busy"
            class="adm-btn adm-btn--secondary"
            @click="intent = null"
          >
            Cancelar
          </button>
          <button
            type="button"
            data-testid="macro-confirm"
            :disabled="busy"
            class="adm-btn adm-btn--primary"
            @click="dispatch(uncertain)"
          >
            {{ uncertain ? 'Comprobar y recuperar el envío' : 'Confirmar y guardar' }}
          </button>
        </div>
      </div>
    </div>
  </AdminCard>
</template>
