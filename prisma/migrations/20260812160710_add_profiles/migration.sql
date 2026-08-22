-- CreateTable
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "temperatureMin" DOUBLE PRECISION NOT NULL,
    "temperatureMax" DOUBLE PRECISION NOT NULL,
    "humidityMin" DOUBLE PRECISION NOT NULL,
    "humidityMax" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);
