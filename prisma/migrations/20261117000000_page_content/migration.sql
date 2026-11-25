-- CreateTable
CREATE TABLE "PageContent" (
    "namespace" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "values" JSONB NOT NULL DEFAULT '{}',
    "hidden" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PageContent_pkey" PRIMARY KEY ("namespace","locale")
);
