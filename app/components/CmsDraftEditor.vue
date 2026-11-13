<script setup lang="ts">
import { Teleport } from 'vue'
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

const props = withDefaults(
  defineProps<{
    runtime: unknown
    operatorId: string
    authorize: () => boolean
    /** Oculta «Actualizar» y «Nueva página» de la cabecera cuando la pantalla muestra otro apartado. */
    headerActions?: boolean
  }>(),
  { headerActions: true }
)
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

// ── Estado de presentación (no interviene en lecturas ni envíos) ──
const ACTION_NAMES: Record<CmsAction, string> = {
  create_draft: 'página creada',
  update_draft: 'borrador guardado',
  restore_draft: 'versión restaurada',
  archive_draft: 'página archivada'
}
const BLOCK_NAMES: Record<ContentBlock['type'], string> = {
  heading: 'Encabezado',
  paragraph: 'Párrafo',
  list: 'Lista',
  image: 'Imagen',
  callout: 'Aviso destacado',
  cta: 'Enlace'
}
const PROMO_BLOCK_TYPES = ['heading', 'paragraph', 'cta', 'image', 'list', 'callout'] as const
const PLACEMENT_NAMES: Record<(typeof promoPlacements)[number], string> = {
  home: 'Inicio',
  catalog: 'Catálogo',
  category: 'Categoría',
  product: 'Producto'
}
const STATUS_OPTIONS = [
  { value: 'all', label: 'Todas' },
  { value: 'draft', label: 'Borradores' },
  { value: 'hidden', label: 'Archivadas' }
]
/** Texto legible de un bloque para los resúmenes del borrador y del historial. */
function blockSummary(block: Record<string, unknown>): string {
  const text = (key: string) => (typeof block[key] === 'string' ? (block[key] as string) : '')
  switch (block.type) {
    case 'cta':
      return `${text('label')} → ${text('href')}`
    case 'image':
      return text('alt') || text('caption')
    case 'list':
      return Array.isArray(block.items) ? block.items.join(' · ') : ''
    case 'callout':
      return [text('title'), text('text')].filter(Boolean).join(': ')
    default:
      return text('text')
  }
}
const helpCategoryName = (id: string) =>
  SUPPORT_KNOWLEDGE_CATEGORIES.find((category) => category.id === id)?.label.toLowerCase() ?? id
const panel = ref<'list' | 'page'>('list'),
  detailTab = ref('draft'),
  search = ref(''),
  statusFilter = ref('all'),
  headerTarget = ref<boolean | null>(null)
const visiblePages = computed(() => {
  const term = search.value.toLowerCase()
  return (currentList.value?.pages ?? []).filter(
    (page) =>
      (statusFilter.value === 'all' || page.status === statusFilter.value) &&
      (!term || page.title.toLowerCase().includes(term) || page.slug.toLowerCase().includes(term))
  )
})
const detailTabs = computed(() => [
  { value: 'draft', label: 'Borrador' },
  { value: 'publication', label: 'Publicación' },
  { value: 'history', label: 'Historial', count: currentDetail.value?.history.pagination.total ?? null }
])
function clearFilters() {
  search.value = ''
  statusFilter.value = 'all'
}
async function openPage(id: string, calendarSelection = false) {
  await loadDetail(id, 1, calendarSelection)
  if (alive && selectedId.value === id && (detailStatus.value !== 'idle' || mode.value)) panel.value = 'page'
}
function backToList() {
  if (busy.value || intent.value || mode.value) return
  panel.value = 'list'
  if (!currentList.value) void loadList()
}
watch(mode, (current) => {
  if (current) {
    panel.value = 'page'
    detailTab.value = 'draft'
  } else if (!selectedId.value) panel.value = 'list'
})
onMounted(() => {
  headerTarget.value = !!document.getElementById('adm-page-actions')
})
</script>

