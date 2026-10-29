<script setup lang="ts">
import {
  supportAdminTicketSchema,
  supportAdminInputSchema,
  supportUuid,
  type SupportAdminTicket,
  type SupportReceipt
} from '~~/shared/support-operations'
import { useSupportCommand } from './support/commands'
import { supportStateLabels, supportPriorityLabels } from './support/labels'
import SupportTicketFacts from './support/SupportTicketFacts.vue'
import AdminSupportMacrosPanel from './AdminSupportMacrosPanel.vue'
import AdminSupportEscalationsPanel from './AdminSupportEscalationsPanel.vue'
import type { supportMacroPreviewSchema } from '~~/shared/support-macros'
const props = defineProps<{
  snapshot: unknown
  publicRef: string
  operatorId: string
  runtime: unknown
  authorize: () => boolean
  reload: () => Promise<unknown>
}>()
const emit = defineEmits<{ confirmed: [receipt: SupportReceipt]; pending: [value: boolean] }>()
const escalationPending = ref(false)
const form = reactive({
  action: 'reply',
  reason: '',
  message: '',
  state: 'open',
  priority: 'normal',
  ownerId: '',
  nextActionAt: '',
  slaDueAt: '',
  resolution: '',
  occurredAt: ''
})
const file = shallowRef<File | null>(null),
  visibility = ref<'public' | 'internal'>('public'),
  validation = ref('')
