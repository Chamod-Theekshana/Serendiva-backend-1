import { loadEnv } from '@/config/env'
import { buildApp } from '@/app'
import { startDataRetentionJob } from '@/jobs/data-retention'
import { startEmailRetryJob } from '@/jobs/email-retry'
import { startFollowUpDigestJob } from '@/jobs/follow-up-digest'

const env = loadEnv()
const app = await buildApp({ env })

const stopRetry = env.EMAIL_RETRY_DISABLED ? () => {} : startEmailRetryJob(app)
const stopDigest = env.FOLLOW_UP_DIGEST_DISABLED ? () => {} : startFollowUpDigestJob(app)
const stopRetention = env.RETENTION_DISABLED ? () => {} : startDataRetentionJob(app)

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down')
  stopRetry()
  stopDigest()
  stopRetention()
  await app.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await app.listen({ port: env.PORT, host: env.HOST })
  const docsNote = env.NODE_ENV !== 'production' || env.DOCS_ENABLED ? ` — docs at ${env.API_PUBLIC_URL}/docs` : ''
  app.log.info(`Serendiva API ready on ${env.API_PUBLIC_URL}${docsNote}`)
  if (env.NODE_ENV === 'production' && env.EMAIL_DRIVER === 'console') {
    app.log.warn('EMAIL_DRIVER=console in production: emails are only written to tmp/emails and nobody receives them')
  }
  if (env.NODE_ENV === 'production') {
    const examples = (['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'REVALIDATE_SECRET'] as const).filter((key) =>
      env[key].startsWith('change-me'),
    )
    if (examples.length > 0) {
      app.log.warn({ variables: examples }, 'example secrets from .env.example are in use — set unique random values')
    }
  }
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
