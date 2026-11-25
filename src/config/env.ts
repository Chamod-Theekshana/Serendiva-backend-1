import { z } from 'zod'

/**
 * Environment variables are validated once at start-up. If anything is missing or malformed the
 * process exits immediately with a readable list of problems ("fail fast").
 */
const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1')

/**
 * Fastify `trustProxy`: "false"/"" (default), a hop count such as "1" (recommended behind one platform
 * proxy), a comma-separated list of proxy IPs/CIDRs, or "true". "true" trusts every X-Forwarded-For
 * entry, so clients can choose their own IP and slip past per-IP rate limits — avoid it.
 */
const trustProxy = z
  .string()
  .optional()
  .transform((v): boolean | number | string[] => {
    const s = (v ?? '').trim().toLowerCase()
    if (s === '' || s === 'false' || s === '0') return false
    if (s === 'true') return true
    if (/^\d+$/.test(s)) return Number(s)
    return s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  })

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Public base URL of this API (used for local-disk media URLs and docs) */
    API_PUBLIC_URL: z.url().default('http://localhost:4000'),
    /** Expose /docs and /openapi.json in production (always enabled outside production). */
    DOCS_ENABLED: bool,
    TRUST_PROXY: trustProxy,

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    CORS_ORIGINS: csv,
    FRONTEND_URL: z.url().default('http://localhost:3000'),
    REVALIDATE_SECRET: z.string().min(16, 'REVALIDATE_SECRET must be at least 16 characters'),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    /** e.g. ".serendiva.com" when web and API share a parent domain; empty = host-only cookies */
    COOKIE_DOMAIN: z.string().optional().transform((v) => (v ? v : undefined)),
    COOKIE_SECURE: z
      .enum(['true', 'false', 'auto'])
      .default('auto'),
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

    ADMIN_SEED_EMAIL: z.email().optional(),
    ADMIN_SEED_PASSWORD: z.string().min(10).optional(),
    ADMIN_SEED_NAME: z.string().default('Dinesh Jayasuriya'),

    EMAIL_DRIVER: z.enum(['resend', 'smtp', 'console']).default('console'),
    RESEND_API_KEY: z.string().optional(),
    /** SMTP (EMAIL_DRIVER=smtp) — defaults fit Gmail with an App Password. */
    SMTP_HOST: z.string().default('smtp.gmail.com'),
    SMTP_PORT: z.coerce.number().int().positive().default(465),
    /** TLS from the start (port 465). Use false with port 587 (STARTTLS). */
    SMTP_SECURE: z
      .enum(['true', 'false', '1', '0', ''])
      .optional()
      .transform((v) => (v === undefined || v === '' ? true : v === 'true' || v === '1')),
    SMTP_USER: z.string().optional().transform((v) => (v ? v : undefined)),
    SMTP_PASSWORD: z.string().optional().transform((v) => (v ? v : undefined)),
    MAIL_FROM: z.string().default('Serendiva <hello@serendiva.lk>'),
    GUIDE_NOTIFY_EMAIL: z.email().default('guide@serendiva.lk'),

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    UPLOAD_DIR: z.string().default('uploads'),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('auto'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_PUBLIC_URL: z.string().optional(),

    /** Max form submissions (inquiry, proposal, newsletter, review) per IP per minute */
    FORM_RATE_LIMIT: z.coerce.number().int().positive().default(5),
    /**
     * Anti-spam for visitor confirmations (sent to whatever address was typed, through the guide's mailbox —
     * Gmail allows ~500 recipients/day): at most this many per email address and in total per 24 h. Over the
     * limit the inquiry is still saved and the guide is still notified; only the confirmation is skipped.
     */
    VISITOR_EMAILS_PER_ADDRESS_PER_DAY: z.coerce.number().int().positive().default(3),
    VISITOR_EMAILS_PER_DAY: z.coerce.number().int().positive().default(150),
    TURNSTILE_SECRET: z.string().optional().transform((v) => (v ? v : undefined)),

    /**
     * The reply time promised to visitors ("I will reply within 24 hours"): used in the thank-you text and
     * emails, and a lead still "new" after this many hours shows as overdue.
     */
    RESPONSE_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    /** Hour (UTC) after which the daily follow-up email goes to the guide; 3 = 08:30 in Sri Lanka. */
    FOLLOW_UP_DIGEST_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(3),
    FOLLOW_UP_DIGEST_DISABLED: bool,
    /** Turn off the daily clean-up that deletes old leads / sign-ups as the privacy policy promises. */
    RETENTION_DISABLED: bool,

    /** Disable the in-process email retry loop (tests) */
    EMAIL_RETRY_DISABLED: bool,
    EMAIL_RETRY_INTERVAL_MINUTES: z.coerce.number().int().positive().default(10),
    /** Turn off revalidation webhooks (tests / when no frontend is running) */
    REVALIDATE_DISABLED: bool,
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_DRIVER === 'resend' && !env.RESEND_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'required when EMAIL_DRIVER=resend' })
    }
    if (env.EMAIL_DRIVER === 'smtp') {
      for (const key of ['SMTP_USER', 'SMTP_PASSWORD'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required when EMAIL_DRIVER=smtp' })
      }
    }
    if (env.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_PUBLIC_URL'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required when STORAGE_DRIVER=s3' })
      }
    }
    if (env.COOKIE_SAMESITE === 'none' && env.COOKIE_SECURE === 'false') {
      ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'SameSite=None cookies must be Secure' })
    }
  })

export type Env = z.infer<typeof EnvSchema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    console.error(`\nInvalid environment configuration:\n${lines.join('\n')}\n`)
    process.exit(1)
  }
  return parsed.data
}

let cached: Env | undefined

/** Lazily validated singleton (validated on first use). */
export function env(): Env {
  cached ??= loadEnv()
  return cached
}

/** For tests: override the cached env. */
export function setEnv(next: Env): void {
  cached = next
}
