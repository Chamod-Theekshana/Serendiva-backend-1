import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type { AppDeps } from '@/types'
import { errorMessage } from '@/modules/inquiries/lead-helpers'
import { utcToday } from '@/modules/inquiries/lead-lifecycle'

export const DATA_RETENTION_JOB_KEY = 'data_retention'

const FIRST_RUN_DELAY_MS = 90_000
const CHECK_INTERVAL_MS = 6 * 60 * 60_000
const BATCH_LIMIT = 200

export interface RetentionCutoffs {
  /** Inquiries & proposals that never became a confirmed booking: 24 months after last contact. */
  nonConfirmedLeadCutoff: Date
  /** Confirmed bookings: 6 years (72 months) after journey end / last contact. */
  confirmedLeadCutoff: Date
  /** Corporate proposal file attachments: 12 months after receipt. */
  proposalAttachmentCutoff: Date
  /** Unconfirmed newsletter sign-ups: 30 days after sign-up. */
  unconfirmedNewsletterCutoff: Date
}

export interface DataRetentionSummary {
  ran: boolean
  inquiriesDeleted: number
  proposalsDeleted: number
  proposalAttachmentsDeleted: number
  newsletterSignupsDeleted: number
}

/** Calendar-month subtraction in UTC, clamping end-of-month days cleanly (e.g. Mar 31 - 1 mo -> Feb 28). */
export function subMonthsUtc(date: Date, months: number): Date {
  const d = new Date(date.getTime())
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - months)
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, lastDay))
  return d
}

/** Privacy-policy retention cutoffs relative to `now`. */
export function retentionCutoffs(now = new Date()): RetentionCutoffs {
  return {
    nonConfirmedLeadCutoff: subMonthsUtc(now, 24),
    confirmedLeadCutoff: subMonthsUtc(now, 72),
    proposalAttachmentCutoff: subMonthsUtc(now, 12),
    unconfirmedNewsletterCutoff: new Date(now.getTime() - 30 * 86_400_000),
  }
}

/** True when a once-per-UTC-day job has not run today yet. */
export function shouldRunDailyJob(now: Date, lastRunAt: Date | null): boolean {
  if (!lastRunAt) return true
  return lastRunAt < utcToday(now)
}

/** Confirmed inquiry expires 6 years after `bookedEnd ?? travelEnd ?? lastContactAt`. */
export function isConfirmedInquiryExpired(
  row: { bookedEnd: Date | null; travelEnd: Date | null; lastContactAt: Date },
  cutoff: Date,
): boolean {
  const anchor = row.bookedEnd ?? row.travelEnd ?? row.lastContactAt
  return anchor < cutoff
}

/**
 * Daily GDPR data retention job enforcing the privacy-policy retention windows via `JobState`.
 */
