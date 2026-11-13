import { defineStore } from 'pinia'
import { computed, watch } from 'vue'
import { z } from 'zod'

export interface CartItem {
  productId: number
  slug: string
  name: string
  brand: string
  variantId: number
  format: string
  sku: string
  price: number
  basePrice?: number
  compareAtPrice?: number | null
  referencePrice30d?: number | null
  priceTiers?: Array<{ minimumQuantity: number; unitGrossCents: number }>
  pricingVersion?: string
  netPrice: number
  lineNet?: number
  taxRateBasisPoints: number
  qty: number
  visual: { type: string; color: string }
  image?: string | null
  imageAlt?: string | null
  minimumQuantity?: number
  maximumQuantity?: number | null
  quantityIncrement?: number
}

interface ServerCart {
  id: string
  version: number
  status: string
  expiresAt: string
  items: CartItem[]
  count: number
  subtotal: number
  subtotalNet: number
  tax: number
  replacedConvertedCart?: boolean
}

let loadPromise: Promise<void> | null = null
const ADD_JOURNAL = 'neteco-cart-add-v1'
const positiveInteger = z.number().int().positive().safe()
const addIntentSchema = z
  .object({
    cartId: z.string().min(1).max(200),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    body: z
      .object({
        variantId: positiveInteger,
        quantity: positiveInteger.max(999),
        expectedVersion: positiveInteger,
        idempotencyKey: z.string().uuid()
      })
      .strict(),
    confirmed: z.boolean()
  })
  .strict()
type AddIntent = z.infer<typeof addIntentSchema>
interface AddContext {
  generation: number
  busy: boolean
  cloudflare: boolean
  scope: Promise<string>
  pending: AddIntent | null
  stored: AddIntent | null
  restoring: Promise<void> | null
  storageFailed: boolean
  journalSeen: boolean
}
const addContexts = new WeakMap<object, AddContext>()
const UNCERTAIN_ADD = 'No sabemos si se añadió el producto. Comprueba la adición antes de continuar.'
const CONFIRMED_ADD = 'La adición está confirmada. Falta actualizar el carrito antes de continuar.'
async function ownerHash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
function currentCart(value: unknown, id: string, minimumVersion = 1): value is ServerCart {
  if (!value || typeof value !== 'object') return false
  const cart = value as ServerCart
  return (
    cart.id === id &&
    Number.isSafeInteger(cart.version) &&
    cart.version >= minimumVersion &&
    Array.isArray(cart.items) &&
    [cart.subtotal, cart.subtotalNet, cart.tax].every((number) => Number.isFinite(number) && number >= 0)
  )
}

