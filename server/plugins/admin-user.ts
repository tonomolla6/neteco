// Crea (o promociona) el usuario administrador al arrancar el servidor.
// Credenciales: admin@neteco.es / NUXT_ADMIN_PASSWORD (por defecto "neteco-admin").
export default defineNitroPlugin(async () => {
  const db = useDb()
  const email = 'admin@neteco.es'
  const row = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email) as
    | { id: number; role: string }
    | undefined

  if (!row) {
    const hash = await hashPassword(process.env.NUXT_ADMIN_PASSWORD || 'neteco-admin')
    db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, 'Administración NETECO', 'admin')").run(
      email,
      hash
    )
  } else if (row.role !== 'admin') {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(row.id)
  }
})
