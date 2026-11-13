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
const uid = useId()
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
        form.nextActionAt = adminIsoToLocal(value.nextActionAt)
        form.slaDueAt = adminIsoToLocal(value.slaDueAt)
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
    validation.value = 'Esta consulta ya no admite respuestas en su estado actual.'
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
          nextActionAt: adminLocalToIso(form.nextActionAt),
          slaDueAt: adminLocalToIso(form.slaDueAt),
          ...(form.resolution.trim() ? { resolution: form.resolution.trim() } : {})
        }
      : form.action === 'call'
        ? {
            ...common,
            message: form.message.trim(),
            occurredAt: adminLocalToIso(form.occurredAt) ?? form.occurredAt,
            nextActionAt: adminLocalToIso(form.nextActionAt)
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
      'Revisa el motivo, el texto y las fechas (formato 2026-10-04T10:00:00Z). Para resolver o cerrar hace falta un resumen para el cliente.'
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
    validation.value = 'El archivo no puede estar vacío ni pesar más de 10 MB.'
    return
  }
  validation.value = ''
  command.prepare({ file: file.value, expectedVersion: data.version, visibility: visibility.value }, data, true)
}
</script>
<template>
  <section aria-label="Gestión operativa del ticket" class="adm-stack">
    <UAlert
      v-if="message && command.authorize()"
      data-testid="admin-support-message"
      role="status"
      color="info"
      variant="subtle"
      icon="i-lucide-info"
      :title="message"
    />
    <UAlert
      v-if="validation && command.authorize()"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="validation"
    />
    <div v-if="view" data-testid="admin-support-facts" class="adm-stack">
      <AdminCard title="Cliente">
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
          <dt class="text-[var(--text-muted)]">Nombre</dt>
          <dd>{{ view.requester.name }}</dd>
          <dt class="text-[var(--text-muted)]">Correo</dt>
          <dd class="break-all">{{ view.requester.email }}</dd>
          <template v-if="view.requester.phone">
            <dt class="text-[var(--text-muted)]">Teléfono</dt>
            <dd>{{ view.requester.phone }}</dd>
          </template>
          <template v-if="view.declaredOrderReference">
            <dt class="text-[var(--text-muted)]">Pedido que indica</dt>
            <dd>
              {{ view.declaredOrderReference }}
              <span class="adm-help block">Lo ha escrito el cliente; no está comprobado que sea suyo.</span>
            </dd>
          </template>
        </dl>
      </AdminCard>
      <SupportTicketFacts :snapshot="view" administrative />
      <UAlert
        v-if="view.ownerId && !view.staff.some((staff) => staff.id === view?.ownerId)"
        role="status"
        color="warning"
        variant="subtle"
        icon="i-lucide-user-x"
        title="El responsable anterior ya no puede atender consultas"
        description="Se conserva en el historial. Asigna la consulta a otra persona."
      />
      <AdminCard v-if="view.capabilities.manage && !intent" title="Responder o gestionar">
        <form class="adm-stack" @submit.prevent="prepare">
          <div class="adm-field">
            <label :for="`${uid}-action`" class="adm-label">Qué quieres hacer</label>
            <select :id="`${uid}-action`" v-model="form.action" data-testid="admin-support-action" class="w-full">
              <option value="reply">Responder al cliente</option>
              <option value="note">Añadir una nota interna</option>
              <option value="call">Anotar una llamada ya hecha</option>
              <option value="update">Cambiar estado, prioridad, responsable o fechas</option>
            </select>
            <p v-if="form.action === 'reply'" class="adm-help">
              El cliente verá esta respuesta. Si su contacto no está verificado, no incluyas datos privados de pedidos.
            </p>
            <p v-if="form.action === 'note' || form.action === 'call'" class="adm-help">
              Solo lo ve el equipo. Evita datos personales innecesarios y nunca guardes contraseñas.
            </p>
          </div>
          <div v-if="form.action !== 'update'" class="adm-field">
            <label :for="`${uid}-body`" class="adm-label">
              {{ form.action === 'reply' ? 'Respuesta' : form.action === 'call' ? 'Resumen de la llamada' : 'Nota' }}
            </label>
            <textarea
              :id="`${uid}-body`"
              v-model="form.message"
              data-testid="admin-support-body"
              required
              maxlength="5000"
              rows="5"
              :readonly="form.action === 'reply' && !!macroPreview"
              class="w-full"
            />
            <div v-if="form.action === 'reply' && macroPreview" class="flex flex-wrap items-center gap-2">
              <p class="adm-help">
                Texto de una respuesta guardada: no se puede editar aquí. Para personalizarlo, cambia sus campos y
                vuelve a previsualizarla.
              </p>
              <button type="button" class="adm-btn adm-btn--secondary adm-btn--sm" @click="discardMacro">
                Quitar y escribir a mano
              </button>
            </div>
          </div>
          <div v-if="form.action === 'update'" class="adm-form-grid">
            <div class="adm-field">
              <label :for="`${uid}-state`" class="adm-label">Estado</label>
              <select :id="`${uid}-state`" v-model="form.state" data-testid="admin-support-state" class="w-full">
                <option v-for="(label, state) in supportStateLabels" :key="state" :value="state">{{ label }}</option>
              </select>
            </div>
            <div class="adm-field">
              <label :for="`${uid}-priority`" class="adm-label">Prioridad</label>
              <select :id="`${uid}-priority`" v-model="form.priority" class="w-full">
                <option v-for="(label, priority) in supportPriorityLabels" :key="priority" :value="priority">
                  {{ label }}
                </option>
              </select>
            </div>
            <div class="adm-field">
              <label :for="`${uid}-owner`" class="adm-label">Responsable</label>
              <select :id="`${uid}-owner`" v-model="form.ownerId" class="w-full">
                <option value="">Sin asignar</option>
                <option v-for="staff in view.staff" :key="staff.id" :value="staff.id">{{ staff.label }}</option>
              </select>
            </div>
            <div class="adm-field">
              <label :for="`${uid}-sla`" class="adm-label">Plazo de respuesta (opcional)</label>
              <input :id="`${uid}-sla`" v-model="form.slaDueAt" type="datetime-local" class="adm-input w-full" />
            </div>
          </div>
          <div v-if="form.action === 'update'" class="adm-field">
            <label :for="`${uid}-resolution`" class="adm-label">Resumen para el cliente al resolver o cerrar</label>
            <textarea
              :id="`${uid}-resolution`"
              v-model="form.resolution"
              minlength="10"
              maxlength="1000"
              class="w-full"
            />
          </div>
          <div v-if="form.action === 'update' || form.action === 'call'" class="adm-form-grid">
            <div class="adm-field">
              <label :for="`${uid}-next`" class="adm-label">Próximo seguimiento (opcional)</label>
              <input :id="`${uid}-next`" v-model="form.nextActionAt" type="datetime-local" class="adm-input w-full" />
            </div>
            <div v-if="form.action === 'call'" class="adm-field">
              <label :for="`${uid}-occurred`" class="adm-label">Cuándo fue la llamada</label>
              <input
                :id="`${uid}-occurred`"
                v-model="form.occurredAt"
                required
                type="datetime-local"
                class="adm-input w-full"
              />
            </div>
          </div>
          <div class="adm-field">
            <label :for="`${uid}-reason`" class="adm-label">Motivo (queda en el historial interno)</label>
            <input
              :id="`${uid}-reason`"
              v-model="form.reason"
              data-testid="admin-support-reason"
              required
              minlength="3"
              maxlength="500"
              placeholder="Qué has hecho y cuál es el siguiente paso"
              class="w-full"
            />
          </div>
          <div class="flex justify-end">
            <button
              data-testid="admin-support-prepare"
              :disabled="busy || escalationPending"
              class="adm-btn adm-btn--primary"
            >
              Continuar
            </button>
          </div>
        </form>
      </AdminCard>
      <AdminSupportMacrosPanel
        v-if="view.capabilities.manage && !intent"
        :public-ref="publicRef"
        :operator-id="operatorId"
        :runtime="runtime"
        :authorize="authorize"
        @selected="selectMacro"
      />
      <AdminCard
        v-if="view.capabilities.attachments && !intent"
        title="Adjuntar un archivo"
        description="Imagen JPEG o PNG, o un PDF, de 10 MB como máximo."
      >
        <div class="adm-form-grid">
          <div class="adm-field">
            <label :for="`${uid}-file`" class="adm-label">Archivo</label>
            <input :id="`${uid}-file`" type="file" accept="image/png,image/jpeg,application/pdf" @change="chooseFile" />
          </div>
          <div class="adm-field">
            <label :for="`${uid}-visibility`" class="adm-label">Quién lo ve</label>
            <select :id="`${uid}-visibility`" v-model="visibility" class="w-full">
              <option value="public">El cliente y el equipo</option>
              <option value="internal">Solo el equipo</option>
            </select>
          </div>
        </div>
        <template #footer>
          <button
            type="button"
            :disabled="busy || escalationPending || !file"
            class="adm-btn adm-btn--secondary"
            @click="prepareAttachment()"
          >
            Adjuntar
          </button>
        </template>
      </AdminCard>
    </div>
    <AdminCard
      v-if="intent && command.authorize()"
      :title="ambiguous ? 'No sabemos si se ha guardado' : 'Revisa y confirma'"
      :description="
        ambiguous
          ? 'La conexión falló al enviar. Recupera el mismo envío para no duplicarlo.'
          : 'Todavía no se ha enviado nada. Al confirmar se guardará tal como lo has escrito.'
      "
    >
      <div class="flex flex-wrap justify-end gap-2">
        <button
          v-if="!ambiguous"
          type="button"
          :disabled="busy"
          class="adm-btn adm-btn--secondary"
          @click="command.cancel()"
        >
          Cancelar
        </button>
        <button
          v-if="!ambiguous"
          type="button"
          data-testid="admin-support-send"
          :disabled="busy || escalationPending"
          class="adm-btn adm-btn--primary"
          @click="command.dispatch()"
        >
          Confirmar y guardar
        </button>
        <button
          v-else
          type="button"
          data-testid="admin-support-recover"
          :disabled="busy || escalationPending"
          class="adm-btn adm-btn--primary"
          @click="command.dispatch(true)"
        >
          Recuperar el envío
        </button>
      </div>
    </AdminCard>
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
