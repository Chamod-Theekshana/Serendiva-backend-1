-- AlterTable
ALTER TABLE "Inquiry" ADD COLUMN     "clientRequestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Inquiry_clientRequestId_key" ON "Inquiry"("clientRequestId");
