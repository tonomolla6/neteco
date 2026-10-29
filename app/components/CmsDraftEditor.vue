<script setup lang="ts">
import {
  cmsPageListSchema,
  cmsPageDetailSchema,
  cmsCommandReceiptSchema,
  cmsCreateInputSchema,
  cmsUpdateInputSchema,
  cmsRestoreInputSchema,
  cmsArchiveInputSchema,
  type CmsPageList,
  type CmsPageDetail,
  type CmsAction,
  type CmsPage,
  type CmsVersion,
  type CmsCommandReceipt
} from '~~/shared/cms-commands'
import { catalogPolicyUuidSchema, catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'
import { SUPPORT_KNOWLEDGE_CATEGORIES } from '~~/shared/support-knowledge'
import type { ContentBlock } from '~~/server/utils/content-schema'
import type { PromotionalMetadata } from '~~/shared/promotional-content'
import CmsPublicationControls from './CmsPublicationControls.vue'
import CmsEditorialCalendar from './CmsEditorialCalendar.vue'

const props = defineProps<{ runtime: unknown; operatorId: string; authorize: () => boolean }>()
const prefix = useId(),
  root = '/api/admin/content/pages'
const list = shallowRef<CmsPageList | null>(null),
  detail = shallowRef<CmsPageDetail | null>(null),
  listStatus = ref('idle'),
  detailStatus = ref('idle'),
  selectedId = ref(''),
  listPage = ref(1),
  historyPage = ref(1),
  mode = ref<CmsAction | null>(null),
  baseline = shallowRef<CmsPage | null>(null),
  restoreSource = shallowRef<CmsVersion | null>(null),
  busy = ref(false),
  reading = ref(false),
  uncertain = ref(false),
  blocked = ref(false),
  message = ref(''),
  acknowledgement = shallowRef<CmsCommandReceipt | null>(null),
  archiveConfirmed = ref(false),
  publicationPending = ref(false)
const form = reactive({
  title: '',
  slug: '',
  seoTitle: '',
  seoDescription: '',
  noindex: true,
  helpEnabled: false,
  helpCategory: '',
  helpReviewDueAt: '',
  resourceEnabled: false,
  resourceKind: 'article',
  resourceCategory: '',
  resourceCategoryLabel: '',
  resourceAuthor: '',
  resourceExperience: '',
  resourceReviewed: '',
  resourceReviewDue: '',
  resourcePillar: '',
  resourceProducts: '',
  resourceCategories: '',
  resourceResources: '',
  blocksJson: '',
  promoEnabled: false,
  promoFormat: 'banner' as PromotionalMetadata['format'],
  promoPlacements: [] as PromotionalMetadata['placements'],
  promoPriority: 0 as string | number,
  promoPaths: '',
  promoCategories: '',
  promoProducts: '',
  reason: ''
})
const promoBlocks = ref<ContentBlock[]>([])
const promoPlacements = ['home', 'catalog', 'category', 'product'] as const
function addPromoBlock(type: ContentBlock['type']) {
  if (promoBlocks.value.length >= 10) return
  const id = crypto.randomUUID()
  const block: ContentBlock =
    type === 'heading'
      ? { id, type, level: 'h2', text: '' }
      : type === 'paragraph'
        ? { id, type, text: '' }
        : type === 'cta'
          ? { id, type, label: '', href: '' }
          : type === 'image'
            ? { id, type, assetId: '', alt: '', caption: '' }
            : type === 'list'
              ? { id, type, items: [''] }
              : { id, type: 'callout', tone: 'info', title: '', text: '' }
  promoBlocks.value.push(block)
}
function setPromoList(block: Extract<ContentBlock, { type: 'list' }>, event: Event) {
  block.items = (event.target as HTMLTextAreaElement).value
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
}
const selectors = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
type Intent = Readonly<{
  action: CmsAction
  payload: string
  key: string
  operatorId: string
  target: CmsPage | null
  source: CmsVersion | null
  path: string
  method: 'POST' | 'PUT' | 'DELETE'
  expectedSlug: string
}>
const intent = shallowRef<Intent | null>(null)
let alive = true,
  generation = 0,
  listActor = '',
  detailActor = ''
function authorized() {
  try {
    return (
      alive &&
      props.runtime === 'cloudflare' &&
      catalogPolicyUuidSchema.safeParse(props.operatorId).success &&
      props.authorize() === true
    )
  } catch {
    return false
  }
}
const authority = computed(authorized)
const currentList = computed(() =>
  authority.value && listStatus.value === 'success' && listActor === props.operatorId ? list.value : null
)
const currentDetail = computed(() =>
  authority.value &&
  detailStatus.value === 'success' &&
  detailActor === props.operatorId &&
  detail.value?.page.id === selectedId.value
    ? detail.value
    : null
)
const cap = {
  create_draft: 'contentCreate',
  update_draft: 'contentUpdate',
  restore_draft: 'contentRestore',
  archive_draft: 'contentArchive'
} as const
function permitted(action: CmsAction, target: CmsPage | null, replay = false) {
  if (!authorized()) return false
  if (action === 'create_draft') return currentList.value?.capabilities.contentCreate === true
  const data = currentDetail.value
  return (
    !!target &&
    !!data &&
    data.page.id === target.id &&
    data.capabilities[cap[action]] === true &&
    (replay ||
      (data.page.pageVersion === target.pageVersion &&
        data.page.draftVersionId === target.draftVersionId &&
        (action === 'restore_draft' || data.page.status === 'draft')))
  )
}
function epochCurrent(epoch: number, actor: string) {
  return alive && generation === epoch && authorized() && props.operatorId === actor
}
watch([() => props.runtime, () => props.operatorId, authority], () => {
  generation++
  list.value = null
  detail.value = null
  listStatus.value = 'idle'
  detailStatus.value = 'idle'
  if (intent.value) {
    uncertain.value = true
    message.value = 'El acceso ha cambiado. Se conserva el intento original sin repetirlo automáticamente.'
  }
})
onBeforeUnmount(() => {
  alive = false
  generation++
})
async function loadList(page = listPage.value) {
  if (
    !authorized() ||
    busy.value ||
    reading.value ||
    publicationPending.value ||
    !Number.isSafeInteger(page) ||
    page < 1
  )
    return
  reading.value = true
  listStatus.value = 'pending'
  list.value = null
  const actor = props.operatorId,
    epoch = generation
  try {
    const raw: unknown = await $fetch(root, { query: { page, perPage: 25 }, retry: 0 })
    if (!epochCurrent(epoch, actor)) return
    const parsed = cmsPageListSchema.safeParse(raw)
    if (!parsed.success || parsed.data.pagination.page !== page || parsed.data.pagination.perPage !== 25)
      throw new Error('cms_list_unconfirmed')
    list.value = parsed.data
    listActor = actor
    listPage.value = page
    listStatus.value = 'success'
    if (!intent.value) blocked.value = false
  } catch {
    if (epochCurrent(epoch, actor)) {
      listStatus.value = 'error'
      list.value = null
      message.value = 'No se han podido consultar las páginas. Reintenta sólo la lectura.'
    }
  } finally {
    if (alive) reading.value = false
  }
}
async function loadDetail(id: string, page = 1, calendarSelection = false) {
  if (
    !authorized() ||
    busy.value ||
    reading.value ||
    publicationPending.value ||
    !catalogPolicyUuidSchema.safeParse(id).success ||
    (!currentList.value?.pages.some((entry) => entry.id === id) && selectedId.value !== id && !calendarSelection) ||
    (calendarSelection && (!currentList.value?.capabilities.contentSchedule || !!intent.value || !!mode.value)) ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    (intent.value && intent.value.target?.id !== id)
  )
    return
  reading.value = true
  detailStatus.value = 'pending'
  detail.value = null
  selectedId.value = id
  if (!intent.value) {
    mode.value = null
    baseline.value = null
    restoreSource.value = null
    acknowledgement.value = null
  }
  const actor = props.operatorId,
    epoch = generation
  try {
    const raw: unknown = await $fetch(`${root}/${id}`, { query: { historyPage: page, historyPerPage: 5 }, retry: 0 })
    if (!epochCurrent(epoch, actor) || selectedId.value !== id) return
    const parsed = cmsPageDetailSchema.safeParse(raw)
    if (
      !parsed.success ||
      parsed.data.page.id !== id ||
      parsed.data.history.pagination.page !== page ||
      parsed.data.history.pagination.perPage !== 5
    )
      throw new Error('cms_detail_unconfirmed')
    detail.value = parsed.data
    detailActor = actor
    historyPage.value = page
    detailStatus.value = 'success'
    if (!intent.value) blocked.value = false
  } catch {
    if (epochCurrent(epoch, actor)) {
      detailStatus.value = 'error'
      detail.value = null
      message.value = 'No se ha confirmado el borrador ni su historial. Reintenta sólo la consulta.'
    }
  } finally {
    if (alive) reading.value = false
  }
}
onMounted(() => {
  void loadList()
})
function begin(action: CmsAction, versionId?: string) {
  if (busy.value || reading.value || publicationPending.value || intent.value || blocked.value || !alive) return
  const target = action === 'create_draft' ? null : (currentDetail.value?.page ?? null)
  if (!permitted(action, target)) return
  const source =
    action === 'restore_draft'
      ? (currentDetail.value?.history.versions.find((version) => version.id === versionId) ?? null)
      : null
  if (action === 'restore_draft' && !source) return
  baseline.value = target
  restoreSource.value = source
  mode.value = action
  acknowledgement.value = null
  message.value = ''
  archiveConfirmed.value = false
  const document = source?.document ?? (action === 'create_draft' ? null : currentDetail.value?.draft.document)
  form.title = document?.title ?? ''
  form.slug = document?.slug ?? ''
  form.seoTitle = document?.seo.title ?? ''
  form.seoDescription = document?.seo.description ?? ''
  form.noindex = document?.seo.noindex ?? true
  form.helpEnabled = !!document?.supportKnowledge
  form.helpCategory = document?.supportKnowledge?.category ?? ''
  form.helpReviewDueAt = document?.supportKnowledge?.reviewDueAt ?? ''
  const resource = document?.resourceHub
  form.resourceEnabled = !!resource
  form.resourceKind = resource?.kind ?? 'article'
  form.resourceCategory = resource?.category.slug ?? ''
  form.resourceCategoryLabel = resource?.category.label ?? ''
  form.resourceAuthor = resource?.author.name ?? ''
  form.resourceExperience = resource?.author.experience ?? ''
  form.resourceReviewed = resource?.reviewedAt ?? ''
  form.resourceReviewDue = resource?.reviewDueAt ?? ''
  form.resourcePillar = resource?.pillarSlug ?? ''
  form.resourceProducts = resource?.relatedProducts.join('\n') ?? ''
  form.resourceCategories = resource?.relatedCategories.join('\n') ?? ''
  form.resourceResources = resource?.relatedResources.join('\n') ?? ''
  form.promoEnabled = !!document?.promotional
  form.promoFormat = document?.promotional?.format ?? 'banner'
  form.promoPlacements = [...(document?.promotional?.placements ?? [])]
  form.promoPriority = document?.promotional?.priority ?? 0
  form.promoPaths = document?.promotional?.paths.join('\n') ?? ''
  form.promoCategories = document?.promotional?.categorySlugs.join('\n') ?? ''
  form.promoProducts = document?.promotional?.productSlugs.join('\n') ?? ''
  promoBlocks.value = document ? JSON.parse(JSON.stringify(document.blocks)) : []
  if (!document) for (const type of ['heading', 'paragraph', 'cta'] as const) addPromoBlock(type)
  form.reason = ''
  form.blocksJson = JSON.stringify(
    document?.blocks ?? [{ id: crypto.randomUUID(), type: 'paragraph', text: 'Escribe aquí el contenido.' }],
    null,
    2
  )
}
function prepared() {
  const action = mode.value,
    target = baseline.value
  if (
    !action ||
    !permitted(action, target) ||
    busy.value ||
    reading.value ||
    publicationPending.value ||
    intent.value ||
    blocked.value
  )
    return null
  if (action === 'archive_draft') {
    if (!archiveConfirmed.value) return null
    const parsed = cmsArchiveInputSchema.safeParse({ expectedVersion: target?.pageVersion, reason: form.reason })
    return parsed.success ? parsed.data : null
  }
  if (action === 'restore_draft') {
    const parsed = cmsRestoreInputSchema.safeParse({
      expectedVersion: target?.pageVersion,
      versionId: restoreSource.value?.id,
      reason: form.reason
    })
    return parsed.success ? parsed.data : null
  }
  let blocks: unknown
  try {
    blocks = form.promoEnabled
      ? promoBlocks.value.filter((block) =>
          block.type === 'heading' || block.type === 'paragraph'
            ? block.text.trim() !== ''
            : block.type === 'cta'
              ? block.label.trim() !== '' || block.href.trim() !== ''
              : true
        )
      : JSON.parse(form.blocksJson)
  } catch {
    return null
  }
  const input = {
    title: form.title,
    slug: form.slug,
    blocks,
    seo: { title: form.seoTitle, description: form.seoDescription, noindex: form.noindex },
    changeSummary: form.reason,
    ...(form.resourceEnabled
      ? {
          resourceHub: {
            kind: form.resourceKind,
            category: { slug: form.resourceCategory, label: form.resourceCategoryLabel },
            author: { name: form.resourceAuthor, experience: form.resourceExperience },
            reviewedAt: form.resourceReviewed,
            reviewDueAt: form.resourceReviewDue,
            pillarSlug: form.resourcePillar.trim() || null,
            relatedProducts: selectors(form.resourceProducts).map((value) =>
              /^\d+$/.test(value) ? Number(value) : null
            ),
            relatedCategories: selectors(form.resourceCategories),
            relatedResources: selectors(form.resourceResources)
          }
        }
      : {}),
    ...(form.promoEnabled
      ? {
          promotional: {
            format: form.promoFormat,
            placements: form.promoPlacements,
            priority:
              typeof form.promoPriority === 'number'
                ? form.promoPriority
                : /^\d+$/.test(form.promoPriority.trim())
                  ? Number(form.promoPriority)
                  : null,
            paths: selectors(form.promoPaths),
            categorySlugs: selectors(form.promoCategories),
            productSlugs: selectors(form.promoProducts)
          }
        }
      : {}),
    ...(form.helpEnabled
      ? { supportKnowledge: { category: form.helpCategory, reviewDueAt: form.helpReviewDueAt } }
      : {}),
    expectedVersion: target?.pageVersion ?? 0
  }
  const parsed =
    action === 'create_draft' ? cmsCreateInputSchema.safeParse(input) : cmsUpdateInputSchema.safeParse(input)
  return parsed.success ? parsed.data : null
}
const canSubmit = computed(() => prepared() !== null)
const canRetry = computed(
  () =>
    !!intent.value &&
    uncertain.value &&
    !busy.value &&
    !reading.value &&
    intent.value.operatorId === props.operatorId &&
    permitted(intent.value.action, intent.value.target, true)
)
function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}
function domainCode(raw: unknown) {
  try {
    const data = catalogPolicyOwnJson(raw),
      error = ownData(data, 'error'),
      code = ownData(error, 'code')
    return typeof code === 'string' ? code : null
  } catch {
    return null
  }
}
function responseFailure(context: unknown) {
  const response = ownData(context, 'response')
  let status = ownData(response, 'status')
  if (status === undefined && response instanceof Response) {
    try {
      status = Object.getOwnPropertyDescriptor(Response.prototype, 'status')?.get?.call(response)
    } catch {
      return null
    }
  }
  return typeof status === 'number' && status >= 400 && status < 500 ? domainCode(ownData(response, '_data')) : null
}
const definitive = new Set([
  'invalid_input',
  'unauthenticated',
  'email_unverified',
  'mfa_required',
  'forbidden',
  'not_found',
  'version_conflict',
  'idempotency_conflict',
  'slug_conflict',
  'draft_not_editable',
  'reference_unavailable',
  'csrf_rejected',
  'invalid_idempotency_key',
  'rate_limited'
])
function matchesReceipt(raw: unknown, command: Intent) {
  const parsed = cmsCommandReceiptSchema.safeParse(raw)
  if (!parsed.success) return null
  const value = parsed.data,
    target = command.target
  if (
    value.action !== command.action ||
    value.slug !== command.expectedSlug ||
    value.pageVersion !== (target?.pageVersion ?? 0) + 1 ||
    value.draftVersion !== (target?.draftVersion ?? 0) + (command.action === 'archive_draft' ? 0 : 1) ||
    (target && value.pageId !== target.id) ||
    (command.action === 'archive_draft'
      ? value.versionId !== target?.draftVersionId
      : value.versionId === target?.draftVersionId || value.versionId === command.source?.id)
  )
    return null
  return value
}
async function dispatch(replay = false) {
  const command = intent.value
  if (
    !command ||
    busy.value ||
    reading.value ||
    command.operatorId !== props.operatorId ||
    !permitted(command.action, command.target, replay)
  )
    return
  busy.value = true
  message.value = ''
  const epoch = generation,
    actor = command.operatorId
  let sent = false,
    responseCode: string | null = null,
    acknowledged = false
  try {
    const raw: unknown = await $fetch(command.target ? `${root}/${command.target.id}` : root, { retry: 0 })
    if (!epochCurrent(epoch, actor)) return
    const freshList = command.target ? null : cmsPageListSchema.safeParse(raw),
      freshDetail = command.target ? cmsPageDetailSchema.safeParse(raw) : null
    const caps = freshDetail?.success
      ? freshDetail.data.capabilities
      : freshList?.success
        ? freshList.data.capabilities
        : null
    if (
      !caps ||
      caps[cap[command.action]] !== true ||
      (command.target && (!freshDetail?.success || freshDetail.data.page.id !== command.target.id))
    )
      throw new Error('cms_authority_unconfirmed')
    if (
      !replay &&
      command.target &&
      freshDetail?.success &&
      (freshDetail.data.page.pageVersion !== command.target.pageVersion ||
        freshDetail.data.page.draftVersionId !== command.target.draftVersionId ||
        (command.action !== 'restore_draft' && freshDetail.data.page.status !== 'draft'))
    ) {
      intent.value = null
      uncertain.value = false
      blocked.value = true
      detail.value = null
      detailStatus.value = 'error'
      message.value = 'El borrador ha cambiado. Consulta el estado vigente y prepara otra operación.'
      return
    }
    sent = true
    uncertain.value = true
    const response: unknown = await $fetch(command.path, {
      method: command.method,
      body: command.payload,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': command.key },
      retry: 0,
      onResponseError(context: unknown) {
        responseCode = responseFailure(context)
      }
    })
    if (!epochCurrent(epoch, actor)) return
    const receipt = matchesReceipt(response, command)
    if (!receipt) throw new Error('cms_receipt_unconfirmed')
    acknowledgement.value = receipt
    acknowledged = true
    detail.value = null
    detailStatus.value = 'pending'
    const refreshed: unknown = await $fetch(`${root}/${receipt.pageId}`, { retry: 0 })
    if (!epochCurrent(epoch, actor)) return
    const latest = cmsPageDetailSchema.safeParse(refreshed)
    if (!latest.success || latest.data.page.id !== receipt.pageId || latest.data.page.pageVersion < receipt.pageVersion)
      throw new Error('cms_current_state_unconfirmed')
    detail.value = latest.data
    selectedId.value = receipt.pageId
    detailActor = actor
    detailStatus.value = 'success'
    historyPage.value = 1
    list.value = null
    listStatus.value = 'idle'
    intent.value = null
    uncertain.value = false
    blocked.value = false
    mode.value = null
    baseline.value = null
    message.value =
      command.action === 'archive_draft'
        ? 'Archivo confirmado. El historial y los slugs se conservan; la consulta muestra el estado vigente.'
        : command.action === 'restore_draft'
          ? 'Restauración confirmada como una nueva versión de borrador. No se ha publicado.'
          : 'Nueva versión de borrador confirmada y auditada. No se ha publicado.'
  } catch (failure) {
    if (!epochCurrent(epoch, actor)) return
    const code = responseCode ?? domainCode(ownData(failure, 'data')),
      authorityFailure = code && ['unauthenticated', 'email_unverified', 'mfa_required', 'forbidden'].includes(code)
    detail.value = null
    detailStatus.value = 'error'
    if (!acknowledged && code && definitive.has(code) && !(authorityFailure && (sent || replay))) {
      intent.value = null
      uncertain.value = false
      blocked.value = true
      message.value = 'La operación ha sido rechazada. Consulta el estado vigente antes de preparar otro cambio.'
    } else {
      uncertain.value = true
      message.value = acknowledged
        ? 'Hay un recibo histórico, pero no se ha confirmado el estado vigente. Se conserva la solicitud original para recuperarla manualmente.'
        : sent || replay
          ? 'No hay confirmación. Puede haberse guardado: conserva el intento y reintenta sólo la misma solicitud con la misma clave.'
          : 'No se ha enviado: no se ha confirmado el acceso actual. Se conserva el intento original para recuperarlo manualmente.'
    }
  } finally {
    if (alive) {
      busy.value = false
      if (intent.value) uncertain.value = true
    }
  }
}
async function submit() {
  const body = prepared(),
    action = mode.value,
    target = baseline.value,
    source = restoreSource.value
  if (!body || !action || intent.value || !alive) return
  intent.value = Object.freeze({
    action,
    payload: JSON.stringify(body),
    key: crypto.randomUUID(),
    operatorId: props.operatorId,
    target: target ? Object.freeze({ ...target }) : null,
    source: source ? Object.freeze({ ...source }) : null,
    path: target ? `${root}/${target.id}${action === 'restore_draft' ? '/rollback' : ''}` : root,
    method: action === 'update_draft' ? 'PUT' : action === 'archive_draft' ? 'DELETE' : 'POST',
    expectedSlug:
      action === 'archive_draft' ? target!.slug : action === 'restore_draft' ? source!.document.slug : form.slug.trim()
  })
  await dispatch()
}
async function retry() {
  if (canRetry.value) await dispatch(true)
}
function cancel() {
  if (intent.value || busy.value || reading.value) return
  mode.value = null
  baseline.value = null
  restoreSource.value = null
}
</script>

