<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AdminRecurringIncentivesPanel from '~/components/AdminRecurringIncentivesPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Incentivos por recurrencia B2B · Admin', robots: 'noindex, nofollow, noarchive' })

/** Lo que esta pantalla necesita de cada empresa del listado de clientes profesionales. */
interface CompanyOption {
  id: string
  legalName: string
  tradeName?: string | null
  taxId?: string | null
  status?: string
}
/** El listado llega paginado (`items`, `total`) o, en el servidor clásico, como `companies`. */
interface CompanyListResponse {
  items?: CompanyOption[]
  companies?: CompanyOption[]
  total?: number
}

const PER_PAGE = 50
const COMPANY_STATUS: Record<string, string> = {
  pending: 'en revisión',
  rejected: 'no aprobada',
  suspended: 'suspendida'
}

const requestFetch = useRequestFetch()
const listStatus = ref<'loading' | 'ready' | 'error'>('loading')
const companies = ref<CompanyOption[]>([])
const total = ref(0)
const search = ref('')
const appliedSearch = ref('')
const selectedId = ref('')
let sequence = 0

async function loadCompanies() {
  const current = ++sequence
  const term = search.value.trim().slice(0, 100)
  listStatus.value = 'loading'
  try {
    const res = await requestFetch<CompanyListResponse>('/api/admin/companies', {
      query: { ...(term ? { q: term } : {}), page: 1, perPage: PER_PAGE }
    })
    if (current !== sequence) return
    let list: CompanyOption[] = []
    if (Array.isArray(res.items)) {
      list = res.items
      total.value = typeof res.total === 'number' ? res.total : list.length
    } else if (Array.isArray(res.companies)) {
      // El servidor clásico devuelve todas las empresas sin filtrar: la búsqueda se aplica aquí.
      const needle = term.toLowerCase()
      list = res.companies.filter(
        (company) =>
          !needle ||
          [company.legalName, company.tradeName, company.taxId].some((value) =>
            (value ?? '').toLowerCase().includes(needle)
          )
      )
      total.value = list.length
    }
    companies.value = list
    appliedSearch.value = term
    if (!list.some((company) => company.id === selectedId.value)) selectedId.value = list[0]?.id ?? ''
    listStatus.value = 'ready'
  } catch {
    if (current === sequence) listStatus.value = 'error'
  }
}

let timer: ReturnType<typeof setTimeout> | undefined
watch(search, () => {
  clearTimeout(timer)
  timer = setTimeout(() => void loadCompanies(), 300)
})
onBeforeUnmount(() => clearTimeout(timer))

function companyLabel(company: CompanyOption): string {
  const name =
    company.tradeName && company.tradeName !== company.legalName
      ? `${company.legalName} (${company.tradeName})`
      : company.legalName
  const parts = [name]
  if (company.taxId) parts.push(company.taxId)
  const status = company.status ? COMPANY_STATUS[company.status] : undefined
  if (status) parts.push(status)
  return parts.join(' · ')
}

const selectedCompany = computed(() => companies.value.find((company) => company.id === selectedId.value) ?? null)
/** Sin búsqueda y sin resultados: de verdad no hay ninguna empresa dada de alta. */
const noCompanies = computed(() => listStatus.value === 'ready' && !companies.value.length && !appliedSearch.value)
const countHint = computed(() => {
  if (listStatus.value !== 'ready' || !companies.value.length) return ''
  if (total.value > companies.value.length)
    return `Se muestran ${companies.value.length} de ${total.value}: escribe para afinar`
  return companies.value.length === 1 ? '1 empresa' : `${companies.value.length} empresas`
})

onMounted(() => {
  void loadCompanies()
})
</script>

<template>
  <AdminPage>
    <div class="adm-stack">
      <AdminCard v-if="noCompanies">
        <AdminEmptyState
          icon="i-lucide-building-2"
          title="Todavía no hay empresas con cuenta"
          description="Los descuentos por compra recurrente se acuerdan con cada empresa cliente. Cuando una empresa se dé de alta y la apruebes, podrás consultar aquí su acuerdo."
        >
          <AdminButton to="/admin/clientes" icon="i-lucide-building-2">Ir a clientes profesionales</AdminButton>
        </AdminEmptyState>
      </AdminCard>

      <template v-else>
        <AdminCard>
          <div class="adm-toolbar">
            <label for="company-search" class="sr-only">Buscar empresa</label>
            <input
              id="company-search"
              v-model="search"
              type="search"
              class="adm-input w-auto min-w-0 flex-1 sm:max-w-xs"
              placeholder="Buscar empresa por nombre o NIF"
              maxlength="100"
              autocomplete="off"
            />
            <label for="company-picker" class="adm-label">Empresa</label>
            <select
              id="company-picker"
              v-model="selectedId"
              data-test="company-input"
              class="adm-input w-auto min-w-0 max-w-full flex-1"
              :disabled="listStatus !== 'ready' || !companies.length"
            >
              <option v-if="!companies.length" value="">
                {{ listStatus === 'loading' ? 'Cargando empresas…' : 'Sin empresas' }}
              </option>
              <option v-for="company in companies" :key="company.id" :value="company.id">
                {{ companyLabel(company) }}
              </option>
            </select>
            <span v-if="countHint" class="adm-help">{{ countHint }}</span>
          </div>
        </AdminCard>

        <AdminCard v-if="listStatus === 'error'">
          <div role="alert">
            <AdminEmptyState
              variant="error"
              title="No se han podido cargar las empresas"
              description="Puede ser un fallo puntual de conexión. Vuelve a intentarlo en unos segundos."
            >
              <AdminButton icon="i-lucide-rotate-cw" @click="loadCompanies()">Reintentar</AdminButton>
            </AdminEmptyState>
          </div>
        </AdminCard>

        <div
          v-else-if="listStatus === 'loading' && !selectedCompany"
          role="status"
          class="adm-card adm-table-skeleton"
          aria-busy="true"
        >
          <span class="sr-only">Cargando las empresas…</span>
          <div v-for="row in 3" :key="row"><i /><i /><i /></div>
        </div>

        <AdminCard v-else-if="!selectedCompany">
          <AdminEmptyState
            variant="filtered"
            title="Ninguna empresa coincide con la búsqueda"
            description="Prueba con otro nombre o con el NIF de la empresa."
          >
            <AdminButton icon="i-lucide-x" @click="search = ''">Quitar la búsqueda</AdminButton>
          </AdminEmptyState>
        </AdminCard>

        <AdminRecurringIncentivesPanel
          v-else
          :key="selectedCompany.id"
          :company-id="selectedCompany.id"
          :company-name="selectedCompany.legalName"
        />
      </template>
    </div>
  </AdminPage>
</template>