export function createDataRetentionRunner(deps: AppDeps, log: FastifyBaseLogger) {
  const { prisma, storage } = deps

  return async function runOnce(now = new Date(), opts: { force?: boolean } = {}): Promise<DataRetentionSummary> {
    const state = await prisma.jobState.findUnique({ where: { key: DATA_RETENTION_JOB_KEY } })
    if (!opts.force && !shouldRunDailyJob(now, state?.lastRunAt ?? null)) {
      return {
        ran: false,
        inquiriesDeleted: 0,
        proposalsDeleted: 0,
        proposalAttachmentsDeleted: 0,
        newsletterSignupsDeleted: 0,
      }
    }

    const c = retentionCutoffs(now)
    let inquiriesDeleted = 0
    let proposalsDeleted = 0
    let proposalAttachmentsDeleted = 0

    // 1. Inquiries without a confirmed journey (24 months after lastContactAt)
    const oldOpenInquiries = await prisma.inquiry.findMany({
      where: { status: { not: 'confirmed' }, lastContactAt: { lt: c.nonConfirmedLeadCutoff } },
      select: { id: true },
      take: BATCH_LIMIT,
    })

    // 2. Confirmed inquiries (6 years after bookedEnd ?? travelEnd ?? lastContactAt)
    const confirmedCandidates = await prisma.inquiry.findMany({
      where: {
        status: 'confirmed',
        OR: [
          { bookedEnd: { lt: c.confirmedLeadCutoff } },
          { bookedEnd: null, travelEnd: { lt: c.confirmedLeadCutoff } },
          { bookedEnd: null, travelEnd: null, lastContactAt: { lt: c.confirmedLeadCutoff } },
        ],
      },
      select: { id: true, bookedEnd: true, travelEnd: true, lastContactAt: true },
      take: BATCH_LIMIT,
    })

    const expiredInquiryIds = [
      ...oldOpenInquiries.map((r) => r.id),
      ...confirmedCandidates.filter((r) => isConfirmedInquiryExpired(r, c.confirmedLeadCutoff)).map((r) => r.id),
    ]
    for (const id of expiredInquiryIds) {
      await prisma.$transaction(async (tx) => {
        await tx.availabilityRange.deleteMany({ where: { inquiryId: id } })
        await tx.inquiry.deleteMany({ where: { id } })
      })
      inquiriesDeleted++
    }

    // 3. Corporate proposal attachments older than 12 months
    const oldAttachments = await prisma.corporateProposal.findMany({
      where: { attachmentId: { not: null }, createdAt: { lt: c.proposalAttachmentCutoff } },
      select: { id: true, attachment: { select: { id: true, key: true } } },
      take: BATCH_LIMIT,
    })
    for (const row of oldAttachments) {
      if (!row.attachment) continue
      const mediaId = row.attachment.id
      const key = row.attachment.key
      await prisma.$transaction(async (tx) => {
        await tx.corporateProposal.update({ where: { id: row.id }, data: { attachmentId: null } })
        await tx.media.deleteMany({ where: { id: mediaId } })
      })
      await storage
        .delete(key)
        .catch((err: unknown) => log.warn({ proposalId: row.id, err: errorMessage(err) }, 'retention: failed to delete attachment file'))
      proposalAttachmentsDeleted++
    }

    // 4. Expired corporate proposals (24 months non-confirmed, 6 years confirmed)
    const expiredProposals = await prisma.corporateProposal.findMany({
      where: {
        OR: [
          { status: { not: 'confirmed' }, lastContactAt: { lt: c.nonConfirmedLeadCutoff } },
          { status: 'confirmed', lastContactAt: { lt: c.confirmedLeadCutoff } },
        ],
      },
      select: { id: true },
      take: BATCH_LIMIT,
    })
    for (const row of expiredProposals) {
      const key = await prisma.$transaction(async (tx) => {
        const deleted = await tx.corporateProposal.delete({
          where: { id: row.id },
          select: { attachment: { select: { id: true, key: true } } },
        })
        if (deleted.attachment) await tx.media.deleteMany({ where: { id: deleted.attachment.id } })
        return deleted.attachment?.key ?? null
      })
      if (key) {
        await storage
          .delete(key)
          .catch((err: unknown) => log.warn({ proposalId: row.id, err: errorMessage(err) }, 'retention: failed to delete proposal file'))
      }
      proposalsDeleted++
    }

    // 5. Unconfirmed newsletter sign-ups older than 30 days
    const { count: newsletterSignupsDeleted } = await prisma.newsletterSubscriber.deleteMany({
      where: { confirmedAt: null, unsubscribedAt: null, createdAt: { lt: c.unconfirmedNewsletterCutoff } },
    })

    await prisma.jobState.upsert({
      where: { key: DATA_RETENTION_JOB_KEY },
      create: { key: DATA_RETENTION_JOB_KEY, lastRunAt: now },
      update: { lastRunAt: now },
    })

    const summary: DataRetentionSummary = {
      ran: true,
      inquiriesDeleted,
      proposalsDeleted,
      proposalAttachmentsDeleted,
      newsletterSignupsDeleted,
    }
    if (inquiriesDeleted || proposalsDeleted || proposalAttachmentsDeleted || newsletterSignupsDeleted) {
      log.info(summary, 'data retention cleanup finished')
    } else {
      log.debug(summary, 'data retention cleanup checked (nothing expired)')
    }
    return summary
  }
}

/**
 * Starts the daily retention scheduler (~90 s after boot, then every 6 h; `JobState` ensures at most
 * one run per UTC day). Never throws; returns a stop function.
 */
export function startDataRetentionJob(app: FastifyInstance): () => void {
  const log = app.log.child({ job: 'data-retention' })
  const runOnce = createDataRetentionRunner(app.deps, log)
  let running = false
  let stopped = false

  const tick = async () => {
    if (running || stopped) return
    running = true
    try {
      await runOnce()
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'data retention run failed')
    } finally {
      running = false
    }
  }

  const first = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS)
  const interval = setInterval(() => void tick(), CHECK_INTERVAL_MS)
  first.unref()
  interval.unref()
  log.info('data retention job scheduled')

  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(interval)
  }
}
