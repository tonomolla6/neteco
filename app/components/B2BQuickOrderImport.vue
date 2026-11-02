<script setup lang="ts">
import { z } from 'zod'
import { useCartStore } from '~/stores/cart'
import {
  QUICK_ORDER_IMPORT_MAX_BYTES,
  QUICK_ORDER_IMPORT_MAX_ROWS,
  addScannedCode,
  parseQuickOrderImport,
  type QuickOrderImportRow,
  type QuickOrderLine
} from '~~/shared/quick-order-import'

// SEA-018. CSV upload / paste with column mapping, barcode scan (scanner keyboard or camera) and
// server-side resolution under the authenticated company. The browser never sends a company,
// customer, price or time: the server derives them from the session.
const runtime = useRuntimeConfig().public.serverRuntime
const { ready, loggedIn, user, session } = useUserSession()
const request = useRequestFetch()
const cart = useCartStore()

const readyLine = z.object({
  index: z.number().int(),
  status: z.literal('ready'),
  reference: z.string(),
  quantity: z.number().int(),
  variantId: z.string(),
  legacyVariantId: z.number().int().positive().nullable(),
  name: z.string(),
  format: z.string(),
  unitLabel: z.string(),
  unitGrossCents: z.number().int(),
  grossCents: z.number().int(),
  source: z.enum(['public', 'b2b_variant', 'b2b_category'])
})
const errorLine = z.object({
  index: z.number().int(),
  status: z.literal('error'),
  reference: z.string(),
  quantity: z.number().int(),
  code: z.string()
})
const responseSchema = z.object({ companyId: z.string(), lines: z.array(z.union([readyLine, errorLine])).max(100) })
type Resolved = z.infer<typeof responseSchema>['lines'][number]
type ReadyResolved = z.infer<typeof readyLine>

const text = ref('')
const lines = ref<QuickOrderLine[]>([])
const importErrors = ref<QuickOrderImportRow[]>([])
const importCounts = ref<{ valid: number; errors: number } | null>(null)
const generalError = ref('')
const mapping = ref<{ headers: string[]; reference: number; quantity: number } | null>(null)
const scanCode = ref('')
const scanError = ref('')
const validating = ref(false)
const validateError = ref('')
const results = shallowRef<Resolved[]>([])
const selected = ref<number[]>([])
const confirmed = ref(false)
const adding = ref(false)
const addNotice = ref('')
const attempted = ref<number[]>([])
const canCamera = ref(false)
const cameraOn = ref(false)
const video = ref<HTMLVideoElement | null>(null)
let generation = 0
let disposed = false
let stream: MediaStream | null = null
let timer: ReturnType<typeof setTimeout> | undefined

const scope = computed(() =>
  JSON.stringify([
    ready.value,
    loggedIn.value,
    user.value?.id,
    user.value?.emailVerified,
    session.value?.sessionId,
    session.value?.sessionVersion
  ])
)
const allowed = computed(
  () =>
    runtime === 'cloudflare' &&
    ready.value &&
    loggedIn.value &&
    user.value?.emailVerified === true &&
    z.string().uuid().safeParse(user.value.id).success &&
    z.string().uuid().safeParse(session.value?.sessionId).success &&
    Number.isSafeInteger(session.value?.sessionVersion) &&
    Number(session.value?.sessionVersion) >= 1
)
const busy = computed(() => validating.value || adding.value)
const selectedRows = computed(() =>
  selected.value.flatMap((index) => {
    const row = results.value[index]
    return row?.status === 'ready' && row.legacyVariantId !== null && !attempted.value.includes(index) ? [row] : []
  })
)

