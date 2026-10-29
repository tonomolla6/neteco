<script setup lang="ts">
import {
  favoriteUnavailableLabel,
  type AccountFavoriteItem,
  type AccountFavoriteList,
  type FavoriteCartPreparation
} from '~/composables/useFavorites'
import { useCartStore } from '~/stores/cart'
import { validateQuantity } from '~~/server/domain/money'

definePageMeta({ middleware: 'auth', layout: 'cuenta' })
useSeoMeta({ title: 'Listas de compra', robots: 'noindex, nofollow' })

/**
 * Listas de compra.
 *
 * En B2B esto no es una lista de deseos: es la plantilla de reposición. Por eso se
 * llama «lista de compra» y no «favoritos», y por eso la acción principal es añadir
 * la lista entera al carrito, no ir producto a producto.
 */
const { notice, errorMessage, busy, run, showNotice } = useAccountFeedback()
const cart = useCartStore()
const runtimeConfig = useRuntimeConfig()
const runtime = computed(() => runtimeConfig.public.serverRuntime)
const { ready, loggedIn, user, session } = useUserSession()
const authorityDenied = ref(false)
const scopeKey = computed(() =>
  JSON.stringify([
    loggedIn.value,
    user.value?.id,
    user.value?.emailVerified,
    session.value?.sessionId,
    session.value?.sessionVersion
  ])
)
const authorized = () =>
  runtime.value === 'node' ||
  (!authorityDenied.value &&
    ready.value &&
    loggedIn.value &&
    user.value?.emailVerified === true &&
    typeof user.value.id === 'string' &&
    typeof session.value?.sessionId === 'string' &&
    Number.isSafeInteger(session.value?.sessionVersion) &&
    Number(session.value?.sessionVersion) > 0)
const {
  data,
  refresh,
  status,
  error: fetchError
} = await useFetch<unknown>(
  '/api/account/favorites',
  runtime.value === 'cloudflare' ? { immediate: authorized(), retry: 0, cache: 'no-store' } : {}
)

type NodeFavoriteItem = Pick<AccountFavoriteItem, 'variantId' | 'sku' | 'quantity' | 'name' | 'slug' | 'available'>
type ReadFavoriteItem = NodeFavoriteItem | AccountFavoriteItem
type ReadFavoriteList = Omit<AccountFavoriteList, 'items'> & { items: ReadFavoriteItem[] }
const CORE_FIELDS = ['variantId', 'sku', 'quantity', 'name', 'slug', 'available']
const D1_FIELDS = [
  ...CORE_FIELDS,
  'cartVariantId',
  'format',
  'unitLabel',
  'minimumQuantity',
  'maximumQuantity',
  'quantityIncrement',
  'reason'
]

/** Read own data only: reject accessors, custom prototypes, sparse arrays and
 * unknown fields without calling coercion/getter hooks on a cached payload. */