export const useCartStore = defineStore('cart', {
  state: () => ({
    items: [] as CartItem[],
    id: null as string | null,
    version: 0,
    serverTotals: null as Pick<ServerCart, 'subtotal' | 'subtotalNet' | 'tax'> | null,
    ready: false,
    loading: false,
    error: '',
    addInFlight: false,
    addRecovery: false,
    addRecoveryConfirmed: false,
    addRecoveryMessage: '',
    addReceiptAvailable: false,
    checkingAddJournal: false
  }),
  getters: {
    pendingMutation: (state) => state.addInFlight || state.addRecovery || state.checkingAddJournal,
    blockedMutations: (state) => state.addInFlight || state.addRecovery || state.checkingAddJournal,
    canRecoverAdd: (state) => state.addRecovery && !state.addInFlight && state.addReceiptAvailable,
    canRetryAdd: (state) => state.addRecovery && !state.addInFlight && !state.addRecoveryConfirmed,
    count: (state) => state.items.reduce((total, item) => total + item.qty, 0),
    subtotal: (state) =>
      state.serverTotals?.subtotal ?? state.items.reduce((total, item) => total + item.price * item.qty, 0),
    subtotalNet: (state) =>
      state.serverTotals?.subtotalNet ??
      state.items.reduce((total, item) => total + (item.lineNet ?? (item.netPrice ?? item.price) * item.qty), 0),
    tax: (state) =>
      state.serverTotals?.tax ??
      state.items.reduce(
        (total, item) => total + item.price * item.qty - (item.lineNet ?? (item.netPrice ?? item.price) * item.qty),
        0
      )
  },
  actions: {
    initializeAddRecovery(): AddContext {
      let context = addContexts.get(this)
      if (context) return context
      const { loggedIn, user, session } = useUserSession()
      const identity = computed(() =>
        JSON.stringify([loggedIn.value, user.value?.id, session.value?.sessionId, session.value?.sessionVersion])
      )
      context = {
        generation: 0,
        busy: false,
        cloudflare: useRuntimeConfig().public.serverRuntime === 'cloudflare',
        scope: ownerHash(identity.value),
        pending: null,
        stored: null,
        restoring: null,
        storageFailed: false,
        journalSeen: false
      }
      const ownContext = context
      addContexts.set(this, context)
      this.addReceiptAvailable = context.cloudflare
      watch(
        identity,
        (value) => {
          ownContext.scope = ownerHash(value)
          this.resetLocal()
        },
        { flush: 'sync' }
      )
      if (import.meta.client && context.cloudflare) {
        try {
          const raw = localStorage.getItem(ADD_JOURNAL)
          if (raw) {
            ownContext.journalSeen = true
            this.checkingAddJournal = true
            ownContext.restoring = (async () => {
              const generation = ownContext.generation
              let value: unknown = null
              try {
                if (raw.length <= 2048) value = JSON.parse(raw)
              } catch {
                /* Malformed own journal is discarded, never submitted. */
              }
              const parsed = addIntentSchema.safeParse(value)
              const scope = await ownContext.scope
              if (ownContext.generation !== generation) return
              if (parsed?.success && parsed.data.scope === scope) ownContext.stored = parsed.data
              else {
                localStorage.removeItem(ADD_JOURNAL)
                this.checkingAddJournal = false
              }
            })()
              .catch(() => {
                ownContext.storageFailed = true
                this.checkingAddJournal = true
                this.error =
                  'No se ha podido leer la recuperación del carrito. Comprueba el almacenamiento del navegador.'
                this.addRecoveryMessage = this.error
              })
              .finally(() => {
                ownContext.restoring = null
              })
          }
        } catch {
          ownContext.storageFailed = true
          this.checkingAddJournal = true
          this.error = 'No se ha podido leer la recuperación del carrito. Comprueba el almacenamiento del navegador.'
          this.addRecoveryMessage = this.error
        }
      }
      return context
    },
    clearAddRecovery() {
      const context = addContexts.get(this)
      if (context) {
        context.generation++
        context.pending = null
        context.stored = null
      }
      this.addRecovery = false
      this.addRecoveryConfirmed = false
      this.addInFlight = false
      this.addRecoveryMessage = ''
      this.checkingAddJournal = false
      if (import.meta.client) {
        try {
          localStorage.removeItem(ADD_JOURNAL)
        } catch {
          if (context?.cloudflare) {
            context.storageFailed = true
            this.checkingAddJournal = true
          }
        }
      }
    },
    saveAddIntent(intent: AddIntent) {
      const context = addContexts.get(this)!
      if (import.meta.client && context.cloudflare) localStorage.setItem(ADD_JOURNAL, JSON.stringify(intent))
      context.pending = intent
      Object.freeze(intent.body)
      this.checkingAddJournal = false
      this.addRecovery = true
      this.addRecoveryConfirmed = intent.confirmed
      this.addRecoveryMessage = intent.confirmed ? CONFIRMED_ADD : UNCERTAIN_ADD
    },
    apply(cart: ServerCart) {
      const context = addContexts.get(this)
      if (context && this.id && this.id !== cart.id) this.clearAddRecovery()
      this.id = cart.id
      this.version = cart.version
      this.items = cart.items
      this.serverTotals = { subtotal: cart.subtotal, subtotalNet: cart.subtotalNet, tax: cart.tax }
      this.ready = true
      this.error = ''
      this.persist()
    },
    persist() {
      if (import.meta.client) localStorage.setItem('neteco-cart-cache', JSON.stringify(this.items))
    },
    async load(options: { restoreCachedItems?: boolean } = {}) {
      if (!import.meta.client) return
      const context = this.initializeAddRecovery()
      if (context.restoring) await context.restoring
      if (loadPromise) return loadPromise
      let generation = context.generation
      loadPromise = (async () => {
        this.loading = true
        const cached =
          options.restoreCachedItems === false ||
          context.pending ||
          context.stored ||
          context.journalSeen ||
          context.storageFailed
            ? null
            : (localStorage.getItem('neteco-cart-cache') ?? localStorage.getItem('neteco-cart'))
        if (!this.ready && cached) {
          this.serverTotals = null
          try {
            this.items = JSON.parse(cached)
          } catch {
            this.items = []
          }
        }
        try {
          let cart = await $fetch<ServerCart>('/api/cart')
          if (context.generation !== generation) return
          if (context.stored) {
            const stored = context.stored
            context.stored = null
            if (currentCart(cart, stored.cartId) && stored.scope === (await context.scope)) this.saveAddIntent(stored)
            else {
              this.clearAddRecovery()
              generation = context.generation
            }
          }
          if (cart.replacedConvertedCart) {
            this.items = []
            localStorage.removeItem('neteco-cart-cache')
            localStorage.removeItem('neteco-cart')
          }
          // Explicit read retries never repeat the legacy-cache import writes.
          if (
            options.restoreCachedItems !== false &&
            !context.journalSeen &&
            !context.storageFailed &&
            !context.pending &&
            cart.items.length === 0 &&
            this.items.length > 0
          ) {
            for (const item of this.items) {
              cart = await $fetch<ServerCart>('/api/cart/items', {
                method: 'POST',
                body: {
                  variantId: item.variantId,
                  quantity: item.qty,
                  expectedVersion: cart.version,
                  idempotencyKey: randomId()
                }
              })
            }
            localStorage.removeItem('neteco-cart')
          }
          if (context.generation === generation) this.apply(cart)
        } catch {
          this.error = 'No se ha podido sincronizar el carrito'
          this.ready = true
        } finally {
          this.loading = false
        }
      })()
      try {
        await loadPromise
      } finally {
        loadPromise = null
      }
    },
    async ensureLoaded() {
      if (!this.ready) await this.load()
      if (!this.id || this.version < 1) throw new Error('El carrito no está disponible')
    },
    async add(item: Pick<CartItem, 'variantId'> & Partial<Omit<CartItem, 'variantId' | 'qty'>>, qty = 1) {
      const variantId = item.variantId
      const context = this.initializeAddRecovery()
      if (context.restoring) await context.restoring
      if (context.storageFailed) throw new Error('No se puede guardar la recuperación del carrito')
      if (context.busy || context.pending) throw new Error(UNCERTAIN_ADD)
      context.busy = true
      this.addInFlight = true
      const generation = context.generation
      try {
        await this.ensureLoaded()
        if (context.stored) await this.load({ restoreCachedItems: false })
        if (context.generation !== generation || context.pending || context.stored) throw new Error(UNCERTAIN_ADD)
        const cartId = this.id,
          expectedVersion = this.version
        const intent = addIntentSchema.parse({
          cartId,
          scope: await context.scope,
          confirmed: false,
          body: { variantId, quantity: qty, expectedVersion, idempotencyKey: randomId() }
        })
        if (context.generation !== generation) return
        try {
          this.saveAddIntent(intent)
        } catch {
          this.error = 'No se ha podido guardar la intención del carrito. No se ha enviado la adición.'
          this.addRecoveryMessage = this.error
          throw new Error(this.error)
        }
        await this.sendOriginalAdd(intent, generation, true)
      } finally {
        context.busy = false
        this.addInFlight = false
      }
    },
    async sendOriginalAdd(intent: AddIntent, generation: number, freshAttempt = false) {
      const context = addContexts.get(this)!
      if (context.generation !== generation || context.pending !== intent) return
      try {
        const cart = await $fetch<ServerCart>('/api/cart/items', {
          method: 'POST',
          body: { ...intent.body },
          ...(context.cloudflare ? { headers: { 'X-Neteco-Cart-Id': intent.cartId } } : {})
        })
        if (context.generation !== generation || context.pending !== intent) return
        if (!currentCart(cart, intent.cartId, intent.body.expectedVersion + 1)) throw new Error('invalid_cart_response')
        this.apply(cart)
        this.clearAddRecovery()
        void useAnalytics().track('cart_item_added', {
          variantId: intent.body.variantId,
          quantity: intent.body.quantity,
          cartVersion: cart.version
        })
      } catch (error) {
        const failure =
          error && typeof error === 'object'
            ? (error as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } })
            : null
        const status = failure?.statusCode ?? failure?.status ?? failure?.response?.status
        if (context.generation === generation) {
          if (freshAttempt && (status === 400 || status === 422)) this.clearAddRecovery()
          else this.addRecoveryMessage = UNCERTAIN_ADD
        }
        throw Object.assign(new Error(UNCERTAIN_ADD), { statusCode: typeof status === 'number' ? status : undefined })
      }
    },
    async retryAdd() {
      const context = this.initializeAddRecovery()
      if (context.restoring) await context.restoring
      const intent = context.pending
      if (!intent || intent.confirmed || context.busy) return
      context.busy = true
      this.addInFlight = true
      const generation = context.generation
      try {
        const cart = await $fetch<unknown>('/api/cart', { cache: 'no-store' })
        if (context.generation !== generation || context.pending !== intent) return
        if (!currentCart(cart, intent.cartId)) throw new Error(UNCERTAIN_ADD)
        await this.sendOriginalAdd(intent, generation)
      } finally {
        context.busy = false
        this.addInFlight = false
      }
    },
    async recoverAdd() {
      const context = this.initializeAddRecovery()
      if (context.restoring) await context.restoring
      const intent = context.pending
      if (!context.cloudflare || !intent || context.busy) return
      context.busy = true
      this.addInFlight = true
      const generation = context.generation
      try {
        if (!intent.confirmed) {
          const receipt = await $fetch<unknown>(
            `/api/cart/operations/${encodeURIComponent(intent.body.idempotencyKey)}`,
            {
              query: {
                variantId: intent.body.variantId,
                quantity: intent.body.quantity,
                expectedVersion: intent.body.expectedVersion
              },
              cache: 'no-store'
            }
          )
          if (context.generation !== generation || context.pending !== intent) return
          const parsed = z
            .object({
              source: z.literal('cloudflare'),
              cartId: z.literal(intent.cartId),
              commandId: z.literal(intent.body.idempotencyKey),
              outcome: z.literal('applied'),
              appliedVersion: z.literal(intent.body.expectedVersion + 1)
            })
            .strict()
            .safeParse(receipt)
          if (!parsed.success) throw new Error('unconfirmed_receipt')
          intent.confirmed = true
          this.addRecoveryConfirmed = true
          this.addRecoveryMessage = CONFIRMED_ADD
          this.saveAddIntent(intent)
        }
        const cart = await $fetch<unknown>('/api/cart', { cache: 'no-store' })
        if (context.generation !== generation || context.pending !== intent) return
        if (!currentCart(cart, intent.cartId, intent.body.expectedVersion + 1))
          throw new Error('current_cart_unavailable')
        this.apply(cart)
        this.clearAddRecovery()
      } catch {
        if (context.generation === generation)
          this.addRecoveryMessage = intent.confirmed ? CONFIRMED_ADD : UNCERTAIN_ADD
      } finally {
        context.busy = false
        this.addInFlight = false
      }
    },
    async setQty(variantId: number, qty: number) {
      const context = this.initializeAddRecovery()
      if (context.restoring) await context.restoring
      if (context.busy || context.pending || context.stored || context.storageFailed) throw new Error(UNCERTAIN_ADD)
      if (qty <= 0) return this.remove(variantId)
      const generation = context.generation
      await this.ensureLoaded()
      if (
        context.busy ||
        context.pending ||
        context.stored ||
        context.storageFailed ||
        context.generation !== generation
      )
        throw new Error(UNCERTAIN_ADD)
      const previous = this.items.find((item) => item.variantId === variantId)?.qty ?? 0
      try {
        const cart = await $fetch<ServerCart>(`/api/cart/items/${variantId}`, {
          method: 'PUT',
          body: { quantity: qty, expectedVersion: this.version, idempotencyKey: randomId() }
        })
        this.apply(cart)
        const difference = qty - previous
        if (difference !== 0) {
          void useAnalytics().track(difference > 0 ? 'cart_item_added' : 'cart_item_removed', {
            variantId,
            quantity: Math.abs(difference),
            cartVersion: cart.version
          })
        }
      } catch (error) {
        await this.load()
        throw error
      }
    },
    async remove(variantId: number) {
      const context = this.initializeAddRecovery()
      if (context.restoring) await context.restoring
      if (context.busy || context.pending || context.stored || context.storageFailed) throw new Error(UNCERTAIN_ADD)
      const generation = context.generation
      await this.ensureLoaded()
      if (
        context.busy ||
        context.pending ||
        context.stored ||
        context.storageFailed ||
        context.generation !== generation
      )
        throw new Error(UNCERTAIN_ADD)
      const previous = this.items.find((item) => item.variantId === variantId)?.qty ?? 0
      try {
        const cart = await $fetch<ServerCart>(`/api/cart/items/${variantId}`, {
          method: 'DELETE',
          query: { expectedVersion: this.version, idempotencyKey: randomId() }
        })
        this.apply(cart)
        if (previous > 0) {
          void useAnalytics().track('cart_item_removed', {
            variantId,
            quantity: previous,
            cartVersion: cart.version
          })
        }
      } catch (error) {
        await this.load()
        throw error
      }
    },
    async clear() {
      const context = this.initializeAddRecovery()
      if (context.restoring) await context.restoring
      if (context.busy || context.pending || context.stored || context.storageFailed) throw new Error(UNCERTAIN_ADD)
      const generation = context.generation
      if (!this.ready) await this.load()
      if (
        context.busy ||
        context.pending ||
        context.stored ||
        context.storageFailed ||
        context.generation !== generation
      )
        throw new Error(UNCERTAIN_ADD)
      if (!this.id) {
        this.items = []
        this.serverTotals = null
        this.persist()
        return
      }
      await $fetch('/api/cart', {
        method: 'DELETE',
        query: { expectedVersion: this.version, idempotencyKey: randomId() }
      })
      if (context.generation !== generation) return
      const previousRead = loadPromise
      this.resetLocal()
      const clearedGeneration = context.generation
      // Discard a read of the deleted cart before creating its replacement.
      // A failed replacement read retains the ordinary explicit retry state.
      if (previousRead) await previousRead
      if (context.generation === clearedGeneration) await this.load({ restoreCachedItems: false })
    },
    resetLocal() {
      this.clearAddRecovery()
      this.items = []
      this.id = null
      this.version = 0
      this.serverTotals = null
      this.ready = false
      try {
        this.persist()
      } catch {
        this.error = 'No se ha podido actualizar el almacenamiento del carrito.'
      }
    }
  }
})
