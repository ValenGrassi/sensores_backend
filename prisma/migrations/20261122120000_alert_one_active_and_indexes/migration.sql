-- Migración compatible con la versión anterior del backend: solo agrega índices.
-- Se puede aplicar antes o después de desplegar el código nuevo.

-- 1) Una sola alerta activa por sensor y tipo.
--    Si ya hubiera repetidas, se conserva la más vieja (cuándo empezó el problema)
--    y se resuelven las demás; si no, el índice único no se podría crear.
UPDATE "Alert" AS a
SET "active" = false, "resolvedAt" = CURRENT_TIMESTAMP
WHERE a."active" = true
  AND EXISTS (
    SELECT 1 FROM "Alert" AS older
    WHERE older."sensorId" = a."sensorId"
      AND older."type" = a."type"
      AND older."active" = true
      AND (older."createdAt" < a."createdAt" OR (older."createdAt" = a."createdAt" AND older."id" < a."id"))
  );

-- CreateIndex
CREATE UNIQUE INDEX "Alert_sensorId_type_key" ON "Alert"("sensorId", "type") WHERE ("active" = true);

-- 2) Índices para las búsquedas por relación y el historial por fecha.

-- CreateIndex
CREATE INDEX "Alert_sensorId_idx" ON "Alert"("sensorId");

-- CreateIndex
CREATE INDEX "Measurement_timestamp_idx" ON "Measurement"("timestamp");

-- CreateIndex
CREATE INDEX "Room_cinemaId_idx" ON "Room"("cinemaId");

-- CreateIndex
CREATE INDEX "Room_profileId_idx" ON "Room"("profileId");

-- CreateIndex
CREATE INDEX "Sensor_roomId_idx" ON "Sensor"("roomId");