function ownRecord(value: unknown, allowed?: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const output: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(value)) {
      if (
        typeof key !== 'string' ||
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        (allowed && !allowed.includes(key))
      )
        return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) return null
      output[key] = descriptor.value
    }
    return output
  } catch {
    return null
  }
}
function ownArray(value: unknown, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
    const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value
    if (typeof length !== 'number' || length > maximum || Reflect.ownKeys(value).length !== length + 1) return null
    const output: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) return null
      output.push(descriptor.value)
    }
    return output
  } catch {
    return null
  }
}
function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  )
}
function id(value: unknown): value is string {
  return text(value, 128) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function isD1Item(item: ReadFavoriteItem): item is AccountFavoriteItem {
  return Object.hasOwn(item, 'cartVariantId')
}
function unavailableReason(value: unknown): value is AccountFavoriteItem['reason'] {
  return (
    value === null ||
    (typeof value === 'string' && ['unpublished', 'quantity_changed', 'out_of_stock', 'cart_unmapped'].includes(value))
  )
}
function quantityAllowed(item: ReadFavoriteItem, quantity: unknown): quantity is number {
  if (!positive(quantity) || quantity > 999) return false
  if (!isD1Item(item)) return true
  try {
    validateQuantity(quantity, item)
    return true
  } catch {
    return false
  }
}
function readItem(value: unknown, mode: 'node' | 'cloudflare'): ReadFavoriteItem | null {
  const row = ownRecord(value, mode === 'cloudflare' ? D1_FIELDS : CORE_FIELDS)
  if (
    !row ||
    !id(row.variantId) ||
    !text(row.sku, 200) ||
    !text(row.name, 500) ||
    !text(row.slug, 180) ||
    !/^[a-z0-9][a-z0-9-]*$/.test(row.slug) ||
    typeof row.available !== 'boolean' ||
    !text(row.quantity, 10)
  )
    return null
  const quantity = row.quantity
  if (
    mode === 'cloudflare'
      ? !/^[1-9]\d{0,2}$/.test(quantity) || Number(quantity) > 999
      : !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,3})?$/.test(quantity) || Number(quantity) <= 0 || Number(quantity) > 999999
  )
    return null
  const core: NodeFavoriteItem = {
    variantId: row.variantId,
    sku: row.sku,
    quantity,
    name: row.name,
    slug: row.slug,
    available: row.available
  }
  if (mode === 'node') return core
  if (
    !(row.cartVariantId === null || positive(row.cartVariantId)) ||
    !text(row.format, 200) ||
    !text(row.unitLabel, 100) ||
    !positive(row.minimumQuantity) ||
    !(row.maximumQuantity === null || positive(row.maximumQuantity)) ||
    !positive(row.quantityIncrement) ||
    (row.maximumQuantity !== null && row.maximumQuantity < row.minimumQuantity) ||
    !unavailableReason(row.reason) ||
    row.available !== (row.reason === null)
  )
    return null
  const item: AccountFavoriteItem = {
    ...core,
    cartVariantId: row.cartVariantId,
    format: row.format,
    unitLabel: row.unitLabel,
    minimumQuantity: row.minimumQuantity,
    maximumQuantity: row.maximumQuantity,
    quantityIncrement: row.quantityIncrement,
    reason: row.reason
  }
  return item.available && (item.cartVariantId === null || !quantityAllowed(item, Number(item.quantity))) ? null : item
}
function readLists(value: unknown): ReadFavoriteList[] | null {
  const mode = runtime.value
  if (mode !== 'node' && mode !== 'cloudflare') return null
  const payload = ownRecord(value, ['lists']),
    rows = payload && ownArray(payload.lists, 21)
  if (!rows) return null
  const output: ReadFavoriteList[] = [],
    seen = new Set<string>()
  for (const value of rows) {
    const row = ownRecord(value, ['id', 'name', 'isDefault', 'items'])
    if (!row || !id(row.id) || !text(row.name, 80) || typeof row.isDefault !== 'boolean' || seen.has(row.id))
      return null
    const rawItems = ownArray(row.items, 100)
    if (!rawItems) return null
    const items: ReadFavoriteItem[] = [],
      variants = new Set<string>()
    for (const raw of rawItems) {
      const item = readItem(raw, mode)
      if (!item || variants.has(item.variantId)) return null
      variants.add(item.variantId)
      items.push(item)
    }
    seen.add(row.id)
    output.push({ id: row.id, name: row.name, isDefault: row.isDefault, items })
  }
  return output.filter((list) => list.isDefault).length > 1 || output.filter((list) => !list.isDefault).length > 20
    ? null
    : output
}

const retryingRead = ref(false),
  retryFailed = ref(false)
let disposed = false,
  readGeneration = 0,
  requestGeneration = 0
watch(
  [data, status, fetchError, runtime],
  () => {
    readGeneration += 1
  },
  { flush: 'sync' }
)
onScopeDispose(() => {
  disposed = true
  readGeneration += 1
  requestGeneration += 1
  if (runtime.value === 'cloudflare') purgePrivate()
})
const checkedLists = computed(() => (status.value === 'success' && !fetchError.value ? readLists(data.value) : null))
const readState = computed(() => {
  if (disposed || !authorized() || scopeNeedsRead.value) return 'error'
  if (retryingRead.value || status.value === 'pending' || status.value === 'idle') return 'loading'
  if (retryFailed.value || fetchError.value || status.value === 'error') return 'error'
  return status.value === 'success' && checkedLists.value !== null ? 'success' : 'invalid'
})
const lists = computed(() => (readState.value === 'success' ? checkedLists.value! : []))
const totalItems = computed(() => lists.value.reduce((total, list) => total + list.items.length, 0))
const canAct = () =>
  !disposed && authorized() && readState.value === 'success' && !busy.value && !uncertain.value && !batch.value

