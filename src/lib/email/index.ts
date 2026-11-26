import type { FastifyBaseLogger } from 'fastify'
import type { Env } from '@/config/env'
import { createBrevoProvider, createConsoleProvider, createResendProvider, createSmtpProvider } from './providers'
import type { EmailMessage, EmailProvider } from './types'

export interface EmailService {
  readonly provider: string
  send(message: EmailMessage): Promise<{ id?: string }>
}

function providerFor(env: Env, log: FastifyBaseLogger): EmailProvider {
  if (env.EMAIL_DRIVER === 'resend' && env.RESEND_API_KEY) return createResendProvider(env.RESEND_API_KEY)
  if (env.EMAIL_DRIVER === 'brevo' && env.BREVO_API_KEY) return createBrevoProvider(env.BREVO_API_KEY)
  if (env.EMAIL_DRIVER === 'smtp' && env.SMTP_USER && env.SMTP_PASSWORD) {
    return createSmtpProvider({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
    })
  }
  return createConsoleProvider(log)
}

export function createEmailService(env: Env, log: FastifyBaseLogger, provider?: EmailProvider): EmailService {
  const p = provider ?? providerFor(env, log)
  return {
    provider: p.name,
    send: (message) => p.send({ ...message, from: env.MAIL_FROM }),
  }
}

export type { EmailMessage, EmailProvider } from './types'