<template>
  <section :aria-labelledby="`${prefix}-heading`" class="adm-stack">
    <h2 :id="`${prefix}-heading`" class="sr-only">Páginas de contenido</h2>
    <component
      :is="headerTarget ? Teleport : 'div'"
      v-if="headerTarget !== null"
      v-bind="headerTarget ? { to: '#adm-page-actions' } : {}"
    >
      <div v-show="headerActions" class="flex flex-wrap items-center justify-end gap-2">
        <button
          data-cms-read
          type="button"
          class="adm-btn adm-btn--secondary"
          :disabled="!authority || busy || reading"
          @click="loadList()"
        >
          Actualizar
        </button>
        <button
          v-if="currentList?.capabilities.contentCreate"
          data-cms-create
          type="button"
          class="adm-btn adm-btn--primary"
          :disabled="busy || reading || !!intent || blocked"
          @click="begin('create_draft')"
        >
          Nueva página
        </button>
      </div>
    </component>

    <UAlert
      v-if="message"
      role="status"
      aria-live="polite"
      :color="blocked || uncertain ? 'warning' : 'neutral'"
      variant="subtle"
      :icon="blocked || uncertain ? 'i-lucide-triangle-alert' : 'i-lucide-info'"
      :title="message"
    />
    <div v-if="intent && uncertain">
      <button
        data-cms-retry
        type="button"
        class="adm-btn adm-btn--secondary"
        :disabled="!canRetry || busy"
        @click="retry"
      >
        Reintentar el mismo envío
      </button>
    </div>
    <p v-if="acknowledgement && authority" data-cms-receipt class="adm-help">
      Última operación registrada: {{ ACTION_NAMES[acknowledgement.action] }} (cambio n.º
      {{ acknowledgement.pageVersion }} de la página). Pulsa «Actualizar» para ver cómo ha quedado.
    </p>

    <!-- Listado de páginas -->
    <div v-show="panel === 'list'" class="adm-stack">
      <AdminCard
        title="Páginas"
        description="Borrador y publicación son independientes: guardar o restaurar un borrador no lo publica."
        flush
      >
        <div v-if="currentList && currentList.pagination.total > 0" class="adm-tablecard__bar">
          <AdminToolbar v-model:search="search" placeholder="Buscar por título o dirección…">
            <AdminFilters v-model="statusFilter" :options="STATUS_OPTIONS" label="Filtrar por estado" />
          </AdminToolbar>
        </div>
        <div v-if="!authority" role="alert">
          <AdminEmptyState
            variant="error"
            title="Ahora mismo no puedes gestionar las páginas"
            description="Se necesita una sesión vigente con correo verificado, verificación en dos pasos y permiso de contenido."
          />
        </div>
        <div v-else-if="listStatus === 'pending'" role="status" class="adm-table-skeleton" aria-busy="true">
          <span class="sr-only">Consultando las páginas…</span>
          <div v-for="row in 5" :key="row"><i /><i /><i /></div>
        </div>
        <div v-else-if="!currentList" role="alert">
          <AdminEmptyState
            variant="error"
            title="No se han podido cargar las páginas"
            description="No hay una lista confirmada. Esto no significa que no existan páginas."
          >
            <button type="button" class="adm-btn adm-btn--secondary" :disabled="busy || reading" @click="loadList()">
              Reintentar
            </button>
          </AdminEmptyState>
        </div>
        <div v-else-if="currentList.pagination.total === 0" role="status">
          <AdminEmptyState
            icon="i-lucide-panels-top-left"
            title="Todavía no hay páginas de contenido"
            description="Son las páginas que no son catálogo: quiénes somos, condiciones, guías de uso o una campaña. Crea la primera con «Nueva página»."
          />
        </div>
        <AdminEmptyState
          v-else-if="!visiblePages.length"
          variant="filtered"
          title="Ninguna página con estos filtros"
          description="Prueba con otra búsqueda o quita el filtro de estado."
        >
          <button type="button" class="adm-btn adm-btn--secondary" @click="clearFilters">Quitar filtros</button>
        </AdminEmptyState>
        <div v-else class="adm-table-wrap">
          <table class="adm-table" aria-label="Páginas editoriales">
            <thead>
              <tr>
                <th scope="col">Página</th>
                <th scope="col">Estado</th>
                <th scope="col" class="hidden sm:table-cell">Borrador</th>
                <th scope="col" class="hidden md:table-cell">Última modificación</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="page in visiblePages" :key="page.id" :data-selected="selectedId === page.id || undefined">
                <td>
                  <button
                    type="button"
                    :data-cms-select="page.id"
                    class="text-left font-semibold text-[var(--text-strong)] hover:underline disabled:opacity-60"
                    :disabled="busy || reading || !!intent"
                    @click="openPage(page.id)"
                  >
                    {{ page.title }}
                  </button>
                  <p class="adm-help break-all">/{{ page.slug }}</p>
                </td>
                <td>
                  <AdminBadge :tone="page.status === 'hidden' ? 'neutral' : 'warning'">
                    {{ page.status === 'hidden' ? 'Archivada' : 'Borrador' }}
                  </AdminBadge>
                </td>
                <td class="hidden sm:table-cell">Versión {{ page.draftVersion }}</td>
                <td class="hidden md:table-cell">{{ adminDate(page.updatedAt, true) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="currentList && currentList.pagination.total > 25" class="adm-pagination">
          <p>Página {{ listPage }} · {{ currentList.pagination.total }} páginas</p>
          <div class="flex items-center gap-2">
            <button
              data-cms-list-previous
              type="button"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :disabled="listPage <= 1 || busy || reading || !!intent"
              @click="loadList(listPage - 1)"
            >
              Anterior
            </button>
            <button
              data-cms-list-next
              type="button"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :disabled="!currentList.pagination.hasMore || busy || reading || !!intent"
              @click="loadList(listPage + 1)"
            >
              Siguiente
            </button>
          </div>
        </div>
      </AdminCard>

      <CmsEditorialCalendar
        v-if="currentList?.capabilities.contentSchedule"
        :runtime="runtime"
        :operator-id="operatorId"
        :authorize="authorize"
        :enabled="true"
        :can-select="!busy && !reading && !publicationPending && !intent && !mode"
        @select-page="openPage($event, true)"
      />
    </div>

    <!-- Página abierta -->
    <div v-show="panel === 'page'" class="adm-stack">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          class="adm-btn adm-btn--ghost adm-btn--sm"
          :disabled="busy || !!intent || !!mode"
          @click="backToList"
        >
          <UIcon name="i-lucide-arrow-left" class="size-4" />Páginas
        </button>
        <template v-if="mode === 'create_draft'">
          <h3 class="adm-section__title">Nueva página</h3>
        </template>
        <template v-else-if="currentDetail">
          <h3 class="adm-section__title">{{ currentDetail.page.title }}</h3>
          <AdminBadge :tone="currentDetail.page.status === 'hidden' ? 'neutral' : 'warning'">
            {{ currentDetail.page.status === 'hidden' ? 'Archivada' : 'Borrador' }}
          </AdminBadge>
          <span class="adm-help break-all">
            /{{ currentDetail.page.slug }} · borrador versión {{ currentDetail.page.draftVersion }}
          </span>
        </template>
        <div v-show="mode !== 'create_draft'" class="ml-auto flex flex-wrap items-center gap-2">
          <button
            v-if="selectedId && authority"
            data-cms-detail-read
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            :disabled="busy || reading"
            @click="loadDetail(selectedId, historyPage)"
          >
            Actualizar
          </button>
          <template v-if="currentDetail && currentDetail.page.status === 'draft'">
            <button
              v-if="currentDetail.capabilities.contentArchive"
              v-show="!mode"
              data-cms-archive
              type="button"
              class="adm-btn adm-btn--danger-soft adm-btn--sm"
              :disabled="busy || reading || !!intent || blocked"
              @click="begin('archive_draft')"
            >
              Archivar
            </button>
            <button
              v-if="currentDetail.capabilities.contentUpdate"
              v-show="!mode"
              data-cms-edit
              type="button"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :disabled="busy || reading || !!intent || blocked"
              @click="begin('update_draft')"
            >
              Editar borrador
            </button>
          </template>
        </div>
      </div>

      <div v-show="mode !== 'create_draft'" class="adm-stack">
        <p v-if="detailStatus === 'pending'" role="status" class="adm-help">Cargando la página y su historial…</p>
        <AdminEmptyState
          v-else-if="selectedId && detailStatus === 'error'"
          variant="error"
          compact
          title="No se ha podido cargar esta página"
          description="Vuelve a consultarla antes de preparar ningún cambio."
        >
          <button
            type="button"
            class="adm-btn adm-btn--secondary"
            :disabled="busy || reading"
            @click="loadDetail(selectedId, historyPage)"
          >
            Reintentar
          </button>
        </AdminEmptyState>

        <AdminTabs v-show="selectedId && !mode" v-model="detailTab" :tabs="detailTabs" label="Apartados de la página" />

        <div v-show="!mode && detailTab === 'draft'">
          <AdminCard
            v-if="currentDetail"
            title="Contenido del borrador"
            :description="`Último cambio: ${currentDetail.draft.document.changeSummary}`"
          >
            <dl class="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <div>
                <dt class="adm-help">Título en buscadores</dt>
                <dd>{{ currentDetail.draft.document.seo.title }}</dd>
              </div>
              <div>
                <dt class="adm-help">Descripción en buscadores</dt>
                <dd>{{ currentDetail.draft.document.seo.description }}</dd>
              </div>
            </dl>
            <ul class="mt-4 space-y-2 border-t border-[var(--border)] pt-4">
              <li v-for="block in currentDetail.draft.document.blocks" :key="block.id" class="flex gap-3">
                <span class="adm-help w-28 shrink-0">{{ BLOCK_NAMES[block.type] }}</span>
                <span class="min-w-0 whitespace-pre-wrap break-words">{{ blockSummary(block) }}</span>
              </li>
            </ul>
          </AdminCard>
        </div>

        <div v-show="!mode && detailTab === 'publication'">
          <CmsPublicationControls
            v-if="selectedId"
            :page-id="selectedId"
            :runtime="runtime"
            :operator-id="operatorId"
            :authorize="authorize"
            @pending="publicationPending = $event"
          />
        </div>

        <div v-show="!mode && detailTab === 'history'">
          <AdminCard
            v-if="currentDetail"
            title="Historial de versiones"
            description="Cada guardado crea una versión nueva; las anteriores no se modifican."
            flush
          >
            <ul class="adm-list">
              <li v-for="version in currentDetail.history.versions" :key="version.id" class="flex-wrap">
                <span class="adm-list__index">{{ version.version }}</span>
                <div class="min-w-0 flex-1">
                  <p class="adm-list__title">{{ version.document.changeSummary }}</p>
                  <p class="adm-help">
                    {{ adminDate(version.createdAt, true) }} · autor #{{ version.createdBy.slice(0, 8).toUpperCase() }}
                  </p>
                  <details class="mt-1">
                    <summary class="adm-help cursor-pointer">Ver el contenido de esta versión</summary>
                    <ul class="mt-2 space-y-1">
                      <li class="flex gap-3">
                        <span class="adm-help w-28 shrink-0">Título</span>
                        <span class="min-w-0 break-words">{{ version.document.title }}</span>
                      </li>
                      <li class="flex gap-3">
                        <span class="adm-help w-28 shrink-0">Dirección</span>
                        <span class="min-w-0 break-all">/{{ version.document.slug }}</span>
                      </li>
                      <li v-for="block in version.document.blocks" :key="block.id" class="flex gap-3">
                        <span class="adm-help w-28 shrink-0">{{ BLOCK_NAMES[block.type] }}</span>
                        <span class="min-w-0 whitespace-pre-wrap break-words">{{ blockSummary(block) }}</span>
                      </li>
                    </ul>
                  </details>
                </div>
                <button
                  v-if="currentDetail.capabilities.contentRestore"
                  :data-cms-restore="version.id"
                  type="button"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  :disabled="busy || reading || !!intent || blocked"
                  @click="begin('restore_draft', version.id)"
                >
                  Restaurar como versión nueva
                </button>
              </li>
            </ul>
            <template v-if="currentDetail.history.pagination.total > 5" #footer>
              <button
                data-cms-history-previous
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="historyPage <= 1 || busy || reading || !!intent"
                @click="loadDetail(selectedId, historyPage - 1)"
              >
                Versiones más recientes
              </button>
              <button
                data-cms-history-next
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="!currentDetail.history.pagination.hasMore || busy || reading || !!intent"
                @click="loadDetail(selectedId, historyPage + 1)"
              >
                Versiones anteriores
              </button>
            </template>
          </AdminCard>
        </div>
      </div>

      <form
        v-if="mode && authority && (mode === 'create_draft' ? currentList : currentDetail)"
        class="adm-stack"
        :aria-busy="busy"
        @submit.prevent="submit"
      >
        <fieldset
          :disabled="busy || reading || !!intent || blocked || !permitted(mode, baseline)"
          class="adm-stack min-w-0"
        >
          <legend class="adm-section__title" :class="mode === 'create_draft' && 'sr-only'">
            {{
              mode === 'create_draft'
                ? 'Nueva página'
                : mode === 'archive_draft'
                  ? 'Archivar la página'
                  : mode === 'restore_draft'
                    ? 'Restaurar una versión anterior'
                    : 'Editar el borrador'
            }}
          </legend>
          <template v-if="mode === 'create_draft' || mode === 'update_draft'">
            <AdminCard title="Datos de la página">
              <div class="adm-form-grid">
                <AdminFormField label="Título" :for="`${prefix}-title`" required>
                  <input :id="`${prefix}-title`" v-model="form.title" data-cms-title maxlength="160" required />
                </AdminFormField>
                <AdminFormField
                  label="Dirección de la página"
                  :for="`${prefix}-slug`"
                  help="Lo que va detrás de la barra en la dirección web: minúsculas, números y guiones. Ejemplo: quienes-somos"
                  required
                >
                  <input :id="`${prefix}-slug`" v-model="form.slug" data-cms-slug maxlength="160" required />
                </AdminFormField>
              </div>
            </AdminCard>

            <AdminCard title="Buscadores" description="Cómo se presenta la página en Google y otros buscadores.">
              <div class="adm-stack">
                <AdminFormField label="Título en buscadores" :for="`${prefix}-seo-title`" required>
                  <input
                    :id="`${prefix}-seo-title`"
                    v-model="form.seoTitle"
                    data-cms-seo-title
                    maxlength="70"
                    required
                  />
                </AdminFormField>
                <AdminFormField label="Descripción en buscadores" :for="`${prefix}-seo-description`" required>
                  <input
                    :id="`${prefix}-seo-description`"
                    v-model="form.seoDescription"
                    data-cms-seo-description
                    maxlength="180"
                    required
                  />
                </AdminFormField>
                <label class="adm-check">
                  <input v-model="form.noindex" data-cms-noindex type="checkbox" />
                  Pedir a los buscadores que no muestren esta página cuando se publique
                </label>
              </div>
            </AdminCard>

            <AdminCard title="Contenido">
              <div class="adm-stack">
                <label class="adm-check">
                  <input v-model="form.promoEnabled" data-cms-promo-enabled type="checkbox" />
                  Es un bloque promocional (no aplica descuentos por sí solo)
                </label>
                <fieldset v-if="form.promoEnabled" class="adm-stack min-w-0">
                  <legend class="adm-label">Presentación y lugares donde se muestra</legend>
                  <div class="adm-form-grid">
                    <AdminFormField v-slot="{ id }" label="Formato">
                      <select :id="id" v-model="form.promoFormat" data-cms-promo-format>
                        <option value="banner">Franja con imagen</option>
                        <option value="bar">Barra</option>
                        <option value="card">Tarjeta</option>
                      </select>
                    </AdminFormField>
                    <AdminFormField
                      v-slot="{ id }"
                      label="Prioridad"
                      help="De 0 a 1000. Con un número mayor se muestra antes."
                    >
                      <input
                        :id="id"
                        v-model="form.promoPriority"
                        data-cms-promo-priority
                        type="number"
                        min="0"
                        max="1000"
                        step="1"
                      />
                    </AdminFormField>
                  </div>
                  <div class="flex flex-wrap gap-x-5 gap-y-2">
                    <label v-for="placement in promoPlacements" :key="placement" class="adm-check">
                      <input
                        v-model="form.promoPlacements"
                        :value="placement"
                        :data-cms-promo-placement="placement"
                        type="checkbox"
                      />
                      {{ PLACEMENT_NAMES[placement] }}
                    </label>
                  </div>
                  <details>
                    <summary class="adm-label cursor-pointer">Limitar a ciertas páginas (opcional)</summary>
                    <div class="adm-stack mt-3">
                      <p class="adm-help">
                        Una por línea, hasta 20. Si lo dejas vacío no se limita. No se dirige a personas ni a perfiles.
                      </p>
                      <div class="adm-form-grid">
                        <AdminFormField v-slot="{ id }" label="Direcciones exactas de la tienda">
                          <textarea
                            :id="id"
                            v-model="form.promoPaths"
                            data-cms-promo-paths
                            rows="3"
                            placeholder="/catalogo"
                          />
                        </AdminFormField>
                        <AdminFormField v-slot="{ id }" label="Categorías (su dirección)">
                          <textarea :id="id" v-model="form.promoCategories" data-cms-promo-categories rows="3" />
                        </AdminFormField>
                        <AdminFormField v-slot="{ id }" label="Productos (su dirección)">
                          <textarea :id="id" v-model="form.promoProducts" data-cms-promo-products rows="3" />
                        </AdminFormField>
                      </div>
                    </div>
                  </details>
                  <p class="adm-help">
                    Las fechas, la aprobación y la vista previa se gestionan en la pestaña «Publicación». Guardar aquí
                    no publica.
                  </p>
                  <article
                    v-for="(block, index) in promoBlocks"
                    :key="block.id"
                    class="min-w-0 space-y-3 rounded-[var(--radius-surface)] border border-[var(--border)] p-3"
                  >
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <strong>{{ index + 1 }} · {{ BLOCK_NAMES[block.type] }}</strong>
                      <button
                        type="button"
                        class="adm-btn adm-btn--ghost adm-btn--sm"
                        @click="promoBlocks.splice(index, 1)"
                      >
                        Quitar bloque {{ index + 1 }}
                      </button>
                    </div>
                    <template v-if="block.type === 'heading'">
                      <AdminFormField v-slot="{ id }" label="Encabezado">
                        <input :id="id" v-model="block.text" data-cms-promo-heading maxlength="180" />
                      </AdminFormField>
                      <AdminFormField v-slot="{ id }" label="Tamaño">
                        <select :id="id" v-model="block.level">
                          <option value="h2">Grande</option>
                          <option value="h3">Mediano</option>
                        </select>
                      </AdminFormField>
                    </template>
                    <AdminFormField v-else-if="block.type === 'paragraph'" v-slot="{ id }" label="Texto">
                      <textarea :id="id" v-model="block.text" data-cms-promo-text maxlength="5000" rows="3" />
                    </AdminFormField>
                    <template v-else-if="block.type === 'cta'">
                      <AdminFormField v-slot="{ id }" label="Texto del enlace">
                        <input :id="id" v-model="block.label" data-cms-promo-cta-label maxlength="120" />
                      </AdminFormField>
                      <AdminFormField
                        v-slot="{ id }"
                        label="Destino"
                        help="Una dirección de la tienda (empieza por /) o una web segura (https://)."
                      >
                        <input :id="id" v-model="block.href" data-cms-promo-cta-href maxlength="500" />
                      </AdminFormField>
                    </template>
                    <template v-else-if="block.type === 'image'">
                      <AdminFormField
                        v-slot="{ id }"
                        label="Identificador de la imagen"
                        help="Cópialo de la biblioteca de imágenes. La imagen debe tener sus derechos y revisión al día; aquí no se aprueba ni se publica."
                      >
                        <input :id="id" v-model="block.assetId" maxlength="36" />
                      </AdminFormField>
                      <AdminFormField v-slot="{ id }" label="Texto alternativo">
                        <input :id="id" v-model="block.alt" maxlength="240" />
                      </AdminFormField>
                      <AdminFormField v-slot="{ id }" label="Pie de imagen">
                        <input :id="id" v-model="block.caption" maxlength="500" />
                      </AdminFormField>
                    </template>
                    <AdminFormField v-else-if="block.type === 'list'" v-slot="{ id }" label="Elementos (uno por línea)">
                      <textarea
                        :id="id"
                        :value="block.items.join('\n')"
                        rows="3"
                        @input="setPromoList(block, $event)"
                      />
                    </AdminFormField>
                    <template v-else-if="block.type === 'callout'">
                      <AdminFormField v-slot="{ id }" label="Título">
                        <input :id="id" v-model="block.title" maxlength="180" />
                      </AdminFormField>
                      <AdminFormField v-slot="{ id }" label="Texto">
                        <textarea :id="id" v-model="block.text" maxlength="2000" />
                      </AdminFormField>
                      <AdminFormField v-slot="{ id }" label="Tipo de aviso">
                        <select :id="id" v-model="block.tone">
                          <option value="info">Información</option>
                          <option value="success">Confirmación</option>
                          <option value="warning">Aviso</option>
                        </select>
                      </AdminFormField>
                    </template>
                  </article>
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="adm-help">Añadir:</span>
                    <button
                      v-for="type in PROMO_BLOCK_TYPES"
                      :key="type"
                      type="button"
                      :disabled="promoBlocks.length >= 10"
                      class="adm-btn adm-btn--secondary adm-btn--sm"
                      @click="addPromoBlock(type)"
                    >
                      {{ BLOCK_NAMES[type] }}
                    </button>
                  </div>
                </fieldset>
                <AdminFormField
                  v-else
                  label="Bloques de contenido (formato avanzado)"
                  :for="`${prefix}-blocks`"
                  help="Lista de bloques: encabezado, párrafo, lista, imagen, aviso destacado o enlace. No admite código; las imágenes solo pueden ser las ya subidas a la biblioteca."
                  required
                >
                  <textarea
                    :id="`${prefix}-blocks`"
                    v-model="form.blocksJson"
                    data-cms-blocks
                    rows="12"
                    required
                    class="font-mono text-xs"
                  />
                </AdminFormField>
              </div>
            </AdminCard>

            <AdminCard
              title="Centro de recursos"
              description="Guías y artículos que se muestran en la sección de recursos."
            >
              <div class="adm-stack">
                <label class="adm-check">
                  <input v-model="form.resourceEnabled" data-cms-resource-enabled type="checkbox" />
                  Incluir en el centro de recursos
                </label>
                <fieldset v-if="form.resourceEnabled" class="adm-stack min-w-0">
                  <legend class="adm-label">Datos editoriales</legend>
                  <p class="adm-help">
                    No publica ni acredita experiencia por sí solo: hace falta la revisión y la publicación habituales.
                    Usa solo una identidad profesional autorizada para mostrarse en público.
                  </p>
                  <div class="adm-form-grid">
                    <AdminFormField v-slot="{ id }" label="Tipo">
                      <select :id="id" v-model="form.resourceKind" data-cms-resource-kind>
                        <option value="article">Artículo</option>
                        <option value="pillar">Guía principal</option>
                        <option value="landing">Problema o sector</option>
                      </select>
                    </AdminFormField>
                    <AdminFormField v-slot="{ id }" label="Nombre de la categoría" required>
                      <input
                        :id="id"
                        v-model="form.resourceCategoryLabel"
                        data-cms-resource-category-label
                        maxlength="100"
                        required
                      />
                    </AdminFormField>
                    <AdminFormField
                      v-slot="{ id }"
                      label="Dirección de la categoría"
                      help="Minúsculas y guiones. Ejemplo: limpieza"
                      required
                    >
                      <input
                        :id="id"
                        v-model="form.resourceCategory"
                        data-cms-resource-category
                        maxlength="160"
                        required
                      />
                    </AdminFormField>
                    <AdminFormField v-slot="{ id }" label="Autor que se muestra" required>
                      <input :id="id" v-model="form.resourceAuthor" data-cms-resource-author maxlength="120" required />
                    </AdminFormField>
                  </div>
                  <AdminFormField v-slot="{ id }" label="Experiencia profesional del autor" required>
                    <textarea
                      :id="id"
                      v-model="form.resourceExperience"
                      data-cms-resource-experience
                      minlength="10"
                      maxlength="1000"
                      required
                    />
                  </AdminFormField>
                  <div class="adm-form-grid">
                    <AdminFormField
                      v-slot="{ id }"
                      label="Fecha de la última revisión"
                      help="Fecha y hora universal. Ejemplo: 2027-03-01T10:00:00Z"
                      required
                    >
                      <input
                        :id="id"
                        v-model="form.resourceReviewed"
                        data-cms-resource-reviewed
                        placeholder="AAAA-MM-DDTHH:mm:ssZ"
                        required
                      />
                    </AdminFormField>
                    <AdminFormField
                      v-slot="{ id }"
                      label="Próxima revisión"
                      help="Fecha y hora universal, con el mismo formato."
                      required
                    >
                      <input
                        :id="id"
                        v-model="form.resourceReviewDue"
                        data-cms-resource-review-due
                        placeholder="AAAA-MM-DDTHH:mm:ssZ"
                        required
                      />
                    </AdminFormField>
                    <AdminFormField v-slot="{ id }" label="Guía principal a la que pertenece (opcional)">
                      <input :id="id" v-model="form.resourcePillar" data-cms-resource-pillar maxlength="160" />
                    </AdminFormField>
                  </div>
                  <div class="adm-form-grid">
                    <AdminFormField
                      v-slot="{ id }"
                      label="Productos relacionados"
                      help="Número de producto del catálogo, uno por línea (máximo 12)."
                    >
                      <textarea :id="id" v-model="form.resourceProducts" data-cms-resource-products maxlength="240" />
                    </AdminFormField>
                    <AdminFormField
                      v-slot="{ id }"
                      label="Categorías del catálogo"
                      help="Su dirección, una por línea (máximo 12)."
                    >
                      <textarea
                        :id="id"
                        v-model="form.resourceCategories"
                        data-cms-resource-categories
                        maxlength="1932"
                      />
                    </AdminFormField>
                    <AdminFormField
                      v-slot="{ id }"
                      label="Otros recursos relacionados"
                      help="Su dirección, una por línea (máximo 12)."
                    >
                      <textarea
                        :id="id"
                        v-model="form.resourceResources"
                        data-cms-resource-resources
                        maxlength="1932"
                      />
                    </AdminFormField>
                  </div>
                  <p class="adm-help">
                    Los enlaces solo se muestran si su destino sigue publicado. Las categorías abren el catálogo
                    filtrado por esa familia.
                  </p>
                </fieldset>
              </div>
            </AdminCard>

            <AdminCard title="Ayuda" description="Páginas que el centro de ayuda puede mostrar a los clientes.">
              <div class="adm-stack">
                <label :for="`${prefix}-help-enabled`" class="adm-check">
                  <input
                    :id="`${prefix}-help-enabled`"
                    v-model="form.helpEnabled"
                    data-cms-help-enabled
                    type="checkbox"
                  />
                  Incluir en ayuda
                </label>
                <div v-if="form.helpEnabled" class="adm-form-grid">
                  <AdminFormField label="Categoría de ayuda" :for="`${prefix}-help-category`" required>
                    <select :id="`${prefix}-help-category`" v-model="form.helpCategory" data-cms-help-category required>
                      <option value="" disabled>Selecciona una categoría</option>
                      <option v-for="category in SUPPORT_KNOWLEDGE_CATEGORIES" :key="category.id" :value="category.id">
                        {{ category.label }}
                      </option>
                    </select>
                  </AdminFormField>
                  <AdminFormField
                    label="Próxima revisión"
                    :for="`${prefix}-help-review`"
                    help="Fecha y hora universal, por ejemplo 2027-03-01T10:00:00Z. La ayuda solo mostrará la versión publicada mientras su revisión siga vigente."
                    required
                  >
                    <input
                      :id="`${prefix}-help-review`"
                      v-model="form.helpReviewDueAt"
                      data-cms-help-review
                      placeholder="AAAA-MM-DDTHH:mm:ssZ"
                      maxlength="20"
                      required
                    />
                  </AdminFormField>
                </div>
                <p v-if="form.helpEnabled" class="adm-help">Guardar no publica ni aprueba contenido químico o legal.</p>
              </div>
            </AdminCard>
          </template>

          <AdminCard :title="mode === 'archive_draft' ? 'Confirmar el archivo' : 'Motivo del cambio'">
            <div class="adm-stack">
              <p v-if="baseline && mode !== 'update_draft'" class="adm-help">
                Página: {{ baseline.title }} · /{{ baseline.slug }}
              </p>
              <p v-if="restoreSource" class="adm-help">
                Se creará un borrador nuevo a partir de la versión {{ restoreSource.version }} (/{{
                  restoreSource.document.slug
                }}). No se publicará.
              </p>
              <p v-if="restoreSource?.document.supportKnowledge" data-cms-help-restore class="adm-help">
                También se recuperará su inclusión en ayuda: categoría
                {{ helpCategoryName(restoreSource.document.supportKnowledge.category) }}, próxima revisión
                {{ restoreSource.document.supportKnowledge.reviewDueAt }}. No cambia la versión publicada.
              </p>
              <p v-if="restoreSource?.document.resourceHub" data-cms-resource-restore class="adm-help">
                También se recuperarán sus datos del centro de recursos: autor
                {{ restoreSource.document.resourceHub.author.name }}, revisado el
                {{ adminDate(restoreSource.document.resourceHub.reviewedAt) }}, próxima revisión el
                {{ adminDate(restoreSource.document.resourceHub.reviewDueAt) }}. No se publica automáticamente.
              </p>
              <AdminFormField
                label="Motivo o resumen del cambio"
                :for="`${prefix}-reason`"
                help="Queda guardado en el historial de la página."
                required
              >
                <input
                  :id="`${prefix}-reason`"
                  v-model="form.reason"
                  data-cms-reason
                  minlength="3"
                  maxlength="500"
                  required
                />
              </AdminFormField>
              <label v-if="mode === 'archive_draft'" class="adm-check">
                <input v-model="archiveConfirmed" data-cms-archive-confirm type="checkbox" />
                Confirmo que quiero archivar esta página. Su historial y su dirección se conservan.
              </label>
            </div>
          </AdminCard>
        </fieldset>
        <div class="flex flex-wrap justify-end gap-2">
          <button
            data-cms-cancel
            type="button"
            class="adm-btn adm-btn--secondary"
            :disabled="busy || reading || !!intent"
            @click="cancel"
          >
            Cancelar
          </button>
          <button
            data-cms-submit
            type="submit"
            class="adm-btn"
            :class="mode === 'archive_draft' ? 'adm-btn--danger' : 'adm-btn--primary'"
            :disabled="!canSubmit || busy"
          >
            {{
              mode === 'archive_draft'
                ? 'Archivar página'
                : mode === 'restore_draft'
                  ? 'Restaurar versión'
                  : 'Guardar borrador'
            }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>
