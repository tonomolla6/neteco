<script setup lang="ts">
import {
  adminMarketingModalDetailSchema,
  adminMarketingModalInputSchema,
  adminMarketingModalIntentHash,
  adminMarketingModalListSchema,
  adminMarketingModalPolicyIntentHash,
  adminMarketingModalPolicyInputSchema,
  adminMarketingModalPolicyReceiptSchema,
  adminMarketingModalReceiptSchema,
  type AdminMarketingModalDetail,
  type AdminMarketingModalInput,
  type AdminMarketingModalItem,
  type AdminMarketingModalList,
  type AdminMarketingModalPolicyInput
} from '~~/shared/marketing-modals'

/**
 * Administration of marketing modals (MKT-009). Writes are frozen commands: the reviewed body and
 * its Idempotency-Key are kept until the server confirms the receipt. An uncertain outcome is never
 * resent automatically; it must be verified first and then replayed with the exact same key.
 */
const request = useRequestFetch()
const runtime = useRuntimeConfig()

const COLLECTION = '/api/admin/marketing-modals'
const POLICY = '/api/admin/marketing-modals/policy'

const list = ref<AdminMarketingModalList | null>(null)
const detail = ref<AdminMarketingModalDetail | null>(null)
const loadError = ref('')
const notice = ref('')
const formError = ref('')
const busy = ref(false)
const search = ref('')
const statusFilter = ref<'all' | 'draft' | 'published' | 'retired'>('all')
const page = ref(1)

const editing = ref(false)
const editingVersion = ref(0)
const draft = reactive({
  id: '',
  code: '',
  title: '',
  body: '',
  ctaLabel: '',
  ctaPath: '/',
  objective: 'newsletter_subscription' as AdminMarketingModalInput['definition']['objective'],
  status: 'draft' as 'draft' | 'published' | 'retired',
  triggerKind: 'time_on_page' as 'time_on_page' | 'scroll_depth' | 'exit_intent' | 'page_views',
  triggerValue: '10',
  segments: ['anonymous', 'customer', 'professional'] as Array<'anonymous' | 'customer' | 'professional'>,
  marketingConsent: 'any' as 'any' | 'with_consent' | 'without_consent',
  includePrefixes: '/catalogo',
  excludePrefixes: '',
  priority: '100',
  priorityTier: 'normal' as 'normal' | 'high' | 'critical',
  maxImpressions: '2',
  windowSeconds: '86400',
  startsAt: '',
  endsAt: '',
  reason: ''
})

interface FrozenCommand {
  raw: AdminMarketingModalInput
  key: string
  payloadHash: string
  uncertain: boolean
  absent: boolean
}
const frozen = ref<FrozenCommand | null>(null)

const policyCooldown = ref('3600')
const policyReason = ref('')
const policyKey = ref<string | null>(null)
const policyFrozen = ref<{ raw: AdminMarketingModalPolicyInput; payloadHash: string } | null>(null)

const instant = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z')
const localInput = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const toInstant = (local: string): string | null => {
  if (!local) return null
  const time = Date.parse(local)
  return Number.isFinite(time) ? instant(new Date(time)) : null
}

function errorCode(cause: unknown): string | undefined {
  const code = (cause as { data?: { error?: { code?: unknown } } } | null)?.data?.error?.code
  return typeof code === 'string' ? code : undefined
}

const FINAL_ERRORS: Record<string, string> = {
  version_conflict: 'La modal ha cambiado desde que la abriste. Consulta de nuevo antes de guardar.',
  idempotency_conflict:
    'El comando no coincide con la clave registrada. Consulta de nuevo; no lo repitas con otra clave.',
  code_immutable: 'El código de una modal no puede cambiarse.',
  code_conflict: 'Ya existe una modal con ese código.',
  modal_retired: 'Una modal retirada no puede modificarse.',
  forbidden: 'No tienes permiso para esta operación.',
  mfa_required: 'Verifica el segundo factor y consulta de nuevo.',
  unauthenticated: 'Inicia sesión y consulta de nuevo.',
  invalid_input: 'El servidor ha rechazado los datos. Revisa los campos y el motivo.',
  rate_limited: 'Hay demasiados intentos. Espera antes de volver a intentarlo.'
}

