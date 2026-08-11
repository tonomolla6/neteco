import { z } from 'zod'

const schema = z.object({
  name: z.string().min(2, 'Indica tu nombre'),
  email: z.string().email('Email no válido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  phone: z.string().optional(),
  company: z.string().optional()
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const db = useDb()

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(body.email.toLowerCase())
  if (existing) {
    throw createError({ statusCode: 409, statusMessage: 'Ya existe una cuenta con ese email' })
  }

  const hash = await hashPassword(body.password)
  const info = db
    .prepare('INSERT INTO users (email, password_hash, name, phone, company) VALUES (?, ?, ?, ?, ?)')
    .run(body.email.toLowerCase(), hash, body.name, body.phone ?? null, body.company ?? null)

  const user = {
    id: Number(info.lastInsertRowid),
    email: body.email.toLowerCase(),
    name: body.name,
    phone: body.phone ?? null,
    company: body.company ?? null,
    role: 'customer'
  }
  await setUserSession(event, { user })
  return { user }
})