async function reloadRead() {
  if (disposed || !authorized() || retryingRead.value) return false
  const generation = ++requestGeneration
  const scope = scopeKey.value
  retryingRead.value = true
  retryFailed.value = false
  try {
    await refresh()
    if (disposed || scope !== scopeKey.value || !authorized()) {
      data.value = undefined
      return false
    }
    if (runtime.value === 'cloudflare' && rejectsAuthority(fetchError.value)) {
      denyAuthority()
      return false
    }
    scopeNeedsRead.value = false
    return status.value === 'success' && !fetchError.value && readLists(data.value) !== null
  } catch (error) {
    if (runtime.value === 'cloudflare' && scope === scopeKey.value && rejectsAuthority(error)) denyAuthority()
    if (!disposed && generation === requestGeneration) retryFailed.value = true
    return false
  } finally {
    if (!disposed && generation === requestGeneration) retryingRead.value = false
  }
}
async function retryRead() {
  if (disposed || busy.value || !['error', 'invalid'].includes(readState.value)) return
  await reloadRead()
}
function memberList(value: unknown): ReadFavoriteList | null {
  if (disposed || readState.value !== 'success') return null
  const candidate = typeof value === 'string' ? value : ownRecord(value)?.id
  return id(candidate) ? (readLists(data.value)?.find((list) => list.id === candidate) ?? null) : null
}
function memberItem(value: unknown): ReadFavoriteItem | null {
  const mode = runtime.value
  if (mode !== 'node' && mode !== 'cloudflare') return null
  const candidate = readItem(value, mode)
  if (!candidate) return null
  const snapshot = JSON.stringify(candidate)
  return (
    readLists(data.value)
      ?.flatMap((list) => list.items)
      .find((item) => item.variantId === candidate.variantId && JSON.stringify(item) === snapshot) ?? null
  )
}
async function perform(action: () => Promise<void>, fallback: string) {
  if (!canAct()) return
  await run(async () => {
    try {
      await action()
    } catch {
      // Feedback's shared helper can reflect provider statusMessage. Deliberately
      // pass only a local Error here, never a server/SQL/personal-data exception.
      if (!disposed) throw new Error('favorite_action_failed')
    }
  }, fallback)
}