function resetDraft(next?: AdminMarketingModalItem) {
  const definition = next?.definition
  Object.assign(draft, {
    id: definition?.id ?? crypto.randomUUID(),
    code: definition?.code ?? '',
    title: definition?.title ?? '',
    body: definition?.body ?? '',
    ctaLabel: definition?.ctaLabel ?? '',
    ctaPath: definition?.ctaPath ?? '/',
    objective: definition?.objective ?? 'newsletter_subscription',
    status: definition?.status === 'published' ? 'published' : 'draft',
    triggerKind: definition?.trigger.kind ?? 'time_on_page',
    triggerValue: String(
      definition
        ? definition.trigger.kind === 'scroll_depth'
          ? definition.trigger.minPercent
          : definition.trigger.kind === 'page_views'
            ? definition.trigger.minPageViews
            : definition.trigger.minSeconds
        : 10
    ),
    segments: definition?.audience.segments ?? ['anonymous', 'customer', 'professional'],
    marketingConsent: definition?.audience.marketingConsent ?? 'any',
    includePrefixes: definition?.targeting.includePrefixes.join(', ') ?? '/catalogo',
    excludePrefixes: definition?.targeting.excludePrefixes.join(', ') ?? '',
    priority: String(definition?.priority ?? 100),
    priorityTier: definition?.priorityTier ?? 'normal',
    maxImpressions: String(definition?.frequency.maxImpressionsPerVisitor ?? 2),
    windowSeconds: String(definition?.frequency.windowSeconds ?? 86400),
    startsAt: localInput(definition ? new Date(definition.startsAt) : new Date()),
    endsAt: definition?.endsAt ? localInput(new Date(definition.endsAt)) : '',
    reason: ''
  })
  editingVersion.value = definition?.version ?? 0
  frozen.value = null
  formError.value = ''
}

function startCreate() {
  editing.value = true
  resetDraft()
}

function startEdit(item: AdminMarketingModalItem) {
  if (item.definition.status === 'retired') return
  editing.value = true
  resetDraft(item)
}

