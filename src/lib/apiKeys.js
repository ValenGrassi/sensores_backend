/**
 * Claves de API.
 *
 * - La clave de administrador (la tuya) se define en la variable ADMIN_API_KEY.
 * - Las claves de terceros se crean con `npm run clients -- create` y en la base
 *   se guarda solo su hash SHA-256: si alguien lee la tabla, no obtiene las claves.
 */

const crypto = require("crypto");
const prisma = require("./prisma");
const config = require("../config");
const { ALL } = require("./permissions");

const KEY_PREFIX = "sk_";
const CACHE_TTL_MS = 60 * 1000; // una clave revocada deja de funcionar en menos de 1 minuto
const CACHE_MAX_ENTRIES = 1000;
const LAST_USED_EVERY_MS = 60 * 60 * 1000; // actualizar lastUsedAt como mucho una vez por hora

const ADMIN_CLIENT = Object.freeze({
  id: "admin",
  name: "Administrador",
  type: "admin",
  permissions: Object.freeze([ALL]),
});

const adminHash = config.adminApiKey ? hashApiKey(config.adminApiKey) : null;
const cache = new Map();
const lastTouched = new Map();
const warned = new Set();

function generateApiKey() {
  return KEY_PREFIX + crypto.randomBytes(24).toString("base64url");
}

function hashApiKey(key) {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

/** Primeros caracteres, para reconocer una clave sin mostrarla entera. */
function keyPrefixOf(key) {
  return key.slice(0, 10);
}

function sameHash(a, b) {
  const bufferA = Buffer.from(a, "hex");
  const bufferB = Buffer.from(b, "hex");
  return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB);
}

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[auth] ${message}`);
}

async function findClientByHash(hash) {
  if (!prisma.apiClient) {
    warnOnce("no-model", "El cliente de Prisma no conoce ApiClient. Ejecutá `npx prisma generate`.");
    return null;
  }

  try {
    const row = await prisma.apiClient.findUnique({ where: { keyHash: hash } });
    if (!row || row.revokedAt) return null;

    return {
      id: row.id,
      name: row.name,
      type: "client",
      permissions: row.permissions,
      lastUsedAt: row.lastUsedAt,
    };
  } catch (error) {
    if (error?.code === "P2021") {
      warnOnce("no-table", "Falta la tabla ApiClient. Ejecutá `npx prisma migrate deploy`.");
      return null;
    }
    throw error;
  }
}

function touchLastUsed(client) {
  const now = Date.now();
  const previous = lastTouched.get(client.id) ?? client.lastUsedAt?.getTime() ?? 0;
  if (now - previous < LAST_USED_EVERY_MS) return;

  lastTouched.set(client.id, now);
  prisma.apiClient
    .update({ where: { id: client.id }, data: { lastUsedAt: new Date(now) } })
    .catch((error) => console.warn("[auth] No se pudo actualizar lastUsedAt:", error.message));
}

/** Devuelve el cliente dueño de la clave, o null si la clave no es válida. */
async function resolveApiKey(key) {
  if (typeof key !== "string" || key.length < 16 || key.length > 200) return null;

  const hash = hashApiKey(key);

  if (adminHash && sameHash(hash, adminHash)) {
    return ADMIN_CLIENT;
  }

  const cached = cache.get(hash);
  if (cached && cached.expires > Date.now()) {
    return cached.client;
  }

  const client = await findClientByHash(hash);

  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(hash, { client, expires: Date.now() + CACHE_TTL_MS });

  if (client) touchLastUsed(client);
  return client;
}

module.exports = { generateApiKey, hashApiKey, keyPrefixOf, resolveApiKey };
