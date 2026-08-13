// ¿Está ya la página "viva" (JS hidratado y botones respondiendo)?
// El HTML del servidor se pinta al instante, pero hasta que el cliente hidrata,
// los clics no hacen nada: este estado permite comunicarlo (barra superior,
// controles atenuados) en vez de dejar clics muertos.
export function useHydrated() {
  return useState('hydrated', () => false)
}