function values(text: string) {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function buildRaw(): unknown {
  const trigger = (() => {
    const value = Number(draft.triggerValue)
    switch (draft.triggerKind) {
      case 'scroll_depth':
        return { kind: 'scroll_depth', minPercent: value }
      case 'page_views':
        return { kind: 'page_views', minPageViews: value }
      case 'exit_intent':
        return { kind: 'exit_intent', minSeconds: value }
      default:
        return { kind: 'time_on_page', minSeconds: value }
    }
  })()
  return {
    expectedVersion: editingVersion.value,
    definition: {
      id: draft.id,
      version: editingVersion.value + 1,
      code: draft.code.trim(),
      status: draft.status,
      title: draft.title,
      body: draft.body,
      ctaLabel: draft.ctaLabel,
      ctaPath: draft.ctaPath.trim(),
      objective: draft.objective,
      abVariant: null,
      trigger,
      audience: { segments: draft.segments, marketingConsent: draft.marketingConsent },
      targeting: { includePrefixes: values(draft.includePrefixes), excludePrefixes: values(draft.excludePrefixes) },
      priority: Number(draft.priority),
      priorityTier: draft.priorityTier,
      frequency: {
        maxImpressionsPerVisitor: Number(draft.maxImpressions),
        windowSeconds: Number(draft.windowSeconds)
      },
      startsAt: toInstant(draft.startsAt),
      endsAt: toInstant(draft.endsAt)
    },
    reason: draft.reason
  }
}

async function review() {
  formError.value = ''
  const parsed = adminMarketingModalInputSchema.safeParse(buildRaw())
  if (!parsed.success) {
    formError.value = 'Revisa los campos: hay datos que no cumplen las reglas de la modal.'
    return
  }
  const raw = parsed.data
  frozen.value = {
    raw,
    key: crypto.randomUUID(),
    payloadHash: await adminMarketingModalIntentHash(raw),
    uncertain: false,
    absent: false
  }
}

function closeEditor() {
  editing.value = false
  frozen.value = null
}

function cancelReview() {
  frozen.value = null
}

async function loadList() {
  loadError.value = ''
  const params = new URLSearchParams({
    q: search.value.trim(),
    status: statusFilter.value,
    page: String(page.value),
    perPage: '25'
  })
  try {
    const parsed = adminMarketingModalListSchema.safeParse(await request(`${COLLECTION}?${params}`))
    if (!parsed.success) throw new Error('unconfirmed_list')
    list.value = parsed.data
  } catch (cause) {
    loadError.value = apiErrorMessage(cause, 'No se han podido cargar las modales.')
  }
}

async function inspect(id: string) {
  try {
    const parsed = adminMarketingModalDetailSchema.safeParse(await request(`${COLLECTION}/${id}`))
    detail.value = parsed.success ? parsed.data : null
    if (!parsed.success) loadError.value = 'No se ha podido confirmar el historial de la modal.'
  } catch (cause) {
    loadError.value = apiErrorMessage(cause, 'No se ha podido cargar el historial.')
  }
}

async function confirmWrite(replay: boolean) {
  const command = frozen.value
  if (!command || busy.value) return
  busy.value = true
  notice.value = ''
  try {
    const receipt = await request(COLLECTION, {
      method: 'POST',
      body: command.raw,
      headers: { 'Idempotency-Key': command.key }
    })
    const parsed = adminMarketingModalReceiptSchema.safeParse(receipt)
    if (!parsed.success || parsed.data.payloadHash !== command.payloadHash) throw new Error('unconfirmed_receipt')
    frozen.value = null
    editing.value = false
    notice.value = `Modal «${parsed.data.item.definition.code}» guardada en la versión ${parsed.data.version}.`
    await loadList()
  } catch (cause) {
    const code = errorCode(cause)
    if (code && FINAL_ERRORS[code]) {
      // Definitive rejection: the server did not register the command, a new draft needs a new key.
      frozen.value = null
      formError.value = FINAL_ERRORS[code]!
    } else {
      command.uncertain = true
      formError.value = replay
        ? 'El reintento tampoco se ha podido confirmar. Verifica el resultado antes de volver a intentarlo.'
        : 'No se ha podido confirmar el resultado. Verifica el resultado antes de reintentar; no se reenviará automáticamente.'
    }
  } finally {
    busy.value = false
  }
}

async function verifyReceipt() {
  const command = frozen.value
  if (!command || busy.value) return
  busy.value = true
  try {
    const response = (await request(`${COLLECTION}/commands/${command.key}`, {
      headers: { 'X-Neteco-Command-Payload-Hash': command.payloadHash }
    })) as { outcome?: unknown; receipt?: { payloadHash?: unknown }; error?: { code?: unknown } }
    if (response?.outcome === 'applied' && response.receipt?.payloadHash === command.payloadHash) {
      frozen.value = null
      editing.value = false
      notice.value = 'El cambio ya estaba registrado; la lista se ha actualizado.'
      await loadList()
      return
    }
    if (response?.error?.code === 'not_found') command.absent = true
    else formError.value = 'No se ha podido verificar el resultado. Consulta de nuevo más tarde.'
  } catch (cause) {
    if (errorCode(cause) === 'not_found') command.absent = true
    else formError.value = 'No se ha podido verificar el resultado. Consulta de nuevo más tarde.'
  } finally {
    busy.value = false
  }
}

async function reviewPolicy() {
  const parsed = adminMarketingModalPolicyInputSchema.safeParse({
    expectedVersion: list.value?.policy.version ?? 0,
    globalCooldownSeconds: Number(policyCooldown.value),
    reason: policyReason.value
  })
  if (!parsed.success) {
    formError.value = 'La pausa global debe estar entre 60 segundos y 7 días, con un motivo de al menos 5 caracteres.'
    return
  }
  policyFrozen.value = {
    raw: parsed.data,
    payloadHash: await adminMarketingModalPolicyIntentHash(parsed.data)
  }
  policyKey.value = crypto.randomUUID()
}

async function savePolicy() {
  const command = policyFrozen.value
  if (!command || !policyKey.value || busy.value) return
  busy.value = true
  try {
    const receipt = await request(POLICY, {
      method: 'POST',
      body: command.raw,
      headers: { 'Idempotency-Key': policyKey.value }
    })
    const parsed = adminMarketingModalPolicyReceiptSchema.safeParse(receipt)
    if (!parsed.success || parsed.data.payloadHash !== command.payloadHash) throw new Error('unconfirmed_receipt')
    policyFrozen.value = null
    policyKey.value = null
    notice.value = 'Pausa global actualizada.'
    await loadList()
  } catch (cause) {
    const code = errorCode(cause)
    if (code && FINAL_ERRORS[code]) {
      policyFrozen.value = null
      policyKey.value = null
      formError.value = FINAL_ERRORS[code]!
    } else {
      formError.value = 'No se ha podido confirmar el cambio de pausa global. Consulta antes de reintentar.'
    }
  } finally {
    busy.value = false
  }
}

function statusLabel(status: string) {
  return status === 'published' ? 'Publicada' : status === 'retired' ? 'Retirada' : 'Borrador'
}

function triggerLabel(item: AdminMarketingModalItem) {
  const trigger = item.definition.trigger
  switch (trigger.kind) {
    case 'scroll_depth':
      return `Scroll ≥ ${trigger.minPercent} %`
    case 'exit_intent':
      return `Intención de salida (escritorio, ≥ ${trigger.minSeconds} s)`
    case 'page_views':
      return `Páginas vistas ≥ ${trigger.minPageViews}`
    default:
      return `Tiempo en página ≥ ${trigger.minSeconds} s`
  }
}

onMounted(() => {
  if (runtime.public.serverRuntime === 'cloudflare') void loadList()
})

watch([statusFilter, page], () => {
  void loadList()
})
</script>

<template>
  <div class="space-y-8">
    <section class="rounded-xl border border-slate-200 p-5">
      <h2 class="text-lg font-semibold">Pausa global entre modales</h2>
      <p class="mt-1 text-sm text-slate-600">
        Tras cerrar o convertir una modal, ningún otro modal aparece durante este tiempo. Vigente:
        <strong data-testid="modal-policy-current">{{ list?.policy.globalCooldownSeconds ?? '—' }} s</strong>
      </p>
      <form class="mt-4 grid gap-3 sm:grid-cols-[12rem_1fr_auto] sm:items-end" @submit.prevent="reviewPolicy">
        <label class="text-sm">
          Pausa (segundos)
          <input
            v-model="policyCooldown"
            type="number"
            min="60"
            max="604800"
            data-testid="modal-policy-cooldown"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          Motivo
          <input
            v-model="policyReason"
            type="text"
            data-testid="modal-policy-reason"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <button type="submit" class="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">
          Revisar pausa
        </button>
      </form>
      <div v-if="policyFrozen" class="mt-4 rounded-lg bg-amber-50 p-3 text-sm">
        <p>
          Se aplicará una pausa de {{ policyFrozen.raw.globalCooldownSeconds }} s. Motivo: {{ policyFrozen.raw.reason }}
        </p>
        <button
          type="button"
          data-testid="modal-policy-confirm"
          class="mt-2 rounded-lg bg-slate-950 px-3 py-1.5 text-sm font-semibold text-white"
          :disabled="busy"
          @click="savePolicy"
        >
          Confirmar pausa
        </button>
      </div>
    </section>

    <section class="space-y-4">
      <div class="flex flex-wrap items-end gap-3">
        <label class="text-sm">
          Buscar
          <input
            v-model="search"
            type="search"
            data-testid="modal-search"
            class="mt-1 rounded-lg border border-slate-300 px-3 py-2"
            @keyup.enter="loadList"
          />
        </label>
        <label class="text-sm">
          Estado
          <select
            v-model="statusFilter"
            data-testid="modal-status-filter"
            class="mt-1 rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="all">Todas</option>
            <option value="draft">Borrador</option>
            <option value="published">Publicadas</option>
            <option value="retired">Retiradas</option>
          </select>
        </label>
        <button
          type="button"
          data-testid="modal-create"
          class="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
          @click="startCreate"
        >
          Nueva modal
        </button>
      </div>

      <p v-if="notice" role="status" class="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">{{ notice }}</p>
      <p v-if="loadError" role="alert" class="rounded-lg bg-rose-50 p-3 text-sm text-rose-900">{{ loadError }}</p>

      <table v-if="list" class="w-full text-left text-sm">
        <caption class="sr-only">
          Modales de marketing
        </caption>
        <thead>
          <tr class="border-b border-slate-200">
            <th scope="col" class="py-2 pr-3">Código</th>
            <th scope="col" class="py-2 pr-3">Título</th>
            <th scope="col" class="py-2 pr-3">Estado</th>
            <th scope="col" class="py-2 pr-3">Disparador</th>
            <th scope="col" class="py-2 pr-3">Impr. / cierre / conv.</th>
            <th scope="col" class="py-2"><span class="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in list.items" :key="item.definition.id" class="border-b border-slate-100 align-top">
            <td class="py-2 pr-3 font-mono text-xs">{{ item.definition.code }}</td>
            <td class="py-2 pr-3">{{ item.definition.title }}</td>
            <td class="py-2 pr-3">{{ statusLabel(item.definition.status) }} · v{{ item.definition.version }}</td>
            <td class="py-2 pr-3">{{ triggerLabel(item) }}</td>
            <td class="py-2 pr-3 tabular-nums">
              {{ item.stats.impressions }} / {{ item.stats.dismissals }} / {{ item.stats.conversions }}
            </td>
            <td class="py-2 text-right">
              <button
                type="button"
                :data-testid="`modal-inspect-${item.definition.id}`"
                class="mr-2 rounded-lg border border-slate-300 px-2 py-1 text-xs"
                @click="inspect(item.definition.id)"
              >
                Historial
              </button>
              <button
                v-if="item.definition.status !== 'retired'"
                type="button"
                :data-testid="`modal-edit-${item.definition.id}`"
                class="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                @click="startEdit(item)"
              >
                Editar
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <section v-if="detail" class="rounded-xl border border-slate-200 p-4" aria-label="Historial de auditoría">
        <h3 class="font-semibold">Historial de {{ detail.item.definition.code }}</h3>
        <ol class="mt-2 space-y-2 text-sm">
          <li v-for="entry in detail.history" :key="`${entry.definition.version}-${entry.createdAt}`">
            v{{ entry.definition.version }} · {{ entry.createdAt }} · {{ entry.reason }}
          </li>
        </ol>
      </section>
    </section>

    <section v-if="editing" class="rounded-xl border border-slate-200 p-5" aria-labelledby="modal-editor-title">
      <h2 id="modal-editor-title" class="text-lg font-semibold">
        {{ editingVersion ? `Editar modal (versión ${editingVersion} → ${editingVersion + 1})` : 'Nueva modal' }}
      </h2>
      <form class="mt-4 grid gap-4 sm:grid-cols-2" @submit.prevent="review">
        <label class="text-sm">
          Código
          <input
            v-model="draft.code"
            data-testid="modal-code"
            :disabled="editingVersion > 0"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          Estado
          <select
            v-model="draft.status"
            data-testid="modal-status"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="draft">Borrador</option>
            <option value="published">Publicada</option>
            <option value="retired">Retirada</option>
          </select>
        </label>
        <label class="text-sm sm:col-span-2">
          Título
          <input
            v-model="draft.title"
            data-testid="modal-title"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm sm:col-span-2">
          Texto (sin HTML)
          <textarea
            v-model="draft.body"
            data-testid="modal-body"
            rows="3"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          Texto del botón
          <input
            v-model="draft.ctaLabel"
            data-testid="modal-cta-label"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          Ruta del botón (interna)
          <input
            v-model="draft.ctaPath"
            data-testid="modal-cta-path"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          Objetivo
          <select
            v-model="draft.objective"
            data-testid="modal-objective"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="newsletter_subscription">Suscripción al boletín</option>
            <option value="professional_lead">Captación profesional</option>
            <option value="catalog_discovery">Descubrimiento de catálogo</option>
            <option value="promotion_redemption">Canje de promoción</option>
            <option value="support_guidance">Orientación de soporte</option>
          </select>
        </label>
        <label class="text-sm">
          Disparador
          <select
            v-model="draft.triggerKind"
            data-testid="modal-trigger-kind"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="time_on_page">Tiempo en página (s)</option>
            <option value="scroll_depth">Scroll (%)</option>
            <option value="exit_intent">Intención de salida, escritorio (s)</option>
            <option value="page_views">Páginas vistas</option>
          </select>
        </label>
        <label class="text-sm">
          Valor del disparador
          <input
            v-model="draft.triggerValue"
            type="number"
            data-testid="modal-trigger-value"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <fieldset class="text-sm">
          <legend>Audiencia</legend>
          <label class="mr-3"><input v-model="draft.segments" type="checkbox" value="anonymous" /> Anónimos</label>
          <label class="mr-3"><input v-model="draft.segments" type="checkbox" value="customer" /> Clientes</label>
          <label class="mr-3"
            ><input v-model="draft.segments" type="checkbox" value="professional" /> Profesionales</label
          >
          <select
            v-model="draft.marketingConsent"
            data-testid="modal-consent"
            class="mt-2 block rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="any">Con o sin consentimiento</option>
            <option value="with_consent">Solo con consentimiento de marketing</option>
            <option value="without_consent">Solo sin consentimiento de marketing</option>
          </select>
        </fieldset>
        <label class="text-sm">
          Páginas incluidas (prefijos)
          <input
            v-model="draft.includePrefixes"
            data-testid="modal-include"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          Páginas excluidas (prefijos)
          <input
            v-model="draft.excludePrefixes"
            data-testid="modal-exclude"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          Prioridad (0-1000)
          <input
            v-model="draft.priority"
            type="number"
            data-testid="modal-priority"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          Nivel de prioridad
          <select
            v-model="draft.priorityTier"
            data-testid="modal-priority-tier"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="normal">Normal</option>
            <option value="high">Alta</option>
            <option value="critical">Crítica (salta el límite por sesión)</option>
          </select>
        </label>
        <label class="text-sm">
          Impresiones máximas por visitante
          <input
            v-model="draft.maxImpressions"
            type="number"
            min="1"
            max="50"
            data-testid="modal-max-impressions"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          Ventana de frecuencia (s)
          <input
            v-model="draft.windowSeconds"
            type="number"
            min="60"
            data-testid="modal-window"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          Inicio de vigencia
          <input
            v-model="draft.startsAt"
            type="datetime-local"
            data-testid="modal-starts-at"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm">
          Fin de vigencia (opcional)
          <input
            v-model="draft.endsAt"
            type="datetime-local"
            data-testid="modal-ends-at"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label class="text-sm sm:col-span-2">
          Motivo del cambio (auditoría)
          <input
            v-model="draft.reason"
            data-testid="modal-reason"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <div class="sm:col-span-2 flex flex-wrap gap-3">
          <button
            type="submit"
            data-testid="modal-review"
            class="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
          >
            Revisar cambios
          </button>
          <button type="button" class="rounded-lg border border-slate-300 px-4 py-2 text-sm" @click="closeEditor">
            Cerrar editor
          </button>
        </div>
      </form>

      <div v-if="frozen" class="mt-5 rounded-lg bg-amber-50 p-4 text-sm" data-testid="modal-frozen">
        <p class="font-semibold">Revisa el comando antes de confirmarlo</p>
        <p class="mt-1">
          «{{ frozen.raw.definition.title }}» ({{ frozen.raw.definition.code }}), versión
          {{ frozen.raw.definition.version }}, estado {{ statusLabel(frozen.raw.definition.status) }}.
        </p>
        <div class="mt-3 flex flex-wrap gap-3">
          <button
            v-if="!frozen.uncertain"
            type="button"
            data-testid="modal-confirm"
            :disabled="busy"
            class="rounded-lg bg-slate-950 px-3 py-1.5 text-sm font-semibold text-white"
            @click="confirmWrite(false)"
          >
            Confirmar y guardar
          </button>
          <button type="button" class="rounded-lg border border-slate-300 px-3 py-1.5 text-sm" @click="cancelReview">
            Volver al formulario
          </button>
          <button
            v-if="frozen.uncertain && !frozen.absent"
            type="button"
            data-testid="modal-verify-receipt"
            :disabled="busy"
            class="rounded-lg border border-slate-900 px-3 py-1.5 text-sm font-semibold"
            @click="verifyReceipt"
          >
            Verificar resultado
          </button>
          <button
            v-if="frozen.uncertain && frozen.absent"
            type="button"
            data-testid="modal-replay"
            :disabled="busy"
            class="rounded-lg bg-slate-950 px-3 py-1.5 text-sm font-semibold text-white"
            @click="confirmWrite(true)"
          >
            Reintentar con la misma clave
          </button>
        </div>
      </div>
      <p v-if="formError" role="alert" class="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-900">{{ formError }}</p>
    </section>
  </div>
</template>
