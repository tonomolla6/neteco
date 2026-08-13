<script setup lang="ts">
import type { ContentBlock } from '~~/server/utils/content-schema'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Contenido · Admin' })

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

const { data, refresh } = await useFetch<{ pages: PageSummary[] }>('/api/admin/content/pages')
const pages = computed(() => data.value?.pages ?? [])
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
  return [{ id: crypto.randomUUID(), type: 'paragraph', text: 'Escribe aquí el contenido.' }]
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
  selected.value = await $fetch<Detail>(`/api/admin/content/pages/${page.id}`)
  creating.value = false
  populate(selected.value.versions.find((version) => version.id === selected.value?.draftVersionId))
  scheduleForm.publishAtLocal = madridLocalInput(selected.value.scheduledPublishAt)
  scheduleForm.unpublishAtLocal = madridLocalInput(selected.value.scheduledUnpublishAt)
  scheduleForm.reason = ''
}

function createNew() {
  selected.value = null
  creating.value = true
  populate()
}

function parsedBlocks() {
  const blocks = JSON.parse(form.blocksJson) as unknown
  if (!Array.isArray(blocks)) throw new Error('Los bloques deben ser una lista JSON')
  return blocks
}

async function save() {
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
    toast.add({ title: apiErrorMessage(error, 'Revisa el esquema de bloques y los campos'), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function publish() {
  if (!selected.value) return
  await $fetch(`/api/admin/content/pages/${selected.value.id}/publish`, {
    method: 'POST',
    body: { reason: 'Publicación editorial aprobada desde el CMS' }
  })
  await refresh()
  await load({ ...selected.value })
  toast.add({ title: 'Versión publicada atómicamente', color: 'success' })
}

async function schedulePublication() {
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
    toast.add({ title: 'Calendario editorial actualizado', color: 'success' })
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido actualizar el calendario'), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function preview() {
  if (!selected.value) return
  const result = await $fetch<{ url: string }>(`/api/admin/content/pages/${selected.value.id}/preview`, {
    method: 'POST',
    body: { segment: 'default', device: 'responsive' }
  })
  window.open(result.url, '_blank', 'noopener,noreferrer')
}

async function rollback(version: Version) {
  if (!selected.value || !confirm(`¿Crear una nueva versión desde la v${version.version}?`)) return
  await $fetch(`/api/admin/content/pages/${selected.value.id}/rollback`, {
    method: 'POST',
    body: { versionId: version.id, reason: `Rollback editorial desde versión ${version.version}` }
  })
  await refresh()
  await load({ ...selected.value })
  toast.add({ title: 'Rollback creado como nueva versión', color: 'success' })
}
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold text-slate-900">Contenido versionado</h1>
        <p class="mt-1 text-sm text-slate-500">Bloques tipados, preview firmado, publicación atómica e historial.</p>
      </div>
      <UButton icon="i-lucide-plus" @click="createNew">Nueva página</UButton>
    </div>

    <div class="mt-6 grid gap-6 lg:grid-cols-[18rem_1fr]">
      <aside class="rounded-2xl border border-slate-200 bg-white p-3">
        <button
          v-for="page in pages"
          :key="page.id"
          class="mb-1 block w-full rounded-xl px-3 py-2 text-left hover:bg-slate-50"
          :class="selected?.id === page.id ? 'bg-neteco-50 text-neteco-800' : 'text-slate-700'"
          @click="load(page)"
        >
          <span class="block font-semibold">{{ page.title }}</span>
          <span class="text-xs">/{{ page.slug }} · {{ page.status }} · v{{ page.draftVersion }}</span>
        </button>
        <p v-if="!pages.length" class="p-4 text-sm text-slate-500">Todavía no hay páginas.</p>
      </aside>

      <section v-if="selected || creating" class="rounded-2xl border border-slate-200 bg-white p-6">
        <form class="space-y-4" @submit.prevent="save">
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Título"><UInput v-model="form.title" class="w-full" /></UFormField>
            <UFormField label="Slug"><UInput v-model="form.slug" class="w-full" /></UFormField>
            <UFormField label="SEO title"><UInput v-model="form.seoTitle" class="w-full" /></UFormField>
            <UFormField label="SEO description"><UInput v-model="form.seoDescription" class="w-full" /></UFormField>
          </div>
          <label class="flex items-center gap-2 text-sm text-slate-700">
            <input v-model="form.noindex" type="checkbox" /> No indexar la versión publicada
          </label>
          <UFormField
            label="Bloques tipados (JSON)"
            hint="heading, paragraph, list, image, callout o cta; no admite HTML/JS"
          >
            <UTextarea v-model="form.blocksJson" :rows="18" class="w-full font-mono text-xs" />
          </UFormField>
          <UFormField label="Resumen del cambio">
            <UInput v-model="form.changeSummary" class="w-full" placeholder="Qué cambia y por qué" />
          </UFormField>
          <div class="flex flex-wrap gap-2">
            <UButton type="submit" icon="i-lucide-save" :loading="saving">Guardar nueva versión</UButton>
            <UButton v-if="selected" type="button" variant="outline" icon="i-lucide-eye" @click="preview">
              Vista previa 30 min
            </UButton>
            <UButton v-if="selected" type="button" color="success" icon="i-lucide-send" @click="publish">
              Publicar borrador
            </UButton>
          </div>
        </form>

        <form
          v-if="selected"
          class="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4"
          @submit.prevent="schedulePublication"
        >
          <h2 class="font-bold text-slate-900">Calendario editorial</h2>
          <p class="mt-1 text-xs text-slate-500">
            Horario Europe/Madrid. En la hora repetida de otoño se aplica la segunda ocurrencia.
          </p>
          <div class="mt-3 grid gap-3 md:grid-cols-3">
            <UFormField label="Publicar desde">
              <UInput v-model="scheduleForm.publishAtLocal" type="datetime-local" class="w-full" />
            </UFormField>
            <UFormField label="Despublicar desde">
              <UInput v-model="scheduleForm.unpublishAtLocal" type="datetime-local" class="w-full" />
            </UFormField>
            <UFormField label="Motivo">
              <UInput v-model="scheduleForm.reason" required minlength="3" class="w-full" />
            </UFormField>
          </div>
          <UButton type="submit" class="mt-3" icon="i-lucide-calendar-clock" :loading="saving">
            Guardar programación
          </UButton>
        </form>

        <div v-if="selected" class="mt-8 border-t border-slate-200 pt-5">
          <h2 class="font-bold text-slate-900">Historial inmutable</h2>
          <ul class="mt-3 space-y-2">
            <li
              v-for="version in selected.versions"
              :key="version.id"
              class="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3 text-sm"
            >
              <span>
                <strong>v{{ version.version }}</strong> · {{ version.changeSummary }} · {{ version.author }} ·
                {{ new Date(version.createdAt).toLocaleString('es-ES') }}
                <details class="mt-1 text-xs text-slate-500">
                  <summary class="cursor-pointer">Ver snapshot/diff respecto a la versión anterior</summary>
                  <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap">{{
                    JSON.stringify({ seo: version.seo, blocks: version.blocks }, null, 2)
                  }}</pre>
                </details>
              </span>
              <UButton size="xs" variant="ghost" icon="i-lucide-history" @click="rollback(version)">
                Restaurar como nueva
              </UButton>
            </li>
          </ul>
        </div>
      </section>
      <div v-else class="rounded-2xl border border-dashed border-slate-300 p-12 text-center text-slate-500">
        Selecciona una página o crea una nueva.
      </div>
    </div>
  </div>
</template>
