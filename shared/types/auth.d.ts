declare module '#auth-utils' {
  interface User {
    id: string
    email: string
    name: string | null
    phone: string | null
    company: string | null
    role: string
    roles: string[]
    emailVerified: boolean
    mfaVerified: boolean
  }

  interface UserSession {
    sessionId?: string
    sessionVersion?: number
  }
}

export {}