const newListName = ref('')
const editingListId = ref<string | null>(null)
const editingListName = ref('')
const quantities = ref<Record<string, number>>({})
const scopeNeedsRead = ref(false)
type FavoriteIntent = {
  scope: string
  ack: unknown
  validAck: (value: unknown) => boolean
  proof: (lists: ReadFavoriteList[], ack: unknown) => boolean
  success: string
  complete: () => void
}
const uncertain = shallowRef<FavoriteIntent | null>(null)
const reviewed = ref(false)
type Batch = { listId: string; remaining: FavoriteCartPreparation['ready']; added: number; scope: string }
const batch = shallowRef<Batch | null>(null)
function purgePrivate() {
  data.value = undefined
  newListName.value = ''
  editingListId.value = null
  editingListName.value = ''
  quantities.value = {}
  uncertain.value = null
  reviewed.value = false
  batch.value = null
  notice.value = ''
  errorMessage.value = ''
  busy.value = false
  retryingRead.value = false
  scopeNeedsRead.value = true
  requestGeneration += 1
}
watch(
  scopeKey,
  () => {
    if (runtime.value === 'cloudflare') {
      authorityDenied.value = false
      purgePrivate()
    }
  },
  { flush: 'sync' }
)
watch(
  ready,
  () => {
    if (runtime.value === 'cloudflare' && !ready.value) {
      data.value = undefined
      scopeNeedsRead.value = true
    }
  },
  { flush: 'sync' }
)
function currentIntent(intent: FavoriteIntent) {
  return !disposed && authorized() && intent.scope === scopeKey.value && uncertain.value === intent
}
function rejectsAuthority(error: unknown) {
  const code =
    (error as { statusCode?: unknown; status?: unknown } | null)?.statusCode ??
    (error as { status?: unknown } | null)?.status
  return code === 401 || code === 403
}
function denyAuthority() {
  authorityDenied.value = true
  purgePrivate()
  errorMessage.value = 'La sesión necesita verificarse de nuevo. El resultado del cambio no se ha confirmado.'
}
function acceptIntent(intent: FavoriteIntent) {
  if (
    !currentIntent(intent) ||
    readState.value !== 'success' ||
    !intent.validAck(intent.ack) ||
    !intent.proof(readLists(data.value) ?? [], intent.ack)
  )
    return false
  uncertain.value = null
  reviewed.value = false
  intent.complete()
  showNotice(intent.success)
  return true
}
async function mutateFavorite(
  path: string,
  options: { method: 'POST' | 'PUT' | 'DELETE'; body?: Record<string, unknown>; query?: Record<string, string> },
  spec: Omit<FavoriteIntent, 'scope' | 'ack'>
) {
  if (!canAct()) return
  const intent: FavoriteIntent = { ...spec, scope: scopeKey.value, ack: null }
  uncertain.value = intent
  reviewed.value = false
  busy.value = true
  notice.value = ''
  errorMessage.value = ''
  try {
    intent.ack = await $fetch<unknown>(path, { ...options, retry: 0 })
    if (!currentIntent(intent)) return
    if (!intent.validAck(intent.ack)) throw new Error('invalid_ack')
    if (await reloadRead()) {
      if (acceptIntent(intent)) return
    }
  } catch (error) {
    if (currentIntent(intent) && rejectsAuthority(error)) denyAuthority()
    /* A failed response or reread is not evidence that the write did not happen. */
  } finally {
    if (!disposed && scopeKey.value === intent.scope) {
      busy.value = false
      if (currentIntent(intent))
        errorMessage.value =
          'Hay un resultado incierto. Revisa las listas antes de continuar; no se reenviará el cambio.'
    }
  }
}
async function reviewUncertain() {
  const intent = uncertain.value
  if (!intent || !currentIntent(intent) || busy.value) return
  busy.value = true
  reviewed.value = false
  try {
    if (await reloadRead()) {
      if (!currentIntent(intent)) return
      if (!acceptIntent(intent)) reviewed.value = true
    }
  } finally {
    if (!disposed && scopeKey.value === intent.scope) busy.value = false
  }
}
function continueAfterReview() {
  if (
    !uncertain.value ||
    !currentIntent(uncertain.value) ||
    !reviewed.value ||
    readState.value !== 'success' ||
    busy.value
  )
    return
  uncertain.value = null
  reviewed.value = false
  errorMessage.value = 'Resultado no confirmado: comprueba posibles duplicados antes de iniciar un cambio nuevo.'
}
function simpleAck(value: unknown, expected?: string) {
  const row = ownRecord(value, ['ok', 'id'])
  return !!row && row.ok === true && id(row.id) && (!expected || row.id === expected)
}
function validName(value: unknown): value is string {
  return text(value, 80) && value.trim().length > 0
}
function setQuantity(listId: string, item: ReadFavoriteItem, value: unknown) {
  if (!canAct() || !memberList(listId) || !memberItem(item)) return
  quantities.value[`${listId}:${item.variantId}`] =
    typeof value === 'number' ? value : text(value, 3) && /^[1-9]\d{0,2}$/.test(value) ? Number(value) : Number.NaN
}
function minimumFor(item: ReadFavoriteItem) {
  return isD1Item(item) ? item.minimumQuantity : undefined
}
function maximumFor(item: ReadFavoriteItem) {
  return isD1Item(item) ? Math.min(item.maximumQuantity ?? 999, 999) : 999
}
function incrementFor(item: ReadFavoriteItem) {
  return isD1Item(item) ? item.quantityIncrement : undefined
}
function unavailableLabel(item: ReadFavoriteItem) {
  return isD1Item(item) ? favoriteUnavailableLabel(item) : 'No disponible ahora mismo'
}

// Worker-owned routes are not part of Nitro's generated Node route typings.
function listPath(id?: string): string {
  return '/api/account/favorites/lists' + (id ? `/${encodeURIComponent(id)}` : '')
}

async function saveItem(listId: unknown, candidate: unknown, supplied?: unknown) {
  if (!canAct()) return
  const list = memberList(listId),
    item = memberItem(candidate)
  const quantity = supplied === undefined && item ? Number(item.quantity) : supplied
  if (!list || !item || !quantityAllowed(item, quantity)) return
  if (runtime.value === 'cloudflare')
    return mutateFavorite(
      '/api/account/favorites',
      { method: 'POST', body: { listId: list.id, variantId: item.variantId, quantity } },
      {
        validAck: (value) => {
          const ack = ownRecord(value, ['listId', 'variantId', 'quantity'])
          return !!ack && ack.listId === list.id && ack.variantId === item.variantId && ack.quantity === quantity
        },
        proof: (rows) =>
          rows
            .find((row) => row.id === list.id)
            ?.items.some((entry) => entry.variantId === item.variantId && Number(entry.quantity) === quantity) === true,
        success: 'Referencia guardada en la lista.',
        complete: () => {
          quantities.value = {}
        }
      }
    )
  await perform(async () => {
    await $fetch('/api/account/favorites', {
      method: 'POST',
      body: { listId: list.id, variantId: item.variantId, quantity }
    })
    if (disposed) return
    await reloadRead()
    if (!disposed) showNotice('Referencia guardada en la lista.')
  }, 'No se ha podido guardar la referencia. Revisa la cantidad y la disponibilidad.')
}

