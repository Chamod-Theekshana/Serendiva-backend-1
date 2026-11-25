import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type { AppDeps } from '@/types'
import { isoDate } from '@/lib/dates'
import { guideFollowUpDigestEmail, type FollowUpDigestItem } from '@/lib/email/templates'
import { tr } from '@/lib/i18n'
import { siteUrl } from '@/modules/inquiries/lead-helpers'
import { dueWhere, leadOrder, utcToday } from '@/modules/inquiries/lead-lifecycle'
import { errorMessage } from '@/modules/inquiries/lead-helpers'

export const FOLLOW_UP_DIGEST_JOB_KEY = 'follow_up_digest'

const FIRST_RUN_DELAY_MS = 60_000
const CHECK_INTERVAL_MS = 30 * 60_000
const MAX_ITEMS_PER_BUCKET = 100

export interface FollowUpDigestSummary {
  ran: boolean
  sent: boolean
  overdueReplies: number
  dueFollowUps: number
}

/** True once the configured UTC hour has arrived and the digest has not yet run today (UTC). */
export function shouldRunDailyDigest(now: Date, lastRunAt: Date | null, digestHourUtc: number): boolean {
  if (now.getUTCHours() < digestHourUtc) return false
  if (!lastRunAt) return true
  return lastRunAt < utcToday(now)
}

/**
 * Daily follow-up digest job: collects open leads whose promised reply window has elapsed or whose
 * scheduled follow-up date is today (UTC) or earlier, emails the guide when at least one lead needs
 * attention, and records `lastRunAt` in `JobState`.
 */
