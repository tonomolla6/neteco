<script setup lang="ts" generic="T extends Record<string, any>">
/**
 * Tabla única del panel: cabecera fija, ordenación, selección, carga, vacío, error y
 * paginación. Si no se da `total`, ordena y pagina en cliente sobre `rows`.
 * En móvil cada fila se pinta como una ficha con las columnas no ocultas.
 */
export interface AdminColumn<Row> {
  key: string
  label: string
  numeric?: boolean
  sortable?: boolean
  hideOnMobile?: boolean
  /** Anchura fija opcional (p. ej. '8rem'). */
  width?: string
  /** Columna secundaria: empieza oculta y se activa desde «Columnas». */
  secondary?: boolean
  /** El contenido puede ocupar varias líneas (nombres largos); el resto de celdas cortas no salta. */
  wrap?: boolean
  value?: (row: Row) => unknown
}

const props = withDefaults(
  defineProps<{
    rows: T[]
    columns: AdminColumn<T>[]
    rowKey: (row: T) => string
    status?: 'idle' | 'pending' | 'success' | 'error'
    /** Total de servidor: activa la paginación y la ordenación remotas. */
    total?: number
    perPage?: number
    selectable?: boolean
    /** Hace clicable la fila completa. */
    rowTo?: (row: T) => string | undefined
    emptyTitle?: string
    emptyDescription?: string
    emptyIcon?: string
    /** Indica que el vacío se debe a la búsqueda o a un filtro activo. */
    filtered?: boolean
    errorMessage?: string
    caption?: string
    /** Selector «Columnas»: por defecto aparece con seis o más columnas o si alguna es secundaria. */
    columnPicker?: boolean
    /** Clave para recordar en este navegador las columnas elegidas (por defecto, la ruta). */
    columnsKey?: string
  }>(),
  {
    status: 'idle',
    total: undefined,
    perPage: 25,
    selectable: false,
    rowTo: undefined,
    emptyTitle: 'Todavía no hay nada aquí',
    emptyDescription: undefined,
    emptyIcon: 'i-lucide-inbox',
    filtered: false,
    errorMessage: 'No hemos podido cargar estos datos. Vuelve a intentarlo.',
    caption: undefined,
    columnPicker: undefined,
    columnsKey: undefined
  }
)
const emit = defineEmits<{
  sort: [{ key: string; direction: 'asc' | 'desc' }]
  retry: []
  'clear-filters': []
  'row-click': [T]
}>()
const page = defineModel<number>('page', { default: 1 })
const selected = defineModel<string[]>('selected', { default: () => [] })
const sortKey = defineModel<string>('sortKey', { default: '' })
const sortDir = defineModel<'asc' | 'desc'>('sortDir', { default: 'asc' })

const remote = computed(() => props.total !== undefined)

