<script setup lang="ts">
import { z as zod, type z } from 'zod'
import {
  newsletterAdminSnapshotSchema,
  newsletterAdminInputSchema,
  newsletterCommandReceiptSchema,
  newsletterPreviewSchema,
  newsletterDispatchReportSchema,
  newsletterPrecommitRejectionSchema,
  newsletterHttpAuthorityLossSchema,
  type NewsletterAdminInput
} from '~~/shared/newsletter-editorial'
import NewsletterCampaignPreview from './NewsletterCampaignPreview.vue'
const props = defineProps<{ actorId: string; authorize: () => boolean }>(),
  fetch = useRequestFetch()
const snapshot = ref<z.infer<typeof newsletterAdminSnapshotSchema> | null>(null),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  preview = ref<z.infer<typeof newsletterPreviewSchema> | null>(null),
  report = ref<z.infer<typeof newsletterDispatchReportSchema> | null>(null)
const selected = ref(''),
  topicId = ref(''),
  cursor = ref<string | undefined>(),
  reason = ref('')
const policy = reactive({
  name: '',
  immediate: '',
  weekly: '',
  monthly: '',
  ratio: '',
  quiet: false,
  start: '',
  end: ''
})
const topic = reactive({ code: '', label: '', active: true })
type Block = {
  id: string
  type: 'heading' | 'paragraph' | 'link'
  kind: 'editorial' | 'commercial'
  text: string
  label: string
  targetType: 'static' | 'cms' | 'product'
  target: string
}
const document = reactive({
  name: '',
  subject: '',
  topics: [] as string[],
  topicMatch: 'any' as 'any' | 'all',
  frequencies: [] as Array<'immediate' | 'weekly' | 'monthly'>,
  changeSummary: '',
  blocks: [] as Block[]
})
const windowForm = reactive({ start: '', end: '', repeated: 'earlier' as 'earlier' | 'later' })
const pending = ref<{
  path: string
  method: 'POST' | 'PUT'
  body: NewsletterAdminInput
  key: string
  actor: string
  target: string | null
} | null>(null)
const campaign = computed(() => snapshot.value?.campaigns.find((c) => c.id === selected.value) ?? null)
const canOperate = computed(
  () => props.authorize() && !!props.actorId && !busy.value && !pending.value && !!snapshot.value
)
let epoch = 0
const minute = (value: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(value)
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1
}
function topicEditing(id: string) {
  const current = snapshot.value?.topics.find((t) => t.id === id)
  if (!current) return
  topicId.value = id
  topic.code = current.code
  topic.label = current.label
  topic.active = current.active
}
function newTopic() {
  topicId.value = ''
  topic.code = ''
  topic.label = ''
  topic.active = true
}
function newCampaign() {
  selected.value = ''
  preview.value = null
  report.value = null
  document.name = ''
  document.subject = ''
  document.topics = []
  document.frequencies = []
  document.topicMatch = 'any'
  document.changeSummary = ''
  document.blocks = []
}
function clearPrivate() {
  snapshot.value = null
  pending.value = null
  preview.value = null
  report.value = null
  busy.value = false
  notice.value = ''
  reason.value = ''
  cursor.value = undefined
  newCampaign()
  newTopic()
  Object.assign(policy, {
    name: '',
    immediate: '',
    weekly: '',
    monthly: '',
    ratio: '',
    quiet: false,
    start: '',
    end: ''
  })
  Object.assign(windowForm, { start: '', end: '', repeated: 'earlier' })
}
function selectCampaign(id: string) {
  const c = snapshot.value?.campaigns.find((row) => row.id === id)
  if (!c) return
  selected.value = id
  preview.value = null
  report.value = null
  document.name = c.document.name
  document.subject = c.document.subject
  document.topics = [...c.document.topics]
  document.topicMatch = c.document.topicMatch
  document.frequencies = [...c.document.frequencies]
  document.changeSummary = ''
  document.blocks = c.document.blocks.map((b) => ({
    id: b.id,
    type: b.type,
    kind: b.kind,
    text: b.type === 'link' ? '' : b.text,
    label: b.type === 'link' ? b.label : '',
    targetType: b.type === 'link' ? b.target.type : 'static',
    target: b.type === 'link' ? (b.target.type === 'static' ? b.target.path : b.target.slug) : '/catalogo'
  }))
}
function addBlock() {
  document.blocks.push({
    id: crypto.randomUUID(),
    type: 'paragraph',
    kind: 'editorial',
    text: '',
    label: '',
    targetType: 'static',
    target: '/catalogo'
  })
}
async function load(next?: string) {
  const turn = ++epoch,
    actor = props.actorId
  if (!props.authorize() || !actor) {
    snapshot.value = null
    return
  }
  busy.value = true
  error.value = ''
  try {
    const data = newsletterAdminSnapshotSchema.parse(
      await fetch<unknown>('/api/admin/newsletter', {
        query: next ? { cursor: next } : {},
        onRequest: () => {
          if (!props.authorize() || props.actorId !== actor) throw new Error('authority_changed')
        }
      })
    )
    if (turn !== epoch || !props.authorize() || actor !== props.actorId) return
    snapshot.value = data
    cursor.value = next
    if (!pending.value && selected.value && !data.campaigns.some((c) => c.id === selected.value)) newCampaign()
  } catch (failure) {
    if (turn === epoch) {
      if (newsletterHttpAuthorityLossSchema.safeParse(failure).success || !props.authorize()) clearPrivate()
      snapshot.value = null
      error.value =
        'Lectura no confirmada. El servicio puede estar apagado o faltan permisos/MFA; no usamos datos anteriores para operar.'
    }
  } finally {
    if (turn === epoch) busy.value = false
  }
}
async function send() {
  const intent = pending.value
  if (!intent || busy.value || !props.authorize() || intent.actor !== props.actorId) return
  const turn = ++epoch
  busy.value = true
  error.value = ''
  try {
    const receipt = newsletterCommandReceiptSchema.parse(
      await fetch<unknown>(intent.path, {
        method: intent.method,
        body: intent.body,
        headers: { 'Idempotency-Key': intent.key },
        onRequest: () => {
          if (!props.authorize() || intent.actor !== props.actorId) throw new Error('authority_changed')
        }
      })
    )
    if (turn !== epoch || !props.authorize() || intent.actor !== props.actorId) return
    if (
      receipt.action !== intent.body.action ||
      receipt.revision !== intent.body.expectedRevision + 1 ||
      (intent.target && receipt.resourceId !== intent.target)
    )
      throw new Error('unconfirmed_receipt')
    pending.value = null
    notice.value = 'Comando confirmado por el servidor. La aprobación editorial no activa por sí sola el envío externo.'
    reason.value = ''
    preview.value = null
    const resource = receipt.resourceId
    busy.value = false
    await load(cursor.value)
    if (receipt.action === 'create_campaign' || receipt.action === 'update_campaign') selectCampaign(resource)
  } catch (failure) {
    if (turn === epoch) {
      if (newsletterHttpAuthorityLossSchema.safeParse(failure).success || !props.authorize()) {
        clearPrivate()
        error.value =
          'La sesión o MFA no autorizan esta lectura. Hemos retirado datos privados; actualiza el estado tras verificar tu acceso.'
      } else if (newsletterPrecommitRejectionSchema.safeParse(failure).success) {
        pending.value = null
        snapshot.value = null
        preview.value = null
        error.value =
          'El servidor ha rechazado el comando antes de guardarlo. Actualiza el estado confirmado antes de preparar otro comando.'
      } else
        error.value =
          'Resultado no confirmado. Conservamos exactamente petición y clave. Actualiza el estado o reintenta manualmente; no enviamos automáticamente otra versión.'
    }
  } finally {
    if (turn === epoch) busy.value = false
  }
}
function stage(path: string, method: 'POST' | 'PUT', raw: unknown, target: string | null = null) {
  if (!canOperate.value) return
  const parsed = newsletterAdminInputSchema.safeParse(raw)
  if (!parsed.success) {
    error.value = 'Revisa los campos obligatorios, los límites, los temas, el motivo y los bloques.'
    return
  }
  pending.value = { path, method, body: parsed.data, key: crypto.randomUUID(), actor: props.actorId, target }
  void send()
}
function savePolicy() {
  if ([policy.immediate, policy.weekly, policy.monthly, policy.ratio].some((value) => value.trim() === '')) {
    error.value = 'Completa explícitamente todos los límites y el porcentaje editorial.'
    return
  }
  stage('/api/admin/newsletter/policy', 'POST', {
    action: 'set_policy',
    expectedRevision: snapshot.value?.policyRevision,
    reason: reason.value,
    policy: {
      name: policy.name,
      reason: reason.value,
      intervalHours: {
        immediate: Number(policy.immediate),
        weekly: Number(policy.weekly),
        monthly: Number(policy.monthly)
      },
      quietHours: policy.quiet
        ? { startMinute: minute(policy.start), endMinute: minute(policy.end), timezone: 'Europe/Madrid' }
        : null,
      minEditorialPercent: Number(policy.ratio),
      locale: 'es'
    }
  })
}
function retirePolicy() {
  if (snapshot.value?.policy)
    stage('/api/admin/newsletter/policy', 'POST', {
      action: 'retire_policy',
      expectedRevision: snapshot.value.policyRevision,
      reason: reason.value
    })
}
function saveTopic() {
  const current = snapshot.value?.topics.find((t) => t.id === topicId.value)
  stage(
    `/api/admin/newsletter/topics${current ? `/${current.id}` : ''}`,
    current ? 'PUT' : 'POST',
    current
      ? {
          action: 'update_topic',
          expectedRevision: current.revision,
          label: topic.label,
          active: topic.active,
          reason: reason.value
        }
      : { action: 'create_topic', expectedRevision: 0, code: topic.code, label: topic.label, reason: reason.value },
    current?.id ?? null
  )
}
function saveCampaign() {
  const current = campaign.value
  const blocks = document.blocks.map((b) =>
    b.type === 'link'
      ? {
          id: b.id,
          type: b.type,
          kind: b.kind,
          label: b.label,
          target:
            b.targetType === 'static' ? { type: 'static', path: b.target } : { type: b.targetType, slug: b.target }
        }
      : { id: b.id, type: b.type, kind: b.kind, text: b.text }
  )
  stage(
    `/api/admin/newsletter/campaigns${current ? `/${current.id}` : ''}`,
    current ? 'PUT' : 'POST',
    {
      action: current ? 'update_campaign' : 'create_campaign',
      expectedRevision: current?.revision ?? 0,
      reason: reason.value,
      document: {
        name: document.name,
        subject: document.subject,
        topics: [...document.topics],
        topicMatch: document.topicMatch,
        frequencies: [...document.frequencies],
        locale: 'es',
        blocks,
        changeSummary: document.changeSummary
      }
    },
    current?.id ?? null
  )
}
function approve() {
  const c = campaign.value,
    p = snapshot.value?.policy
  if (!c || !p) return
  stage(
    `/api/admin/newsletter/campaigns/${c.id}/approve`,
    'POST',
    {
      action: 'approve_campaign',
      expectedRevision: c.revision,
      versionId: c.versionId,
      policyId: p.id,
      startsAtLocal: windowForm.start,
      endsAtLocal: windowForm.end,
      repeatedHour: windowForm.repeated,
      reason: reason.value
    },
    c.id
  )
}
function cancel() {
  const c = campaign.value
  if (c)
    stage(
      `/api/admin/newsletter/campaigns/${c.id}/cancel`,
      'POST',
      { action: 'cancel_campaign', expectedRevision: c.revision, reason: reason.value },
      c.id
    )
}
async function execute(action: 'preview' | 'test' | 'dispatch') {
  const c = campaign.value
  if (!c || !canOperate.value) return
  const turn = ++epoch,
    actor = props.actorId
  busy.value = true
  error.value = ''
  try {
    const data = await fetch<unknown>(`/api/admin/newsletter/campaigns/${c.id}/${action}`, {
      method: action === 'preview' ? 'GET' : 'POST',
      ...(action === 'preview' ? {} : { body: {} }),
      onRequest: () => {
        if (!props.authorize() || actor !== props.actorId) throw new Error('authority_changed')
      }
    })
    if (turn !== epoch || !props.authorize() || actor !== props.actorId) return
    if (action === 'preview') {
      const result = newsletterPreviewSchema.parse(data)
      if (result.campaignId !== c.id || result.versionId !== c.versionId) throw new Error('stale_preview')
      preview.value = result
    } else if (action === 'dispatch') {
      report.value = newsletterDispatchReportSchema.parse(data)
      busy.value = false
      await load(cursor.value)
    } else {
      const result = zTest.safeParse(data)
      if (!result.success) throw new Error('unconfirmed')
      notice.value = 'Prueba sintética aceptada por el sender local. No acredita entrega externa.'
    }
  } catch (failure) {
    if (turn === epoch && (newsletterHttpAuthorityLossSchema.safeParse(failure).success || !props.authorize()))
      clearPrivate()
    if (turn === epoch)
      error.value =
        'Acción no confirmada o deshabilitada por el servidor. No se reintentará automáticamente; consulta los resultados de la cola.'
  } finally {
    if (turn === epoch) busy.value = false
  }
}
const zTest = zod
  .object({
    source: zod.literal('cloudflare'),
    synthetic: zod.literal(true),
    externalDelivery: zod.literal(false),
    acceptedLocal: zod.literal(true),
    delivered: zod.literal(false)
  })
  .strict()
