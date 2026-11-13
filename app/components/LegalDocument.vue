<script setup lang="ts">
import { LEGAL_PAGES, type LegalPage } from '~~/shared/legal-pages'

/**
 * Armazón común de las páginas legales: título, índice con anclas, texto a ~65 caracteres
 * por línea y enlaces al resto de documentos legales. El SEO sale de `shared/legal-pages.ts`.
 */
const props = defineProps<{
  path: LegalPage['path']
  sections: ReadonlyArray<{ id: string; title: string }>
}>()

const page = LEGAL_PAGES.find((entry) => entry.path === props.path)!
const related = LEGAL_PAGES.filter((entry) => entry.path !== props.path)

useSeoMeta({ title: page.title, description: page.description, ogTitle: page.title, ogDescription: page.description })

function print() {
  if (import.meta.client) window.print()
}
</script>

<template>
  <article class="legal-document text-[var(--text)]">
    <!-- Cabecera: título, resumen y acciones, en una banda propia -->
    <header class="border-b border-[var(--border)] bg-[var(--surface)]">
      <div class="mx-auto max-w-[1200px] px-4 py-8 sm:px-6 sm:py-10">
        <p class="text-xs font-bold uppercase tracking-wide text-[var(--link)]">Información legal</p>
        <h1 class="mt-2 text-3xl font-bold tracking-tight text-[var(--text-strong)] sm:text-4xl">{{ page.title }}</h1>
        <div class="mt-3 max-w-[75ch] text-base leading-relaxed text-[var(--text-muted)]"><slot name="intro" /></div>
        <div class="mt-5 flex flex-wrap gap-2 print:hidden">
          <UButton color="neutral" variant="outline" icon="i-lucide-printer" @click="print">
            Imprimir o guardar en PDF
          </UButton>
          <UButton color="neutral" variant="ghost" icon="i-lucide-mail" to="/contacto">¿Dudas? Escríbenos</UButton>
        </div>
      </div>
    </header>

    <div class="mx-auto max-w-[1200px] px-4 py-8 sm:px-6 lg:grid lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-10">
      <nav
        data-legal-toc
        aria-labelledby="legal-toc-title"
        class="mb-8 self-start rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-5 lg:sticky lg:top-6 lg:mb-0 print:hidden"
      >
        <h2 id="legal-toc-title" class="text-xs font-bold uppercase tracking-wide text-[var(--text-muted)]">
          En esta página
        </h2>
        <ol class="mt-3 space-y-0.5 text-sm">
          <li v-for="(section, index) in sections" :key="section.id">
            <a
              :href="`#${section.id}`"
              class="flex gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 font-medium text-[var(--text)] hover:bg-[var(--surface-sunken)] hover:text-[var(--link)]"
            >
              <span class="tabular w-5 shrink-0 text-right text-[var(--text-muted)]">{{ index + 1 }}.</span>
              <span>{{ section.title }}</span>
            </a>
          </li>
        </ol>
      </nav>

      <div class="min-w-0">
        <div class="legal-body leading-relaxed">
          <slot />
        </div>

        <footer
          class="mt-8 rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm sm:p-6"
        >
          <h2 class="text-base font-bold text-[var(--text-strong)]">Otros documentos legales</h2>
          <ul class="mt-3 flex flex-wrap gap-2">
            <li v-for="entry in related" :key="entry.path">
              <NuxtLink
                :to="entry.path"
                class="inline-flex min-h-10 items-center rounded-full border border-[var(--border-strong)] px-4 font-medium text-[var(--link)] hover:bg-[var(--surface-sunken)]"
                >{{ entry.label }}</NuxtLink
              >
            </li>
            <li>
              <NuxtLink
                to="/devoluciones"
                class="inline-flex min-h-10 items-center rounded-full border border-[var(--border-strong)] px-4 font-medium text-[var(--link)] hover:bg-[var(--surface-sunken)]"
                >Devoluciones</NuxtLink
              >
            </li>
          </ul>
        </footer>
      </div>
    </div>
  </article>
</template>

<style scoped>
/* Cada apartado es una tarjeta numerada: se lee por bloques, no como un muro de texto. */
.legal-body {
  counter-reset: legal-section;
  display: grid;
  gap: 1rem;
}
.legal-body > :deep(section) {
  counter-increment: legal-section;
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  background: var(--surface);
  padding: 1.25rem;
  scroll-margin-top: 1.5rem;
}
@media (min-width: 640px) {
  .legal-body > :deep(section) {
    padding: 1.75rem 2rem;
  }
}
.legal-body > :deep(section) > h2 {
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  font-size: 1.375rem;
  line-height: 1.3;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text-strong);
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--border);
}
.legal-body > :deep(section) > h2::before {
  content: counter(legal-section) '.';
  color: var(--link);
  font-variant-numeric: tabular-nums;
}
.legal-body :deep(h3) {
  margin-top: 1.5rem;
  font-size: 1.0625rem;
  font-weight: 700;
  color: var(--text-strong);
  scroll-margin-top: 1.5rem;
}
.legal-body :deep(p),
.legal-body :deep(ul),
.legal-body :deep(ol) {
  margin-top: 0.875rem;
  max-width: 78ch;
}
.legal-body :deep(ul) {
  list-style: disc;
  padding-left: 1.25rem;
}
.legal-body :deep(ol) {
  list-style: decimal;
  padding-left: 1.25rem;
}
.legal-body :deep(li + li) {
  margin-top: 0.5rem;
}
.legal-body :deep(li)::marker {
  color: var(--link);
  font-weight: 700;
}
.legal-body :deep(a) {
  color: var(--link);
  font-weight: 500;
  text-decoration: underline;
  text-underline-offset: 2px;
  overflow-wrap: anywhere;
}
/* La negrita se fija a 700: con `bolder` dependía del peso heredado y apenas se distinguía. */
.legal-body :deep(strong),
.legal-body :deep(b) {
  font-weight: 700;
  color: var(--text-strong);
}
.legal-body :deep(.legal-table) {
  margin-top: 1rem;
  overflow-x: auto;
}
.legal-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}
.legal-body :deep(th),
.legal-body :deep(td) {
  padding: 0.625rem 0.75rem;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}
.legal-body :deep(th) {
  font-weight: 700;
  color: var(--text-strong);
  background: var(--surface-sunken);
}
.legal-body :deep(.legal-form) {
  margin-top: 1rem;
  padding: 1rem 1.25rem;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-surface);
  background: var(--surface-sunken);
}
@media print {
  .legal-body > :deep(section) {
    border: 0;
    padding: 0.5rem 0;
    break-inside: avoid;
  }
}
</style>
