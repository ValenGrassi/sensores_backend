#!/usr/bin/env node
/**
 * Prueba de contrato de /api/v1: la forma de cada respuesta (campos y tipos)
 * tiene que seguir siendo la que guarda test/contract/v1.json.
 *
 *   npm run test:contract              compara con el contrato guardado
 *   npm run test:contract -- --update  guarda la forma actual como contrato
 *
 * Falla si desaparece un campo, cambia su tipo o cambia un código de estado:
 * eso rompería la app del cliente. Un campo nuevo es compatible: se informa,
 * no falla (después conviene actualizar el contrato con --update).
 *
 * Necesita una base de datos LOCAL y desechable, con las migraciones aplicadas:
 * borra todo y carga datos de prueba. En GitHub Actions la crea el workflow.
 */

const fs = require("fs");
const path = require("path");

const CONTRACT_FILE = path.join(__dirname, "v1.json");
const UPDATE = process.argv.includes("--update");
const CLIENT_KEY = "sk_contract_client_key_0123456789";

const dbUrl = process.env.DATABASE_URL || "";
let dbHost = "";
try {
  dbHost = new URL(dbUrl).hostname;
} catch {
  // se informa abajo
}
if (!["localhost", "127.0.0.1"].includes(dbHost)) {
  console.error("La prueba de contrato borra la base: solo corre contra una base local (DATABASE_URL en localhost).");
  process.exit(1);
}

const prisma = require("../../src/lib/prisma");
const { createApp } = require("../../src/app");
const { hashApiKey, keyPrefixOf } = require("../../src/lib/apiKeys");

// ─── Datos fijos ───────────────────────────────────────────────────────────

async function seed() {
  const tables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
  }

  const now = Date.now();
  await prisma.profile.create({
    data: { id: "prof_proy", name: "Proyección", description: "Cabinas", temperatureMin: 18, temperatureMax: 24, humidityMin: 30, humidityMax: 60 },
  });
  await prisma.cinema.create({ data: { id: "cin_1", name: "Cine Centro", address: "Av. Siempre Viva 123" } });
  await prisma.room.create({ data: { id: "room_1", name: "Cabina 1", type: "projection", cinemaId: "cin_1", profileId: "prof_proy" } });

  // Un sensor asignado con lecturas, y uno recién registrado (sin nombre, sala ni lecturas).
  const sensor = await prisma.sensor.create({
    data: { devEui: "a84041000181c4b1", name: "Cabina 1 - A", roomId: "room_1", temperature: 22.5, humidity: 65, battery: 90, lastSeen: new Date(now - 60000) },
  });
  await prisma.sensor.create({ data: { devEui: "a84041000181c4b9" } });

  const readings = [];
  for (let i = 0; i < 480; i++) {
    readings.push({
      sensorId: sensor.id,
      timestamp: new Date(now - (i + 1) * 30 * 60000),
      temperature: 21 + (i % 7) / 2,
      humidity: 50 + (i % 5),
      battery: i % 3 === 0 ? 90 : null,
    });
  }
  await prisma.measurement.createMany({ data: readings });

  await prisma.alert.create({ data: { sensorId: sensor.id, type: "humidity_high", temperature: 22.5, humidity: 65, active: true } });
  await prisma.alert.create({
    data: { sensorId: sensor.id, type: "temperature_high", temperature: 26, humidity: null, active: false, resolvedAt: new Date(now - 3600000) },
  });

  await prisma.apiClient.create({
    data: { name: "Contrato", keyHash: hashApiKey(CLIENT_KEY), keyPrefix: keyPrefixOf(CLIENT_KEY), permissions: ["sensors:write"] },
  });
}

// ─── Forma de una respuesta ───────────────────────────────────────────────

/** { types, fields?, items?, optional? }: tipos posibles, campos de objeto e ítems de lista. */
function shapeOf(value) {
  if (value === null) return { types: ["null"] };
  if (Array.isArray(value)) {
    const node = { types: ["array"] };
    for (const item of value) node.items = node.items ? merge(node.items, shapeOf(item)) : shapeOf(item);
    return node;
  }
  if (typeof value === "object") {
    const fields = {};
    for (const key of Object.keys(value).sort()) fields[key] = shapeOf(value[key]);
    return { types: ["object"], fields };
  }
  return { types: [typeof value] };
}

function merge(a, b) {
  const out = { types: [...new Set([...a.types, ...b.types])].sort() };
  if (a.fields || b.fields) {
    out.fields = {};
    const bothObjects = Boolean(a.fields && b.fields);
    const keys = [...new Set([...Object.keys(a.fields || {}), ...Object.keys(b.fields || {})])].sort();
    for (const key of keys) {
      const left = a.fields?.[key];
      const right = b.fields?.[key];
      out.fields[key] = left && right ? merge(left, right) : { ...(left || right) };
      if (bothObjects && (!left || !right)) out.fields[key].optional = true;
    }
  }
  if (a.items || b.items) out.items = a.items && b.items ? merge(a.items, b.items) : a.items || b.items;
  if (a.optional || b.optional) out.optional = true;
  return out;
}