async function createList() {
  if (!canAct() || !validName(newListName.value) || lists.value.filter((list) => !list.isDefault).length >= 20) return
  if (runtime.value === 'cloudflare') {
    const name = newListName.value.trim(),
      previous = new Set(lists.value.map((list) => list.id))
    return mutateFavorite(
      listPath(),
      { method: 'POST', body: { name } },
      {
        validAck: (value) => simpleAck(value) && !previous.has((value as { id: string }).id),
        proof: (rows, ack) =>
          rows.some((row) => row.id === (ack as { id: string }).id && row.name === name && !row.isDefault),
        success: 'Lista creada.',
        complete: () => {
          newListName.value = ''
        }
      }
    )
  }
  await perform(async () => {
    await $fetch(listPath(), { method: 'POST', body: { name: newListName.value.trim() } })
    if (disposed) return
    newListName.value = ''
    await reloadRead()
    if (!disposed) showNotice('Lista creada.')
  }, 'No se ha podido crear la lista. Usa un nombre único de hasta 80 caracteres.')
}

async function renameList(candidate: unknown) {
  if (!canAct()) return
  const list = memberList(candidate)
  if (!list || list.isDefault || !validName(editingListName.value)) return
  if (runtime.value === 'cloudflare') {
    const name = editingListName.value.trim()
    return mutateFavorite(
      listPath(list.id),
      { method: 'PUT', body: { name } },
      {
        validAck: (value) => simpleAck(value, list.id),
        proof: (rows) => rows.some((row) => row.id === list.id && row.name === name),
        success: 'Nombre actualizado.',
        complete: () => {
          editingListId.value = null
          editingListName.value = ''
        }
      }
    )
  }
  await perform(async () => {
    await $fetch(listPath(list.id), {
      method: 'PUT',
      body: { name: editingListName.value.trim() }
    })
    if (disposed) return
    editingListId.value = null
    await reloadRead()
    if (!disposed) showNotice('Nombre actualizado.')
  }, 'No se ha podido cambiar el nombre de la lista.')
}

function startRename(candidate: unknown) {
  if (!canAct()) return
  const list = memberList(candidate)
  if (!list || list.isDefault) return
  editingListId.value = list.id
  editingListName.value = list.name
}

async function deleteList(candidate: unknown) {
  if (!canAct()) return
  const list = memberList(candidate)
  if (!list || list.isDefault) return
  if (!window.confirm(`¿Eliminar la lista «${list.name}» y sus referencias?`)) return
  if (runtime.value === 'cloudflare')
    return mutateFavorite(
      listPath(list.id),
      { method: 'DELETE' },
      {
        validAck: (value) => simpleAck(value, list.id),
        proof: (rows) => !rows.some((row) => row.id === list.id),
        success: 'Lista eliminada.',
        complete: () => {}
      }
    )
  await perform(async () => {
    await $fetch(listPath(list.id), { method: 'DELETE' })
    if (disposed) return
    await reloadRead()
    if (!disposed) showNotice('Lista eliminada.')
  }, 'No se ha podido eliminar la lista.')
}

async function removeItem(listId: unknown, variantId: unknown) {
  if (!canAct()) return
  const list = memberList(listId)
  if (!list || !id(variantId) || !list.items.some((item) => item.variantId === variantId)) return
  if (runtime.value === 'cloudflare')
    return mutateFavorite(
      `/api/account/favorites/${encodeURIComponent(variantId)}`,
      { method: 'DELETE', query: { listId: list.id } },
      {
        validAck: (value) => simpleAck(value, list.id),
        proof: (rows) => {
          const current = rows.find((row) => row.id === list.id)
          return !!current && !current.items.some((item) => item.variantId === variantId)
        },
        success: 'Referencia quitada de la lista.',
        complete: () => {
          quantities.value = {}
        }
      }
    )
  await perform(async () => {
    await $fetch(`/api/account/favorites/${encodeURIComponent(variantId)}`, {
      method: 'DELETE',
      query: { listId: list.id }
    })
    if (disposed) return
    await reloadRead()
    if (!disposed) showNotice('Referencia quitada de la lista.')
  }, 'No se ha podido quitar la referencia.')
}

