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
const transferOrderSchema = z
  .object({
    orderId: z.string(),
    companyId: z.string(),
    companyName: z.string(),
    totalCents: z.number(),
    outstandingCents: z.number(),
    simulatedOutstandingCents: z.number(),
    paymentDueAt: z.string().nullable()
  })
  .strict()
const transfersSchema = z.object({ enabled: z.boolean(), orders: z.array(transferOrderSchema) }).strict()
type TransferOrder = z.infer<typeof transferOrderSchema>
type Company = z.infer<typeof companySchema>
type PriceList = z.infer<typeof listSchema>
const companies = ref<Company[]>([]),
  priceLists = ref<PriceList[]>([])
const transfers = ref<TransferOrder[]>([]),
  transfersLoaded = ref(false),
  transfersEnabled = ref(false)
const transfer = reactive({ orderId: '', amountCents: '', bankReference: '', reason: '' })
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
async function loadTransfers(expected = generation) {
  error.value = ''
  try {
    const data = transfersSchema.parse(await request('/api/admin/b2b/transfers'))
    if (expected !== generation || !props.enabled) return
    transfers.value = data.orders
    transfersEnabled.value = data.enabled
    transfersLoaded.value = true
  } catch {
    if (expected === generation) error.value = 'No se han podido cargar las transferencias.'
  }
}
watch(
  () => [props.enabled, props.scopeKey],
  () => {
    generation++
    transfers.value = []
    transfersLoaded.value = false
    transfersEnabled.value = false
    Object.assign(transfer, { orderId: '', amountCents: '', bankReference: '', reason: '' })
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
    if (command.url.startsWith('/api/admin/b2b/transfers/')) await loadTransfers(expected)
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
          ? 'Alguien ha cambiado estos datos mientras los editabas. Vuelve a cargar y revisa los valores.'
          : 'No se han podido guardar los cambios.'
    } else {
      uncertain.value = true
      error.value =
        'No sabemos si el cambio ha llegado a guardarse. Pulsa «Reintentar operación» para repetirlo sin duplicarlo.'
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
const selectedTransfer = computed(() => transfers.value.find((order) => order.orderId === transfer.orderId))
function reconcileTransfer() {
  const order = selectedTransfer.value
  if (!order) return
  void send(`/api/admin/b2b/transfers/${encodeURIComponent(order.orderId)}`, {
    expectedOutstandingCents: order.simulatedOutstandingCents,
    amountCents: Number(transfer.amountCents),
    bankReference: transfer.bankReference.trim(),
    reason: transfer.reason.trim()
  })
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

/* --- Presentación --- */
const prefix = useId()
const tab = ref('empresa')
const TABS = [
  { value: 'empresa', label: 'Condiciones por empresa' },
  { value: 'tarifas', label: 'Tarifas' },
  { value: 'transferencias', label: 'Transferencias' }
]
const COMPANY_STATUS_LABELS: Record<string, string> = {
  pending: 'En revisión',
  approved: 'Aprobada',
  rejected: 'No aprobada',
  suspended: 'Suspendida'
}
const removeOpen = ref(false)
function confirmRemove() {
  removeOpen.value = false
  saveAssignment(true)
}
const PAYMENT_LABELS: Record<number, string> = {
  0: 'Pago inmediato',
  15: 'Transferencia a 15 días',
  30: 'Transferencia a 30 días',
  60: 'Transferencia a 60 días'
}
</script>
<template>
  <section class="adm-stack">
    <AdminEmptyState
      v-if="!enabled"
      icon="i-lucide-lock"
      title="No tienes acceso a las tarifas"
      description="Necesitas permiso de administración comercial y una sesión verificada."
    />
    <template v-else>
      <UAlert v-if="error" role="alert" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error">
        <template #actions>
          <button
            v-if="uncertain"
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            :disabled="saving"
            @click="send()"
          >
            Reintentar operación
          </button>
          <AdminButton v-else size="sm" icon="i-lucide-rotate-cw" :loading="loading" @click="load()">
            Reintentar
          </AdminButton>
        </template>
      </UAlert>
      <UAlert
        v-if="notice"
        role="status"
        color="success"
        variant="subtle"
        icon="i-lucide-circle-check"
        :title="notice"
      />
      <p v-if="loading" role="status" class="adm-help">Cargando tarifas y condiciones…</p>

      <AdminTabs v-model="tab" :tabs="TABS" label="Apartados de tarifas y crédito" />

      <fieldset :disabled="loading || saving || uncertain" class="adm-stack m-0 min-w-0 border-0 p-0">
        <div v-show="tab === 'empresa'" class="adm-stack">
          <div class="adm-card adm-tablecard">
            <div class="adm-tablecard__bar">
              <div class="adm-toolbar">
                <label :for="`${prefix}-company`" class="adm-label">Empresa</label>
                <select :id="`${prefix}-company`" v-model="selectedCompany" name="company" class="min-w-0 sm:w-80">
                  <option value="">Selecciona una empresa</option>
                  <option v-for="company in companies" :key="company.id" :value="company.id">
                    {{ company.legalName }} ({{
                      COMPANY_STATUS_LABELS[company.status] ?? adminHumanize(company.status)
                    }})
                  </option>
                </select>
              </div>
            </div>
            <AdminEmptyState
              v-if="!currentCompany"
              compact
              icon="i-lucide-building-2"
              title="Elige una empresa"
              description="Verás su crédito, su forma de pago y la tarifa que tiene asignada."
            />
          </div>

          <template v-if="currentCompany">
            <div class="adm-grid">
              <AdminStat
                label="Crédito utilizado"
                :value="adminMoney(currentCompany.exposureCents)"
                hint="Pedidos pendientes de cobro"
              />
              <AdminStat label="Límite de crédito" :value="adminMoney(currentCompany.creditLimitCents ?? 0)" />
              <AdminStat
                label="Forma de pago"
                :value="PAYMENT_LABELS[currentCompany.paymentDays ?? 0] ?? `${currentCompany.paymentDays} días`"
                :hint="currentCompany.blocked === 1 ? 'Crédito bloqueado' : undefined"
              />
            </div>

            <div class="grid items-start gap-5 lg:grid-cols-2">
              <AdminCard title="Crédito y forma de pago">
                <form :id="`${prefix}-credit`" data-test="credit-form" class="adm-stack" @submit.prevent="saveCredit">
                  <AdminFormField v-slot="{ id }" label="Forma de pago">
                    <select :id="id" v-model.number="credit.paymentDays">
                      <option :value="0">Inmediato</option>
                      <option :value="15">Transferencia a 15 días</option>
                      <option :value="30">Transferencia a 30 días</option>
                      <option :value="60">Transferencia a 60 días</option>
                    </select>
                  </AdminFormField>
                  <AdminFormField
                    v-slot="{ id }"
                    label="Límite de crédito (en céntimos)"
                    :help="`Equivale a ${adminMoney(Number(credit.creditLimitCents) || 0)}`"
                  >
                    <input :id="id" v-model.number="credit.creditLimitCents" type="number" min="0" step="1" required />
                  </AdminFormField>
                  <label class="adm-check"><input v-model="credit.blocked" type="checkbox" /> Bloquear crédito</label>
                  <AdminFormField v-if="credit.blocked" v-slot="{ id }" label="Motivo del bloqueo" required>
                    <input :id="id" v-model="credit.blockReason" required />
                  </AdminFormField>
                  <AdminFormField
                    v-slot="{ id }"
                    label="Motivo del cambio"
                    help="Queda guardado en el historial."
                    required
                  >
                    <input :id="id" v-model="credit.reason" name="reason" minlength="3" required />
                  </AdminFormField>
                </form>
                <template #footer>
                  <button type="submit" :form="`${prefix}-credit`" class="adm-btn adm-btn--primary">
                    Guardar condiciones
                  </button>
                </template>
              </AdminCard>

              <AdminCard title="Tarifa asignada">
                <form :id="`${prefix}-assignment`" class="adm-stack" @submit.prevent="saveAssignment()">
                  <AdminFormField v-slot="{ id }" label="Tarifa" required>
                    <select :id="id" v-model="assignment.priceListId" required>
                      <option value="">Selecciona una tarifa</option>
                      <option v-for="tariff in priceLists" :key="tariff.id" :value="tariff.id">
                        {{ tariff.name }}
                      </option>
                    </select>
                  </AdminFormField>
                  <div class="adm-form-grid">
                    <AdminFormField
                      v-slot="{ id }"
                      label="Válida desde"
                      help="Fecha y hora universal, como 2026-01-01T00:00:00Z"
                      required
                    >
                      <input :id="id" v-model="assignment.validFrom" required />
                    </AdminFormField>
                    <AdminFormField v-slot="{ id }" label="Válida hasta" help="Opcional. Mismo formato.">
                      <input :id="id" v-model="assignment.validUntil" />
                    </AdminFormField>
                  </div>
                  <AdminFormField v-slot="{ id }" label="Motivo" help="Queda guardado en el historial." required>
                    <input :id="id" v-model="assignment.reason" minlength="3" required />
                  </AdminFormField>
                </form>
                <template #footer>
                  <button
                    v-if="currentCompany.assignmentActive === 1"
                    type="button"
                    class="adm-btn adm-btn--danger-soft"
                    @click="removeOpen = true"
                  >
                    Retirar tarifa
                  </button>
                  <button type="submit" :form="`${prefix}-assignment`" class="adm-btn adm-btn--secondary">
                    Asignar tarifa
                  </button>
                </template>
              </AdminCard>
            </div>
          </template>
        </div>

        <div v-show="tab === 'tarifas'">
          <AdminCard title="Tarifas profesionales" description="Precios especiales y descuentos para empresas.">
            <template #actions>
              <label :for="`${prefix}-list`" class="adm-label">Editar</label>
              <select :id="`${prefix}-list`" v-model="selectedList">
                <option value="">Nueva tarifa</option>
                <option v-for="tariff in priceLists" :key="tariff.id" :value="tariff.id">{{ tariff.name }}</option>
              </select>
            </template>
            <form :id="`${prefix}-tariff`" class="adm-stack" @submit.prevent="saveList">
              <div class="adm-form-grid">
                <AdminFormField v-slot="{ id }" label="Nombre" required>
                  <input :id="id" v-model="list.name" required />
                </AdminFormField>
                <AdminFormField v-slot="{ id }" label="Referencia" help="Nombre corto para identificarla." required>
                  <input :id="id" v-model="list.code" required />
                </AdminFormField>
                <AdminFormField v-slot="{ id }" label="Estado">
                  <select :id="id" v-model="list.status">
                    <option value="active">Activa</option>
                    <option value="inactive">Inactiva</option>
                  </select>
                </AdminFormField>
                <AdminFormField
                  v-slot="{ id }"
                  label="Válida desde"
                  help="Fecha y hora universal, como 2026-01-01T00:00:00Z"
                  required
                >
                  <input :id="id" v-model="list.validFrom" required placeholder="2026-01-01T00:00:00Z" />
                </AdminFormField>
                <AdminFormField v-slot="{ id }" label="Válida hasta" help="Opcional. Mismo formato.">
                  <input :id="id" v-model="list.validUntil" />
                </AdminFormField>
              </div>

              <AdminSection title="Precios por producto" description="Precio fijo con IVA para una variante concreta.">
                <template #actions>
                  <button
                    type="button"
                    class="adm-btn adm-btn--secondary adm-btn--sm"
                    @click="list.variantRules.push({ variantId: '', unitGrossCents: 1 })"
                  >
                    Añadir precio
                  </button>
                </template>
                <p v-if="!list.variantRules.length" class="adm-help">Esta tarifa no tiene precios por producto.</p>
                <div
                  v-for="(rule, index) in list.variantRules"
                  :key="index"
                  class="mb-3 flex flex-wrap items-end gap-3"
                >
                  <AdminFormField v-slot="{ id }" label="Identificador de la variante" class="min-w-0 flex-1">
                    <input :id="id" v-model="rule.variantId" required />
                  </AdminFormField>
                  <AdminFormField
                    v-slot="{ id }"
                    :label="`Precio en céntimos (${adminMoney(Number(rule.unitGrossCents) || 0)})`"
                  >
                    <input :id="id" v-model.number="rule.unitGrossCents" type="number" min="1" required />
                  </AdminFormField>
                  <button
                    type="button"
                    class="adm-btn adm-btn--ghost"
                    aria-label="Quitar variante"
                    title="Quitar variante"
                    @click="list.variantRules.splice(index, 1)"
                  >
                    <UIcon name="i-lucide-trash-2" class="size-4" />
                  </button>
                </div>
              </AdminSection>

              <AdminSection
                title="Descuentos por categoría"
                description="Descuento sobre el precio normal de toda una categoría."
              >
                <template #actions>
                  <button
                    type="button"
                    class="adm-btn adm-btn--secondary adm-btn--sm"
                    @click="list.categoryRules.push({ categoryId: '', discountBps: 0 })"
                  >
                    Añadir descuento
                  </button>
                </template>
                <p v-if="!list.categoryRules.length" class="adm-help">Esta tarifa no tiene descuentos por categoría.</p>
                <div
                  v-for="(rule, index) in list.categoryRules"
                  :key="index"
                  class="mb-3 flex flex-wrap items-end gap-3"
                >
                  <AdminFormField v-slot="{ id }" label="Identificador de la categoría" class="min-w-0 flex-1">
                    <input :id="id" v-model="rule.categoryId" required />
                  </AdminFormField>
                  <AdminFormField
                    v-slot="{ id }"
                    :label="`Descuento en centésimas de % (${(Number(rule.discountBps) || 0) / 100} %)`"
                  >
                    <input :id="id" v-model.number="rule.discountBps" type="number" min="0" max="9500" required />
                  </AdminFormField>
                  <button
                    type="button"
                    class="adm-btn adm-btn--ghost"
                    aria-label="Quitar categoría"
                    title="Quitar categoría"
                    @click="list.categoryRules.splice(index, 1)"
                  >
                    <UIcon name="i-lucide-trash-2" class="size-4" />
                  </button>
                </div>
              </AdminSection>

              <AdminFormField v-slot="{ id }" label="Motivo" help="Queda guardado en el historial." required>
                <input :id="id" v-model="list.reason" minlength="3" required />
              </AdminFormField>
            </form>
            <template #footer>
              <button type="submit" :form="`${prefix}-tariff`" class="adm-btn adm-btn--primary">Guardar tarifa</button>
            </template>
          </AdminCard>
        </div>

        <section v-show="tab === 'transferencias'" aria-label="Conciliación de transferencias">
          <AdminCard
            title="Transferencias de pedidos a crédito"
            description="Pedidos de empresas pendientes de cobro por transferencia."
          >
            <template #actions>
              <button
                type="button"
                data-test="load-transfers"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                @click="loadTransfers()"
              >
                {{ transfersLoaded ? 'Actualizar' : 'Ver transferencias pendientes' }}
              </button>
            </template>
            <AdminEmptyState
              v-if="!transfersLoaded"
              compact
              icon="i-lucide-landmark"
              title="Todavía no se han consultado"
              description="Pulsa «Ver transferencias pendientes» para cargarlas."
            />
            <UAlert
              v-else-if="!transfersEnabled"
              color="warning"
              variant="subtle"
              icon="i-lucide-info"
              title="Aún no disponible"
              description="La conciliación real de transferencias bancarias todavía no está disponible; solo existe una simulación en el entorno de pruebas."
            />
            <div v-else class="adm-stack">
              <UAlert
                color="warning"
                variant="subtle"
                icon="i-lucide-flask-conical"
                title="Simulación local"
                description="No se registra ningún cobro real ni se modifica ningún pedido."
              />
              <AdminEmptyState
                v-if="!transfers.length"
                compact
                title="No hay pedidos a crédito pendientes de transferencia"
              />
              <form v-else data-test="transfer-form" class="adm-stack" @submit.prevent="reconcileTransfer">
                <AdminFormField v-slot="{ id }" label="Pedido" required>
                  <select :id="id" v-model="transfer.orderId" name="transfer-order" required>
                    <option value="">Selecciona un pedido</option>
                    <option v-for="order in transfers" :key="order.orderId" :value="order.orderId">
                      {{ order.companyName }} · pendiente {{ adminMoney(order.simulatedOutstandingCents) }}
                    </option>
                  </select>
                </AdminFormField>
                <div class="adm-form-grid">
                  <AdminFormField
                    v-slot="{ id }"
                    label="Importe (en céntimos)"
                    :help="`Equivale a ${adminMoney(Number(transfer.amountCents) || 0)}`"
                    required
                  >
                    <input
                      :id="id"
                      v-model="transfer.amountCents"
                      name="transfer-amount"
                      type="number"
                      min="1"
                      step="1"
                      required
                    />
                  </AdminFormField>
                  <AdminFormField v-slot="{ id }" label="Referencia bancaria" required>
                    <input :id="id" v-model="transfer.bankReference" name="transfer-reference" required />
                  </AdminFormField>
                </div>
                <AdminFormField v-slot="{ id }" label="Motivo" required>
                  <input :id="id" v-model="transfer.reason" name="transfer-reason" minlength="3" required />
                </AdminFormField>
                <div>
                  <button type="submit" class="adm-btn adm-btn--primary">Simular conciliación</button>
                </div>
              </form>
            </div>
          </AdminCard>
        </section>
      </fieldset>

      <AdminConfirm
        v-model:open="removeOpen"
        title="Retirar tarifa"
        :description="`${currentCompany?.legalName ?? 'La empresa'} volverá a los precios normales. Se usará el motivo escrito en el formulario.`"
        confirm-label="Retirar tarifa"
        danger
        @confirm="confirmRemove"
      />
    </template>
  </section>
</template>
