// Social share cards (1200x630 JPG in public/og/). /marca and /certificaciones keep the
// default card until their certification claims are backed by real certificates.
const PAGE_CARDS: Readonly<Record<string, string>> = {
  '/': 'og-home.jpg',
  '/catalogo': 'og-catalogo.jpg',
  '/envios': 'og-envios.jpg',
  '/devoluciones': 'og-devoluciones.jpg',
  '/formas-de-pago': 'og-formas-de-pago.jpg',
  '/contacto': 'og-contacto.jpg',
  '/ayuda': 'og-ayuda.jpg',
  '/kits': 'og-kits.jpg',
  '/pedido-rapido': 'og-pedido-rapido.jpg',
  '/casos-exito': 'og-casos-exito.jpg',
  '/recursos': 'og-recursos.jpg',
  '/plantillas': 'og-plantillas.jpg',
  '/eventos': 'og-eventos.jpg',
  '/reparto': 'og-reparto.jpg',
  '/accesibilidad': 'og-accesibilidad.jpg',
  '/registro': 'og-registro.jpg',
  '/categoria/productos-quimicos': 'og-categoria-productos-quimicos.jpg',
  '/categoria/menaje-hosteleria': 'og-categoria-menaje-hosteleria.jpg'
}

export const DEFAULT_OG_IMAGE = '/og-default.jpg'

export function ogImageForPath(path: string): string {
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path
  const card = PAGE_CARDS[normalized] ?? (normalized.startsWith('/producto/') ? 'og-producto.jpg' : undefined)
  return card ? `/og/${card}` : DEFAULT_OG_IMAGE
}
