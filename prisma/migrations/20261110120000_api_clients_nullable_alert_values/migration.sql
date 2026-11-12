-- Migración compatible con la versión anterior del backend:
-- solo agrega una tabla y relaja dos restricciones NOT NULL.
-- Se puede aplicar ANTES de desplegar el código nuevo sin afectar nada.

-- 1) Las alertas guardan null (en vez de 0) cuando el sensor no informó un valor.
ALTER TABLE "Alert" ALTER COLUMN "temperature" DROP NOT NULL;
ALTER TABLE "Alert" ALTER COLUMN "humidity" DROP NOT NULL;

-- 2) Clientes externos con permiso de escritura (API keys hasheadas).
CREATE TABLE "ApiClient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "permissions" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiClient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiClient_keyHash_key" ON "ApiClient"("keyHash");

-- En Supabase, las tablas de "public" quedan expuestas por la Data API.
-- Con RLS activado y sin políticas, nadie puede leerla por esa vía;
-- el backend (dueño de la tabla) la sigue usando normalmente.
ALTER TABLE "ApiClient" ENABLE ROW LEVEL SECURITY;
