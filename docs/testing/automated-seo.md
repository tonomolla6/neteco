# Gate SEO automatizado

`tests/e2e/seo.spec.ts` valida el HTML SSR y las rutas públicas contra la aplicación y PostgreSQL reales. El gate cubre:

- Estados 200 de home, catálogo, categoría y producto; 404 de slugs inexistentes.
- Una única canonical absoluta: elimina SKU/facetas y conserva únicamente `?page=N` en catálogo y categorías.
- `title` y descripción; `noindex, follow` en búsqueda y facetas, con paginación pura indexable.
- `X-Robots-Tag: noindex, nofollow, noarchive` en cualquier entorno no productivo.
- JSON-LD parseable para Organization, Product/Offer y BreadcrumbList.
- `robots.txt`, índice y tres sitemaps XML; URLs únicas, públicas y alcanzables.
- Todos los destinos publicados en los sitemaps, enlaces internos descubiertos, enlaces `prev`/`next`, navegación visible y páginas de catálogo sin productos duplicados.
- Redirect canónico 301 directo, conservando query, y una muestra acotada de enlaces internos sin respuestas rotas.
- Alternates `es-ES` y `x-default`, que dejan preparado el contrato para añadir idiomas sin cambiar canónicas.

Alpha solo publica `es-ES`. No se inventan variantes regionales adicionales: `x-default` apunta a la misma canonical hasta que exista contenido traducido. La paginación pura conserva canonical propia; cualquier filtro u ordenación permanece `noindex, follow`. Todos los productos publicados también son descubribles directamente en el sitemap.

El test usa la fixture Playwright determinista y el guard de red; forma parte del recorrido E2E Chromium de CI.
El contenedor debe recibir `APP_BASE_URL` para workers y `NUXT_PUBLIC_BASE_URL` con el mismo origen para la configuración pública de Nuxt en runtime; el gate verifica sus canonical absolutas contra el origen servido.