function readPreparation(value: unknown, list: ReadFavoriteList): FavoriteCartPreparation | null {
  const payload = ownRecord(value, ['outcome', 'ready', 'unavailable'])
  if (!payload || payload.outcome !== 'ready') return null
  const readyRows = ownArray(payload.ready, 100),
    unavailableRows = ownArray(payload.unavailable, 100)
  if (!readyRows || !unavailableRows || readyRows.length + unavailableRows.length !== list.items.length) return null
  const ready: FavoriteCartPreparation['ready'] = [],
    unavailable: AccountFavoriteItem[] = [],
    seen = new Set<string>()
  for (const value of readyRows) {
    const row = ownRecord(value, ['variantId', 'cartVariantId', 'quantity', 'unitLabel'])
    if (
      !row ||
      !id(row.variantId) ||
      !positive(row.cartVariantId) ||
      !text(row.unitLabel, 100) ||
      seen.has(row.variantId)
    )
      return null
    const item = list.items.find((item) => item.variantId === row.variantId)
    if (
      !item ||
      !isD1Item(item) ||
      !item.available ||
      row.cartVariantId !== item.cartVariantId ||
      row.unitLabel !== item.unitLabel ||
      !quantityAllowed(item, row.quantity) ||
      row.quantity !== Number(item.quantity)
    )
      return null
    seen.add(row.variantId)
    ready.push({
      variantId: row.variantId,
      cartVariantId: row.cartVariantId,
      quantity: row.quantity,
      unitLabel: row.unitLabel
    })
  }
  for (const value of unavailableRows) {
    const item = readItem(value, 'cloudflare')
    if (
      !item ||
      !isD1Item(item) ||
      item.available ||
      seen.has(item.variantId) ||
      !list.items.some((source) => source.variantId === item.variantId)
    )
      return null
    seen.add(item.variantId)
    unavailable.push(item)
  }
  return { outcome: 'ready', ready, unavailable }
}
async function addListToCart(candidate: unknown) {
  if (!canAct() || runtime.value !== 'cloudflare') return
  if (cart.pendingMutation || cart.blockedMutations) {
    errorMessage.value = 'Revisa la adición pendiente en el carrito antes de añadir otras referencias.'
    return
  }
  const list = memberList(candidate)
  if (!list || !list.items.some((item) => item.available)) return
  const generation = readGeneration,
    snapshot = JSON.stringify(list)
  const stillCurrent = () =>
    !disposed &&
    generation === readGeneration &&
    readState.value === 'success' &&
    JSON.stringify(memberList(list.id)) === snapshot
  await perform(async () => {
    const response = await $fetch<unknown>(`/api/account/favorites/lists/${encodeURIComponent(list.id)}/cart`, {
      method: 'POST',
      retry: 0
    })
    if (!stillCurrent()) return
    const plan = readPreparation(response, list)
    if (!plan) throw new Error('favorite_preparation_invalid')
    let added = 0
    for (const [index, item] of plan.ready.entries()) {
      if (!stillCurrent()) return
      try {
        await cart.add({ variantId: item.cartVariantId }, item.quantity)
        added += 1
      } catch {
        if (!stillCurrent()) return
        batch.value = { listId: list.id, remaining: plan.ready.slice(index + 1), added, scope: scopeKey.value }
        showNotice(
          `${added} referencias confirmadas en el carrito. Una adición tiene resultado incierto; ${plan.ready.length - index - 1} referencias sin intentar. Comprueba la adición en el carrito. No se reenviará esa referencia.`
        )
        return
      }
    }
    if (!stillCurrent()) return
    await reloadRead()
    if (disposed) return
    const skipped = plan.unavailable.length + plan.ready.length - added
    showNotice(
      `${added} ${added === 1 ? 'referencia añadida' : 'referencias añadidas'} al carrito.${skipped ? ` ${skipped} no se han añadido; revisa disponibilidad y cantidades.` : ''}`
    )
  }, 'No se han podido añadir las referencias.')
}
async function continueBatch() {
  const intent = batch.value
  if (
    !intent ||
    disposed ||
    !authorized() ||
    intent.scope !== scopeKey.value ||
    busy.value ||
    cart.pendingMutation ||
    cart.blockedMutations
  )
    return
  busy.value = true
  try {
    if (!(await reloadRead()) || intent !== batch.value || intent.scope !== scopeKey.value) return
    const list = memberList(intent.listId)
    if (
      !list ||
      !intent.remaining.every((row) =>
        list.items.some(
          (item) =>
            isD1Item(item) &&
            item.available &&
            item.variantId === row.variantId &&
            item.cartVariantId === row.cartVariantId &&
            Number(item.quantity) === row.quantity &&
            quantityAllowed(item, row.quantity)
        )
      )
    ) {
      errorMessage.value =
        'Las referencias sin intentar han cambiado. Revisa la lista; no se ha enviado ninguna adición.'
      return
    }
    while (intent.remaining.length) {
      if (
        disposed ||
        intent !== batch.value ||
        !authorized() ||
        intent.scope !== scopeKey.value ||
        cart.pendingMutation ||
        cart.blockedMutations
      )
        return
      const item = intent.remaining[0]!
      // Remove before sending: an uncertain line must never become a replay candidate.
      intent.remaining = intent.remaining.slice(1)
      try {
        await cart.add({ variantId: item.cartVariantId }, item.quantity)
        intent.added += 1
      } catch {
        if (!disposed && intent === batch.value && intent.scope === scopeKey.value)
          showNotice(
            `${intent.added} referencias confirmadas. Una adición tiene resultado incierto; ${intent.remaining.length} referencias sin intentar. Revisa el carrito.`
          )
        return
      }
    }
    if (!disposed && intent === batch.value && intent.scope === scopeKey.value) {
      batch.value = null
      showNotice(
        `${intent.added} referencias confirmadas en el carrito. La referencia inicialmente incierta no se ha reenviado; revisa el carrito.`
      )
    }
  } finally {
    if (!disposed && intent.scope === scopeKey.value) busy.value = false
  }
}
function discardBatch() {
  if (busy.value || cart.pendingMutation || cart.blockedMutations) return
  batch.value = null
  showNotice('Referencias sin intentar descartadas. Revisa el carrito antes de iniciar otra incorporación de la lista.')
}
</script>

