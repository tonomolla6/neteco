<script setup lang="ts">
import { z } from 'zod'
const request = useRequestFetch()
const tokenSchema = z
  .object({
    id: z.string().uuid(),
    status: z.literal('active'),
    version: z.number().int().safe().positive(),
    createdAt: z.string().datetime()
  })
  .strict()
const responseSchema = z.object({ tokens: z.array(tokenSchema).max(100) }).strict()
const receiptSchema = z
  .object({
    tokenId: z.string().uuid(),
    version: z.number().int().safe().positive(),
    outcome: z.literal('removal_pending')
  })
  .strict()
type Token = z.infer<typeof tokenSchema>
const tokens = ref<Token[]>([])
const loading = ref(true),
  busy = ref(false),
  error = ref(''),
  message = ref('')
const pending = ref<{ tokenId: string; expectedVersion: number; commandId: string } | null>(null)
async function load() {
  if (busy.value) return
  loading.value = true
  error.value = ''
  try {
    tokens.value = responseSchema.parse(await request('/api/account/payment-tokens')).tokens
  } catch {
    tokens.value = []
    error.value = 'No hemos podido cargar tus métodos de pago. Vuelve a intentarlo.'
  } finally {
    loading.value = false
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
  try {
    const receipt = receiptSchema.parse(
      await request('/api/account/payment-tokens', {
        method: 'POST',
        headers: { 'Idempotency-Key': command.commandId },
        body: command
      })
    )
    if (receipt.tokenId !== command.tokenId || receipt.version !== command.expectedVersion + 1)
      throw new Error('invalid_receipt')
    tokens.value = tokens.value.filter((item) => item.id !== command.tokenId)
    pending.value = null
    message.value = 'La retirada se ha solicitado y está pendiente de confirmación por el proveedor.'
  } catch {
    error.value = 'No hemos podido confirmar la solicitud. Vuelve a intentarlo con el mismo comando.'
  } finally {
    busy.value = false
  }
}
onMounted(() => {
  void load()
})
</script>
<template>
  <section aria-labelledby="saved-payment-title">
    <h1 id="saved-payment-title">Métodos de pago guardados</h1>
    <p v-if="loading" role="status">Cargando métodos de pago…</p>
    <p v-if="message" role="status">{{ message }}</p>
    <div v-if="error" role="alert">
      <p>{{ error }}</p>
      <button v-if="pending" type="button" :disabled="busy" @click="remove()">Volver a comprobar</button>
      <button v-else type="button" :disabled="loading" @click="load()">Volver a cargar</button>
    </div>
    <p v-if="!loading && !error && !tokens.length">No tienes métodos de pago guardados.</p>
    <ul v-if="!loading && tokens.length">
      <li v-for="(token, index) in tokens" :key="token.id">
        <span>Método guardado {{ index + 1 }}</span>
        <button
          v-if="!pending"
          type="button"
          :disabled="busy"
          :aria-label="`Solicitar retirada del método guardado ${index + 1}`"
          @click="remove(token)"
        >
          Solicitar retirada
        </button>
      </li>
    </ul>
  </section>
</template>
