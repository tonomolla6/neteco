<script setup lang="ts">
import type { ContentBlock } from '~~/server/utils/content-schema'
import CmsDraftEditor from '../../components/CmsDraftEditor.vue'
import AdminEditorialReview from '../../components/AdminEditorialReview.vue'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Contenido · Admin', robots: 'noindex, nofollow, noarchive' })
const runtime = useRuntimeConfig().public.serverRuntime
const cloudflare = runtime === 'cloudflare',
  node = runtime === 'node'
const { ready, loggedIn, user } = useUserSession()
const operatorId = computed(() => (typeof user.value?.id === 'string' ? user.value.id : ''))
const activeTab = ref('editor')
const TABS = [
  { value: 'editor', label: 'Páginas' },
  { value: 'review', label: 'Revisiones y aprobaciones' }
]
function authorizeCms() {
  return (
    cloudflare &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.mfaVerified === true &&
    catalogPolicyUuidSchema.safeParse(operatorId.value).success
  )
}

interface PageSummary {
  id: string
  slug: string
  title: string
  status: 'draft' | 'published' | 'hidden'
  draftVersion: number
  publishedVersion: number | null
  scheduledPublishAt: string | null
  scheduledUnpublishAt: string | null
  updatedAt: string
}
interface Version {
  id: string
  version: number
  blocks: ContentBlock[]
  seo: { title: string; description: string; noindex: boolean }
  changeSummary: string
  author: string
  createdAt: string
}
interface Detail extends PageSummary {
  draftVersionId: string
  publishedVersionId: string | null
  versions: Version[]
}

const { data, refresh } = await useFetch<{ pages: PageSummary[] }>('/api/admin/content/pages', {
  immediate: node,
  server: node
})
const pages = computed(() => data.value?.pages ?? [])

const PAGE_STATUS: Record<string, { label: string; tone: 'neutral' | 'warning' | 'success' }> = {
  draft: { label: 'Borrador', tone: 'warning' },
  published: { label: 'Publicada', tone: 'success' },
  hidden: { label: 'Oculta', tone: 'neutral' }
}
const STATUS_OPTIONS = [
  { value: 'all', label: 'Todas' },
  { value: 'published', label: 'Publicadas' },
  { value: 'draft', label: 'Borradores' },
  { value: 'hidden', label: 'Ocultas' }
]
const columns = [
  { key: 'title', label: 'Página', sortable: true },
  { key: 'status', label: 'Estado', sortable: true },
  { key: 'draftVersion', label: 'Versión', numeric: true, hideOnMobile: true },
  { key: 'updatedAt', label: 'Última modificación', sortable: true, hideOnMobile: true }
]
const search = ref(''),
  statusFilter = ref('all'),
  drawerOpen = ref(false),
  drawerTab = ref('content')
const DRAWER_TABS = [
  { value: 'content', label: 'Contenido' },
  { value: 'schedule', label: 'Programación' },
  { value: 'history', label: 'Historial' }
]
const visiblePages = computed(() => {
  const term = search.value.toLowerCase()
  return pages.value.filter(
    (page) =>
      (statusFilter.value === 'all' || page.status === statusFilter.value) &&
      (!term || page.title.toLowerCase().includes(term) || page.slug.toLowerCase().includes(term))
  )
})
function clearFilters() {
  search.value = ''
  statusFilter.value = 'all'
}
const selected = ref<Detail | null>(null)
const creating = ref(false)
const saving = ref(false)
const toast = useToast()
const form = reactive({
  title: '',
  slug: '',
  seoTitle: '',
  seoDescription: '',
  noindex: false,
  changeSummary: '',
  blocksJson: ''
})
const scheduleForm = reactive({ publishAtLocal: '', unpublishAtLocal: '', reason: '' })

