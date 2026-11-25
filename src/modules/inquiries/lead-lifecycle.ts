import type { Prisma } from '@/generated/prisma/client'
import { isoDate, parseDate } from '@/lib/dates'
import type { LeadContactBodyT, LeadStatus } from './lead-schemas'

/**
 * Lead lifecycle rules shared by inquiries and corporate proposals: which timestamps a status change sets,
 * what goes into the lead's history, and the "is a reply overdue" / "follow-up due" filters.
 * Everything here is pure (no database) so it can be unit-tested.
 */

/** Still being worked on: shows in "needs reply" / follow-up views. */
export const OPEN_STATUSES = ['new', 'replied', 'proposal_sent'] as const satisfies readonly LeadStatus[]
/** The lead ended without a journey. */
export const CLOSED_STATUSES = ['lost', 'cancelled'] as const satisfies readonly LeadStatus[]
/** The visitor has had an answer. */
const RESPONDED_STATUSES: readonly LeadStatus[] = ['replied', 'proposal_sent', 'confirmed']

const isClosed = (s: LeadStatus) => (CLOSED_STATUSES as readonly LeadStatus[]).includes(s)
const isResponded = (s: LeadStatus) => RESPONDED_STATUSES.includes(s)

/** The lifecycle columns both lead tables share. */
export interface LifecycleRow {
  status: LeadStatus
  internalNotes: string | null
  repliedAt: Date | null
  confirmedAt: Date | null
  closedAt: Date | null
  lastContactAt: Date
  followUpAt: Date | null
  lostReason: string | null
  createdAt: Date
}

export interface LifecycleUpdate {
  status?: LeadStatus
  internalNotes?: string | null
  followUpAt?: string | null
  lostReason?: string | null
}

export interface LifecycleData {
  status?: LeadStatus
  internalNotes?: string | null
  repliedAt?: Date
  confirmedAt?: Date
  closedAt?: Date | null
  lastContactAt?: Date
  followUpAt?: Date | null
  lostReason?: string | null
}

export interface LeadEventDraft {
  type: 'status' | 'note' | 'contact' | 'follow_up' | 'booking'
  fromStatus?: LeadStatus
  toStatus?: LeadStatus
  text?: string | null
  actorName: string | null
}

export interface LifecyclePlan {
  data: LifecycleData
  events: LeadEventDraft[]
}

/** Timestamps for moving from `row.status` to `next` (nothing when the status does not change). */
function statusStamps(row: LifecycleRow, next: LeadStatus, now: Date): LifecycleData {
  if (next === row.status) return {}
  const data: LifecycleData = { status: next }
  if (isResponded(next)) {
    if (!row.repliedAt) data.repliedAt = now
    data.lastContactAt = now
  }
  if (next === 'confirmed' && !row.confirmedAt) data.confirmedAt = now
  data.closedAt = isClosed(next) ? now : null
  return data
}

/** Plan an admin edit: the columns to write and the history entries to add. */
export function planLeadUpdate(row: LifecycleRow, body: LifecycleUpdate, now: Date, actorName: string | null): LifecyclePlan {
  const events: LeadEventDraft[] = []
  const data: LifecycleData = {}
  const nextStatus = body.status ?? row.status

  if (body.status && body.status !== row.status) {
    Object.assign(data, statusStamps(row, body.status, now))
    events.push({ type: 'status', fromStatus: row.status, toStatus: body.status, text: null, actorName })
  }

  // The reason only belongs to lost / cancelled leads.
  if (isClosed(nextStatus)) {
    if (body.lostReason !== undefined) {
      const reason = body.lostReason?.trim() || null
      if (reason !== row.lostReason) data.lostReason = reason
    }
    const statusEvent = events.find((e) => e.type === 'status')
    const reason = data.lostReason !== undefined ? data.lostReason : row.lostReason
    if (statusEvent && reason) statusEvent.text = reason
  } else if (row.lostReason) {
    data.lostReason = null
  }

  if (body.internalNotes !== undefined) {
    const notes = body.internalNotes?.trim() || null
    if (notes !== (row.internalNotes?.trim() || null)) {
      data.internalNotes = notes
      events.push({ type: 'note', text: notes, actorName })
    }
  }

  // A lost / cancelled lead needs no follow-up, unless a date is set in the same edit.
  let followUp: string | null | undefined = body.followUpAt
  if (followUp === undefined && isClosed(nextStatus) && !isClosed(row.status) && row.followUpAt) followUp = null
  if (followUp !== undefined && followUp !== isoDate(row.followUpAt)) {
    data.followUpAt = followUp ? parseDate(followUp) : null
    events.push({ type: 'follow_up', text: followUp, actorName })
  }

  return { data, events }
}

/** The guide logged a contact: last contact is now, and a "new" lead counts as replied. */
export function planLeadContact(row: LifecycleRow, body: LeadContactBodyT, now: Date, actorName: string | null): LifecyclePlan {
  const events: LeadEventDraft[] = []
  const data: LifecycleData = { lastContactAt: now }
  if (row.status === 'new') {
    Object.assign(data, statusStamps(row, 'replied', now))
    events.push({ type: 'status', fromStatus: 'new', toStatus: 'replied', text: null, actorName })
  }
  const note = body.note?.trim()
  events.push({ type: 'contact', text: note ? `${body.channel}: ${note}` : body.channel, actorName })
  return { data, events }
}

/** "new" and older than the promised response time. */
export const isReplyOverdue = (row: { status: LeadStatus; createdAt: Date }, responseHours: number, now = new Date()) =>
  row.status === 'new' && now.getTime() - row.createdAt.getTime() > responseHours * 3_600_000

/** Start of today (UTC) — follow-up dates are whole days. */
export const utcToday = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

/** Where-clauses for the "due" list views, shared by both lead tables. */
export function dueWhere(due: 'reply' | 'followUp', responseHours: number, now = new Date()) {
  if (due === 'reply') {
    return { status: 'new' as const, createdAt: { lt: new Date(now.getTime() - responseHours * 3_600_000) } }
  }
  return {
    followUpAt: { lte: utcToday(now) },
    status: { notIn: [...CLOSED_STATUSES] },
  }
}

/** List order for the admin views: newest first by default, oldest first for overdue replies. */
export function leadOrder(opts: { due?: 'reply' | 'followUp'; sort?: 'newest' | 'oldest' }) {
  if (opts.due === 'followUp' && !opts.sort) {
    return [{ followUpAt: 'asc' as const }, { createdAt: 'asc' as const }, { id: 'asc' as const }]
  }
  const dir = (opts.sort ?? (opts.due === 'reply' ? 'oldest' : 'newest')) === 'oldest' ? ('asc' as const) : ('desc' as const)
  return [{ createdAt: dir }, { id: dir }]
}

/** Prisma rows for the history table. */
export function eventRows(
  events: LeadEventDraft[],
  lead: { inquiryId: string } | { proposalId: string },
  now: Date,
): Prisma.LeadEventCreateManyInput[] {
  // Same-second events keep their order when read back.
  return events.map((e, i) => ({
    ...lead,
    type: e.type,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    text: e.text ?? null,
    actorName: e.actorName,
    createdAt: new Date(now.getTime() + i),
  }))
}

export function toLeadEvent(e: {
  id: string
  type: LeadEventDraft['type']
  fromStatus: LeadStatus | null
  toStatus: LeadStatus | null
  text: string | null
  actorName: string | null
  createdAt: Date
}) {
  return {
    id: e.id,
    type: e.type,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    text: e.text,
    actorName: e.actorName,
    createdAt: e.createdAt.toISOString(),
  }
}