<template>
  <section :aria-labelledby="`${prefix}-heading`" class="space-y-5">
    <UiPageHeader
      title="Contenido"
      description="Borradores tipados y versionados en Cloudflare, con auditoría y archivo recuperable."
    />
    <h2 :id="`${prefix}-heading`" class="sr-only">CMS de borradores</h2>
    <UAlert
      color="warning"
      title="Borrador y publicación son independientes"
      description="Guardar o restaurar no publica. Consulta los controles editoriales de la página para confirmar capacidades, publicar, programar o emitir una vista previa privada. Sin configuración dedicada permanecen desactivados."
    />
    <CmsEditorialCalendar
      v-if="currentList?.capabilities.contentSchedule"
      :runtime="runtime"
      :operator-id="operatorId"
      :authorize="authorize"
      :enabled="true"
      :can-select="!busy && !reading && !publicationPending && !intent && !mode"
      @select-page="loadDetail($event, 1, true)"
    />
    <p v-if="!authority" role="alert">
      Se necesita una sesión vigente con correo verificado, MFA y permiso de contenido.
    </p>
    <p v-else-if="listStatus === 'pending'" role="status">Consultando las páginas…</p>
    <p v-else-if="!currentList" role="alert">No hay una lista confirmada. Esto no significa que no existan páginas.</p>
    <p v-else-if="currentList.pagination.total === 0" role="status">Todavía no hay páginas de contenido.</p>
    <div class="flex flex-wrap gap-2">
      <UButton data-cms-read :disabled="!authority || busy || reading" @click="loadList()">Consultar páginas</UButton>
      <UButton
        v-if="currentList?.capabilities.contentCreate"
        data-cms-create
        :disabled="busy || reading || !!intent || blocked"
        @click="begin('create_draft')"
        >Nueva página borrador</UButton
      >
    </div>
    <ul v-if="currentList" class="space-y-2" aria-label="Páginas editoriales">
      <li v-for="page in currentList.pages" :key="page.id">
        <UButton
          :data-cms-select="page.id"
          variant="outline"
          :disabled="busy || reading || !!intent"
          @click="loadDetail(page.id)"
          >{{ page.title }} · /{{ page.slug }} · {{ page.status === 'hidden' ? 'Archivada' : 'Borrador' }}</UButton
        >
      </li>
    </ul>
    <div v-if="currentList && currentList.pagination.total > 25" class="flex gap-2">
      <UButton
        data-cms-list-previous
        :disabled="listPage <= 1 || busy || reading || !!intent"
        @click="loadList(listPage - 1)"
        >Anterior</UButton
      >
      <span>Página {{ listPage }} · {{ currentList.pagination.total }} páginas</span>
      <UButton
        data-cms-list-next
        :disabled="!currentList.pagination.hasMore || busy || reading || !!intent"
        @click="loadList(listPage + 1)"
        >Siguiente</UButton
      >
    </div>
    <p v-if="detailStatus === 'pending'" role="status">Consultando borrador e historial…</p>
    <CmsPublicationControls
      v-if="selectedId"
      :page-id="selectedId"
      :runtime="runtime"
      :operator-id="operatorId"
      :authorize="authorize"
      @pending="publicationPending = $event"
    />
    <div v-if="selectedId && authority" class="flex gap-2">
      <UButton data-cms-detail-read :disabled="busy || reading" @click="loadDetail(selectedId, historyPage)"
        >Consultar borrador e historial</UButton
      >
    </div>
    <article v-if="currentDetail" class="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <h2 class="text-xl font-bold">{{ currentDetail.page.title }}</h2>
      <p>
        Estado vigente: {{ currentDetail.page.status === 'hidden' ? 'archivado' : 'borrador' }} · versión de página
        {{ currentDetail.page.pageVersion }} · borrador v{{ currentDetail.page.draftVersion }}.
      </p>
      <div class="flex flex-wrap gap-2">
        <UButton
          v-if="currentDetail.capabilities.contentUpdate && currentDetail.page.status === 'draft'"
          data-cms-edit
          :disabled="busy || reading || !!intent || blocked"
          @click="begin('update_draft')"
          >Editar borrador</UButton
        >
        <UButton
          v-if="currentDetail.capabilities.contentArchive && currentDetail.page.status === 'draft'"
          data-cms-archive
          :disabled="busy || reading || !!intent || blocked"
          @click="begin('archive_draft')"
          >Archivar borrador</UButton
        >
      </div>
      <h3 class="font-semibold">Historial inmutable</h3>
      <ul class="space-y-3">
        <li v-for="version in currentDetail.history.versions" :key="version.id" class="rounded-lg border p-3">
          <p>
            v{{ version.version }} · {{ version.document.changeSummary }} · autor {{ version.createdBy }} ·
            {{ version.createdAt }}
          </p>
          <details>
            <summary>Ver snapshot de esta versión</summary>
            <pre class="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{{
              JSON.stringify(version.document, null, 2)
            }}</pre>
          </details>
          <UButton
            v-if="currentDetail.capabilities.contentRestore"
            :data-cms-restore="version.id"
            variant="ghost"
            :disabled="busy || reading || !!intent || blocked"
            @click="begin('restore_draft', version.id)"
            >Restaurar como nueva versión</UButton
          >
        </li>
      </ul>
      <div v-if="currentDetail.history.pagination.total > 5" class="flex gap-2">
        <UButton
          data-cms-history-previous
          :disabled="historyPage <= 1 || busy || reading || !!intent"
          @click="loadDetail(selectedId, historyPage - 1)"
          >Versiones más recientes</UButton
        >
        <UButton
          data-cms-history-next
          :disabled="!currentDetail.history.pagination.hasMore || busy || reading || !!intent"
          @click="loadDetail(selectedId, historyPage + 1)"
          >Versiones anteriores</UButton
        >
      </div>
    </article>
    <form
      v-if="mode && authority && (mode === 'create_draft' ? currentList : currentDetail)"
      class="space-y-4 rounded-2xl border p-5"
      :aria-busy="busy"
      @submit.prevent="submit"
    >
      <fieldset :disabled="busy || reading || !!intent || blocked || !permitted(mode, baseline)" class="space-y-3">
        <legend class="font-semibold">
          {{
            mode === 'create_draft'
              ? 'Nueva página borrador'
              : mode === 'archive_draft'
                ? 'Archivar sin borrar historia'
                : mode === 'restore_draft'
                  ? 'Restaurar como nuevo borrador'
                  : 'Nueva versión de borrador'
          }}
        </legend>
        <template v-if="mode === 'create_draft' || mode === 'update_draft'">
          <label :for="`${prefix}-title`" class="block"
            >Título<input
              :id="`${prefix}-title`"
              v-model="form.title"
              data-cms-title
              maxlength="160"
              required
              class="cms-field"
          /></label>
          <label :for="`${prefix}-slug`" class="block"
            >Slug<input
              :id="`${prefix}-slug`"
              v-model="form.slug"
              data-cms-slug
              maxlength="160"
              required
              class="cms-field"
          /></label>
          <label :for="`${prefix}-seo-title`" class="block"
            >Título SEO<input
              :id="`${prefix}-seo-title`"
              v-model="form.seoTitle"
              data-cms-seo-title
              maxlength="70"
              required
              class="cms-field"
          /></label>
          <label :for="`${prefix}-seo-description`" class="block"
            >Descripción SEO<input
              :id="`${prefix}-seo-description`"
              v-model="form.seoDescription"
              data-cms-seo-description
              maxlength="180"
              required
              class="cms-field"
          /></label>
          <label
            ><input v-model="form.noindex" data-cms-noindex type="checkbox" /> No indexar cuando exista publicación
            aprobada</label
          >
          <label class="block"
            ><input v-model="form.promoEnabled" data-cms-promo-enabled type="checkbox" /> Bloque promocional editorial
            (sin descuentos automáticos)</label
          >
          <fieldset v-if="form.promoEnabled" class="min-w-0 space-y-3 rounded-lg border p-3">
            <legend>Presentación y contexto público</legend>
            <label class="block"
              >Formato<select v-model="form.promoFormat" data-cms-promo-format class="cms-field">
                <option value="banner">Banner</option>
                <option value="bar">Barra</option>
                <option value="card">Tarjeta</option>
              </select></label
            >
            <div class="flex flex-wrap gap-3">
              <label v-for="placement in promoPlacements" :key="placement"
                ><input
                  v-model="form.promoPlacements"
                  :value="placement"
                  :data-cms-promo-placement="placement"
                  type="checkbox"
                />
                {{
                  { home: 'Inicio', catalog: 'Catálogo', category: 'Categoría', product: 'Producto' }[placement]
                }}</label
              >
            </div>
            <label class="block"
              >Prioridad (0–1000; mayor primero)<input
                v-model="form.promoPriority"
                data-cms-promo-priority
                type="number"
                min="0"
                max="1000"
                step="1"
                class="cms-field"
            /></label>
            <details class="space-y-2">
              <summary>Limitar por contexto (opcional)</summary>
              <p>
                Una ruta o slug por línea, hasta 20. Vacío no restringe esa dimensión. No se dirige a personas ni
                perfiles.
              </p>
              <label class="block"
                >Rutas públicas exactas<textarea
                  v-model="form.promoPaths"
                  data-cms-promo-paths
                  rows="3"
                  class="cms-field"
                  placeholder="/catalogo"
                />
              </label>
              <label class="block"
                >Slugs de categoría<textarea
                  v-model="form.promoCategories"
                  data-cms-promo-categories
                  rows="3"
                  class="cms-field"
                />
              </label>
              <label class="block"
                >Slugs de producto<textarea
                  v-model="form.promoProducts"
                  data-cms-promo-products
                  rows="3"
                  class="cms-field"
                />
              </label>
            </details>
            <p>
              El calendario, la aprobación y la vista previa se gestionan con los controles editoriales existentes.
              Guardar aquí no publica.
            </p>
            <article
              v-for="(block, index) in promoBlocks"
              :key="block.id"
              class="min-w-0 space-y-2 rounded-lg border p-3"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <strong>{{ index + 1 }} · {{ block.type }}</strong
                ><button type="button" class="underline" @click="promoBlocks.splice(index, 1)">
                  Quitar bloque {{ index + 1 }}
                </button>
              </div>
              <template v-if="block.type === 'heading'"
                ><label class="block"
                  >Encabezado<input
                    v-model="block.text"
                    data-cms-promo-heading
                    maxlength="180"
                    class="cms-field" /></label
                ><label
                  >Nivel<select v-model="block.level" class="cms-field">
                    <option value="h2">H2</option>
                    <option value="h3">H3</option>
                  </select></label
                ></template
              >
              <label v-else-if="block.type === 'paragraph'" class="block"
                >Texto<textarea v-model="block.text" data-cms-promo-text maxlength="5000" rows="3" class="cms-field" />
              </label>
              <template v-else-if="block.type === 'cta'"
                ><label class="block"
                  >Texto del enlace<input
                    v-model="block.label"
                    data-cms-promo-cta-label
                    maxlength="120"
                    class="cms-field" /></label
                ><label class="block"
                  >Destino interno o HTTPS<input
                    v-model="block.href"
                    data-cms-promo-cta-href
                    maxlength="500"
                    class="cms-field" /></label
              ></template>
              <template v-else-if="block.type === 'image'"
                ><label class="block"
                  >Original de media existente (ID)<input
                    v-model="block.assetId"
                    maxlength="36"
                    class="cms-field" /></label
                ><label class="block"
                  >Texto alternativo<input v-model="block.alt" maxlength="240" class="cms-field" /></label
                ><label class="block"
                  >Pie de imagen<input v-model="block.caption" maxlength="500" class="cms-field"
                /></label>
                <p>Requiere derechos y comprobación vigentes; no aprueba ni publica media.</p></template
              >
              <label v-else-if="block.type === 'list'" class="block"
                >Elementos (uno por línea)<textarea
                  :value="block.items.join('\n')"
                  rows="3"
                  class="cms-field"
                  @input="setPromoList(block, $event)"
                />
              </label>
              <template v-else-if="block.type === 'callout'"
                ><label class="block">Título<input v-model="block.title" maxlength="180" class="cms-field" /></label
                ><label class="block">Texto<textarea v-model="block.text" maxlength="2000" class="cms-field" /></label
                ><label class="block"
                  >Tono<select v-model="block.tone" class="cms-field">
                    <option value="info">Información</option>
                    <option value="success">Confirmación</option>
                    <option value="warning">Aviso</option>
                  </select></label
                ></template
              >
            </article>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="type in ['heading', 'paragraph', 'cta', 'image', 'list', 'callout'] as const"
                :key="type"
                type="button"
                :disabled="promoBlocks.length >= 10"
                class="rounded border px-3 py-2"
                @click="addPromoBlock(type)"
              >
                Añadir {{ type }}
              </button>
            </div>
          </fieldset>
          <label v-else :for="`${prefix}-blocks`" class="block"
            >Bloques tipados (JSON)<textarea
              :id="`${prefix}-blocks`"
              v-model="form.blocksJson"
              data-cms-blocks
              rows="12"
              required
              class="cms-field font-mono text-sm"
            />
          </label>
          <label class="block"
            ><input v-model="form.resourceEnabled" data-cms-resource-enabled type="checkbox" /> Incluir en el centro de
            recursos</label
          >
          <fieldset v-if="form.resourceEnabled" class="min-w-0 space-y-3 rounded-lg border p-3">
            <legend>Metadatos editoriales del borrador</legend>
            <p>
              No publica ni acredita experiencia por sí solo. Requiere la revisión y publicación gobernadas del CMS. Usa
              únicamente identidad profesional autorizada para mostrarse públicamente.
            </p>
            <label class="block"
              >Tipo<select v-model="form.resourceKind" data-cms-resource-kind class="cms-field">
                <option value="article">Artículo</option>
                <option value="pillar">Guía pilar</option>
                <option value="landing">Problema / sector</option>
              </select></label
            >
            <label class="block"
              >Slug de categoría editorial<input
                v-model="form.resourceCategory"
                data-cms-resource-category
                maxlength="160"
                required
                class="cms-field"
            /></label>
            <label class="block"
              >Nombre de categoría editorial<input
                v-model="form.resourceCategoryLabel"
                data-cms-resource-category-label
                maxlength="100"
                required
                class="cms-field"
            /></label>
            <label class="block"
              >Autoría pública<input
                v-model="form.resourceAuthor"
                data-cms-resource-author
                maxlength="120"
                required
                class="cms-field"
            /></label>
            <label class="block"
              >Experiencia profesional autorizada<textarea
                v-model="form.resourceExperience"
                data-cms-resource-experience
                minlength="10"
                maxlength="1000"
                required
                class="cms-field"
              />
            </label>
            <label class="block"
              >Revisión realizada (UTC ISO)<input
                v-model="form.resourceReviewed"
                data-cms-resource-reviewed
                placeholder="AAAA-MM-DDTHH:mm:ssZ"
                required
                class="cms-field"
            /></label>
            <label class="block"
              >Próxima revisión (UTC ISO)<input
                v-model="form.resourceReviewDue"
                data-cms-resource-review-due
                placeholder="AAAA-MM-DDTHH:mm:ssZ"
                required
                class="cms-field"
            /></label>
            <label class="block"
              >Slug de guía pilar (opcional)<input
                v-model="form.resourcePillar"
                data-cms-resource-pillar
                maxlength="160"
                class="cms-field"
            /></label>
            <label class="block"
              >Productos relacionados (IDs de catálogo, uno por línea, máximo 12)<textarea
                v-model="form.resourceProducts"
                data-cms-resource-products
                maxlength="240"
                class="cms-field"
              />
            </label>
            <label class="block"
              >Categorías de catálogo (slugs, uno por línea, máximo 12)<textarea
                v-model="form.resourceCategories"
                data-cms-resource-categories
                maxlength="1932"
                class="cms-field"
              />
            </label>
            <label class="block"
              >Recursos relacionados (slugs, uno por línea, máximo 12)<textarea
                v-model="form.resourceResources"
                data-cms-resource-resources
                maxlength="1932"
                class="cms-field"
              />
            </label>
            <p>
              Los vínculos se muestran sólo si su destino sigue publicado. Las categorías abren el catálogo con el
              filtro de familia existente.
            </p>
          </fieldset>
          <label :for="`${prefix}-help-enabled`" class="block">
            <input :id="`${prefix}-help-enabled`" v-model="form.helpEnabled" data-cms-help-enabled type="checkbox" />
            Incluir en ayuda
          </label>
          <template v-if="form.helpEnabled">
            <label :for="`${prefix}-help-category`" class="block"
              >Categoría de ayuda
              <select
                :id="`${prefix}-help-category`"
                v-model="form.helpCategory"
                data-cms-help-category
                required
                class="cms-field"
              >
                <option value="" disabled>Selecciona una categoría</option>
                <option v-for="category in SUPPORT_KNOWLEDGE_CATEGORIES" :key="category.id" :value="category.id">
                  {{ category.label }}
                </option>
              </select>
            </label>
            <label :for="`${prefix}-help-review`" class="block"
              >Próxima revisión (UTC)
              <input
                :id="`${prefix}-help-review`"
                v-model="form.helpReviewDueAt"
                data-cms-help-review
                placeholder="AAAA-MM-DDTHH:mm:ssZ"
                maxlength="20"
                required
                class="cms-field"
              />
            </label>
            <p class="text-sm">
              Fecha explícita en UTC, por ejemplo 2027-03-01T10:00:00Z. Guardar no publica ni aprueba contenido químico
              o legal. La ayuda sólo incluirá la versión publicada mientras su revisión siga vigente.
            </p>
          </template>
          <p class="text-sm">
            heading, paragraph, list, image, callout o cta. Sin HTML/JS arbitrario; imágenes sólo referencian originales
            existentes en cuarentena, sin aprobarlos ni hacerlos públicos.
          </p>
        </template>
        <p v-if="baseline">
          Objetivo: {{ baseline.title }} · /{{ baseline.slug }} · versión de página {{ baseline.pageVersion }}.
        </p>
        <p v-if="restoreSource">
          Se creará una nueva versión desde v{{ restoreSource.version }} · /{{ restoreSource.document.slug }}. No se
          publicará.
        </p>
        <p v-if="restoreSource?.document.supportKnowledge" data-cms-help-restore class="text-sm">
          Se restaurará también su inclusión en ayuda: {{ restoreSource.document.supportKnowledge.category }} · próxima
          revisión {{ restoreSource.document.supportKnowledge.reviewDueAt }}. No modifica la versión publicada.
        </p>
        <p v-if="restoreSource?.document.resourceHub" data-cms-resource-restore class="text-sm">
          Se restaurará su metadata editorial: {{ restoreSource.document.resourceHub.author.name }} · revisión
          {{ restoreSource.document.resourceHub.reviewedAt }} · próxima revisión
          {{ restoreSource.document.resourceHub.reviewDueAt }}. No se publica automáticamente.
        </p>
        <label :for="`${prefix}-reason`" class="block"
          >Motivo o resumen del cambio<input
            :id="`${prefix}-reason`"
            v-model="form.reason"
            data-cms-reason
            minlength="3"
            maxlength="500"
            required
            class="cms-field"
        /></label>
        <label v-if="mode === 'archive_draft'"
          ><input v-model="archiveConfirmed" data-cms-archive-confirm type="checkbox" /> Confirmo archivar este borrador
          y conservar su historial y sus slugs.</label
        >
      </fieldset>
      <div class="flex flex-wrap gap-2">
        <UButton data-cms-submit type="submit" :disabled="!canSubmit" :loading="busy"
          >Confirmar operación de borrador</UButton
        ><UButton data-cms-cancel variant="outline" :disabled="busy || reading || !!intent" @click="cancel"
          >Cancelar</UButton
        >
      </div>
    </form>
    <p v-if="message" role="status" aria-live="polite" class="rounded-lg border p-3">{{ message }}</p>
    <p v-if="acknowledgement && authority" data-cms-receipt class="text-sm">
      Recibo histórico: {{ acknowledgement.action }} · versión de página {{ acknowledgement.pageVersion }}. No sustituye
      la consulta vigente.
    </p>
    <UButton v-if="intent && uncertain" data-cms-retry :disabled="!canRetry" :loading="busy" @click="retry"
      >Reintentar sólo la solicitud original</UButton
    >
  </section>
</template>

<style scoped>
.cms-field {
  display: block;
  width: 100%;
  margin-top: 0.25rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.65rem;
  background: var(--surface);
  color: var(--text);
}
</style>