export function createFollowUpDigestRunner(deps: AppDeps, log: FastifyBaseLogger) {
  const { env, prisma, email } = deps

  return async function runOnce(now = new Date(), opts: { force?: boolean } = {}): Promise<FollowUpDigestSummary> {
    const state = await prisma.jobState.findUnique({ where: { key: FOLLOW_UP_DIGEST_JOB_KEY } })
    if (!opts.force && !shouldRunDailyDigest(now, state?.lastRunAt ?? null, env.FOLLOW_UP_DIGEST_HOUR_UTC)) {
      return { ran: false, sent: false, overdueReplies: 0, dueFollowUps: 0 }
    }

    const replyWhere = dueWhere('reply', env.RESPONSE_HOURS, now)
    const followUpWhere = dueWhere('followUp', env.RESPONSE_HOURS, now)
    const replyOrder = leadOrder({ due: 'reply' })
    const followUpOrder = leadOrder({ due: 'followUp' })

    const [overdueInq, overdueProp, followInq, followProp] = await Promise.all([
      prisma.inquiry.findMany({
        where: replyWhere,
        orderBy: replyOrder,
        take: MAX_ITEMS_PER_BUCKET,
        select: {
          id: true,
          reference: true,
          name: true,
          country: true,
          createdAt: true,
          tour: { select: { slug: true, title: true } },
        },
      }),
      prisma.corporateProposal.findMany({
        where: replyWhere,
        orderBy: replyOrder,
        take: MAX_ITEMS_PER_BUCKET,
        select: { id: true, reference: true, company: true, contactPerson: true, createdAt: true },
      }),
      prisma.inquiry.findMany({
        where: followUpWhere,
        orderBy: followUpOrder,
        take: MAX_ITEMS_PER_BUCKET,
        select: {
          id: true,
          reference: true,
          name: true,
          country: true,
          followUpAt: true,
          tour: { select: { slug: true, title: true } },
        },
      }),
      prisma.corporateProposal.findMany({
        where: followUpWhere,
        orderBy: followUpOrder,
        take: MAX_ITEMS_PER_BUCKET,
        select: { id: true, reference: true, company: true, contactPerson: true, followUpAt: true },
      }),
    ])

    const overdueReplies: FollowUpDigestItem[] = [
      ...overdueInq.map((i) => ({
        kind: 'inquiry' as const,
        id: i.id,
        reference: i.reference,
        title: i.name,
        subtitle: [i.tour ? tr<string>(i.tour.title, 'en', i.tour.slug) : null, i.country].filter(Boolean).join(' · ') || null,
        dateLabel: `Received ${i.createdAt.toISOString().slice(0, 10)}`,
        adminUrl: siteUrl(env.FRONTEND_URL, 'en', `/admin/inquiries?id=${encodeURIComponent(i.id)}`),
      })),
      ...overdueProp.map((p) => ({
        kind: 'proposal' as const,
        id: p.id,
        reference: p.reference,
        title: p.company,
        subtitle: p.contactPerson,
        dateLabel: `Received ${p.createdAt.toISOString().slice(0, 10)}`,
        adminUrl: siteUrl(env.FRONTEND_URL, 'en', `/admin/proposals?id=${encodeURIComponent(p.id)}`),
      })),
    ]

    const dueFollowUps: FollowUpDigestItem[] = [
      ...followInq.map((i) => ({
        kind: 'inquiry' as const,
        id: i.id,
        reference: i.reference,
        title: i.name,
        subtitle: [i.tour ? tr<string>(i.tour.title, 'en', i.tour.slug) : null, i.country].filter(Boolean).join(' · ') || null,
        dateLabel: `Follow up ${isoDate(i.followUpAt) ?? 'due'}`,
        adminUrl: siteUrl(env.FRONTEND_URL, 'en', `/admin/inquiries?id=${encodeURIComponent(i.id)}`),
      })),
      ...followProp.map((p) => ({
        kind: 'proposal' as const,
        id: p.id,
        reference: p.reference,
        title: p.company,
        subtitle: p.contactPerson,
        dateLabel: `Follow up ${isoDate(p.followUpAt) ?? 'due'}`,
        adminUrl: siteUrl(env.FRONTEND_URL, 'en', `/admin/proposals?id=${encodeURIComponent(p.id)}`),
      })),
    ]

    const total = overdueReplies.length + dueFollowUps.length
    let sent = false
    if (total > 0) {
      const rendered = guideFollowUpDigestEmail({
        dateIso: now.toISOString().slice(0, 10),
        responseHours: env.RESPONSE_HOURS,
        overdueReplies,
        dueFollowUps,
        adminDashboardUrl: siteUrl(env.FRONTEND_URL, 'en', '/admin'),
      })
      await email.send({ ...rendered, to: env.GUIDE_NOTIFY_EMAIL })
      sent = true
    }

    await prisma.jobState.upsert({
      where: { key: FOLLOW_UP_DIGEST_JOB_KEY },
      create: { key: FOLLOW_UP_DIGEST_JOB_KEY, lastRunAt: now },
      update: { lastRunAt: now },
    })

    const summary: FollowUpDigestSummary = {
      ran: true,
      sent,
      overdueReplies: overdueReplies.length,
      dueFollowUps: dueFollowUps.length,
    }
    if (sent) log.info(summary, 'follow-up digest email sent')
    else log.debug(summary, 'follow-up digest checked (nothing due)')
    return summary
  }
}

/**
 * Starts the daily follow-up digest scheduler (~1 min after boot, then every 30 min until sent for
 * the UTC day). Runs never overlap and never throw. Returns a stop function.
 */
export function startFollowUpDigestJob(app: FastifyInstance): () => void {
  const log = app.log.child({ job: 'follow-up-digest' })
  const runOnce = createFollowUpDigestRunner(app.deps, log)
  let running = false
  let stopped = false

  const tick = async () => {
    if (running || stopped) return
    running = true
    try {
      await runOnce()
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'follow-up digest run failed')
    } finally {
      running = false
    }
  }

  const first = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS)
  const interval = setInterval(() => void tick(), CHECK_INTERVAL_MS)
  first.unref()
  interval.unref()
  log.info({ hourUtc: app.deps.env.FOLLOW_UP_DIGEST_HOUR_UTC }, 'follow-up digest job scheduled')

  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(interval)
  }
}