const macroPreview = shallowRef<ReturnType<typeof supportMacroPreviewSchema.parse> | null>(null)
function discardMacro() {
  macroPreview.value = null
  form.message = ''
}
function selectMacro(preview: ReturnType<typeof supportMacroPreviewSchema.parse>) {
  if (
    intent.value ||
    !view.value ||
    preview.publicRef !== props.publicRef ||
    preview.ticketVersion !== view.value.version
  )
    return
  form.action = 'reply'
  form.message = preview.message
  macroPreview.value = preview
}
const decode = (raw: unknown): SupportAdminTicket | null => {
  const value = supportAdminTicketSchema.safeParse(raw)
  return value.success && value.data.publicRef === props.publicRef ? value.data : null
}
const owner = () => (supportUuid.safeParse(props.operatorId).success ? props.operatorId + ':' + props.publicRef : null)
const command = useSupportCommand({
  owner,
  runtime: () => props.runtime,
  authorize: () => props.authorize(),
  reload: () => props.reload(),
  decode,
  facts: (value) => ({ ref: value.publicRef, version: value.version, allowed: value.capabilities.manage }),
  endpoint: (ref, upload) => '/api/admin/support/' + ref + (upload ? '/attachments' : ''),
  method: 'PUT',
  fetch: (endpoint, options) => $fetch<unknown>(endpoint, options),
  confirmed: (receipt) => {
    file.value = null
    form.message = ''
    macroPreview.value = null
    emit('confirmed', receipt)
  },
  pending: (value) => emit('pending', value || escalationPending.value)
})
const { intent, busy, ambiguous, message, contextCurrent } = command
function onEscalationPending(value: boolean) {
  escalationPending.value = value
  emit('pending', value || busy.value || !!intent.value)
}
const view = computed(() => (command.authorize() && contextCurrent.value ? decode(props.snapshot) : null))
watch(
  () => props.snapshot,
  () => {
    const value = decode(props.snapshot)
    if (command.authorize() && value) {
      command.confirmedContext()
      if (!intent.value) {
        form.state = value.state
        form.priority = value.priority
        form.ownerId = value.ownerId ?? ''
        form.nextActionAt = value.nextActionAt ?? ''
        form.slaDueAt = value.slaDueAt ?? ''
      }
    }
  },
  { immediate: true }
)
watch(
  () => [props.operatorId, props.publicRef],
  () => {
    form.message = ''
    form.reason = ''
    form.resolution = ''
    file.value = null
    validation.value = ''
    macroPreview.value = null
  }
)
function prepare() {
  if (escalationPending.value) return
  const data = view.value
  if (!data?.capabilities.manage) return
  if (form.action === 'reply' && !data.capabilities.reply) {
    validation.value = 'El ticket no admite nuevas respuestas en su estado confirmado.'
    return
  }
  const common = { action: form.action, expectedVersion: data.version, reason: form.reason.trim() }
  const raw =
    form.action === 'update'
      ? {
          ...common,
          state: form.state,
          priority: form.priority,
          ownerId: form.ownerId || null,
          nextActionAt: form.nextActionAt || null,
          slaDueAt: form.slaDueAt || null,
          ...(form.resolution.trim() ? { resolution: form.resolution.trim() } : {})
        }
      : form.action === 'call'
        ? {
            ...common,
            message: form.message.trim(),
            occurredAt: form.occurredAt,
            nextActionAt: form.nextActionAt || null
          }
        : {
            ...common,
            message: form.message.trim(),
            ...(form.action === 'reply' && macroPreview.value
              ? { macro: { ...macroPreview.value.selection, confirmed: true } }
              : {})
          }
  const parsed = supportAdminInputSchema.safeParse(raw)
  if (!parsed.success) {
    validation.value =
      'Comprueba motivo, contenido y fechas UTC completas. Resolver o cerrar exige un resumen público documentado.'
    return
  }
  validation.value = ''
  command.prepare(parsed.data, data)
}
function chooseFile(event: Event) {
  const target = event.target
  if (target instanceof HTMLInputElement) file.value = target.files?.item(0) ?? null
}
function prepareAttachment() {
  if (escalationPending.value) return
  const data = view.value
  if (!data?.capabilities.attachments || !file.value) return
  if (file.value.size < 1 || file.value.size > 10485760) {
    validation.value = 'El archivo debe tener entre 1 byte y 10 MB.'
    return
  }
  validation.value = ''
  command.prepare({ file: file.value, expectedVersion: data.version, visibility: visibility.value }, data, true)
}
</script>
<template>
  <section aria-label="Gestión operativa del ticket" class="space-y-4">
    <p v-if="message && command.authorize()" data-testid="admin-support-message" role="status">{{ message }}</p>
    <p v-if="validation && command.authorize()" role="alert">{{ validation }}</p>
    <div v-if="view" data-testid="admin-support-facts" class="space-y-4">
      <p>
        Contacto: {{ view.requester.name }} · {{ view.requester.email
        }}<span v-if="view.requester.phone"> · {{ view.requester.phone }}</span>
      </p>
      <p v-if="view.declaredOrderReference">
        Referencia declarada (no acredita propiedad): {{ view.declaredOrderReference }}
      </p>
      <SupportTicketFacts :snapshot="view" administrative />
      <p v-if="view.ownerId && !view.staff.some((staff) => staff.id === view?.ownerId)" role="status">
        El responsable anterior ya no es elegible según sus permisos actuales. La referencia histórica se conserva;
        puedes documentar una reasignación.
      </p>
      <form v-if="view.capabilities.manage && !intent" class="space-y-3" @submit.prevent="prepare">
        <label class="block"
          >Acción
          <select v-model="form.action" data-testid="admin-support-action" class="rounded border p-2">
            <option value="reply">Respuesta pública</option>
            <option value="note">Nota interna</option>
            <option value="call">Anotar llamada ya realizada</option>
            <option value="update">Estado, prioridad, responsable y agenda</option>
          </select></label
        >
        <p v-if="form.action === 'reply'" class="rounded border p-3">
          La respuesta será pública. Las notas internas nunca se incluyen en ella. Si el contacto no está verificado, no
          comuniques datos privados de pedidos.
        </p>
        <p v-if="form.action === 'note' || form.action === 'call'">
          Anotación INTERNA: sólo personal autorizado. Minimiza datos personales y no almacenes secretos.
        </p>
        <label class="block"
          >Motivo de operación
          <input
            v-model="form.reason"
            data-testid="admin-support-reason"
            required
            minlength="3"
            maxlength="500"
            class="rounded border p-2"
        /></label>
        <label v-if="form.action !== 'update'" class="block"
          >Contenido
          <textarea
            v-model="form.message"
            data-testid="admin-support-body"
            required
            maxlength="5000"
            rows="5"
            :readonly="form.action === 'reply' && !!macroPreview"
            class="w-full rounded border p-2"
          />
        </label>
        <p v-if="form.action === 'reply' && macroPreview">
          Texto fijo de revisión inmutable. Para personalizar, cambia los campos declarados y vuelve a previsualizar.
          <button type="button" class="rounded border p-2" @click="discardMacro">
            Descartar plantilla y redactar respuesta libre
          </button>
        </p>
        <template v-if="form.action === 'update'">
          <label class="block"
            >Estado
            <select v-model="form.state" data-testid="admin-support-state" class="rounded border p-2">
              <option v-for="(label, state) in supportStateLabels" :key="state" :value="state">{{ label }}</option>
            </select></label
          >
          <label class="block"
            >Prioridad
            <select v-model="form.priority" class="rounded border p-2">
              <option v-for="(label, priority) in supportPriorityLabels" :key="priority" :value="priority">
                {{ label }}
              </option>
            </select></label
          >
          <label class="block"
            >Responsable actual autorizado
            <select v-model="form.ownerId" class="rounded border p-2">
              <option value="">Sin asignar</option>
              <option v-for="staff in view.staff" :key="staff.id" :value="staff.id">{{ staff.label }}</option>
            </select></label
          >
          <label class="block"
            >SLA documentado UTC, opcional
            <input v-model="form.slaDueAt" placeholder="2026-10-04T10:00:00Z" class="rounded border p-2"
          /></label>
          <label class="block"
            >Resumen público al resolver/cerrar
            <textarea v-model="form.resolution" minlength="10" maxlength="1000" class="w-full rounded border p-2" />
          </label>
        </template>
        <label v-if="form.action === 'update' || form.action === 'call'" class="block"
          >Siguiente acción UTC, opcional
          <input v-model="form.nextActionAt" placeholder="2026-10-04T10:00:00Z" class="rounded border p-2"
        /></label>
        <label v-if="form.action === 'call'" class="block"
          >Fecha de la llamada ya realizada UTC
          <input v-model="form.occurredAt" required placeholder="2026-10-03T10:00:00Z" class="rounded border p-2"
        /></label>
        <button data-testid="admin-support-prepare" :disabled="busy || escalationPending" class="rounded border p-2">
          Revisar acción
        </button>
      </form>
      <AdminSupportMacrosPanel
        v-if="view.capabilities.manage && !intent"
        :public-ref="publicRef"
        :operator-id="operatorId"
        :runtime="runtime"
        :authorize="authorize"
        @selected="selectMacro"
      />
      <div v-if="view.capabilities.attachments && !intent" class="space-y-2">
        <label class="block"
          >Evidencia JPEG, PNG o PDF, máximo 10 MB
          <input type="file" accept="image/png,image/jpeg,application/pdf" @change="chooseFile"
        /></label>
        <label
          >Visibilidad
          <select v-model="visibility">
            <option value="public">Visible para el cliente verificado</option>
            <option value="internal">Interno</option>
          </select></label
        >
        <button :disabled="busy || escalationPending || !file" class="rounded border p-2" @click="prepareAttachment()">
          Preparar adjunto privado
        </button>
      </div>
    </div>
    <div v-if="intent && command.authorize()" class="rounded border p-3">
      <p>Operación preparada con contenido y clave estables.</p>
      <button
        v-if="!ambiguous"
        data-testid="admin-support-send"
        :disabled="busy || escalationPending"
        class="rounded border p-2"
        @click="command.dispatch()"
      >
        Confirmar operación
      </button>
      <button
        v-else
        data-testid="admin-support-recover"
        :disabled="busy || escalationPending"
        class="rounded border p-2"
        @click="command.dispatch(true)"
      >
        Recuperar mismo intento
      </button>
      <button v-if="!ambiguous" :disabled="busy" class="rounded border p-2" @click="command.cancel()">
        Cancelar intento no enviado
      </button>
    </div>
    <AdminSupportEscalationsPanel
      v-if="runtime === 'cloudflare'"
      :public-ref="publicRef"
      :scope-key="operatorId + ':' + publicRef"
      :enabled="!!view?.capabilities.manage"
      :pending="busy || !!intent"
      @pending="onEscalationPending"
    />
  </section>
</template>
