import nodemailer from 'nodemailer'

export interface TransactionalEmail {
  messageId: string
  to: string
  subject: string
  text: string
  html: string
}

export interface EmailProvider {
  readonly name: string
  send(message: TransactionalEmail): Promise<{ providerMessageId: string }>
}

export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp'
  private readonly transport

  constructor(
    private readonly from: string,
    options: {
      host: string
      port: number
      secure: boolean
      user?: string
      password?: string
    }
  ) {
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
    const result = await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      messageId: `<${message.messageId}@neteco.es>`
    })
    return { providerMessageId: result.messageId }
  }
}

export class LogEmailProvider implements EmailProvider {
  readonly name = 'log'

  async send(message: TransactionalEmail) {
    process.stdout.write(`${JSON.stringify({ event: 'email.accepted', messageId: message.messageId })}\n`)
    return { providerMessageId: message.messageId }
  }
}

export function emailProviderFromEnvironment(environment: NodeJS.ProcessEnv = process.env): EmailProvider {
  const provider = environment.EMAIL_PROVIDER ?? 'log'
  if (provider === 'log' && environment.APP_ENV !== 'production') return new LogEmailProvider()
  if (provider !== 'smtp') throw new Error('Production email provider must be smtp')
  const host = environment.SMTP_HOST?.trim()
  const from = environment.EMAIL_FROM?.trim()
  if (!host || !from) throw new Error('SMTP_HOST and EMAIL_FROM are required')
  return new SmtpEmailProvider(from, {
    host,
    port: Number(environment.SMTP_PORT ?? 587),
    secure: environment.SMTP_SECURE === 'true',
    user: environment.SMTP_USER?.trim() || undefined,
    password: environment.SMTP_PASSWORD || undefined
  })
}
