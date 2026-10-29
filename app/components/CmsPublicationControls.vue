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
  <section aria-label="Publicación editorial" class="space-y-4 rounded-xl border border-slate-300 p-4">
    <h2 class="text-lg font-semibold">Publicación, programación y vista previa</h2>
    <p>Guardar o restaurar un borrador no modifica la publicación. Cada envío requiere motivo y confirmación.</p>
    <p v-if="!authorized()" role="alert">
      Confirma sesión, correo y MFA antes de consultar o recuperar la operación editorial.
    </p>
    <button
      data-testid="cms-publication-refresh"
      type="button"
      :disabled="!authorized() || loading || busy"
      @click="refresh"
    >
      Consultar estado editorial
    </button>
    <p v-if="loading" role="status">Confirmando estado editorial…</p>
    <template v-if="snapshot && authorized()">
      <p>
        Revisión editorial {{ snapshot.revision }} ·
        {{ snapshot.publication ? 'Publicación activa' : 'Sin publicación activa' }}
      </p>
      <p v-if="snapshot.publication">
        Slug publicado: {{ snapshot.publication.slug }} · {{ snapshot.publication.publishedAt }}
      </p>
      <p v-if="snapshot.schedule">
        Programación aprobada: {{ snapshot.schedule.publishAt || 'sin publicación' }} /
        {{ snapshot.schedule.unpublishAt || 'sin retirada' }}
        <span v-if="snapshot.schedule.lastError" role="alert">Bloqueada: {{ snapshot.schedule.lastError }}</span>
      </p>
      <label class="block"
        >Motivo editorial
        <input v-model="reason" :disabled="busy || !!intent" maxlength="500" class="block w-full rounded border p-2"
      /></label>
      <div class="flex flex-wrap gap-3">
        <button
          v-if="snapshot.capabilities.publish"
          data-testid="cms-publish"
          :disabled="busy || loading || !!intent"
          @click="prepare('publish')"
        >
          Publicar borrador confirmado
        </button>
        <button
          v-if="snapshot.capabilities.withdraw && snapshot.publication"
          data-testid="cms-withdraw"
          :disabled="busy || loading || !!intent"
          @click="prepare('withdraw')"
        >
          Retirar publicación
        </button>
        <button
          v-if="snapshot.capabilities.schedule && snapshot.schedule"
          data-testid="cms-cancel-schedule"
          :disabled="busy || loading || !!intent"
          @click="prepare('cancel_schedule')"
        >
          Cancelar programación
        </button>
      </div>
      <fieldset v-if="snapshot.capabilities.schedule" :disabled="busy || !!intent" class="space-y-2">
        <legend>Calendario Europe/Madrid</legend>
        <label>Publicar <input v-model="publishAtLocal" type="datetime-local" /></label>
        <label>Retirar <input v-model="unpublishAtLocal" type="datetime-local" /></label>
        <label
          >Hora repetida
          <select v-model="repeatedHour">
            <option value="later">Segunda ocurrencia</option>
            <option value="earlier">Primera ocurrencia</option>
          </select></label
        >
        <button data-testid="cms-schedule" @click="prepare('schedule')">Preparar programación</button>
      </fieldset>
      <fieldset v-if="snapshot.capabilities.preview" :disabled="busy || !!intent">
        <legend>Vista previa privada de 30 minutos</legend>
        <select v-model="device">
          <option value="responsive">Adaptable</option>
          <option value="desktop">Escritorio (1024 px)</option>
          <option value="mobile">Móvil (375 px)</option>
        </select>
        <button data-testid="cms-preview" @click="prepare('preview')">Preparar vista previa</button>
      </fieldset>
      <p v-else>Vista previa desactivada: falta configuración dedicada o autorización.</p>
      <ul>
        <li v-for="preview in snapshot.previews" :key="preview.id">
          {{ preview.device }} · caduca {{ preview.expiresAt }} · {{ preview.revoked ? 'revocada' : 'emitida' }}
          <button
            v-if="snapshot.capabilities.revokePreview && !preview.revoked"
            :disabled="busy || !!intent"
            @click="prepare('revoke_preview', preview.id)"
          >
            Revocar
          </button>
        </li>
      </ul>
    </template>
    <p v-if="message" role="status">{{ message }}</p>
    <div v-if="intent" class="flex gap-3">
      <button
        data-testid="cms-publication-confirm"
        :disabled="busy || !authorized() || intent.operatorId !== operatorId || intent.pageId !== pageId"
        @click="send"
      >
        Confirmar / recuperar mismo intento</button
      ><button :disabled="busy" @click="cancel">Cancelar sólo antes del envío</button>
    </div>
    <ContentPreviewPanel v-if="previewUrl && authorized()" :url="previewUrl" />
  </section>
</template>
