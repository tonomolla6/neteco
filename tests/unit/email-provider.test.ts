import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  emailProviderFromEnvironment,
  LogEmailProvider,
  marketingEmailProviderFromEnvironment,
  SmtpEmailProvider,
  type TransactionalEmail
} from '../../server/integrations/email-provider'

const mail = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn()
}))

vi.mock('nodemailer', () => ({ default: { createTransport: mail.createTransport } }))

const message: TransactionalEmail = {
  messageId: 'message-1',
  to: 'customer@example.test',
  subject: 'Tu pedido',
  text: 'Contenido de texto',
  html: '<p>Contenido</p>'
}

describe('transactional email providers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mail.sendMail.mockResolvedValue({ messageId: '<provider-id@example.test>' })
    mail.createTransport.mockReturnValue({ sendMail: mail.sendMail })
  })

  it('sends through SMTP with bounded transport settings and a stable message id', async () => {
    const provider = new SmtpEmailProvider('NETECO <pedidos@neteco.es>', {
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      user: 'smtp-user',
      password: 'smtp-password'
    })

    await expect(provider.send(message)).resolves.toEqual({ providerMessageId: '<provider-id@example.test>' })
    expect(provider.name).toBe('smtp')
    expect(mail.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.test',
        port: 465,
        secure: true,
        auth: { user: 'smtp-user', pass: 'smtp-password' },
        pool: true,
        maxConnections: 3
      })
    )
    expect(mail.sendMail).toHaveBeenCalledWith({
      from: 'NETECO <pedidos@neteco.es>',
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      messageId: '<message-1@neteco.es>'
    })
  })

  it('supports unauthenticated local SMTP transports', () => {
    new SmtpEmailProvider('pedidos@neteco.test', {
      host: '127.0.0.1',
      port: 1025,
      secure: false
    })
    expect(mail.createTransport).toHaveBeenCalledWith(expect.objectContaining({ auth: undefined }))
  })

  it('passes safe unsubscribe headers and rejects header injection', async () => {
    const provider = new SmtpEmailProvider('pedidos@neteco.test', {
      host: '127.0.0.1',
      port: 1025,
      secure: false
    })
    await provider.send({
      ...message,
      headers: { 'List-Unsubscribe': '<https://neteco.test/newsletter/baja?token=safe>' }
    })
    expect(mail.sendMail).toHaveBeenLastCalledWith(
      expect.objectContaining({
        headers: { 'List-Unsubscribe': '<https://neteco.test/newsletter/baja?token=safe>' }
      })
    )
    await expect(
      provider.send({ ...message, headers: { 'List-Unsubscribe': '<https://safe.test>\r\nBcc: victim@test' } })
    ).rejects.toThrow('invalid line break')
    await expect(provider.send({ ...message, headers: { 'Invalid Header': 'value' } })).rejects.toThrow(
      'Invalid email header name'
    )
  })

  it('logs only non-sensitive delivery metadata in local mode', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const provider = new LogEmailProvider()
    await expect(provider.send(message)).resolves.toEqual({ providerMessageId: message.messageId })
    expect(provider.name).toBe('log')
    expect(output).toHaveBeenCalledWith('{"event":"email.accepted","messageId":"message-1"}\n')
    expect(output.mock.calls.flat().join('')).not.toContain(message.to)
    output.mockRestore()
  })

  it('selects local and production providers with fail-closed configuration', () => {
    expect(emailProviderFromEnvironment({ APP_ENV: 'local' })).toBeInstanceOf(LogEmailProvider)
    expect(() => emailProviderFromEnvironment({ APP_ENV: 'production', EMAIL_PROVIDER: 'log' })).toThrow('must be smtp')
    expect(() => emailProviderFromEnvironment({ APP_ENV: 'production', EMAIL_PROVIDER: 'api' })).toThrow('must be smtp')
    expect(() => emailProviderFromEnvironment({ APP_ENV: 'production', EMAIL_PROVIDER: 'smtp' })).toThrow('SMTP_HOST')
    expect(() =>
      emailProviderFromEnvironment({
        APP_ENV: 'production',
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.test',
        EMAIL_FROM: '   '
      })
    ).toThrow('EMAIL_FROM')

    expect(
      emailProviderFromEnvironment({
        APP_ENV: 'production',
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.test',
        EMAIL_FROM: 'pedidos@neteco.es',
        SMTP_USER: '   '
      })
    ).toBeInstanceOf(SmtpEmailProvider)
    expect(mail.createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ port: 587, secure: false, auth: undefined })
    )

    expect(
      emailProviderFromEnvironment({
        APP_ENV: 'production',
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: ' smtp.example.test ',
        EMAIL_FROM: ' pedidos@neteco.es ',
        SMTP_PORT: '2525',
        SMTP_SECURE: 'true',
        SMTP_USER: ' user ',
        SMTP_PASSWORD: 'password'
      })
    ).toBeInstanceOf(SmtpEmailProvider)
    expect(mail.createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: 'smtp.example.test',
        port: 2525,
        secure: true,
        auth: { user: 'user', pass: 'password' }
      })
    )
  })

  it('requires a separately configured marketing provider in production', () => {
    expect(marketingEmailProviderFromEnvironment({ APP_ENV: 'local' }).name).toBe('marketing-log')
    expect(() => marketingEmailProviderFromEnvironment({ APP_ENV: 'production' })).toThrow('separately configured')
    expect(() =>
      marketingEmailProviderFromEnvironment({
        APP_ENV: 'production',
        MARKETING_EMAIL_PROVIDER: 'smtp'
      })
    ).toThrow('MARKETING_SMTP_HOST')
    const provider = marketingEmailProviderFromEnvironment({
      APP_ENV: 'production',
      MARKETING_EMAIL_PROVIDER: 'smtp',
      MARKETING_SMTP_HOST: 'marketing.smtp.test',
      MARKETING_EMAIL_FROM: 'newsletter@neteco.es'
    })
    expect(provider).toBeInstanceOf(SmtpEmailProvider)
    expect(provider.name).toBe('marketing-smtp')
  })
})