<template>
  <div :aria-busy="readState === 'loading'">
    <UiPageHeader
      title="Listas de compra"
      :count="readState === 'success' ? totalItems : undefined"
      count-label="referencias"
      description="Tus referencias habituales, listas para volver a pedirlas."
    />

    <AccountFeedback :notice="notice" :error="errorMessage" />
    <UiSurface v-if="uncertain && authorized()" class="mt-4">
      <p role="status">
        Hay un resultado incierto. Una revisión de la lista no demuestra por sí sola si el cambio se ejecutó.
      </p>
      <UButton :disabled="busy || retryingRead" @click="reviewUncertain">Revisar listas</UButton>
      <UButton v-if="reviewed" :disabled="busy" @click="continueAfterReview">He revisado las listas; continuar</UButton>
    </UiSurface>
    <UiSurface v-if="batch && authorized()" class="mt-4 flex flex-wrap gap-3">
      <NuxtLink to="/carrito">Ir al carrito y comprobar la adición</NuxtLink>
      <UButton
        v-if="batch.remaining.length"
        :disabled="busy || !!cart.pendingMutation || cart.blockedMutations"
        @click="continueBatch"
        >Continuar referencias sin intentar</UButton
      >
      <UButton :disabled="busy || !!cart.pendingMutation || cart.blockedMutations" @click="discardBatch"
        >Descartar referencias sin intentar</UButton
      >
    </UiSurface>

    <form v-if="readState === 'success'" class="mt-4 flex flex-wrap items-end gap-3" @submit.prevent="createList">
      <UFormField label="Nueva lista de compra" name="listName">
        <UInput
          v-model="newListName"
          maxlength="80"
          placeholder="Por ejemplo, reposición mensual"
          :disabled="!canAct()"
        />
      </UFormField>
      <UButton type="submit" icon="i-lucide-plus" :disabled="!canAct() || !newListName.trim()" :loading="busy"
        >Crear lista</UButton
      >
    </form>

    <div v-if="readState === 'loading'" class="mt-4 space-y-3">
      <p role="status" class="sr-only">Cargando tus listas.</p>
      <div
        v-for="row in 3"
        :key="row"
        class="h-16 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
      />
    </div>

    <UiSurface v-else-if="readState === 'error' || readState === 'invalid'" class="mt-4">
      <p role="alert">No hemos podido cargar tus listas. Vuelve a intentarlo.</p>
      <UButton type="button" class="mt-3" color="neutral" :disabled="busy" @click="retryRead">Reintentar</UButton>
    </UiSurface>

    <UiSurface v-else-if="!lists.length" class="mt-4" padding="none">
      <UiEmptyState
        icon="i-lucide-list-checks"
        title="Todavía no tienes ninguna lista"
        description="Marca como favorito lo que pidas a menudo y podrás añadirlo todo al carrito de una vez."
      >
        <UButton to="/catalogo" icon="i-lucide-arrow-right" trailing>Ver el catálogo</UButton>
      </UiEmptyState>
    </UiSurface>

    <div v-else class="mt-4 space-y-6">
      <UiSurface v-for="list in lists" :key="list.id" padding="none">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 class="font-bold text-[var(--text-strong)]">{{ list.name }}</h2>
            <p class="mt-0.5 text-sm text-[var(--text-muted)]">
              {{ list.items.length }} {{ list.items.length === 1 ? 'referencia' : 'referencias' }}
            </p>
            <form v-if="editingListId === list.id" class="mt-2 flex flex-wrap gap-2" @submit.prevent="renameList(list)">
              <UInput v-model="editingListName" maxlength="80" aria-label="Nombre de la lista" :disabled="!canAct()" />
              <UButton type="submit" size="sm" :disabled="!canAct() || !editingListName.trim()">Guardar nombre</UButton>
              <UButton size="sm" variant="ghost" color="neutral" :disabled="!canAct()" @click="editingListId = null"
                >Cancelar</UButton
              >
            </form>
          </div>
          <div v-if="!list.isDefault" class="flex gap-2">
            <UButton size="sm" color="neutral" variant="ghost" :disabled="!canAct()" @click="startRename(list)"
              >Renombrar</UButton
            >
            <UButton size="sm" color="error" variant="ghost" :disabled="!canAct()" @click="deleteList(list)"
              >Eliminar lista</UButton
            >
          </div>
          <UButton
            icon="i-lucide-shopping-cart"
            :loading="busy"
            :disabled="!canAct() || runtime !== 'cloudflare' || !list.items.some((item) => item.available)"
            @click="addListToCart(list)"
          >
            Añadir todo al carrito
          </UButton>
        </div>

        <p v-if="!list.items.length" class="px-5 py-4 text-sm text-[var(--text-muted)]">
          Esta lista todavía no tiene referencias.
        </p>

        <ul class="divide-y divide-[var(--border)]">
          <li v-for="item in list.items" :key="item.variantId" class="flex flex-wrap items-center gap-4 px-5 py-3">
            <div class="min-w-0 flex-1">
              <NuxtLink
                :to="`/producto/${item.slug}?sku=${encodeURIComponent(item.sku)}`"
                class="font-medium text-[var(--text-strong)] hover:text-neteco-700 hover:underline"
              >
                {{ item.name }}
              </NuxtLink>
              <p class="mt-0.5 text-sm text-[var(--text-muted)]">
                Ref. {{ item.sku }} · {{ item.quantity }}
                <template v-if="isD1Item(item)">{{ item.unitLabel }} · {{ item.format }}</template>
                <template v-if="isD1Item(item) && (item.minimumQuantity > 1 || item.quantityIncrement > 1)">
                  · mín. {{ item.minimumQuantity }}, pasos de {{ item.quantityIncrement }}</template
                >
                <template v-if="!item.available"> · {{ unavailableLabel(item) }}</template>
              </p>
            </div>
            <UBadge v-if="!item.available" color="neutral" variant="subtle">Sin disponibilidad</UBadge>
            <form
              class="flex items-center gap-2"
              @submit.prevent="
                saveItem(list.id, item, quantities[`${list.id}:${item.variantId}`] ?? Number(item.quantity))
              "
            >
              <UInput
                type="number"
                :min="minimumFor(item)"
                :max="maximumFor(item)"
                :step="incrementFor(item)"
                class="w-24"
                :aria-label="`Cantidad de ${item.name}`"
                :model-value="quantities[`${list.id}:${item.variantId}`] ?? Number(item.quantity)"
                :disabled="!canAct()"
                @update:model-value="setQuantity(list.id, item, $event)"
              />
              <UButton
                type="submit"
                size="sm"
                color="neutral"
                variant="outline"
                :disabled="
                  busy || !quantityAllowed(item, quantities[`${list.id}:${item.variantId}`] ?? Number(item.quantity))
                "
                >Actualizar</UButton
              >
            </form>
            <USelect
              v-if="lists.length > 1"
              :items="
                lists
                  .filter((target) => target.id !== list.id)
                  .map((target) => ({ label: target.name, value: target.id }))
              "
              placeholder="Copiar a otra lista"
              :aria-label="`Copiar ${item.name} a otra lista`"
              :disabled="!canAct()"
              @update:model-value="(target) => saveItem(target, item)"
            />
            <UButton
              size="sm"
              color="neutral"
              variant="ghost"
              icon="i-lucide-x"
              :aria-label="`Quitar ${item.name} de la lista`"
              :disabled="!canAct()"
              @click="removeItem(list.id, item.variantId)"
            />
          </li>
        </ul>
      </UiSurface>
    </div>
  </div>
</template>