// Columnas visibles: las secundarias empiezan ocultas; la elección se recuerda por pantalla.
const route = useRoute()
const storageKey = computed(() => 'neteco-admin-columns:' + (props.columnsKey ?? route.path))
const hidden = ref<string[]>([])
hidden.value = props.columns.filter((column) => column.secondary).map((column) => column.key)
const defaultHidden = () => props.columns.filter((column) => column.secondary).map((column) => column.key)
function restoreColumns() {
  hidden.value = defaultHidden()
  if (!import.meta.client) return
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(storageKey.value) ?? 'null')
    if (Array.isArray(saved)) hidden.value = saved.filter((key): key is string => typeof key === 'string')
  } catch {
    // Sin almacenamiento disponible se usan las columnas por defecto.
  }
}
onMounted(restoreColumns)
watch(storageKey, restoreColumns)
const shown = computed(() => {
  const list = props.columns.filter((column) => !hidden.value.includes(column.key))
  return list.length ? list : props.columns.slice(0, 1)
})
const pickable = computed(
  () => props.columnPicker ?? (props.columns.length >= 6 || props.columns.some((column) => column.secondary))
)
function toggleColumn(key: string) {
  const next = hidden.value.includes(key) ? hidden.value.filter((entry) => entry !== key) : [...hidden.value, key]
  if (next.length >= props.columns.length) return
  hidden.value = next
  try {
    window.localStorage.setItem(storageKey.value, JSON.stringify(next))
  } catch {
    // La elección vale para esta visita aunque no se pueda guardar.
  }
}
function cell(row: T, column: AdminColumn<T>): unknown {
  return column.value ? column.value(row) : row[column.key]
}
function toggleSort(column: AdminColumn<T>) {
  if (!column.sortable) return
  if (sortKey.value === column.key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else {
    sortKey.value = column.key
    sortDir.value = column.numeric ? 'desc' : 'asc'
  }
  page.value = 1
  emit('sort', { key: sortKey.value, direction: sortDir.value })
}
const sorted = computed(() => {
  const column = props.columns.find((entry) => entry.key === sortKey.value)
  if (remote.value || !column) return props.rows
  const factor = sortDir.value === 'asc' ? 1 : -1
  return [...props.rows].sort((a, b) => {
    const left = cell(a, column),
      right = cell(b, column)
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor
    return String(left ?? '').localeCompare(String(right ?? ''), 'es', { numeric: true }) * factor
  })
})
const totalRows = computed(() => props.total ?? props.rows.length)
const pageCount = computed(() => Math.max(1, Math.ceil(totalRows.value / props.perPage)))
const visible = computed(() =>
  remote.value ? sorted.value : sorted.value.slice((page.value - 1) * props.perPage, page.value * props.perPage)
)
watch(pageCount, (count) => {
  if (page.value > count) page.value = count
})
const from = computed(() => (totalRows.value ? (page.value - 1) * props.perPage + 1 : 0))
const to = computed(() => Math.min(page.value * props.perPage, totalRows.value))
const allSelected = computed(
  () => visible.value.length > 0 && visible.value.every((row) => selected.value.includes(props.rowKey(row)))
)
function toggleAll() {
  const keys = visible.value.map((row) => props.rowKey(row))
  selected.value = allSelected.value
    ? selected.value.filter((key) => !keys.includes(key))
    : [...new Set([...selected.value, ...keys])]
}
function toggleRow(key: string) {
  selected.value = selected.value.includes(key)
    ? selected.value.filter((entry) => entry !== key)
    : [...selected.value, key]
}
const router = useRouter()
function open(row: T, event: MouseEvent) {
  if ((event.target as HTMLElement).closest('a,button,input,label,select,[role=menuitem]')) return
  emit('row-click', row)
  const target = props.rowTo?.(row)
  if (target) void router.push(target)
}
const mobileColumns = computed(() => shown.value.filter((column) => !column.hideOnMobile))
</script>

<template>
  <div class="adm-card adm-tablecard">
    <div
      v-if="$slots.toolbar || pickable || (selectable && selected.length)"
      class="adm-tablecard__bar adm-tablecard__bar--split"
    >
      <div v-if="selectable && selected.length" class="adm-toolbar">
        <p class="font-semibold text-[var(--text-strong)]">
          {{ selected.length }} seleccionado{{ selected.length === 1 ? '' : 's' }}
        </p>
        <slot name="bulk" :selected="selected" />
        <div class="adm-toolbar__end">
          <AdminButton variant="ghost" size="sm" @click="selected = []">Quitar selección</AdminButton>
        </div>
      </div>
      <div v-else><slot name="toolbar" /></div>
      <UPopover v-if="pickable && rows.length" :content="{ align: 'end' }">
        <AdminButton icon="i-lucide-columns-3" class="hidden md:inline-flex">Columnas</AdminButton>
        <template #content>
          <fieldset class="adm-columns">
            <legend class="adm-label">Columnas visibles</legend>
            <label v-for="column in columns" :key="column.key" class="adm-check">
              <input
                type="checkbox"
                :checked="!hidden.includes(column.key)"
                :disabled="shown.length === 1 && !hidden.includes(column.key)"
                @change="toggleColumn(column.key)"
              />
              <span>{{ column.label }}</span>
            </label>
          </fieldset>
        </template>
      </UPopover>
    </div>

    <div v-if="status === 'pending' && !rows.length" class="adm-table-skeleton" aria-busy="true">
      <span class="sr-only">Cargando…</span>
      <div v-for="row in 6" :key="row"><i /><i /><i /><i /></div>
    </div>

    <AdminEmptyState
      v-else-if="status === 'error'"
      variant="error"
      title="No se han podido cargar los datos"
      :description="errorMessage"
    >
      <AdminButton icon="i-lucide-rotate-cw" @click="emit('retry')">Reintentar</AdminButton>
    </AdminEmptyState>

    <AdminEmptyState
      v-else-if="!rows.length"
      :variant="filtered ? 'filtered' : 'empty'"
      :icon="emptyIcon"
      :title="filtered ? 'Ningún resultado con estos filtros' : emptyTitle"
      :description="filtered ? 'Prueba con otra búsqueda o quita algún filtro.' : emptyDescription"
    >
      <AdminButton v-if="filtered" @click="emit('clear-filters')">Quitar filtros</AdminButton>
      <slot v-else name="empty-action" />
    </AdminEmptyState>

    <template v-else>
      <div class="adm-table-wrap hidden md:block" :aria-busy="status === 'pending'">
        <table class="adm-table">
          <caption v-if="caption" class="sr-only">
            {{
              caption
            }}
          </caption>
          <thead>
            <tr>
              <th v-if="selectable" scope="col" style="width: 2.5rem">
                <input
                  type="checkbox"
                  :checked="allSelected"
                  aria-label="Seleccionar todas las filas"
                  @change="toggleAll"
                />
              </th>
              <th
                v-for="column in shown"
                :key="column.key"
                scope="col"
                :data-numeric="column.numeric ? '' : undefined"
                :style="column.width ? { width: column.width } : undefined"
                :aria-sort="sortKey === column.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined"
              >
                <button v-if="column.sortable" type="button" @click="toggleSort(column)">
                  {{ column.label }}
                  <UIcon
                    :name="
                      sortKey !== column.key
                        ? 'i-lucide-chevrons-up-down'
                        : sortDir === 'asc'
                          ? 'i-lucide-arrow-up'
                          : 'i-lucide-arrow-down'
                    "
                    class="size-3.5"
                    :class="sortKey !== column.key && 'opacity-50'"
                  />
                </button>
                <template v-else>{{ column.label }}</template>
              </th>
              <th v-if="$slots.actions" scope="col" data-numeric><span class="sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in visible"
              :key="rowKey(row)"
              :class="rowTo && 'cursor-pointer'"
              :data-selected="selected.includes(rowKey(row)) || undefined"
              @click="open(row, $event)"
            >
              <td v-if="selectable">
                <input
                  type="checkbox"
                  :checked="selected.includes(rowKey(row))"
                  aria-label="Seleccionar fila"
                  @change="toggleRow(rowKey(row))"
                />
              </td>
              <td
                v-for="column in shown"
                :key="column.key"
                :data-numeric="column.numeric ? '' : undefined"
                :class="column.wrap ? 'adm-table__main' : undefined"
              >
                <slot :name="`cell-${column.key}`" :row="row" :value="cell(row, column)">
                  {{ cell(row, column) ?? '—' }}
                </slot>
              </td>
              <td v-if="$slots.actions" data-numeric class="adm-table__actions">
                <slot name="actions" :row="row" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <ul class="adm-table-cards md:hidden">
        <li v-for="row in visible" :key="rowKey(row)" @click="open(row, $event)">
          <label v-if="selectable" class="adm-table-cards__check">
            <input type="checkbox" :checked="selected.includes(rowKey(row))" @change="toggleRow(rowKey(row))" />
            <span class="sr-only">Seleccionar</span>
          </label>
          <dl>
            <div v-for="column in mobileColumns" :key="column.key">
              <dt>{{ column.label }}</dt>
              <dd>
                <slot :name="`cell-${column.key}`" :row="row" :value="cell(row, column)">
                  {{ cell(row, column) ?? '—' }}
                </slot>
              </dd>
            </div>
          </dl>
          <div v-if="$slots.actions" class="adm-table-cards__actions">
            <slot name="actions" :row="row" />
          </div>
        </li>
      </ul>

      <div class="adm-pagination">
        <p>
          <template v-if="totalRows > perPage">{{ from }}–{{ to }} de {{ totalRows }}</template>
          <template v-else>{{ totalRows }} {{ totalRows === 1 ? 'resultado' : 'resultados' }}</template>
        </p>
        <div v-if="pageCount > 1" class="flex items-center gap-2">
          <AdminButton size="sm" icon="i-lucide-chevron-left" :disabled="page <= 1" @click="page--">
            Anterior
          </AdminButton>
          <span class="tabular-nums">Página {{ page }} de {{ pageCount }}</span>
          <AdminButton size="sm" :disabled="page >= pageCount" @click="page++">
            Siguiente<UIcon name="i-lucide-chevron-right" class="size-4" />
          </AdminButton>
        </div>
      </div>
    </template>
  </div>
</template>
