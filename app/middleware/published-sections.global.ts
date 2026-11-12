import { isPathPublished, parsePublishedSections } from '~~/shared/published-sections'

/**
 * Una sección de contenido sin publicar no existe: responde 404 en vez de una página vacía.
 * Ver `shared/published-sections.ts`.
 */
export default defineNuxtRouteMiddleware((to) => {
  const published = parsePublishedSections(useRuntimeConfig().public.publishedSections)
  if (isPathPublished(to.path, published)) return
  return abortNavigation(createError({ statusCode: 404, statusMessage: 'Página no encontrada', fatal: true }))
})
