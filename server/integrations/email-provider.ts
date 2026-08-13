import nodemailer from 'nodemailer'

export interface TransactionalEmail {
  messageId: string
  to: string
  subject: string
  text: string
  html: string
  headers?: Record<string, string>
}

export interface EmailProvider {
  readonly name: string
  send(message: TransactionalEmail): Promise<{ providerMessageId: string }>
}

export class AllowlistedEmailProvider implements EmailProvider {
  readonly name: string

  constructor(
    private readonly provider: EmailProvider,
    private readonly allowedRecipients: readonly string[]
  ) {
    this.name = provider.name
    if (!allowedRecipients.length) throw new Error('Non-production SMTP recipient allowlist is required')
  }

  async send(message: TransactionalEmail) {
    const recipient = message.to.trim().toLowerCase()
    const allowed = this.allowedRecipients.some((entry) => {
      const normalized = entry.trim().toLowerCase()
      return normalized.startsWith('*@') ? recipient.endsWith(normalized.slice(1)) : recipient === normalized
    })
    if (!allowed) throw new Error('Non-production SMTP recipient is not allowlisted')
    return this.provider.send(message)
  }
}

export class SmtpEmailProvider implements EmailProvider {
  readonly name: string
  private readonly transport

  constructor(
    private readonly from: string,
    options: {
      providerName?: string
      host: string
      port: number
      secure: boolean
      user?: string
      password?: string
    }
  ) {
    this.name = options.providerName ?? 'smtp'
    this.transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      auth: options.user ? { user: options.user, pass: options.password } : undefined,
      pool: true,
      maxConnections: 3,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000
    })
  }

  async send(message: TransactionalEmail) {
    assertSafeHeaderValue('From', this.from)
    assertSafeHeaderValue('To', message.to)
    assertSafeHeaderValue('Subject', message.subject)
    const headers = Object.fromEntries(
      Object.entries(message.headers ?? {}).map(([name, value]) => {
        if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error('Invalid email header name')
        assertSafeHeaderValue(name, value)
        return [name, value]
      })
    )
    const result = await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      messageId: `<${message.messageId}@neteco.es>`,
      ...(Object.keys(headers).length ? { headers } : {})
    })
    return { providerMessageId: result.messageId }
  }
}

export class LogEmailProvider implements EmailProvider {
  constructor(readonly name = 'log') {}

  async send(message: TransactionalEmail) {
    process.stdout.write(`${JSON.stringify({ event: 'email.accepted', messageId: message.messageId })}\n`)
    return { providerMessageId: message.messageId }
  }
}

function assertSafeHeaderValue(name: string, value: string) {
  if (/\r|\n/.test(value)) throw new Error(`${name} contains an invalid line break`)
}

function commaSeparated(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function nonProductionSmtpProvider(
  provider: SmtpEmailProvider,
  host: string,
  environment: NodeJS.ProcessEnv,
  prefix: '' | 'MARKETING_'
) {
  if (environment.APP_ENV === 'production') return provider
  const allowedHosts = commaSeparated(environment[`${prefix}SMTP_ALLOWED_HOSTS`])
  if (!allowedHosts.includes(host)) throw new Error('Non-production SMTP host is not allowlisted')
  return new AllowlistedEmailProvider(provider, commaSeparated(environment[`${prefix}EMAIL_ALLOWED_RECIPIENTS`]))
}

export function emailProviderFromEnvironment(environment: NodeJS.ProcessEnv = process.env): EmailProvider {
  const provider = environment.EMAIL_PROVIDER ?? 'log'
  if (provider === 'log' && environment.APP_ENV !== 'production') return new LogEmailProvider()
  if (provider !== 'smtp') throw new Error('Production email provider must be smtp')
  const host = environment.SMTP_HOST?.trim()
  const from = environment.EMAIL_FROM?.trim()
  if (!host || !from) throw new Error('SMTP_HOST and EMAIL_FROM are required')
  const smtp = new SmtpEmailProvider(from, {
    host,
    port: Number(environment.SMTP_PORT ?? 587),
    secure: environment.SMTP_SECURE === 'true',
    user: environment.SMTP_USER?.trim() || undefined,
    password: environment.SMTP_PASSWORD || undefined
  })
  return nonProductionSmtpProvider(smtp, host, environment, '')
}

export function marketingEmailProviderFromEnvironment(environment: NodeJS.ProcessEnv = process.env): EmailProvider {
  const provider = environment.MARKETING_EMAIL_PROVIDER ?? (environment.APP_ENV === 'production' ? '' : 'log')
  if (provider === 'log' && environment.APP_ENV !== 'production') return new LogEmailProvider('marketing-log')
  if (provider !== 'smtp') throw new Error('Production marketing email provider must be separately configured as smtp')
  const host = environment.MARKETING_SMTP_HOST?.trim()
  const from = environment.MARKETING_EMAIL_FROM?.trim()
  if (!host || !from) throw new Error('MARKETING_SMTP_HOST and MARKETING_EMAIL_FROM are required')
  const smtp = new SmtpEmailProvider(from, {
    providerName: 'marketing-smtp',
    host,
    port: Number(environment.MARKETING_SMTP_PORT ?? 587),
    secure: environment.MARKETING_SMTP_SECURE === 'true',
    user: environment.MARKETING_SMTP_USER?.trim() || undefined,
    password: environment.MARKETING_SMTP_PASSWORD || undefined
  })
  return nonProductionSmtpProvider(smtp, host, environment, 'MARKETING_')
}
