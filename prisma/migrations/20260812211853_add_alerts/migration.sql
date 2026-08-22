-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('temperature_high', 'temperature_low', 'humidity_high', 'humidity_low');

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "sensorId" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL,
    "humidity" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_sensorId_fkey" FOREIGN KEY ("sensorId") REFERENCES "Sensor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
