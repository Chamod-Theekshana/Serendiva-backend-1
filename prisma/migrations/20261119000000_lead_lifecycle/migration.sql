-- Lead lifecycle: new → replied → proposal_sent → confirmed, or lost / cancelled.
-- "closed" mixed up booked and lost; existing closed leads become "lost" (re-mark booked ones as confirmed).

-- CreateEnum
CREATE TYPE "LeadEventType" AS ENUM ('status', 'note', 'contact', 'follow_up', 'booking');

-- AlterEnum
BEGIN;
CREATE TYPE "LeadStatus_new" AS ENUM ('new', 'replied', 'proposal_sent', 'confirmed', 'lost', 'cancelled');
ALTER TABLE "Inquiry" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "CorporateProposal" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Inquiry" ALTER COLUMN "status" TYPE "LeadStatus_new"
  USING (CASE WHEN "status"::text = 'closed' THEN 'lost' ELSE "status"::text END)::"LeadStatus_new";
ALTER TABLE "CorporateProposal" ALTER COLUMN "status" TYPE "LeadStatus_new"
  USING (CASE WHEN "status"::text = 'closed' THEN 'lost' ELSE "status"::text END)::"LeadStatus_new";
ALTER TYPE "LeadStatus" RENAME TO "LeadStatus_old";
ALTER TYPE "LeadStatus_new" RENAME TO "LeadStatus";
DROP TYPE "LeadStatus_old";
ALTER TABLE "Inquiry" ALTER COLUMN "status" SET DEFAULT 'new';
ALTER TABLE "CorporateProposal" ALTER COLUMN "status" SET DEFAULT 'new';
COMMIT;

-- AlterTable
ALTER TABLE "AvailabilityRange" ADD COLUMN     "inquiryId" TEXT;

-- AlterTable
ALTER TABLE "Inquiry" ADD COLUMN     "bookedEnd" DATE,
ADD COLUMN     "bookedStart" DATE,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "followUpAt" DATE,
ADD COLUMN     "lastContactAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lostReason" TEXT,
ADD COLUMN     "repliedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CorporateProposal" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "followUpAt" DATE,
ADD COLUMN     "lastContactAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lostReason" TEXT,
ADD COLUMN     "repliedAt" TIMESTAMP(3);

-- Backfill: the best guesses available for existing leads (the last update is the last status change).
UPDATE "Inquiry" SET
  "lastContactAt" = CASE WHEN "status" = 'new' THEN "createdAt" ELSE "updatedAt" END,
  "repliedAt" = CASE WHEN "status" = 'replied' THEN "updatedAt" ELSE NULL END,
  "closedAt" = CASE WHEN "status" = 'lost' THEN "updatedAt" ELSE NULL END;
UPDATE "CorporateProposal" SET
  "lastContactAt" = CASE WHEN "status" = 'new' THEN "createdAt" ELSE "updatedAt" END,
  "repliedAt" = CASE WHEN "status" = 'replied' THEN "updatedAt" ELSE NULL END,
  "closedAt" = CASE WHEN "status" = 'lost' THEN "updatedAt" ELSE NULL END;

-- CreateTable
CREATE TABLE "LeadEvent" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT,
    "proposalId" TEXT,
    "type" "LeadEventType" NOT NULL,
    "fromStatus" "LeadStatus",
    "toStatus" "LeadStatus",
    "text" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadEvent_pkey" PRIMARY KEY ("id"),
    -- Exactly one lead per event.
    CONSTRAINT "LeadEvent_one_lead_check" CHECK (("inquiryId" IS NULL) <> ("proposalId" IS NULL))
);

-- CreateTable
CREATE TABLE "JobState" (
    "key" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobState_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "LeadEvent_inquiryId_createdAt_idx" ON "LeadEvent"("inquiryId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadEvent_proposalId_createdAt_idx" ON "LeadEvent"("proposalId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AvailabilityRange_inquiryId_key" ON "AvailabilityRange"("inquiryId");

-- CreateIndex
CREATE INDEX "Inquiry_followUpAt_idx" ON "Inquiry"("followUpAt");

-- CreateIndex
CREATE INDEX "Inquiry_lastContactAt_idx" ON "Inquiry"("lastContactAt");

-- CreateIndex
CREATE INDEX "CorporateProposal_followUpAt_idx" ON "CorporateProposal"("followUpAt");

-- CreateIndex
CREATE INDEX "CorporateProposal_lastContactAt_idx" ON "CorporateProposal"("lastContactAt");

-- AddForeignKey
ALTER TABLE "AvailabilityRange" ADD CONSTRAINT "AvailabilityRange_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEvent" ADD CONSTRAINT "LeadEvent_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEvent" ADD CONSTRAINT "LeadEvent_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "CorporateProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