function madridLocalInput(instant: string | null) {
  if (!instant) return ''
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Madrid',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

function defaultBlocks(): ContentBlock[] {
  return [{ id: randomId(), type: 'paragraph', text: 'Escribe aquí el contenido.' }]
}

function populate(version?: Version) {
  const page = selected.value
  form.title = page?.title ?? ''
  form.slug = page?.slug ?? ''
  form.seoTitle = version?.seo.title ?? page?.title ?? ''
  form.seoDescription = version?.seo.description ?? ''
  form.noindex = version?.seo.noindex ?? false
  form.changeSummary = ''
  form.blocksJson = JSON.stringify(version?.blocks ?? defaultBlocks(), null, 2)
}

async function load(page: PageSummary) {
  if (!node) return
  selected.value = await $fetch<Detail>(`/api/admin/content/pages/${page.id}`)
  creating.value = false
  populate(selected.value.versions.find((version) => version.id === selected.value?.draftVersionId))
  scheduleForm.publishAtLocal = madridLocalInput(selected.value.scheduledPublishAt)
  scheduleForm.unpublishAtLocal = madridLocalInput(selected.value.scheduledUnpublishAt)
  scheduleForm.reason = ''
}
async function openPage(page: PageSummary) {
  try {
    await load(page)
    drawerTab.value = 'content'
    drawerOpen.value = true
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido abrir la página'), color: 'error' })
  }
}

function createNew() {
  if (!node) return
  selected.value = null
  creating.value = true
  populate()
  drawerTab.value = 'content'
  drawerOpen.value = true
}

// Texto sencillo: una página hecha solo de párrafos se edita como texto corrido y se guarda como bloques.
const plainText = ref(''),
  plainEditable = ref(true)
let plainWriting = false
function plainBlocks() {
  try {
    const parsed: unknown = JSON.parse(form.blocksJson)
    if (!Array.isArray(parsed)) return null
    const blocks: Array<{ id: string; type: 'paragraph'; text: string }> = []
    for (const entry of parsed as unknown[]) {
      if (!entry || typeof entry !== 'object') return null
      const { id, type, text, ...rest } = entry as Record<string, unknown>
      if (type !== 'paragraph' || typeof id !== 'string' || typeof text !== 'string' || Object.keys(rest).length)
        return null
      blocks.push({ id, type, text })
    }
    return blocks
  } catch {
    return null
  }
}
watch(
  () => form.blocksJson,
  () => {
    if (plainWriting) return
    const blocks = plainBlocks()
    plainEditable.value = blocks !== null
    plainText.value = blocks?.map((block) => block.text).join('\n\n') ?? ''
  },
  { flush: 'sync' }
)
function setPlainText(event: Event) {
  const value = (event.target as HTMLTextAreaElement).value,
    previous = plainBlocks() ?? []
  plainText.value = value
  plainWriting = true
  form.blocksJson = JSON.stringify(
    value
      .split(/\n\s*\n/)
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text, index) => ({ id: previous[index]?.id ?? randomId(), type: 'paragraph', text })),
    null,
    2
  )
  plainWriting = false
}

function parsedBlocks() {
  const blocks = JSON.parse(form.blocksJson) as unknown
  if (!Array.isArray(blocks)) throw new Error('El contenido avanzado debe ser una lista de bloques')
  return blocks
}

