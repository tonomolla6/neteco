<script setup lang="ts">
import { z } from 'zod'
const props = defineProps<{ enabled: boolean; scopeKey: string }>()
const request = useRequestFetch()
const companySchema = z
  .object({
    id: z.string(),
    legalName: z.string(),
    status: z.string(),
    paymentDays: z.number().nullable(),
    creditLimitCents: z.number().nullable(),
    blocked: z.number().nullable(),
    blockReason: z.string().nullable(),
    creditVersion: z.number().nullable(),
    priceListId: z.string().nullable(),
    assignmentVersion: z.number().nullable(),
    assignmentActive: z.number().nullable(),
    exposureCents: z.number()
  })
  .strict()
const listSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    status: z.string(),
    version: z.number(),
    validFrom: z.string(),
    validUntil: z.string().nullable(),
    variantRules: z.array(z.object({ variantId: z.string(), unitGrossCents: z.number() }).strict()),
    categoryRules: z.array(z.object({ categoryId: z.string(), discountBps: z.number() }).strict())
  })
  .strict()
const responseSchema = z.object({ companies: z.array(companySchema), priceLists: z.array(listSchema) }).strict()
type Company = z.infer<typeof companySchema>
type PriceList = z.infer<typeof listSchema>
const companies = ref<Company[]>([]),
  priceLists = ref<PriceList[]>([])
const selectedCompany = ref(''),
  selectedList = ref(''),
  loading = ref(false),
  saving = ref(false),
  error = ref(''),
  notice = ref('')
