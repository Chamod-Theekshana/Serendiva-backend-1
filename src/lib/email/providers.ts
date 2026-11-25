import fs from 'node:fs/promises'
import path from 'node:path'
import nodemailer from 'nodemailer'
import { Resend } from 'resend'
import type { FastifyBaseLogger } from 'fastify'
import type { EmailProvider } from './types'

export function createResendProvider(apiKey: string): EmailProvider {
  const resend = new Resend(apiKey)
  return {
    name: 'resend',
    async send(msg) {
      const { data, error } = await resend.emails.send({
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        replyTo: msg.replyTo,
      })
      if (error) throw new Error(`Resend error: ${error.message}`)
      return { id: data?.id }
    },
  }
}

export interface SmtpOptions {
  host: string
  port: number
  secure: boolean
  user: string
  password: string
}

/**
 * Plain SMTP (e.g. Gmail with an App Password: smtp.gmail.com, port 465, secure). Needs no domain of your own;
 * with Gmail the From address must be the signed-in account (Gmail rewrites any other address).
 */
export function createSmtpProvider(opts: SmtpOptions): EmailProvider {
  const transport = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    // Google shows App Passwords as "abcd efgh ijkl mnop"; the spaces are not part of it.
    auth: { user: opts.user, pass: opts.password.replace(/\s+/g, '') },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  })
  return {
    name: 'smtp',
    async send(msg) {
      try {
        const info = await transport.sendMail({
          from: msg.from,
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          replyTo: msg.replyTo,
        })
        return { id: info.messageId }
      } catch (err) {
        throw new Error(`SMTP error: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

/**
 * Development provider: logs a one-line summary and writes the HTML to tmp/emails so you can open it
 * in a browser. Never use in production.
 */
export function createConsoleProvider(log: FastifyBaseLogger, outDir = 'tmp/emails'): EmailProvider {
  return {
    name: 'console',
    async send(msg) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      try {
        await fs.mkdir(outDir, { recursive: true })
        await fs.writeFile(path.join(outDir, `${id}.html`), msg.html, 'utf8')
      } catch {
        // writing the preview is best-effort
      }
      log.info({ to: msg.to, subject: msg.subject, preview: `${outDir}/${id}.html` }, '[email:console] message captured')
      return { id }
    },
  }
}
