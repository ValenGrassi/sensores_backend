/**
 * Compara las migraciones de prisma/migrations con las aplicadas en la base.
 * Si falta aplicar alguna, el backend sigue funcionando, pero lo avisa en los
 * logs y en GET /api/health ("schema": "outdated").
 */

const fs = require("fs");
const path = require("path");
const prisma = require("./prisma");

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "prisma", "migrations");

let state = { checked: false, pending: [] };

async function checkMigrations() {
  try {
    const local = fs
      .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    const rows = await prisma.$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;

    const applied = new Set(rows.map((row) => row.migration_name));
    const pending = local.filter((name) => !applied.has(name));

    state = { checked: true, pending };

    if (pending.length > 0) {
      console.warn(
        `[db] Hay ${pending.length} migración(es) sin aplicar: ${pending.join(", ")}. ` +
          "Ejecutá `npx prisma migrate deploy`."
      );
    }
  } catch (error) {
    state = { checked: false, pending: [] };
    console.warn("[db] No se pudo verificar el estado de las migraciones:", error.message);
  }

  return state;
}

function getMigrationState() {
  return state;
}

module.exports = { checkMigrations, getMigrationState };