watch(
  () => [props.actorId, props.authorize()],
  () => {
    epoch++
    clearPrivate()
    error.value = ''
    if (props.authorize()) void load()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  epoch++
})
</script>
<template>
  <section aria-label="Newsletter editorial" class="space-y-6">
    <p>
      Segmentación únicamente por temas y frecuencia explícitos. La aprobación fija una versión y una política; cambiar
      o retirar la política bloquea sus envíos futuros. No implica aprobación legal, DNS ni entrega del proveedor.
    </p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <button type="button" :disabled="busy || !props.authorize()" @click="load(cursor)">
      Actualizar estado confirmado
    </button>
    <div v-if="pending" class="rounded border p-3">
      <p>Comando pendiente de confirmar. El reintento conserva contenido y clave.</p>
      <button type="button" :disabled="busy || !props.authorize()" @click="send">Reintentar mismo comando</button>
    </div>
    <template v-if="snapshot">
      <p>
        {{
          snapshot.capabilities.externalDelivery
            ? 'Entrega externa habilitada explícitamente en el servidor.'
            : snapshot.capabilities.localDispatch
              ? 'Sólo sender local sintético habilitado.'
              : 'Entrega desactivada.'
        }}
      </p>
      <label
        >Motivo editorial obligatorio
        <textarea
          v-model="reason"
          :disabled="!canOperate"
          aria-label="Motivo editorial"
          minlength="3"
          maxlength="500"
        />
      </label>
      <section class="space-y-3 rounded border p-4">
        <h2 class="text-xl font-semibold">Política gobernante</h2>
        <p v-if="snapshot.policy">
          {{ snapshot.policy.document.name }} · Revisión {{ snapshot.policyRevision }} · Mínimo editorial
          {{ snapshot.policy.document.minEditorialPercent }} % · Intervalos
          {{ snapshot.policy.document.intervalHours.immediate }} / {{ snapshot.policy.document.intervalHours.weekly }} /
          {{ snapshot.policy.document.intervalHours.monthly }} horas.
        </p>
        <p v-else>No existe una política aprobada. Ningún límite se aprueba por defecto.</p>
        <form @submit.prevent="savePolicy">
          <fieldset :disabled="!canOperate" class="grid gap-3 sm:grid-cols-2">
            <label>Nombre <input v-model="policy.name" required minlength="3" /></label
            ><label
              >Mínimo editorial (%) <input v-model="policy.ratio" type="number" min="0" max="100" required /></label
            ><label
              >Al publicarse: intervalo mínimo (h)
              <input v-model="policy.immediate" type="number" min="1" max="8760" required /></label
            ><label
              >Semanal: intervalo mínimo (h)
              <input v-model="policy.weekly" type="number" min="168" max="8760" required /></label
            ><label
              >Mensual: intervalo mínimo (h)
              <input v-model="policy.monthly" type="number" min="744" max="8760" required /></label
            ><label><input v-model="policy.quiet" type="checkbox" /> Horas de silencio en Madrid</label
            ><template v-if="policy.quiet"
              ><label>Desde <input v-model="policy.start" type="time" required /></label
              ><label>Hasta <input v-model="policy.end" type="time" required /></label></template
            ><button type="submit">Aprobar nueva política explícita</button
            ><button type="button" :disabled="!snapshot.policy" @click="retirePolicy">
              Retirar política y bloquear envíos
            </button>
          </fieldset>
        </form>
      </section>
      <section class="space-y-3 rounded border p-4">
        <h2 class="text-xl font-semibold">Temas explícitos</h2>
        <ul>
          <li v-for="t in snapshot.topics" :key="t.id">
            {{ t.label }} ({{ t.code }}) · {{ t.active ? 'activo' : 'retirado' }} · r{{ t.revision }}
            <button type="button" :disabled="!canOperate" @click="topicEditing(t.id)">Editar tema</button>
          </li>
        </ul>
        <form @submit.prevent="saveTopic">
          <fieldset :disabled="!canOperate">
            <label>Código <input v-model="topic.code" :disabled="!!topicId" required /></label
            ><label>Etiqueta <input v-model="topic.label" required minlength="3" /></label
            ><label v-if="topicId"><input v-model="topic.active" type="checkbox" /> Activo</label
            ><button type="submit">Guardar tema</button><button type="button" @click="newTopic">Nuevo tema</button>
          </fieldset>
        </form>
      </section>
      <section class="space-y-3">
        <h2 class="text-xl font-semibold">Campañas versionadas</h2>
        <button type="button" :disabled="!canOperate" @click="newCampaign">Nueva campaña</button>
        <ul>
          <li v-for="c in snapshot.campaigns" :key="c.id">
            <button type="button" :disabled="!canOperate" @click="selectCampaign(c.id)">{{ c.document.name }}</button> ·
            {{ c.status }} · r{{ c.revision }} · aceptados {{ c.totals.accepted }} / feedback entregados
            {{ c.totals.delivered }} / rebotes {{ c.totals.bounced }} / quejas {{ c.totals.complained }} / revisión
            manual {{ c.totals.manualReview }} / pendientes {{ c.totals.pending + c.totals.leased + c.totals.sending }}
          </li>
        </ul>
        <button v-if="snapshot.nextCursor" type="button" :disabled="!canOperate" @click="load(snapshot.nextCursor)">
          Siguiente página de campañas</button
        ><button v-if="cursor" type="button" :disabled="!canOperate" @click="load()">Primera página</button>
        <form @submit.prevent="saveCampaign">
          <fieldset :disabled="!canOperate || (!!campaign && campaign.status !== 'draft')" class="space-y-3">
            <label>Nombre <input v-model="document.name" required minlength="3" /></label
            ><label>Asunto <input v-model="document.subject" required minlength="3" maxlength="160" /></label>
            <fieldset>
              <legend>Frecuencias elegibles</legend>
              <label><input v-model="document.frequencies" type="checkbox" value="immediate" /> Al publicarse</label
              ><label><input v-model="document.frequencies" type="checkbox" value="weekly" /> Semanal</label
              ><label><input v-model="document.frequencies" type="checkbox" value="monthly" /> Mensual</label>
            </fieldset>
            <fieldset>
              <legend>Temas de la campaña (vacío = general)</legend>
              <label v-for="t in snapshot.topics.filter((t) => t.active)" :key="t.id"
                ><input v-model="document.topics" type="checkbox" :value="t.code" /> {{ t.label }}</label
              ><label
                >Coincidencia
                <select v-model="document.topicMatch">
                  <option value="any">Algún tema</option>
                  <option value="all">Todos los temas</option>
                </select></label
              >
            </fieldset>
            <div v-for="(b, index) in document.blocks" :key="b.id" class="space-y-2 rounded border p-3">
              <label
                >Tipo
                <select v-model="b.type">
                  <option value="heading">Título</option>
                  <option value="paragraph">Párrafo</option>
                  <option value="link">Enlace interno</option>
                </select></label
              ><label
                >Clasificación editorial
                <select v-model="b.kind">
                  <option value="editorial">Editorial</option>
                  <option value="commercial">Comercial</option>
                </select></label
              ><template v-if="b.type === 'link'"
                ><label>Texto <input v-model="b.label" required /></label
                ><label
                  >Destino
                  <select v-model="b.targetType">
                    <option value="static">Página fija</option>
                    <option value="cms">Contenido publicado</option>
                    <option value="product">Producto público vigente</option>
                  </select></label
                ><label v-if="b.targetType === 'static'"
                  >Página
                  <select v-model="b.target">
                    <option value="/catalogo">Catálogo</option>
                    <option value="/ayuda">Ayuda</option>
                    <option value="/contacto">Contacto</option>
                    <option value="/envios">Envíos</option>
                    <option value="/devoluciones">Devoluciones</option>
                    <option value="/formas-de-pago">Formas de pago</option>
                    <option value="/accesibilidad">Accesibilidad</option>
                  </select></label
                ><label v-else>Slug publicado <input v-model="b.target" required /></label></template
              ><label v-else>Contenido <textarea v-model="b.text" required /></label
              ><button type="button" @click="document.blocks.splice(index, 1)">Quitar bloque</button
              ><button
                v-if="index > 0"
                type="button"
                @click="document.blocks.splice(index - 1, 0, ...document.blocks.splice(index, 1))"
              >
                Subir bloque
              </button>
            </div>
            <button type="button" :disabled="document.blocks.length >= 50" @click="addBlock">Añadir bloque</button
            ><label>Resumen de versión <textarea v-model="document.changeSummary" required minlength="3" /></label
            ><button type="submit">Guardar borrador versionado</button>
          </fieldset>
        </form>
        <div v-if="campaign" class="space-y-3 rounded border p-4">
          <p>
            Versión confirmada: {{ campaign.versionId }}. Los aceptados por el sender no se presentan como entregados.
          </p>
          <button type="button" :disabled="!canOperate" @click="execute('preview')">Ver preview sintético</button
          ><button
            v-if="snapshot.capabilities.localDispatch"
            type="button"
            :disabled="!canOperate"
            @click="execute('test')"
          >
            Prueba sintética local
          </button>
          <form v-if="campaign.status === 'draft'" @submit.prevent="approve">
            <fieldset :disabled="!canOperate || !snapshot.policy">
              <label>Inicio (Madrid) <input v-model="windowForm.start" type="datetime-local" required /></label
              ><label>Final (Madrid) <input v-model="windowForm.end" type="datetime-local" required /></label
              ><label
                >Hora repetida DST
                <select v-model="windowForm.repeated">
                  <option value="earlier">Primera ocurrencia</option>
                  <option value="later">Segunda ocurrencia</option>
                </select></label
              ><button type="submit">Aprobar versión y ventana con política vigente</button>
            </fieldset>
          </form>
          <p v-if="campaign.startsAt">Ventana confirmada UTC: {{ campaign.startsAt }} → {{ campaign.endsAt }}</p>
          <button
            v-if="campaign.status === 'draft' || campaign.status === 'approved'"
            type="button"
            :disabled="!canOperate"
            @click="cancel"
          >
            Cancelar campaña y cola no enviada</button
          ><button
            v-if="
              campaign.status === 'approved' &&
              (snapshot.capabilities.localDispatch || snapshot.capabilities.externalDelivery)
            "
            type="button"
            :disabled="!canOperate"
            @click="execute('dispatch')"
          >
            Procesar lote con revalidación de consentimiento
          </button>
        </div>
      </section>
      <p v-if="report" role="status">
        Lote confirmado: {{ report.acceptedLocal }} aceptados locales, {{ report.acceptedProvider }} aceptados por
        proveedor, {{ report.skipped }} omitidos, {{ report.deferred }} aplazados y {{ report.manualReview }} en
        revisión manual. {{ report.disabled ? 'Entrega apagada.' : 'No acredita recepción.' }}
      </p>
      <NewsletterCampaignPreview v-if="preview" :value="preview" />
    </template>
  </section>
</template>
