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

interface BrevoMailbox {
  email: string
  name?: string
}

function parseMailbox(raw: string): BrevoMailbox {
  const trimmed = raw.trim()
  const match = /^(.*)<([^<>]+)>$/.exec(trimmed)
  if (!match) return { email: trimmed }
  const email = (match[2] ?? '').trim()
  const name = (match[1] ?? '').trim().replace(/^["']|["']$/g, '')
  return name ? { name, email } : { email }
}

/**
 * Brevo Transactional Email HTTP API (port 443). Works on platforms that block outbound SMTP
 * (such as Railway Trial/Hobby) and allows sending with a verified single sender address.
 */
export function createBrevoProvider(apiKey: string, fetchImpl: typeof fetch = fetch): EmailProvider {
  return {
    name: 'brevo',
    async send(msg) {
      const recipients = Array.isArray(msg.to) ? msg.to : [msg.to]
      try {
        const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'api-key': apiKey,
          },
          body: JSON.stringify({
            sender: parseMailbox(msg.from),
            to: recipients.map(parseMailbox),
            subject: msg.subject,
            htmlContent: msg.html,
            textContent: msg.text,
            ...(msg.replyTo ? { replyTo: parseMailbox(msg.replyTo) } : {}),
          }),
          signal: AbortSignal.timeout(15_000),
        })
        const rawText = await res.text()
        let parsed: Record<string, unknown> | null = null
        if (rawText) {
          try {
            const json: unknown = JSON.parse(rawText)
            if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
              parsed = json as Record<string, unknown>
            }
          } catch {
            // non-JSON response body
          }
        }
        if (!res.ok) {
          const msgPart = typeof parsed?.message === 'string' ? parsed.message : rawText || res.statusText
          const codePart = typeof parsed?.code === 'string' ? `${parsed.code}: ` : ''
          throw new Error(`Brevo error: ${res.status} ${codePart}${msgPart}`.trim())
        }
        const messageId = typeof parsed?.messageId === 'string' ? parsed.messageId : undefined
        return { id: messageId }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Brevo error:')) throw err
        throw new Error(`Brevo error: ${err instanceof Error ? err.message : String(err)}`)
      }
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
