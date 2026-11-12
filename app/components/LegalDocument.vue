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
</script>

<template>
  <article class="mx-auto max-w-6xl px-4 py-10 text-[var(--text)]">
    <header class="max-w-[65ch]">
      <h1 class="text-3xl font-bold text-[var(--text-strong)]">{{ page.title }}</h1>
      <div class="mt-3 leading-relaxed text-[var(--text-muted)]"><slot name="intro" /></div>
    </header>

    <div class="mt-8 gap-12 lg:grid lg:grid-cols-[15rem_minmax(0,65ch)]">
      <nav
        data-legal-toc
        aria-labelledby="legal-toc-title"
        class="mb-8 self-start rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface)] p-4 lg:sticky lg:top-24 lg:mb-0"
      >
        <h2 id="legal-toc-title" class="text-sm font-semibold text-[var(--text-strong)]">En esta página</h2>
        <ol class="mt-2 space-y-1.5 text-sm">
          <li v-for="section in sections" :key="section.id">
            <a :href="`#${section.id}`" class="text-[var(--link)] hover:underline">{{ section.title }}</a>
          </li>
        </ol>
      </nav>

      <div class="legal-body max-w-[65ch] leading-relaxed">
        <slot />
      </div>
    </div>

    <footer class="mt-12 max-w-[65ch] border-t border-[var(--border)] pt-6 text-sm lg:ml-[calc(15rem+3rem)]">
      <h2 class="font-semibold text-[var(--text-strong)]">Otros documentos legales</h2>
      <ul class="mt-2 flex flex-wrap gap-x-6 gap-y-2">
        <li v-for="entry in related" :key="entry.path">
          <NuxtLink :to="entry.path" class="text-[var(--link)] underline">{{ entry.label }}</NuxtLink>
        </li>
        <li><NuxtLink to="/devoluciones" class="text-[var(--link)] underline">Devoluciones</NuxtLink></li>
      </ul>
    </footer>
  </article>
</template>

<style scoped>
.legal-body :deep(h2) {
  margin-top: 2.5rem;
  font-size: 1.25rem;
  line-height: 1.4;
  font-weight: 700;
  color: var(--text-strong);
  scroll-margin-top: 6rem;
}
.legal-body :deep(section:first-child h2) {
  margin-top: 0;
}
.legal-body :deep(h3) {
  margin-top: 1.5rem;
  font-weight: 600;
  color: var(--text-strong);
  scroll-margin-top: 6rem;
}
.legal-body :deep(p),
.legal-body :deep(ul),
.legal-body :deep(ol) {
  margin-top: 0.75rem;
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
  margin-top: 0.375rem;
}
.legal-body :deep(a) {
  color: var(--link);
  text-decoration: underline;
  overflow-wrap: anywhere;
}
.legal-body :deep(strong) {
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
  padding: 0.5rem 0.75rem 0.5rem 0;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}
.legal-body :deep(th) {
  font-weight: 600;
  color: var(--text-strong);
}
.legal-body :deep(.legal-form) {
  margin-top: 1rem;
  padding: 1rem 1.25rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-surface);
  background: var(--surface-sunken);
}
</style>
