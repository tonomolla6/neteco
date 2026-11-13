<script setup lang="ts">
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import {
  cmsPublicationInputSchema,
  cmsPublicationReceiptSchema,
  cmsPublicationStateSchema,
  type CmsPublicationInput,
  type CmsPublicationState,
  type CmsPublicationAction
} from '~~/shared/cms-publication'
import ContentPreviewPanel from './ContentPreviewPanel.vue'
const props = defineProps<{ pageId: string; runtime: unknown; operatorId: string; authorize: () => boolean }>()
const emit = defineEmits<{ pending: [value: boolean] }>()
const requestFetch = useRequestFetch(),
  snapshot = shallowRef<CmsPublicationState | null>(null),
  loading = ref(false),
  busy = ref(false),
  message = ref(''),
  previewUrl = ref(''),
  reason = ref(''),
  device = ref<'responsive' | 'desktop' | 'mobile'>('responsive'),
  publishAtLocal = ref(''),
  unpublishAtLocal = ref(''),
  repeatedHour = ref<'earlier' | 'later'>('later')
type Intent = Readonly<{
  key: string
  payload: string
  input: CmsPublicationInput
  pageId: string
  operatorId: string
  path: string
}>
const intent = shallowRef<Intent | null>(null)
const DEVICE_NAMES: Record<'responsive' | 'desktop' | 'mobile', string> = {
  responsive: 'Adaptable',
  desktop: 'Escritorio',
  mobile: 'Móvil'
}
let active = true,
  generation = 0
