import { z } from 'zod'
import { cleanText, text } from '@/lib/sanitize'

/**
 * Schema pieces shared by the two lead types (travel inquiries and corporate proposals).
 */

/** "24 hours" — the reply time promised to visitors (RESPONSE_HOURS). */
export const hoursText = (hours: number) => (hours === 1 ? '1 hour' : `${hours} hours`)
export const thankYouMessage = (responseHours: number) => `Thank you — I will reply within ${hoursText(responseHours)}.`

export const LEAD_STATUSES = ['new', 'replied', 'proposal_sent', 'confirmed', 'lost', 'cancelled'] as const
export const LeadStatusEnum = z
  .enum(LEAD_STATUSES)
  .describe('new → replied → proposal_sent → confirmed (booked), or lost / cancelled')
  .meta({ id: 'LeadStatus' })
export type LeadStatus = z.infer<typeof LeadStatusEnum>

export const LeadEventTypeEnum = z.enum(['status', 'note', 'contact', 'follow_up', 'booking']).meta({ id: 'LeadEventType' })

export const LeadEventSchema = z
  .object({
    id: z.string(),
    type: LeadEventTypeEnum,
    fromStatus: LeadStatusEnum.nullable(),
    toStatus: LeadStatusEnum.nullable(),
    text: z.string().nullable().describe('note: the notes as saved · contact: "<channel>: <note>" · follow_up: YYYY-MM-DD or null'),
    actorName: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({ id: 'LeadEvent' })

export type LeadEventT = z.infer<typeof LeadEventSchema>

export const LeadEmailStatusEnum = z
  .enum(['pending', 'sent', 'partial', 'failed'])
  .describe('sent = guide + visitor email delivered, partial = only one, failed = none after an attempt')
  .meta({ id: 'LeadEmailStatus' })

export const LeadCountsSchema = z
  .object({
    new: z.number().int(),
    replied: z.number().int(),
    proposal_sent: z.number().int(),
    confirmed: z.number().int(),
    lost: z.number().int(),
    cancelled: z.number().int(),
    total: z.number().int(),
  })
  .describe('Counts per status for the current filters (ignoring the status filter)')
  .meta({ id: 'LeadCounts' })

export type LeadCounts = z.infer<typeof LeadCountsSchema>

/** Calendar date "YYYY-MM-DD" that must exist (2026-02-30 is rejected). */
export const DateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'Use the format YYYY-MM-DD', abort: true })
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
  }, 'Invalid date')

/**
 * Optional public-form field where "" (and null) mean "not provided" — the website sends empty
 * inputs as empty strings. Text that is empty after sanitising is treated the same way.
 */
export function blankable<T extends z.ZodType>(schema: T, description?: string) {
  // The description goes on the inner schema: describing the wrapping union confuses the
  // OpenAPI generator (it would document the field as accepting only "").
  const inner = description ? schema.describe(description) : schema
  return z
    .union([z.literal(''), z.null(), inner], {
      // Report why the real value failed instead of a generic "Invalid input".
      error: (iss) => (iss.code === 'invalid_union' ? iss.errors.at(-1)?.[0]?.message : undefined),
    })
    .optional()
    .transform((v): Exclude<z.output<T>, ''> | undefined =>
      v === '' || v === null || v === undefined ? undefined : (v as Exclude<z.output<T>, ''>),
    )
}

/** Phone / WhatsApp characters (+, digits, spaces, brackets, dots, hyphens) with at least 5 digits. */
export function isValidPhone(v: string): boolean {
  return /^\+?[\d\s().-]+$/.test(v) && v.replace(/\D/g, '').length >= 5
}

export const PhoneField = text(40).pipe(
  z.string().min(5, 'Please enter a valid phone number').refine(isValidPhone, 'Please enter a valid phone number'),
)

/** Allows yesterday (UTC) as a 24h timezone buffer while rejecting genuinely past dates. */
export function isNotPastDate(ymd: string, nowMs = Date.now()): boolean {
  const minYmd = new Date(nowMs - 86_400_000).toISOString().slice(0, 10)
  return ymd >= minYmd
}

export const ClientRequestIdField = blankable(
  z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  'Random id generated once per form submission (e.g. a UUID). Sending the same id again returns the same reference instead of a duplicate.',
)

/** Email address: trimmed and lower-cased before validation. */
export const EmailField = z
  .string()
  .trim()
  .toLowerCase()
  .max(200)
  .pipe(z.email('Please enter a valid email address'))

/** Honeypot: real visitors never see this field, so any value means a bot. */
export const HoneypotField = z.string().max(500).optional().describe('Honeypot — leave empty')
export const TurnstileField = z.string().max(4096).optional().describe('Cloudflare Turnstile token (when enabled)')

/** Shared admin list filters. Dates filter on createdAt (UTC), both ends inclusive. */
export const LeadListFilters = {
  status: LeadStatusEnum.optional(),
  from: DateString.optional().describe('Created on or after (YYYY-MM-DD, UTC)'),
  to: DateString.optional().describe('Created on or before (YYYY-MM-DD, UTC)'),
  q: z.string().trim().max(100).optional(),
  due: z
    .enum(['reply', 'followUp'])
    .optional()
    .describe('reply = still "new" after the promised response time (oldest first) · followUp = follow-up date today or earlier'),
  sort: z.enum(['newest', 'oldest']).optional().describe('Default newest first (oldest first with due=reply)'),
}

export const LeadPagination = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}

/** Admin update of a lead: status, private notes, follow-up date, reason it was lost ("" or null clears). */
export const leadUpdateFields = {
  status: LeadStatusEnum.optional(),
  internalNotes: z.string().max(10_000).nullable().optional(),
  followUpAt: z
    .union([z.literal(''), DateString])
    .transform((v) => (v === '' ? null : v))
    .pipe(DateString.nullable())
    .nullable()
    .optional()
    .describe('Follow-up reminder date (YYYY-MM-DD); null clears it. Cleared automatically when the lead is lost / cancelled.'),
  lostReason: z
    .string()
    .max(600)
    .transform((v) => cleanText(v) || null)
    .pipe(z.string().max(300).nullable())
    .nullable()
    .optional()
    .describe('Why the lead was lost / cancelled (kept only for those statuses)'),
}

/** POST …/:id/contacts — the guide logged a call, message or meeting. */
export const LeadContactBody = z
  .object({
    channel: z.enum(['whatsapp', 'email', 'phone', 'meeting', 'other']),
    note: z.union([z.null(), text(500)]).optional(),
  })
  .meta({ id: 'LeadContactBody' })
export type LeadContactBodyT = z.infer<typeof LeadContactBody>

/** Lifecycle fields every admin lead returns. */
export const leadLifecycleFields = {
  repliedAt: z.string().nullable().describe('First reply (left "new")'),
  confirmedAt: z.string().nullable(),
  closedAt: z.string().nullable().describe('Became lost / cancelled'),
  lastContactAt: z.string(),
  followUpAt: z.string().nullable().describe('YYYY-MM-DD'),
  lostReason: z.string().nullable(),
  replyOverdue: z.boolean().describe('Still "new" after the promised response time'),
}

export const leadListLifecycleFields = {
  repliedAt: leadLifecycleFields.repliedAt,
  lastContactAt: leadLifecycleFields.lastContactAt,
  followUpAt: leadLifecycleFields.followUpAt,
  replyOverdue: leadLifecycleFields.replyOverdue,
}