async function save() {
  if (!node) return
  saving.value = true
  try {
    const body = {
      title: form.title,
      slug: form.slug,
      blocks: parsedBlocks(),
      seo: { title: form.seoTitle, description: form.seoDescription, noindex: form.noindex },
      changeSummary: form.changeSummary
    }
    if (creating.value) {
      const created = await $fetch<{ id: string }>('/api/admin/content/pages', { method: 'POST', body })
      await refresh()
      const page = pages.value.find((item) => item.id === created.id)
      if (page) await load(page)
    } else if (selected.value) {
      await $fetch(`/api/admin/content/pages/${selected.value.id}`, { method: 'PUT', body })
      await refresh()
      await load({ ...selected.value })
    }
    toast.add({ title: 'Nueva versión guardada', color: 'success', icon: 'i-lucide-check' })
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'Revisa los bloques de contenido y los campos'), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function publish() {
  if (!node) return
  if (!selected.value) return
  await $fetch(`/api/admin/content/pages/${selected.value.id}/publish`, {
    method: 'POST',
    body: { reason: 'Publicación editorial aprobada desde el CMS' }
  })
  await refresh()
  await load({ ...selected.value })
  toast.add({ title: 'Página publicada', color: 'success' })
}

async function schedulePublication() {
  if (!node) return
  if (!selected.value) return
  saving.value = true
  try {
    await $fetch(`/api/admin/content/pages/${selected.value.id}/schedule`, {
      method: 'POST',
      body: {
        publishAtLocal: scheduleForm.publishAtLocal || null,
        unpublishAtLocal: scheduleForm.unpublishAtLocal || null,
        repeatedHour: 'later',
        reason: scheduleForm.reason
      }
    })
    await refresh()
    await load({ ...selected.value })
    toast.add({ title: 'Programación guardada', color: 'success' })
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido actualizar el calendario'), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function preview() {
  if (!node) return
  if (!selected.value) return
  const result = await $fetch<{ url: string }>(`/api/admin/content/pages/${selected.value.id}/preview`, {
    method: 'POST',
    body: { segment: 'default', device: 'responsive' }
  })
  window.open(result.url, '_blank', 'noopener,noreferrer')
}

async function rollback(version: Version) {
  if (!node) return
  if (!selected.value) return
  await $fetch(`/api/admin/content/pages/${selected.value.id}/rollback`, {
    method: 'POST',
    body: { versionId: version.id, reason: `Rollback editorial desde versión ${version.version}` }
  })
  await refresh()
  await load({ ...selected.value })
  toast.add({ title: 'Versión restaurada como borrador nuevo', color: 'success' })
}
const rollbackTarget = ref<Version | null>(null)
const confirmRollback = computed({
  get: () => rollbackTarget.value !== null,
  set: (open: boolean) => {
    if (!open) rollbackTarget.value = null
  }
})
async function confirmRollbackNow() {
  const version = rollbackTarget.value
  rollbackTarget.value = null
  if (!version) return
  try {
    await rollback(version)
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido restaurar la versión'), color: 'error' })
  }
}
</script>

<template>
  <AdminPage
    :count="node ? pages.length : undefined"
    :count-label="node ? (pages.length === 1 ? 'página' : 'páginas') : undefined"
  >
    <template v-if="node" #actions>
      <AdminButton variant="primary" icon="i-lucide-plus" @click="createNew">Nueva página</AdminButton>
    </template>
    <div class="adm-stack">
      <AdminTabs v-model="activeTab" :tabs="TABS" label="Apartados de contenido" />

      <AdminEditorialReview v-if="activeTab === 'review'" :operator-id="operatorId" :page-id="selected?.id" />

      <CmsDraftEditor
        v-if="cloudflare"
        v-show="activeTab === 'editor'"
        :runtime="runtime"
        :operator-id="operatorId"
        :authorize="authorizeCms"
        :second-factor-missing="ready === true && loggedIn === true && user?.mfaVerified !== true"
        :header-actions="activeTab === 'editor'"
      />
      <UAlert
        v-else-if="!node"
        v-show="activeTab === 'editor'"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="El contenido no está disponible ahora mismo"
        description="No se ha podido confirmar la configuración de la tienda, así que no se permite consultar ni cambiar páginas."
      />
      <AdminTable
        v-else
        v-show="activeTab === 'editor'"
        :rows="visiblePages"
        :columns="columns"
        :row-key="(page) => page.id"
        :filtered="!!search || statusFilter !== 'all'"
        empty-icon="i-lucide-panels-top-left"
        empty-title="Todavía no hay páginas de contenido"
        empty-description="Son las páginas que no son catálogo: quiénes somos, condiciones, guías de uso o una campaña. Cada versión queda guardada."
        @row-click="openPage"
        @clear-filters="clearFilters"
      >
        <template #toolbar>
          <AdminToolbar v-model:search="search" placeholder="Buscar por título o dirección…">
            <AdminFilters v-model="statusFilter" :options="STATUS_OPTIONS" label="Filtrar por estado" />
          </AdminToolbar>
        </template>
        <template #cell-title="{ row }">
          <button
            type="button"
            class="text-left font-semibold text-[var(--text-strong)] hover:underline"
            @click="openPage(row)"
          >
            {{ row.title }}
          </button>
          <p class="adm-help break-all">/{{ row.slug }}</p>
        </template>
        <template #cell-status="{ row }">
          <AdminBadge :tone="PAGE_STATUS[row.status]?.tone ?? 'neutral'">
            {{ PAGE_STATUS[row.status]?.label ?? adminStatusLabel(row.status) }}
          </AdminBadge>
        </template>
        <template #cell-updatedAt="{ row }">{{ adminDate(row.updatedAt, true) }}</template>
        <template #empty-action>
          <AdminButton variant="primary" icon="i-lucide-plus" @click="createNew">Crear la primera página</AdminButton>
        </template>
      </AdminTable>
    </div>

    <AdminDrawer v-model:open="drawerOpen" :title="creating ? 'Nueva página' : (selected?.title ?? 'Página')" wide>
      <div class="adm-stack">
        <AdminTabs v-if="selected" v-model="drawerTab" :tabs="DRAWER_TABS" label="Apartados de la página" />

        <form
          v-show="drawerTab === 'content' || !selected"
          id="content-page-form"
          class="adm-stack"
          @submit.prevent="save"
        >
          <div class="adm-form-grid">
            <AdminFormField v-slot="{ id }" label="Título" required>
              <input :id="id" v-model="form.title" type="text" required />
            </AdminFormField>
            <AdminFormField
              v-slot="{ id }"
              label="Dirección de la página"
              help="Minúsculas, números y guiones. Ejemplo: quienes-somos"
              required
            >
              <input :id="id" v-model="form.slug" type="text" required />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Título en buscadores">
              <input :id="id" v-model="form.seoTitle" type="text" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Descripción en buscadores">
              <input :id="id" v-model="form.seoDescription" type="text" />
            </AdminFormField>
          </div>
          <label class="adm-check">
            <input v-model="form.noindex" type="checkbox" />
            Pedir a los buscadores que no muestren la página publicada
          </label>
          <AdminFormField
            v-if="plainEditable"
            v-slot="{ id }"
            label="Texto de la página"
            help="Deja una línea en blanco entre párrafos."
          >
            <textarea :id="id" :value="plainText" rows="10" @input="setPlainText" />
          </AdminFormField>
          <p v-else class="adm-help">
            Esta página combina encabezados, listas, imágenes o avisos. De momento ese contenido se edita en el apartado
            «Avanzado».
          </p>
          <details :open="!plainEditable">
            <summary class="adm-label cursor-pointer">Avanzado</summary>
            <AdminFormField
              v-slot="{ id }"
              class="mt-3"
              label="Bloques de contenido"
              help="Lista de bloques en formato técnico: encabezado, párrafo, lista, imagen, aviso destacado o enlace. No admite código."
            >
              <textarea :id="id" v-model="form.blocksJson" rows="14" class="font-mono text-xs" />
            </AdminFormField>
          </details>
          <AdminFormField v-slot="{ id }" label="Resumen del cambio">
            <input :id="id" v-model="form.changeSummary" type="text" placeholder="Qué cambia y por qué" />
          </AdminFormField>
          <div v-if="selected" class="flex flex-wrap gap-2">
            <AdminButton icon="i-lucide-eye" @click="preview">Vista previa (30 minutos)</AdminButton>
            <AdminButton icon="i-lucide-send" @click="publish">Publicar el borrador</AdminButton>
          </div>
        </form>

        <form v-if="selected" v-show="drawerTab === 'schedule'" class="adm-stack" @submit.prevent="schedulePublication">
          <p class="adm-help">
            Fechas en horario peninsular. La noche del cambio de hora de otoño se aplica la segunda vez que se repite la
            hora.
          </p>
          <div class="adm-form-grid">
            <AdminFormField v-slot="{ id }" label="Publicar el">
              <input :id="id" v-model="scheduleForm.publishAtLocal" type="datetime-local" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Retirar el">
              <input :id="id" v-model="scheduleForm.unpublishAtLocal" type="datetime-local" />
            </AdminFormField>
          </div>
          <AdminFormField v-slot="{ id }" label="Motivo" required>
            <input :id="id" v-model="scheduleForm.reason" type="text" required minlength="3" />
          </AdminFormField>
          <div>
            <AdminButton type="submit" icon="i-lucide-calendar-clock" :loading="saving">
              Guardar programación
            </AdminButton>
          </div>
        </form>

        <div v-if="selected" v-show="drawerTab === 'history'">
          <p class="adm-help mb-3">Cada guardado crea una versión nueva; las anteriores no se modifican.</p>
          <ul class="adm-list">
            <li v-for="version in selected.versions" :key="version.id" class="flex-wrap">
              <span class="adm-list__index">{{ version.version }}</span>
              <div class="min-w-0 flex-1">
                <p class="adm-list__title">{{ version.changeSummary }}</p>
                <p class="adm-help">{{ version.author }} · {{ adminDate(version.createdAt, true) }}</p>
              </div>
              <AdminButton size="sm" icon="i-lucide-history" @click="rollbackTarget = version"> Restaurar </AdminButton>
            </li>
          </ul>
        </div>
      </div>
      <template #footer>
        <AdminButton @click="drawerOpen = false">Cerrar</AdminButton>
        <AdminButton
          v-if="drawerTab === 'content' || !selected"
          variant="primary"
          type="submit"
          form="content-page-form"
          icon="i-lucide-save"
          :loading="saving"
        >
          Guardar versión nueva
        </AdminButton>
      </template>
    </AdminDrawer>

    <AdminConfirm
      v-model:open="confirmRollback"
      title="Restaurar esta versión"
      :description="`Se creará un borrador nuevo con el contenido de la versión ${rollbackTarget?.version ?? ''}. No se publica hasta que lo decidas.`"
      confirm-label="Restaurar"
      @confirm="confirmRollbackNow"
    />
  </AdminPage>
</template>