function authorized() {
  try {
    return (
      active &&
      props.runtime === 'cloudflare' &&
      catalogPolicyUuidSchema.safeParse(props.pageId).success &&
      catalogPolicyUuidSchema.safeParse(props.operatorId).success &&
      props.authorize() === true
    )
  } catch {
    return false
  }
}
function current(epoch: number, actor: string, page: string) {
  return active && epoch === generation && authorized() && actor === props.operatorId && page === props.pageId
}
async function read() {
  if (!authorized()) throw new Error('cms_publication_access_unconfirmed')
  const epoch = generation,
    actor = props.operatorId,
    page = props.pageId
  loading.value = true
  snapshot.value = null
  try {
    const raw: unknown = await requestFetch(`/api/admin/content/pages/${page}/publication`, {
      method: 'GET',
      retry: 0,
      cache: 'no-store'
    })
    if (!current(epoch, actor, page)) throw new Error('cms_publication_access_changed')
    const parsed = cmsPublicationStateSchema.safeParse(raw)
    if (!parsed.success || parsed.data.pageId !== page) throw new Error('cms_publication_source_unconfirmed')
    snapshot.value = parsed.data
    return parsed.data
  } finally {
    if (active && epoch === generation) loading.value = false
  }
}
function refresh() {
  if (!authorized() || busy.value) return
  void read().catch(() => {
    message.value = 'No hay estado editorial confirmado. Esto no significa que no haya publicación o programación.'
  })
}
watch(
  () => [props.pageId, props.runtime, props.operatorId, props.authorize()],
  () => {
    generation++
    snapshot.value = null
    previewUrl.value = ''
    if (intent.value)
      message.value = 'Ha cambiado el acceso. Se conserva el intento original y no se repetirá automáticamente.'
    if (authorized()) refresh()
  },
  { immediate: true }
)
watch(intent, (value) => emit('pending', value !== null), { flush: 'sync' })
onBeforeUnmount(() => {
  active = false
  generation++
  snapshot.value = null
  previewUrl.value = ''
})
function capability(data: CmsPublicationState, action: CmsPublicationAction) {
  return (
    data.capabilities[
      action === 'revoke_preview' ? 'revokePreview' : action === 'cancel_schedule' ? 'schedule' : action
    ] === true
  )
}
function prepare(action: CmsPublicationAction, previewId?: string) {
  const state = snapshot.value
  if (!authorized() || busy.value || loading.value || intent.value || !state || !capability(state, action)) return
  const base = { action, expectedRevision: state.revision, expectedVersion: state.pageVersion, reason: reason.value }
  const candidate =
    action === 'publish'
      ? { ...base, versionId: state.draftVersionId }
      : action === 'schedule'
        ? {
            ...base,
            versionId: state.draftVersionId,
            publishAtLocal: publishAtLocal.value || null,
            unpublishAtLocal: unpublishAtLocal.value || null,
            repeatedHour: repeatedHour.value
          }
        : action === 'preview'
          ? { ...base, versionId: state.draftVersionId, device: device.value, segment: 'default' }
          : action === 'revoke_preview'
            ? { ...base, previewId }
            : base
  const parsed = cmsPublicationInputSchema.safeParse(candidate)
  if (!parsed.success) {
    message.value = 'Indica un motivo de 3–500 caracteres y los datos editoriales completos.'
    return
  }
  intent.value = Object.freeze({
    key: crypto.randomUUID(),
    payload: JSON.stringify(parsed.data),
    input: Object.freeze(parsed.data),
    pageId: props.pageId,
    operatorId: props.operatorId,
    path: `/api/admin/content/pages/${props.pageId}/${action.replaceAll('_', '-')}`
  })
  message.value = 'Solicitud preparada. Confirma el envío explícitamente.'
}
function cancel() {
  if (!busy.value && intent.value && message.value === 'Solicitud preparada. Confirma el envío explícitamente.')
    intent.value = null
}
async function send() {
  const pending = intent.value
  if (
    !pending ||
    busy.value ||
    !authorized() ||
    pending.operatorId !== props.operatorId ||
    pending.pageId !== props.pageId
  )
    return
  busy.value = true
  const epoch = generation,
    actor = props.operatorId,
    page = props.pageId
  let sent = false,
    code = ''
  try {
    const state = await read()
    if (!current(epoch, actor, page) || !capability(state, pending.input.action))
      throw new Error('cms_publication_authority_changed')
    // A retry deliberately preserves the original body/key; historical replay may
    // succeed after the release head has advanced. The server owns CAS/idempotency.
    const raw: unknown = await requestFetch(pending.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': pending.key },
      body: pending.payload,
      retry: 0,
      onRequest() {
        sent = true
      },
      onResponseError(context: unknown) {
        if (
          context &&
          typeof context === 'object' &&
          'response' in context &&
          context.response &&
          typeof context.response === 'object' &&
          '_data' in context.response
        ) {
          const body = context.response._data
          if (
            body &&
            typeof body === 'object' &&
            'error' in body &&
            body.error &&
            typeof body.error === 'object' &&
            'code' in body.error &&
            typeof body.error.code === 'string'
          )
            code = body.error.code
        }
      }
    })
    if (!current(epoch, actor, page)) return
    const parsed = cmsPublicationReceiptSchema.safeParse(raw)
    if (
      !parsed.success ||
      parsed.data.action !== pending.input.action ||
      parsed.data.pageId !== pending.pageId ||
      parsed.data.revision !== pending.input.expectedRevision + 1
    )
      throw new Error('cms_publication_receipt_unconfirmed')
    const receipt = parsed.data
    intent.value = null
    message.value = 'Recibo editorial confirmado y auditado.'
    reason.value = ''
    const fresh = await read()
    if (!current(epoch, actor, page)) return
    if (fresh.revision < receipt.revision) throw new Error('cms_publication_read_stale')
    message.value = 'Operación editorial confirmada y estado vigente consultado.'
    if (receipt.action === 'preview' && receipt.url) {
      const preview = fresh.previews.find((p) => p.id === receipt.previewId)
      if (preview && !preview.revoked && Date.parse(preview.expiresAt) > Date.now()) previewUrl.value = receipt.url
      else message.value = 'Recibo histórico confirmado; la vista previa ya no está vigente.'
    }
    if (receipt.action === 'revoke_preview' || receipt.action === 'withdraw') previewUrl.value = ''
  } catch {
    if (current(epoch, actor, page)) {
      const rejected = [
        'invalid_input',
        'invalid_schedule',
        'version_conflict',
        'idempotency_conflict',
        'draft_not_editable',
        'not_found',
        'media_blocked',
        'feature_unavailable',
        'preview_unavailable',
        'media_unavailable'
      ].includes(code)
      if (rejected) {
        intent.value = null
        message.value = 'Solicitud rechazada sin confirmación de cambio. Consulta el estado y prepara un nuevo intento.'
      } else
        message.value = intent.value
          ? sent
            ? 'No hay confirmación: el envío pudo guardarse. Recupera manualmente el mismo intento, con su payload y clave originales.'
            : 'No se ha enviado. Confirma el acceso y conserva el intento original.'
          : 'El recibo es histórico; no se ha podido confirmar el estado vigente.'
    }
  } finally {
    if (active) busy.value = false
  }
}
</script>
<template>
  <section aria-label="Publicación editorial" class="adm-stack">
    <UAlert
      v-if="!authorized()"
      role="alert"
      color="warning"
      variant="subtle"
      icon="i-lucide-lock"
      title="Confirma tu sesión, tu correo y la verificación en dos pasos antes de consultar o recuperar la publicación."
    />
    <UAlert
      v-if="message"
      role="status"
      :color="intent ? 'warning' : 'neutral'"
      variant="subtle"
      :icon="intent ? 'i-lucide-triangle-alert' : 'i-lucide-info'"
      :title="message"
    />
    <div v-if="intent" class="flex flex-wrap gap-2">
      <button
        data-testid="cms-publication-confirm"
        type="button"
        class="adm-btn adm-btn--primary"
        :disabled="busy || !authorized() || intent.operatorId !== operatorId || intent.pageId !== pageId"
        @click="send"
      >
        Confirmar el envío
      </button>
      <button type="button" class="adm-btn adm-btn--secondary" :disabled="busy" @click="cancel">
        Cancelar (solo antes de enviar)
      </button>
    </div>

    <AdminCard
      title="Estado de la publicación"
      description="Guardar o restaurar un borrador no cambia lo publicado. Cada envío pide un motivo y una confirmación."
    >
      <template #actions>
        <button
          data-testid="cms-publication-refresh"
          type="button"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          :disabled="!authorized() || loading || busy"
          @click="refresh"
        >
          Actualizar
        </button>
      </template>
      <p v-if="loading" role="status" class="adm-help">Consultando el estado de la publicación…</p>
      <div v-else-if="snapshot && authorized()" class="adm-stack">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <AdminBadge :tone="snapshot.publication ? 'success' : 'neutral'">
            {{ snapshot.publication ? 'Publicación activa' : 'Sin publicación activa' }}
          </AdminBadge>
          <span v-if="snapshot.publication" class="adm-help break-all">
            /{{ snapshot.publication.slug }} · desde el {{ adminDate(snapshot.publication.publishedAt, true) }}
          </span>
        </div>
        <p v-if="snapshot.schedule">
          Programación aprobada: se publica
          {{ snapshot.schedule.publishAt ? `el ${adminDate(snapshot.schedule.publishAt, true)}` : 'sin fecha' }} y se
          retira
          {{ snapshot.schedule.unpublishAt ? `el ${adminDate(snapshot.schedule.unpublishAt, true)}` : 'sin fecha' }}.
          <span v-if="snapshot.schedule.lastError" role="alert" class="font-semibold text-red-700">
            Bloqueada: {{ snapshot.schedule.lastError }}
          </span>
        </p>
      </div>
      <p v-else-if="authorized()" class="adm-help">
        Todavía no se ha podido confirmar el estado. Pulsa «Actualizar» para consultarlo.
      </p>
    </AdminCard>

    <template v-if="snapshot && authorized()">
      <AdminCard title="Publicar o retirar">
        <div class="adm-stack">
          <AdminFormField v-slot="{ id }" label="Motivo" help="Entre 3 y 500 caracteres. Se guarda con cada envío.">
            <input :id="id" v-model="reason" :disabled="busy || !!intent" maxlength="500" />
          </AdminFormField>
          <div class="flex flex-wrap gap-2">
            <button
              v-if="snapshot.capabilities.publish"
              data-testid="cms-publish"
              type="button"
              class="adm-btn adm-btn--primary"
              :disabled="busy || loading || !!intent"
              @click="prepare('publish')"
            >
              Publicar el borrador
            </button>
            <button
              v-if="snapshot.capabilities.withdraw && snapshot.publication"
              data-testid="cms-withdraw"
              type="button"
              class="adm-btn adm-btn--danger-soft"
              :disabled="busy || loading || !!intent"
              @click="prepare('withdraw')"
            >
              Retirar la publicación
            </button>
            <button
              v-if="snapshot.capabilities.schedule && snapshot.schedule"
              data-testid="cms-cancel-schedule"
              type="button"
              class="adm-btn adm-btn--secondary"
              :disabled="busy || loading || !!intent"
              @click="prepare('cancel_schedule')"
            >
              Cancelar la programación
            </button>
          </div>
        </div>
      </AdminCard>

      <AdminCard
        v-if="snapshot.capabilities.schedule"
        title="Programar"
        description="Fechas y horas en horario peninsular (Europe/Madrid)."
      >
        <fieldset :disabled="busy || !!intent" class="adm-stack min-w-0">
          <legend class="sr-only">Programación en horario peninsular</legend>
          <div class="adm-form-grid">
            <AdminFormField v-slot="{ id }" label="Publicar el">
              <input :id="id" v-model="publishAtLocal" type="datetime-local" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Retirar el">
              <input :id="id" v-model="unpublishAtLocal" type="datetime-local" />
            </AdminFormField>
            <AdminFormField
              v-slot="{ id }"
              label="Si la hora se repite"
              help="Solo afecta a la noche del cambio de hora de otoño."
            >
              <select :id="id" v-model="repeatedHour">
                <option value="later">Usar la segunda vez</option>
                <option value="earlier">Usar la primera vez</option>
              </select>
            </AdminFormField>
          </div>
          <div>
            <button
              data-testid="cms-schedule"
              type="button"
              class="adm-btn adm-btn--secondary"
              @click="prepare('schedule')"
            >
              Programar
            </button>
          </div>
        </fieldset>
      </AdminCard>

      <AdminCard title="Vista previa privada" description="Un enlace privado que caduca a los 30 minutos.">
        <div class="adm-stack">
          <fieldset v-if="snapshot.capabilities.preview" :disabled="busy || !!intent" class="min-w-0">
            <legend class="sr-only">Vista previa privada de 30 minutos</legend>
            <div class="flex flex-wrap items-end gap-2">
              <AdminFormField v-slot="{ id }" label="Tamaño de pantalla">
                <select :id="id" v-model="device">
                  <option value="responsive">Adaptable</option>
                  <option value="desktop">Escritorio (1024 px)</option>
                  <option value="mobile">Móvil (375 px)</option>
                </select>
              </AdminFormField>
              <button
                data-testid="cms-preview"
                type="button"
                class="adm-btn adm-btn--secondary"
                @click="prepare('preview')"
              >
                Crear vista previa
              </button>
            </div>
          </fieldset>
          <p v-else class="adm-help">La vista previa no está disponible: falta configurarla o no tienes permiso.</p>
          <ul v-if="snapshot.previews.length" class="adm-list">
            <li v-for="preview in snapshot.previews" :key="preview.id">
              <div class="min-w-0 flex-1">
                <p class="adm-list__title">
                  {{ DEVICE_NAMES[preview.device] }}
                  <AdminBadge :tone="preview.revoked ? 'neutral' : 'info'" plain>
                    {{ preview.revoked ? 'Anulada' : 'Creada' }}
                  </AdminBadge>
                </p>
                <p class="adm-help">Caduca el {{ adminDate(preview.expiresAt, true) }}</p>
              </div>
              <button
                v-if="snapshot.capabilities.revokePreview && !preview.revoked"
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="busy || !!intent"
                @click="prepare('revoke_preview', preview.id)"
              >
                Anular
              </button>
            </li>
          </ul>
        </div>
      </AdminCard>
    </template>
    <ContentPreviewPanel v-if="previewUrl && authorized()" :url="previewUrl" />
  </section>
</template>
