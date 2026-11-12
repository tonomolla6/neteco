<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { DownloadableTemplate } from '~~/shared/downloadable-templates'
import { dynamicOgMeta } from '~/utils/og-image'
import { ogVersion } from '~~/shared/og-image'

const route = useRoute()
const runtime = useRuntimeConfig()
const request = useRequestFetch()

const slug = computed(() => (typeof route.params.slug === 'string' ? route.params.slug : ''))
const template = ref<DownloadableTemplate | null>(null)
const loading = ref(true)
const notFound = ref(false)

async function loadTemplate() {
  if (!slug.value) return
  loading.value = true
  notFound.value = false
  try {
    const data = await request<DownloadableTemplate>(`/api/templates/${slug.value}`, { method: 'GET' })
    template.value = data
  } catch {
    notFound.value = true
  } finally {
    loading.value = false
  }
}

// La plantilla se carga en el cliente: el SSR emite la tarjeta de su slug y la versión llega con los datos.
const templateOgMeta = computed(() =>
  dynamicOgMeta({
    origin: String(runtime.public.baseUrl),
    kind: 'plantilla',
    slug: slug.value,
    version: template.value
      ? ogVersion(template.value.title, template.value.version, template.value.updatedAt)
      : undefined,
    alt: `${template.value?.title ?? 'Plantilla descargable'} · NETECO`,
    dynamic: runtime.public.serverRuntime === 'cloudflare'
  })
)

useSeoMeta({
  ogImage: () => templateOgMeta.value.ogImage,
  ogImageWidth: () => templateOgMeta.value.ogImageWidth,
  ogImageHeight: () => templateOgMeta.value.ogImageHeight,
  ogImageType: () => templateOgMeta.value.ogImageType,
  ogImageAlt: () => templateOgMeta.value.ogImageAlt,
  twitterImage: () => templateOgMeta.value.twitterImage,
  twitterImageAlt: () => templateOgMeta.value.twitterImageAlt,
  title: () => formatSeoTitle(template.value ? `${template.value.title} · Plantillas` : 'Plantilla descargable'),
  description: () =>
    truncateSeoDescription(
      template.value?.description ||
        'Plantilla descargable de higiene profesional y control APPCC en formato PDF y CSV en NETECO.'
    ),
  robots: () => (template.value?.indexable ? 'index, follow' : 'noindex, follow')
})

useHead(() => ({
  link: template.value ? [{ rel: 'canonical', href: `${runtime.public.baseUrl}${template.value.canonicalPath}` }] : []
}))

onMounted(() => {
  loadTemplate()
})
</script>

<template>
  <main class="mx-auto max-w-4xl px-4 py-8" data-testid="template-detail-page">
    <!-- Breadcrumb -->
    <nav class="mb-6 hidden text-xs text-slate-500 md:block" aria-label="Miga de pan">
      <ol class="flex items-center gap-1.5">
        <li><NuxtLink to="/" class="hover:underline">Inicio</NuxtLink></li>
        <li>/</li>
        <li><NuxtLink to="/plantillas" class="hover:underline">Plantillas</NuxtLink></li>
        <li>/</li>
        <li class="font-semibold text-slate-800" aria-current="page">{{ template?.title ?? slug }}</li>
      </ol>
    </nav>

    <!-- Loading -->
    <div v-if="loading" class="py-16 text-center" aria-busy="true">
      <div
        class="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-blue-600 border-r-transparent align-[-0.125em]"
      />
      <p class="mt-3 text-sm text-slate-500">Cargando protocolo...</p>
    </div>

    <!-- 404 / Error -->
    <div v-else-if="notFound || !template" class="rounded-xl border border-slate-200 bg-white p-12 text-center">
      <h1 class="text-xl font-bold text-slate-800">Plantilla no encontrada</h1>
      <p class="mt-2 text-sm text-slate-500">
        El documento solicitado no existe o no se encuentra publicado en el catálogo activo.
      </p>
      <NuxtLink
        to="/plantillas"
        class="mt-4 inline-block rounded-lg bg-blue-600 px-4 py-2 text-xs font-bold text-white hover:bg-blue-700"
      >
        Volver a la biblioteca
      </NuxtLink>
    </div>

    <!-- Content -->
    <article v-else class="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <header class="border-b border-slate-200 pb-6">
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded-full bg-blue-100 px-3 py-1 text-xs font-bold uppercase tracking-wider text-blue-800">
            {{ template.templateType }}
          </span>
          <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 capitalize">
            {{ template.category }}
          </span>
          <span class="text-xs text-slate-400">Versión {{ template.version }}</span>
        </div>

        <h1 class="mt-4 text-2xl font-extrabold text-slate-900 sm:text-3xl">
          {{ template.title }}
        </h1>

        <p class="mt-3 text-base text-slate-600 leading-relaxed">
          {{ template.description }}
        </p>

        <div class="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl bg-slate-50 p-4">
          <div class="text-xs text-slate-600">
            <p><strong>Audiencia objetivo:</strong> {{ template.targetAudience }}</p>
            <p class="mt-1">
              <strong>Última revisión técnica:</strong> {{ template.reviewedAt.slice(0, 10) }} |
              <strong>Próxima revisión:</strong> {{ template.reviewDueAt.slice(0, 10) }}
            </p>
          </div>

          <a
            :href="template.downloadUrl"
            download
            class="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-blue-700"
          >
            Descargar PDF Oficial
          </a>
        </div>
      </header>

      <!-- Sections & Items -->
      <section class="mt-8 space-y-8">
        <div
          v-for="section in template.sections"
          :key="section.id"
          class="rounded-xl border border-slate-100 bg-slate-50/50 p-6"
        >
          <h2 class="text-lg font-bold text-slate-900">
            {{ section.title }}
          </h2>
          <p v-if="section.description" class="mt-1 text-xs text-slate-500">
            {{ section.description }}
          </p>

          <ul class="mt-4 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
            <li v-for="item in section.items" :key="item.id" class="flex items-start gap-3 p-3.5 text-sm">
              <span class="mt-0.5 text-slate-400">☐</span>
              <div class="flex-1">
                <span class="text-slate-800">{{ item.label }}</span>
                <div class="mt-1 flex flex-wrap gap-1.5 text-xs">
                  <span v-if="item.frequency" class="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
                    Frecuencia: {{ item.frequency }}
                  </span>
                  <span
                    v-if="item.criticalControlPoint"
                    class="rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800"
                  >
                    Punto de Control Crítico (PCC)
                  </span>
                  <span v-if="item.mandatory" class="rounded bg-red-50 px-1.5 py-0.5 font-semibold text-red-700">
                    Obligatorio
                  </span>
                </div>
              </div>
            </li>
          </ul>
        </div>
      </section>

      <footer class="mt-8 border-t border-slate-200 pt-6 text-xs text-slate-500">
        <p>
          Documento técnico validado por el departamento de Calidad y Seguridad de Neteco. Cumple con los requisitos de
          accesibilidad documental PDF/UA y etiquetado ISO 14289.
        </p>
      </footer>
    </article>
  </main>
</template>