const credit = reactive({
  paymentDays: 0,
  creditLimitCents: 0,
  blocked: false,
  blockReason: '',
  reason: '',
  version: 0
})
const assignment = reactive({ priceListId: '', validFrom: '', validUntil: '', reason: '' })
const list = reactive({
  id: '',
  version: 0,
  code: '',
  name: '',
  status: 'active',
  validFrom: '',
  validUntil: '',
  reason: '',
  variantRules: [] as { variantId: string; unitGrossCents: number }[],
  categoryRules: [] as { categoryId: string; discountBps: number }[]
})
let generation = 0
let pending: { url: string; body: Record<string, unknown>; key: string } | null = null
const uncertain = ref(false)
const currentCompany = computed(() => companies.value.find((c) => c.id === selectedCompany.value))
watch(selectedCompany, () => {
  const c = currentCompany.value
  Object.assign(credit, {
    paymentDays: c?.paymentDays ?? 0,
    creditLimitCents: c?.creditLimitCents ?? 0,
    blocked: c?.blocked === 1,
    blockReason: c?.blockReason ?? '',
    reason: '',
    version: c?.creditVersion ?? 0
  })
  Object.assign(assignment, {
    priceListId: c?.priceListId ?? '',
    validFrom: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    validUntil: '',
    reason: ''
  })
})
watch(selectedList, () => {
  const found = priceLists.value.find((item) => item.id === selectedList.value)
  Object.assign(
    list,
    found
      ? {
          ...found,
          validUntil: found.validUntil ?? '',
          reason: '',
          variantRules: found.variantRules.map((r) => ({ ...r })),
          categoryRules: found.categoryRules.map((r) => ({ ...r }))
        }
      : {
          id: '',
          version: 0,
          code: '',
          name: '',
          status: 'active',
          validFrom: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          validUntil: '',
          reason: '',
          variantRules: [],
          categoryRules: []
        }
  )
})
async function load(expected = generation) {
  loading.value = true
  error.value = ''
  try {
    const data = responseSchema.parse(await request('/api/admin/b2b'))
    if (expected !== generation || !props.enabled) return
    companies.value = data.companies
    priceLists.value = data.priceLists
  } catch {
    if (expected === generation) error.value = 'No se han podido cargar las condiciones comerciales.'
  } finally {
    if (expected === generation) loading.value = false
  }
}
watch(
  () => [props.enabled, props.scopeKey],
  () => {
    generation++
    companies.value = []
    priceLists.value = []
    selectedCompany.value = ''
    selectedList.value = ''
    pending = null
    uncertain.value = false
    notice.value = ''
    error.value = ''
    if (props.enabled) void load()
  },
  { immediate: true }
)
async function send(url?: string, body?: Record<string, unknown>) {
  if (!props.enabled || saving.value) return
  if (!pending) {
    if (!url || !body) return
    pending = { url, body, key: crypto.randomUUID() }
  }
  const command = pending,
    expected = generation
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    await request(command.url, { method: 'PUT', headers: { 'Idempotency-Key': command.key }, body: command.body })
    if (expected !== generation) return
    pending = null
    uncertain.value = false
    notice.value = 'Cambios guardados.'
    await load(expected)
    const selected = selectedCompany.value
    selectedCompany.value = ''
    await nextTick()
    selectedCompany.value = selected
  } catch (e) {
    if (expected !== generation) return
    const status = Number((e as { statusCode?: number })?.statusCode)
    if ([400, 401, 403, 409, 422].includes(status)) {
      pending = null
      uncertain.value = false
      error.value =
        status === 409
          ? 'Las condiciones han cambiado; recarga y revisa la versión.'
          : 'No se han podido guardar los cambios.'
    } else {
      uncertain.value = true
      error.value = 'No se ha confirmado el resultado. Reintenta la misma operación.'
    }
  } finally {
    if (expected === generation) saving.value = false
  }
}
function saveCredit() {
  if (!currentCompany.value) return
  void send(`/api/admin/b2b/companies/${encodeURIComponent(currentCompany.value.id)}/credit`, {
    expectedVersion: credit.version,
    paymentDays: Number(credit.paymentDays),
    creditLimitCents: Number(credit.creditLimitCents),
    blocked: credit.blocked,
    blockReason: credit.blocked ? credit.blockReason.trim() : null,
    reason: credit.reason.trim()
  })
}
function saveAssignment(remove = false) {
  if (!currentCompany.value) return
  void send(
    `/api/admin/b2b/companies/${encodeURIComponent(currentCompany.value.id)}/assignment`,
    remove
      ? { remove: true, expectedVersion: currentCompany.value.assignmentVersion, reason: assignment.reason.trim() }
      : {
          priceListId: assignment.priceListId,
          expectedVersion: currentCompany.value.assignmentVersion ?? 0,
          validFrom: assignment.validFrom,
          validUntil: assignment.validUntil || null,
          reason: assignment.reason.trim()
        }
  )
}
function saveList() {
  void send('/api/admin/b2b/price-lists', {
    ...(list.id ? { priceListId: list.id, expectedVersion: list.version } : {}),
    code: list.code,
    name: list.name,
    status: list.status,
    validFrom: list.validFrom,
    validUntil: list.validUntil || null,
    reason: list.reason,
    variantRules: list.variantRules.map((r) => ({ ...r, unitGrossCents: Number(r.unitGrossCents) })),
    categoryRules: list.categoryRules.map((r) => ({ ...r, discountBps: Number(r.discountBps) }))
  })
}
</script>
<template>
  <section class="space-y-5">
    <p v-if="!enabled">Necesitas permiso de administración comercial y una sesión verificada.</p>
    <template v-else>
      <p v-if="loading" role="status">Cargando tarifas y condiciones…</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <button v-if="uncertain" type="button" :disabled="saving" @click="send()">Reintentar operación</button>
      <fieldset :disabled="loading || saving || uncertain" class="space-y-5">
        <div>
          <label
            >Empresa
            <select v-model="selectedCompany" name="company">
              <option value="">Selecciona una empresa</option>
              <option v-for="company in companies" :key="company.id" :value="company.id">
                {{ company.legalName }} ({{ company.status }})
              </option>
            </select></label
          >
        </div>
        <template v-if="currentCompany">
          <p>Exposición: {{ (currentCompany.exposureCents / 100).toFixed(2) }} €</p>
          <form data-test="credit-form" class="space-y-2" @submit.prevent="saveCredit">
            <h2>Condiciones y límite</h2>
            <label
              >Pago
              <select v-model.number="credit.paymentDays">
                <option :value="0">Inmediato</option>
                <option :value="15">Transferencia a 15 días</option>
                <option :value="30">Transferencia a 30 días</option>
                <option :value="60">Transferencia a 60 días</option>
              </select></label
            >
            <label
              >Límite en céntimos
              <input v-model.number="credit.creditLimitCents" type="number" min="0" step="1" required
            /></label>
            <label><input v-model="credit.blocked" type="checkbox" /> Bloquear crédito</label>
            <label v-if="credit.blocked">Motivo del bloqueo <input v-model="credit.blockReason" required /></label>
            <label>Motivo del cambio <input v-model="credit.reason" name="reason" minlength="3" required /></label>
            <button type="submit">Guardar condiciones</button>
          </form>
          <form class="space-y-2" @submit.prevent="saveAssignment()">
            <h2>Asignación de tarifa</h2>
            <label
              >Tarifa
              <select v-model="assignment.priceListId" required>
                <option value="">Selecciona</option>
                <option v-for="tariff in priceLists" :key="tariff.id" :value="tariff.id">{{ tariff.name }}</option>
              </select></label
            >
            <label>Válida desde (UTC) <input v-model="assignment.validFrom" required /></label
            ><label>Hasta (UTC, opcional) <input v-model="assignment.validUntil" /></label
            ><label>Motivo <input v-model="assignment.reason" minlength="3" required /></label>
            <button type="submit">Asignar tarifa</button
            ><button v-if="currentCompany.assignmentActive === 1" type="button" @click="saveAssignment(true)">
              Retirar tarifa
            </button>
          </form>
        </template>
        <form class="space-y-2" @submit.prevent="saveList">
          <h2>Tarifas profesionales</h2>
          <label
            >Tarifa
            <select v-model="selectedList">
              <option value="">Nueva tarifa</option>
              <option v-for="tariff in priceLists" :key="tariff.id" :value="tariff.id">{{ tariff.name }}</option>
            </select></label
          >
          <label>Código <input v-model="list.code" required /></label
          ><label>Nombre <input v-model="list.name" required /></label
          ><label
            >Estado
            <select v-model="list.status">
              <option value="active">Activa</option>
              <option value="inactive">Inactiva</option>
            </select></label
          >
          <label
            >Válida desde (UTC) <input v-model="list.validFrom" required placeholder="2026-01-01T00:00:00Z" /></label
          ><label>Hasta (UTC, opcional) <input v-model="list.validUntil" /></label>
          <div v-for="(rule, index) in list.variantRules" :key="index">
            <label>Variante <input v-model="rule.variantId" required /></label
            ><label
              >Precio en céntimos <input v-model.number="rule.unitGrossCents" type="number" min="1" required /></label
            ><button type="button" @click="list.variantRules.splice(index, 1)">Quitar variante</button>
          </div>
          <button type="button" @click="list.variantRules.push({ variantId: '', unitGrossCents: 1 })">
            Añadir precio por variante
          </button>
          <div v-for="(rule, index) in list.categoryRules" :key="index">
            <label>Categoría <input v-model="rule.categoryId" required /></label
            ><label
              >Descuento en puntos básicos
              <input v-model.number="rule.discountBps" type="number" min="0" max="9500" required /></label
            ><button type="button" @click="list.categoryRules.splice(index, 1)">Quitar categoría</button>
          </div>
          <button type="button" @click="list.categoryRules.push({ categoryId: '', discountBps: 0 })">
            Añadir descuento por categoría</button
          ><label>Motivo <input v-model="list.reason" minlength="3" required /></label
          ><button type="submit">Guardar tarifa</button>
        </form>
      </fieldset>
    </template>
  </section>
</template>