function stopCamera() {
  cameraOn.value = false
  clearTimeout(timer)
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
}
function clearResults() {
  generation++
  results.value = []
  selected.value = []
  confirmed.value = false
  validateError.value = ''
  addNotice.value = ''
  attempted.value = []
  validating.value = false
}
function purge() {
  clearResults()
  stopCamera()
  text.value = ''
  lines.value = []
  importErrors.value = []
  importCounts.value = null
  generalError.value = ''
  mapping.value = null
  scanCode.value = ''
  scanError.value = ''
  adding.value = false
}
watch([scope, allowed], purge, { flush: 'sync' })
watch(lines, clearResults, { deep: true, flush: 'sync' })
watch(selected, () => (confirmed.value = false), { deep: true, flush: 'sync' })
onMounted(() => {
  canCamera.value =
    typeof (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector === 'function' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
})
onBeforeUnmount(() => {
  disposed = true
  purge()
})

const importMessages: Record<string, string> = {
  missing_reference: 'falta la referencia',
  invalid_reference: 'referencia no válida',
  invalid_checksum: 'el dígito de control del código de barras no coincide',
  missing_quantity: 'falta la cantidad',
  invalid_quantity: 'la cantidad debe ser un entero de 1 a 999',
  duplicate_reference: 'referencia repetida; no se suman cantidades automáticamente'
}
const generalMessages: Record<string, string> = {
  empty: 'No hay filas que importar. Incluye una cabecera y al menos una línea.',
  too_large: `El archivo supera ${QUICK_ORDER_IMPORT_MAX_BYTES / 1024} KiB. No se ha recortado.`,
  too_many_rows: `Máximo ${QUICK_ORDER_IMPORT_MAX_ROWS} filas por importación. No se ha recortado.`,
  malformed_csv: 'El CSV está mal formado (comillas sin cerrar o demasiadas columnas).',
  invalid_mapping: 'La asignación de columnas no es válida.'
}
const scanMessages: Record<string, string> = {
  empty: 'Escanea o escribe un código.',
  too_long: 'El código es demasiado largo.',
  invalid_characters: 'El código contiene caracteres no admitidos.',
  invalid_checksum: 'Código no válido: el dígito de control no coincide.',
  row_limit: `Máximo ${QUICK_ORDER_IMPORT_MAX_ROWS} líneas.`,
  quantity_limit: 'Máximo 999 unidades por referencia.'
}
const lineMessages: Record<string, string> = {
  not_found: 'No se encontró ninguna variante publicada con ese identificador exacto.',
  ambiguous: 'Varias variantes coinciden; usa un identificador más específico.',
  duplicate_reference: 'Referencia repetida en el pedido.',
  duplicate_variant: 'La misma variante aparece con otro identificador.',
  insufficient_stock: 'Stock insuficiente para esa cantidad.',
  quantity_not_allowed: 'Cantidad no admitida: revisa mínimo, incremento y máximo.'
}

function runImport(source: string, forced?: { reference: number; quantity: number }) {
  generalError.value = ''
  importErrors.value = []
  importCounts.value = null
  mapping.value = null
  const result = parseQuickOrderImport(source, forced ? { mapping: forced } : {})
  if (result.status === 'error') {
    generalError.value = generalMessages[result.code] ?? 'No se pudo leer el archivo.'
    return
  }
  if (result.status === 'mapping_required') {
    mapping.value = {
      headers: result.headers,
      reference: result.suggestion.reference ?? 0,
      quantity: result.suggestion.quantity ?? Math.min(1, result.headers.length - 1)
    }
    return
  }
  lines.value = result.rows.flatMap((row) =>
    row.error === null && row.quantity !== null ? [{ reference: row.reference, quantity: row.quantity }] : []
  )
  importErrors.value = result.rows.filter((row) => row.error !== null)
  importCounts.value = { valid: result.validCount, errors: result.errorCount }
}
function submitImport() {
  if (!allowed.value || busy.value) return
  runImport(text.value)
}
function applyMapping() {
  if (!mapping.value) return
  runImport(text.value, { reference: Number(mapping.value.reference), quantity: Number(mapping.value.quantity) })
}
async function onFile(event: Event) {
  if (!allowed.value || busy.value) return
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  generalError.value = ''
  if (file.size > QUICK_ORDER_IMPORT_MAX_BYTES) {
    generalError.value = generalMessages.too_large!
    return
  }
  try {
    text.value = await file.text()
  } catch {
    generalError.value = 'No se pudo leer el archivo.'
    return
  }
  runImport(text.value)
}

function addScan(code: string) {
  scanError.value = ''
  const result = addScannedCode(lines.value, code)
  if (!result.ok) {
    scanError.value = scanMessages[result.error] ?? 'Código no admitido.'
    return false
  }
  lines.value = result.lines
  return true
}
function submitScan() {
  if (!allowed.value || busy.value) return
  if (addScan(scanCode.value)) scanCode.value = ''
}
async function startCamera() {
  if (!allowed.value || !canCamera.value || cameraOn.value) return
  const epoch = generation
  try {
    const opened = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    if (disposed || epoch !== generation || !allowed.value) {
      opened.getTracks().forEach((track) => track.stop())
      return
    }
    stream = opened
    cameraOn.value = true
    await nextTick()
    const element = video.value
    if (!element) return stopCamera()
    element.srcObject = opened
    await element.play()
    const Detector = (
      globalThis as unknown as {
        BarcodeDetector: new (o: { formats: string[] }) => {
          detect(v: HTMLVideoElement): Promise<Array<{ rawValue: string }>>
        }
      }
    ).BarcodeDetector
    const detector = new Detector({ formats: ['ean_13', 'ean_8', 'upc_a', 'itf', 'code_128'] })
    let last = ''
    let lastAt = 0
    const tick = async () => {
      if (!cameraOn.value || disposed) return
      try {
        const found = await detector.detect(element)
        const code = found[0]?.rawValue
        if (code && (code !== last || Date.now() - lastAt > 1500)) {
          last = code
          lastAt = Date.now()
          addScan(code)
        }
      } catch {
        // a frame that cannot be decoded is simply skipped
      }
      timer = setTimeout(tick, 250)
    }
    void tick()
  } catch {
    stopCamera()
    scanError.value = 'No se pudo abrir la cámara. Usa un lector o escribe el código.'
  }
}
function setQuantity(index: number, event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  const line = lines.value[index]
  if (!line) return
  if (!Number.isInteger(value) || value < 1 || value > 999) {
    ;(event.target as HTMLInputElement).value = String(line.quantity)
    return
  }
  lines.value = lines.value.map((item, i) => (i === index ? { ...item, quantity: value } : item))
}
function removeLine(index: number) {
  lines.value = lines.value.filter((_, i) => i !== index)
}

function describeFailure(failure: unknown) {
  const code = (failure as { data?: { error?: { code?: string } } })?.data?.error?.code
  if (code === 'company_not_approved' || code === 'not_company')
    return 'Tu cuenta no tiene una empresa aprobada. Solicita la aprobación de tu empresa para usar precios y carga de empresa.'
  if (code === 'unauthenticated') return 'Tu sesión ha caducado. Vuelve a iniciar sesión.'
  if (code === 'rate_limited') return 'Demasiadas validaciones seguidas. Espera un momento.'
  if (code === 'invalid_input') return 'Algún dato del pedido no es válido. Revisa referencias y cantidades.'
  return 'No se pudo validar con tu empresa. Inténtalo de nuevo.'
}
async function validate() {
  if (!allowed.value || busy.value || !lines.value.length) return
  clearResults()
  const epoch = generation
  const body = { lines: lines.value.map(({ reference, quantity }) => ({ reference, quantity })) }
  validating.value = true
  try {
    const value: unknown = await request<unknown, string>('/api/account/quick-order/company', {
      method: 'POST',
      body,
      cache: 'no-store',
      retry: 0
    })
    if (disposed || epoch !== generation || !allowed.value) return
    const parsed = responseSchema.parse(value)
    results.value = parsed.lines
    selected.value = parsed.lines.flatMap((row, index) =>
      row.status === 'ready' && row.legacyVariantId !== null ? [index] : []
    )
  } catch (failure) {
    if (!disposed && epoch === generation)
      validateError.value =
        failure instanceof z.ZodError ? 'Respuesta no válida; no se ha validado el pedido.' : describeFailure(failure)
  } finally {
    if (epoch === generation) validating.value = false
  }
}
async function addSelection() {
  if (!allowed.value || busy.value || !confirmed.value || !selectedRows.value.length) return
  if (cart.pendingMutation || cart.blockedMutations) {
    addNotice.value = 'Resuelve primero la adición pendiente en el carrito.'
    return
  }
  const epoch = generation
  const batch = selectedRows.value.map((row) => ({ row, index: results.value.indexOf(row) }))
  adding.value = true
  confirmed.value = false
  addNotice.value = ''
  let added = 0
  try {
    for (const [position, { row, index }] of batch.entries()) {
      if (disposed || epoch !== generation) return
      attempted.value = [...attempted.value, index]
      try {
        await cart.add({ variantId: row.legacyVariantId! }, row.quantity)
        added++
      } catch {
        addNotice.value = `${added} adiciones confirmadas. Una adición tiene resultado incierto y ${batch.length - position - 1} filas quedan sin intentar. Comprueba el carrito; no se reenviará desde aquí.`
        return
      }
    }
    addNotice.value = `${added} ${added === 1 ? 'adición confirmada' : 'adiciones confirmadas'} en el carrito. Revisa allí los precios antes de comprar.`
  } finally {
    if (epoch === generation) adding.value = false
  }
}
const money = (cents: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100)
const lineError = (row: Resolved) =>
  row.status === 'error' ? (lineMessages[row.code] ?? 'No se pudo resolver la línea.') : ''
const sourceLabel = (row: ReadyResolved) => (row.source === 'public' ? 'precio público' : 'precio de tu empresa')
</script>

<template>
  <section class="mx-auto w-full min-w-0 max-w-4xl space-y-5 px-4 py-8" aria-labelledby="b2b-import-title">
    <h2 id="b2b-import-title" class="text-xl font-semibold">Pedido de empresa por CSV o código de barras</h2>
    <p v-if="runtime !== 'cloudflare'" role="status">Esta función requiere el catálogo Cloudflare.</p>
    <p v-else-if="!allowed" role="status">
      Inicia sesión con una cuenta de empresa aprobada y correo verificado para cargar un CSV o escanear códigos.
    </p>
    <template v-else>
      <form data-import-form class="space-y-3" @submit.prevent="submitImport">
        <p id="b2b-import-help">
          Sube o pega un CSV (comas, punto y coma o tabulador) con columnas de referencia (SKU, EAN, GTIN o MPN) y
          cantidad. Máximo {{ QUICK_ORDER_IMPORT_MAX_ROWS }} filas y 64 KiB; no se recorta ni se suman duplicados.
        </p>
        <label for="b2b-import-file" class="block font-medium">Archivo CSV</label>
        <input
          id="b2b-import-file"
          data-import-file
          type="file"
          accept=".csv,text/csv,text/plain"
          :disabled="busy"
          aria-describedby="b2b-import-help"
          @change="onFile"
        />
        <label for="b2b-import-text" class="block font-medium">O pega el contenido</label>
        <textarea
          id="b2b-import-text"
          v-model="text"
          data-import-text
          rows="6"
          class="block w-full min-w-0 rounded border p-3 font-mono"
          :disabled="busy"
        />
        <button type="submit" class="rounded border px-4 py-2" :disabled="busy || !text.trim()">Analizar CSV</button>
      </form>
      <p v-if="generalError" data-import-error-general role="alert" class="break-words">{{ generalError }}</p>
      <fieldset v-if="mapping" data-mapping class="space-y-3 rounded border p-4">
        <legend class="font-medium">Asigna las columnas</legend>
        <label class="block"
          >Columna de referencia
          <select v-model="mapping.reference" data-map-reference class="ml-2 rounded border p-1">
            <option v-for="(header, i) in mapping.headers" :key="i" :value="i">
              {{ header || `Columna ${i + 1}` }}
            </option>
          </select></label
        >
        <label class="block"
          >Columna de cantidad
          <select v-model="mapping.quantity" data-map-quantity class="ml-2 rounded border p-1">
            <option v-for="(header, i) in mapping.headers" :key="i" :value="i">
              {{ header || `Columna ${i + 1}` }}
            </option>
          </select></label
        >
        <button type="button" data-map-apply class="rounded border px-4 py-2" @click="applyMapping">
          Aplicar asignación
        </button>
      </fieldset>
      <div v-if="importCounts" aria-live="polite">
        <p data-import-summary>
          {{ importCounts.valid }} {{ importCounts.valid === 1 ? 'válida' : 'válidas' }} · {{ importCounts.errors }} con
          error
        </p>
        <ul v-if="importErrors.length" class="mt-2 space-y-1">
          <li v-for="row in importErrors" :key="row.line" data-import-error role="alert" class="break-words">
            Línea {{ row.line }}: {{ importMessages[row.error!]
            }}<template v-if="row.reference"> ({{ row.reference }})</template>
          </li>
        </ul>
      </div>

      <form data-scan-form class="space-y-2" @submit.prevent="submitScan">
        <label for="b2b-scan" class="block font-medium">Escanear código de barras</label>
        <p class="text-sm">Con un lector USB o Bluetooth, enfoca el campo y escanea: cada lectura suma una unidad.</p>
        <div class="flex flex-wrap gap-2">
          <input
            id="b2b-scan"
            v-model="scanCode"
            data-scan-input
            inputmode="numeric"
            autocomplete="off"
            class="min-w-0 flex-1 rounded border p-2 font-mono"
            :disabled="busy"
          />
          <button type="submit" class="rounded border px-4 py-2" :disabled="busy || !scanCode.trim()">Añadir</button>
          <button
            v-if="canCamera"
            type="button"
            data-scan-camera
            class="rounded border px-4 py-2"
            @click="cameraOn ? stopCamera() : startCamera()"
          >
            {{ cameraOn ? 'Parar cámara' : 'Usar cámara' }}
          </button>
        </div>
        <video v-show="cameraOn" ref="video" playsinline muted class="max-h-64 w-full rounded border" />
        <p v-if="scanError" data-scan-error role="alert">{{ scanError }}</p>
      </form>

      <div v-if="lines.length" class="space-y-2">
        <h3 class="font-medium">Líneas del pedido ({{ lines.length }})</h3>
        <ul class="space-y-2">
          <li
            v-for="(line, i) in lines"
            :key="`${line.reference}-${i}`"
            :data-line="i"
            class="flex flex-wrap items-center gap-2 break-words"
          >
            <span class="min-w-0 flex-1 font-mono">{{ line.reference }}</span>
            <label class="flex items-center gap-1"
              ><span class="sr-only">Cantidad de {{ line.reference }}</span>
              <input
                :value="line.quantity"
                :data-line-quantity="i"
                type="number"
                min="1"
                max="999"
                step="1"
                class="w-24 rounded border p-1"
                :disabled="busy"
                @change="setQuantity(i, $event)"
            /></label>
            <button
              type="button"
              :data-line-remove="i"
              class="rounded border px-2 py-1"
              :disabled="busy"
              @click="removeLine(i)"
            >
              Quitar<span class="sr-only"> {{ line.reference }}</span>
            </button>
          </li>
        </ul>
      </div>
      <button
        type="button"
        data-validate
        class="rounded border px-4 py-2"
        :disabled="busy || !lines.length"
        @click="validate"
      >
        {{ validating ? 'Validando…' : 'Validar con mi empresa' }}
      </button>
      <p v-if="validating" role="status">Consultando catálogo, stock y tarifa de tu empresa…</p>
      <p v-if="validateError" data-validate-error role="alert" class="break-words">{{ validateError }}</p>

      <template v-if="results.length">
        <p>Precios con IVA según la tarifa vigente de tu empresa ahora; el carrito vuelve a validarlos.</p>
        <ul class="space-y-3">
          <li v-for="(row, i) in results" :key="i" data-result class="min-w-0 break-words rounded border p-4">
            <p class="font-medium">{{ row.reference }} · {{ row.quantity }}</p>
            <p v-if="row.status === 'error'" role="alert">{{ lineError(row) }}</p>
            <template v-else>
              <label class="flex items-start gap-2"
                ><input
                  v-model="selected"
                  type="checkbox"
                  :value="i"
                  :data-result-select="i"
                  :disabled="busy || attempted.includes(i) || row.legacyVariantId === null"
                /><span>{{ row.name }} — {{ row.format }} ({{ row.unitLabel }})</span></label
              >
              <p>
                {{ money(row.unitGrossCents) }} / {{ row.unitLabel }} · total {{ money(row.grossCents) }} ·
                {{ sourceLabel(row) }}
              </p>
            </template>
          </li>
        </ul>
        <label class="flex items-start gap-2"
          ><input v-model="confirmed" data-confirm type="checkbox" :disabled="busy || !selectedRows.length" /><span
            >He revisado las líneas seleccionadas, cantidades y precios.</span
          ></label
        >
        <button
          type="button"
          data-add
          class="rounded border px-4 py-2"
          :disabled="busy || !confirmed || !selectedRows.length"
          @click="addSelection"
        >
          {{ adding ? 'Añadiendo…' : 'Añadir selección al carrito' }}
        </button>
      </template>
      <p v-if="addNotice" data-add-notice aria-live="polite" class="break-words">{{ addNotice }}</p>
      <NuxtLink to="/carrito" class="inline-block underline">Ir al carrito</NuxtLink>
    </template>
  </section>
</template>