function compare(expected, actual, where, problems, additions) {
  if (JSON.stringify(expected.types) !== JSON.stringify(actual.types)) {
    problems.push(`${where}: el tipo era ${expected.types.join("|")} y ahora es ${actual.types.join("|")}`);
    return;
  }
  for (const key of Object.keys(expected.fields || {})) {
    if (!actual.fields || !actual.fields[key]) problems.push(`${where}.${key}: el campo desapareció`);
    else compare(expected.fields[key], actual.fields[key], `${where}.${key}`, problems, additions);
  }
  for (const key of Object.keys(actual.fields || {})) {
    if (!expected.fields || !expected.fields[key]) additions.push(`${where}.${key}`);
  }
  if (expected.items) {
    if (!actual.items) problems.push(`${where}[]: la lista vino vacía`);
    else compare(expected.items, actual.items, `${where}[]`, problems, additions);
  }
}

// ─── Pedidos ──────────────────────────────────────────────────────────────

const A = "a84041000181c4b1";
const REQUESTS = [
  ["health", "GET", "/api/v1/health"],
  ["me sin clave", "GET", "/api/v1/me"],
  ["me con clave", "GET", "/api/v1/me", { key: CLIENT_KEY }],
  ["stats", "GET", "/api/v1/stats"],
  ["cinemas", "GET", "/api/v1/cinemas"],
  ["cinema", "GET", "/api/v1/cinemas/cin_1"],
  ["rooms", "GET", "/api/v1/rooms"],
  ["profiles", "GET", "/api/v1/profiles"],
  ["profile", "GET", "/api/v1/profiles/prof_proy"],
  ["sensors", "GET", "/api/v1/sensors"],
  ["sensor", "GET", `/api/v1/sensors/${A}`],
  ["sensor sin sala", "GET", "/api/v1/sensors/a84041000181c4b9"],
  ["lecturas 7d (cada lectura)", "GET", `/api/v1/sensors/${A}/measurements?preset=7d`],
  ["lecturas 6m (promedio diario)", "GET", `/api/v1/sensors/${A}/measurements?preset=6m`],
  ["measurements", "GET", "/api/v1/measurements?preset=30d&pageSize=5"],
  ["alerts", "GET", "/api/v1/alerts"],
  ["alerts activas", "GET", "/api/v1/alerts?active=true"],
  ["patch sensor", "PATCH", `/api/v1/sensors/${A}`, { key: CLIENT_KEY, body: { name: "Cabina 1 - A" } }],
  ["error 401", "PATCH", `/api/v1/sensors/${A}`, { body: { name: "x" } }],
  ["error 404", "GET", "/api/v1/no-existe"],
  ["error 400", "GET", "/api/v1/sensors?status=roto"],
];

async function call(base, [, method, url, options = {}]) {
  const headers = {};
  if (options.key) headers["X-API-Key"] = options.key;
  if (options.body) headers["Content-Type"] = "application/json";
  const res = await fetch(base + url, { method, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function main() {
  await seed();
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const current = {};
  try {
    for (const request of REQUESTS) {
      const res = await call(base, request);
      current[request[0]] = { status: res.status, shape: shapeOf(res.body) };
    }
    // Headers que el cliente lee para respetar los límites.
    const res = await call(base, ["headers", "GET", "/api/v1/sensors"]);
    current["headers de límites"] = {
      status: res.status,
      shape: shapeOf(Object.fromEntries(["ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", "x-request-id"].map((h) => [h, res.headers.get(h)]))),
    };
    // Forma del 429: 20 consultas de historial por minuto sin clave.
    let limited = null;
    for (let i = 0; i < 25 && !limited; i++) {
      const r = await call(base, ["", "GET", "/api/v1/alerts?active=false"]);
      if (r.status === 429) limited = r;
    }
    current["error 429"] = limited ? { status: 429, shape: shapeOf(limited.body) } : { status: 0, shape: { types: ["null"] } };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  }

  if (UPDATE || !fs.existsSync(CONTRACT_FILE)) {
    fs.writeFileSync(CONTRACT_FILE, JSON.stringify(current, null, 2) + "\n");
    console.log(`Contrato guardado en ${path.relative(process.cwd(), CONTRACT_FILE)} (${Object.keys(current).length} respuestas).`);
    return;
  }

  const expected = JSON.parse(fs.readFileSync(CONTRACT_FILE, "utf8"));
  const problems = [];
  const additions = [];
  for (const name of Object.keys(expected)) {
    if (!current[name]) {
      problems.push(`${name}: la prueba ya no pide esta respuesta`);
      continue;
    }
    if (expected[name].status !== current[name].status) {
      problems.push(`${name}: el código de estado era ${expected[name].status} y ahora es ${current[name].status}`);
    }
    compare(expected[name].shape, current[name].shape, name, problems, additions);
  }

  if (additions.length > 0) {
    console.log(`Campos nuevos (compatibles): ${additions.join(", ")}`);
    console.log("Cuando confirmes que son intencionales: npm run test:contract -- --update");
  }
  if (problems.length > 0) {
    console.error(`\nEl contrato de /api/v1 se rompió (${problems.length}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("\nEsto rompería la app del cliente. Si el cambio es necesario, va en /api/v2.");
    process.exit(1);
  }
  console.log(`Contrato de /api/v1 OK: ${Object.keys(expected).length} respuestas con la misma forma.`);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
