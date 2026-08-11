import { z } from 'zod'

const schema = z.object({
  email: z.string().email('Email no válido'),
  password: z.string().min(1, 'Indica tu contraseña')
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const db = useDb()

  const row = db
    .prepare('SELECT id, email, password_hash AS hash, name, phone, company, role FROM users WHERE email = ?')
    .get(body.email.toLowerCase()) as any

  if (!row || !(await verifyPassword(row.hash, body.password))) {
    throw createError({ statusCode: 401, statusMessage: 'Email o contraseña incorrectos' })
  }

  const user = {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    company: row.company,
    role: row.role ?? 'customer'
  }
  await setUserSession(event, { user })
  return { user }
})
