-- AlterTable
ALTER TABLE "CorporateProposal" ADD COLUMN     "clientRequestId" TEXT;
ALTER TABLE "CorporateProposal" ADD COLUMN     "visitorEmailSkipped" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "CorporateProposal_clientRequestId_key" ON "CorporateProposal"("clientRequestId");
