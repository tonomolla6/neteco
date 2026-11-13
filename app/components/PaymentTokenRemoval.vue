<script setup lang="ts">
import { z } from 'zod'
const request = useRequestFetch()
const auth = useUserSession()
const scope = computed(() =>
  JSON.stringify([
    auth.user.value?.id,
    auth.session.value?.sessionId,
    auth.session.value?.sessionVersion,
    auth.loggedIn.value
  ])
)
let epoch = 0
let mounted = false
const current = (generation: number, identity: string) => mounted && generation === epoch && identity === scope.value
const tokenSchema = z
  .object({
    id: z.string().uuid(),
    status: z.literal('active'),
    version: z.number().int().safe().positive(),
    createdAt: z.string().datetime()
  })
  .strict()
const pendingSchema = tokenSchema.extend({ status: z.literal('removal_pending') })
const responseSchema = z
  .object({ tokens: z.array(tokenSchema).max(100), pending: z.array(pendingSchema).max(100).default([]) })
  .strict()
const receiptSchema = z
  .object({
    tokenId: z.string().uuid(),
    version: z.number().int().safe().positive(),
    outcome: z.literal('removal_pending')
  })
  .strict()
type Token = z.infer<typeof tokenSchema>
const tokens = ref<Token[]>([])
const pendingTokens = ref<z.infer<typeof pendingSchema>[]>([])
const loading = ref(true),
  busy = ref(false),
  error = ref(''),
  message = ref('')
const pending = ref<{ tokenId: string; expectedVersion: number; commandId: string } | null>(null)
async function load() {
  if (busy.value) return
  loading.value = true
  error.value = ''
  const generation = epoch,
    identity = scope.value
  try {
    const result = responseSchema.parse(await request('/api/account/payment-tokens'))
    if (!current(generation, identity)) return
    tokens.value = result.tokens
    pendingTokens.value = result.pending
  } catch {
    if (!current(generation, identity)) return
    tokens.value = []
    pendingTokens.value = []
    error.value = 'No hemos podido cargar tus métodos de pago. Vuelve a intentarlo.'
  } finally {
    if (current(generation, identity)) loading.value = false
  }
}
async function remove(token?: Token) {
  if (busy.value) return
  if (!pending.value && token)
    pending.value = { tokenId: token.id, expectedVersion: token.version, commandId: crypto.randomUUID() }
  const command = pending.value
  if (!command) return
  busy.value = true
  error.value = ''
  const generation = epoch,
    identity = scope.value
  try {
    const receipt = receiptSchema.parse(
      await request<unknown, string>('/api/account/payment-tokens', {
        method: 'POST',
        headers: { 'Idempotency-Key': command.commandId },
        body: command
      })
    )
    if (!current(generation, identity)) return
    if (receipt.tokenId !== command.tokenId || receipt.version !== command.expectedVersion + 1)
      throw new Error('invalid_receipt')
    const removed = tokens.value.find((item) => item.id === command.tokenId)
    if (removed) pendingTokens.value.push({ ...removed, status: 'removal_pending', version: receipt.version })
    tokens.value = tokens.value.filter((item) => item.id !== command.tokenId)
    pending.value = null
    message.value = 'La retirada se ha solicitado y está pendiente de confirmación por el proveedor.'
  } catch {
    if (!current(generation, identity)) return
    error.value = 'No hemos podido confirmar la solicitud. Vuelve a intentarlo con el mismo comando.'
  } finally {
    if (current(generation, identity)) busy.value = false
  }
}
watch(scope, () => {
  epoch++
  tokens.value = []
  pendingTokens.value = []
  pending.value = null
  message.value = ''
  error.value = ''
  busy.value = false
  if (mounted) void load()
})
onMounted(() => {
  mounted = true
  void load()
})
onBeforeUnmount(() => {
  mounted = false
  epoch++
})
</script>
<template>
  <section aria-labelledby="saved-payment-title" class="space-y-6">
    <UiPageHeader
      id="saved-payment-title"
      title="Métodos de pago"
      description="Las tarjetas que has guardado al pagar para no tener que escribirlas otra vez."
    />
    <p v-if="loading" role="status" class="text-sm text-[var(--text-muted)]">Cargando métodos de pago…</p>
    <p
      v-if="message"
      role="status"
      class="rounded-[var(--radius-control)] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
    >
      {{ message }}
    </p>
    <div
      v-if="error"
      role="alert"
      class="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    >
      <p>{{ error }}</p>
      <button v-if="pending" type="button" :disabled="busy" @click="remove()">Volver a comprobar</button>
      <button v-else type="button" :disabled="loading" @click="load()">Volver a cargar</button>
    </div>
    <UiSurface v-if="!loading && !error && !tokens.length && !pendingTokens.length" padding="none">
      <UiEmptyState
        icon="i-lucide-credit-card"
        title="No tienes métodos de pago guardados"
        description="Cuando pagues un pedido con tarjeta podrás guardarla para la próxima vez. Nunca almacenamos el número completo."
      >
        <UButton to="/catalogo" color="neutral" variant="outline">Ir al catálogo</UButton>
      </UiEmptyState>
    </UiSurface>
    <div v-if="!loading && pendingTokens.length" class="account-card" aria-label="Retiradas pendientes">
      <p v-for="item in pendingTokens" :key="item.id" class="text-sm text-[var(--text)]">
        Estamos retirando una tarjeta. Falta la confirmación del banco.
      </p>
    </div>
    <div v-if="!loading && tokens.length" class="grid gap-4 sm:grid-cols-2">
      <div v-for="(token, index) in tokens" :key="token.id" class="account-card flex items-center gap-4">
        <span class="grid size-11 shrink-0 place-items-center rounded-full bg-neteco-50 text-neteco-700">
          <UIcon name="i-lucide-credit-card" class="size-5" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="font-semibold text-[var(--text-strong)]">Tarjeta guardada {{ index + 1 }}</p>
          <p class="text-sm text-[var(--text-muted)]">Disponible al pagar tus pedidos.</p>
        </div>
        <button
          v-if="!pending"
          type="button"
          :disabled="busy"
          :aria-label="`Solicitar retirada del método guardado ${index + 1}`"
          @click="remove(token)"
        >
          Quitar
        </button>
      </div>
    </div>
  </section>
</template>
