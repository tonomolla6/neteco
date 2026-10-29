/**
 * Imagen representativa por sector y por familia.
 *
 * El escaparate usaba iconos de línea y puntos de color para representar sectores y
 * familias. Un icono de una fábrica no dice qué vendes; una foto de la garrafa que le vas a
 * llevar al cliente, sí. Todos los mayoristas del sector con los que se comparó
 * —Shalbaida, Muñoz Bosch, Plasticosur— usan foto de producto en la navegación por
 * categorías.
 *
 * Este mapa es histórico, exclusivo del perfil Node. La presencia de una foto en
 * el repositorio NO demuestra derechos ni análisis de seguridad: Cloudflare no
 * publica estos originales y usa únicamente publicaciones gobernadas de D1.
 *
 * Cuando el catálogo real esté cargado, esta tabla debería desaparecer: la imagen de cada
 * familia saldrá de uno de sus productos publicados. Mientras tanto, el mapa evita que el
 * escaparate se vea vacío.
 */
const BASE = '/img/products'

export const SECTOR_IMAGES: Record<string, string> = {
  hosteleria: `${BASE}/delenex/vj-eco-p.jpg`,
  comercio: `${BASE}/defort/naturex.jpg`,
  industria: `${BASE}/kenex/max-100.jpg`,
  colectividades: `${BASE}/guante-de-nitrilo-nitriflex-blue-caja-100-uds/principal.jpg`
}

/**
 * Palabra clave del slug de la familia → imagen. El orden importa: se aplica la primera
 * coincidencia, así que lo más específico va antes.
 */
const FAMILY_RULES: Array<[RegExp, string]> = [
  [/guantes?-de-trabajo|epi/, `${BASE}/guante-ignifugo-azul-par/principal.jpg`],
  [/guantes?/, `${BASE}/guante-de-nitrilo-nitriflex-blue-caja-100-uds/principal.jpg`],
  [/lavado-automatico|lavavajillas/, `${BASE}/delenex/a.jpg`],
  [/lavado-manual/, `${BASE}/delenex/m.jpg`],
  [/vajilla/, `${BASE}/delenex/vj-eco-p.jpg`],
  [/lavanderia-solidos/, `${BASE}/defort/solido.jpg`],
  [/lavanderia|suavizantes|desmanchantes|blancor/, `${BASE}/lavaper/lavaper.jpg`],
  [/desengrasante/, `${BASE}/kenex/dpc.jpg`],
  [/desincrustante|decal/, `${BASE}/defort/decal.jpg`],
  [/insecticida|desinfectante/, `${BASE}/detial/b-100.jpg`],
  [/ambientador|desodorante/, `${BASE}/milane/arome-1.jpg`],
  [/marketing-olfativo|perfume|difusor|aroma/, `${BASE}/milane/essence.jpg`],
  [/perfumador-textil/, `${BASE}/milane/nice.jpg`],
  [/higiene-personal|limpieza-de-manos|colonias|toallitas/, `${BASE}/sabomans/dermo.jpg`],
  [/higiene-alimentaria/, `${BASE}/saniolex/dess.jpg`],
  [/eco|naturex|ecologic/, `${BASE}/defort/naturex.jpg`],
  [/box-c|bag-in-box|concentrado/, `${BASE}/delenex/box-c.jpg`],
  [/capsulas/, `${BASE}/delenex/dtr.jpg`],
  [/limpiadores-maquina|maquina/, `${BASE}/kenex/max-100.jpg`],
  [/limpiadores-generales|multiusos/, `${BASE}/nettion/mc.jpg`],
  [/tratamiento-de-suelos|cera/, `${BASE}/delenex/cera.jpg`],
  [/graffiti/, `${BASE}/kenex/gft-1.jpg`],
  [/piscina|torres-de-refrigeracion/, `${BASE}/defort/ph.jpg`],
  [/automocion/, `${BASE}/cristalin/auto.jpg`],
  [/cristal/, `${BASE}/cristalin/cristalin.jpg`],
  [/banos|wc|sanitario/, `${BASE}/defort/banos.jpg`],
  [/celulosa|desechable|mantel|servilleta/, `${BASE}/rollo-mantel-novotex/precortado/AZ.jpg`],
  [/menaje|utiles-de-limpieza/, `${BASE}/kenex/gm.jpg`],
  [/quimico/, `${BASE}/nettion/nettion.jpg`]
]

/** Reserva estable: mismo slug, misma imagen, para que la rejilla no cambie entre visitas. */
const FALLBACKS = [
  `${BASE}/nettion/nettion.jpg`,
  `${BASE}/delenex/delenex.jpg`,
  `${BASE}/kenex/kenex.jpg`,
  `${BASE}/defort/eco-p.jpg`,
  `${BASE}/lavaper/lavaper.jpg`,
  `${BASE}/milane/milane.jpg`
]

export function familyImage(slug: string): string {
  for (const [pattern, image] of FAMILY_RULES) {
    if (pattern.test(slug)) return image
  }
  let hash = 0
  for (const character of slug) hash = (hash * 31 + character.charCodeAt(0)) % 997
  return FALLBACKS[hash % FALLBACKS.length]!
}
