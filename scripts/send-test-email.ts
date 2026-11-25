/**
 * Sends one test email through the configured EMAIL_DRIVER (resend / smtp / console) to check the setup.
 *
 *   npm run email:test                      -> to GUIDE_NOTIFY_EMAIL
 *   npm run email:test -- someone@example.com
 */
import type { FastifyBaseLogger } from 'fastify'
import { loadEnv } from '@/config/env'
import { createEmailService } from '@/lib/email'

const env = loadEnv()
const to = process.argv[2] ?? env.GUIDE_NOTIFY_EMAIL
// The console driver only logs a summary line; print it plainly.
const log = { info: (obj: unknown, msg?: string) => console.info(msg ?? '', obj) } as unknown as FastifyBaseLogger
const email = createEmailService(env, log)

console.info(`Sending a test email via "${email.provider}" from ${env.MAIL_FROM} to ${to} …`)
try {
  const { id } = await email.send({
    to,
    subject: 'Serendiva — test email',
    text: `This is a test email from the Serendiva API (driver: ${email.provider}). If you can read this, email works.`,
    html: `<p>This is a test email from the Serendiva API (driver: <strong>${email.provider}</strong>).</p><p>If you can read this, email works.</p>`,
  })
  console.info(`Sent${id ? ` (id ${id})` : ''}. Check the inbox — and the spam folder.`)
} catch (err) {
  console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}
