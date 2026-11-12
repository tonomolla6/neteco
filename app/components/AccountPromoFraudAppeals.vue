<script setup lang="ts">
import { z } from 'zod'

// SEC-036. The customer sees only the status of their own promotion / referral reviews, never the
// scores or the signals that triggered them, and can appeal a held or confirmed case once.
const runtime = useRuntimeConfig().public.serverRuntime
const { ready, loggedIn, user, session } = useUserSession()
const request = useRequestFetch()

const itemSchema = z.object({
  id: z.string().uuid(),
  context: z.enum(['referral', 'promotion']),
  refId: z.string(),
  status: z.string(),
  version: z.number().int().min(1),
  benefitBlocked: z.boolean(),
  canAppeal: z.boolean(),
  appealStatus: z.enum(['pending', 'accepted', 'rejected']).nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable()
})
const listSchema = z.object({ items: z.array(itemSchema).max(50) })
type Item = z.infer<typeof itemSchema>

const items = shallowRef<Item[]>([])
const loading = ref(false)
const loadError = ref('')
const openId = ref<string | null>(null)
const statement = ref('')
const submitting = ref(false)
const error = ref('')
const notice = ref('')
let generation = 0 // bumped only when the session scope changes
let loadSeq = 0 // bumped by every list reload
let disposed = false

const scope = computed(() =>
  JSON.stringify([ready.value, loggedIn.value, user.value?.id, session.value?.sessionId, session.value?.sessionVersion])
)
const allowed = computed(
  () => runtime === 'cloudflare' && ready.value && loggedIn.value && user.value?.emailVerified === true
)
const statementValid = computed(() => statement.value.trim().length >= 10 && statement.value.trim().length <= 1000)
const opened = computed(() => items.value.find((item) => item.id === openId.value) ?? null)

const statusLabel = (item: Item) =>
  item.appealStatus === 'pending'
    ? 'Apelación pendiente'
    : item.appealStatus === 'accepted'
      ? 'Apelación aceptada'
      : item.appealStatus === 'rejected'
        ? 'Apelación rechazada'
        : item.status === 'released'
          ? 'Revisión resuelta a tu favor'
          : item.status === 'upheld'
            ? 'Revisión resuelta: ventaja no concedida'
            : 'La ventaja está en revisión'
function describe(failure: unknown) {
  const code = (failure as { data?: { error?: { code?: string } } })?.data?.error?.code
  const messages: Record<string, string> = {
    version_conflict: 'El caso cambió mientras escribías; se ha recargado. Revisa tu texto y envíalo de nuevo.',
    appeal_not_allowed: 'Este caso ya no admite apelación.',
    not_found: 'No se encontró el caso.',
    unauthenticated: 'Tu sesión ha caducado.',
    rate_limited: 'Demasiados envíos seguidos. Espera un momento.',
    invalid_input: 'La explicación debe tener entre 10 y 1000 caracteres.'
  }
  return (code && messages[code]) || 'No se pudo enviar la apelación. Inténtalo de nuevo.'
}
async function load() {
  if (!allowed.value) return
  const epoch = generation
  const seq = ++loadSeq
  loading.value = true
  loadError.value = ''
  try {
    const value = listSchema.parse(await request('/api/account/promo-fraud/cases', { cache: 'no-store', retry: 0 }))
    if (!disposed && epoch === generation && seq === loadSeq) items.value = value.items
  } catch {
    if (!disposed && epoch === generation && seq === loadSeq) {
      items.value = []
      loadError.value = 'No se pudieron cargar tus revisiones.'
    }
  } finally {
    if (epoch === generation && seq === loadSeq) loading.value = false
  }
}
async function submit() {
  const item = opened.value
  if (!allowed.value || !item || submitting.value || !statementValid.value) return
  const epoch = generation
  submitting.value = true
  error.value = ''
  notice.value = ''
  try {
    await request<unknown, string>(`/api/account/promo-fraud/cases/${item.id}/appeal`, {
      method: 'POST',
      body: { caseVersion: item.version, statement: statement.value.trim() },
      cache: 'no-store',
      retry: 0
    })
    if (disposed || epoch !== generation) return
    openId.value = null
    statement.value = ''
    await load()
    notice.value = 'Hemos recibido tu apelación. Una persona distinta de quien tomó la decisión la revisará.'
  } catch (failure) {
    if (disposed || epoch !== generation) return
    await load()
    error.value = describe(failure)
  } finally {
    if (epoch === generation) submitting.value = false
  }
}
function startAppeal(id: string) {
  openId.value = id
  error.value = ''
  notice.value = ''
}
function purge() {
  generation++
  items.value = []
  openId.value = null
  statement.value = ''
  error.value = ''
  notice.value = ''
  loadError.value = ''
  submitting.value = false
  loading.value = false
}
watch(
  scope,
  () => {
    purge()
    void load()
  },
  { flush: 'sync' }
)
onMounted(() => void load())
onBeforeUnmount(() => {
  disposed = true
  purge()
})
</script>

<template>
  <section class="mx-auto w-full min-w-0 max-w-3xl space-y-5 px-4 py-6" aria-labelledby="ap-title">
    <h1 id="ap-title" class="text-2xl font-semibold">Revisiones de promociones y referidos</h1>
    <p class="text-sm">
      Revisamos manualmente las ventajas cuando varias señales coinciden. Nunca bloqueamos por una única señal, y puedes
      apelar la decisión.
    </p>
    <p v-if="runtime !== 'cloudflare'" role="status">
      Esta gestión no está disponible ahora mismo. Si necesitas revisar una promoción, escríbenos desde Contacto.
    </p>
    <p v-else-if="!allowed" role="status">Inicia sesión con una cuenta verificada.</p>
    <template v-else>
      <p v-if="loading" role="status">Cargando…</p>
      <p v-if="loadError" data-ap-error role="alert">{{ loadError }}</p>
      <p v-else-if="!loading && !items.length" data-ap-empty>No tienes ninguna revisión en curso.</p>
      <ul v-if="items.length" data-ap-list class="space-y-3">
        <li v-for="item in items" :key="item.id" :data-ap-case="item.id" class="min-w-0 break-words rounded border p-4">
          <p class="font-medium">{{ item.context === 'referral' ? 'Referido' : 'Promoción' }} {{ item.refId }}</p>
          <p>{{ statusLabel(item) }}</p>
          <button
            v-if="item.canAppeal"
            type="button"
            :data-ap-open="item.id"
            class="mt-2 rounded border px-3 py-1"
            @click="startAppeal(item.id)"
          >
            Apelar<span class="sr-only"> {{ item.refId }}</span>
          </button>
        </li>
      </ul>
      <p v-if="notice" data-ap-notice role="status">{{ notice }}</p>
      <form v-if="opened" data-ap-form class="space-y-3 rounded border p-4" @submit.prevent="submit">
        <label for="ap-statement" class="block font-medium">Explica por qué la decisión no es correcta</label>
        <textarea
          id="ap-statement"
          v-model="statement"
          data-ap-statement
          rows="5"
          maxlength="1000"
          class="block w-full rounded border p-2"
          aria-describedby="ap-help"
        />
        <p id="ap-help" class="text-sm">Entre 10 y 1000 caracteres. No incluyas datos de tarjeta ni contraseñas.</p>
        <p v-if="error" data-ap-error role="alert" class="break-words">{{ error }}</p>
        <button type="submit" data-ap-submit class="rounded border px-4 py-2" :disabled="submitting || !statementValid">
          {{ submitting ? 'Enviando…' : 'Enviar apelación' }}
        </button>
      </form>
    </template>
  </section>
</template>
