#!/usr/bin/env node
/**
 * Registro de sensores. Se ejecuta en tu computadora, contra la base de
 * backend/.env. Con TELEMETRY_AUTO_CREATE=false (por defecto), el backend solo
 * acepta lecturas de sensores registrados acá.
 *
 *   npm run sensors -- add <devEui> ["Nombre"]
 *   npm run sensors -- list
 */

require("dotenv").config({ quiet: true });

const { normalizeDevEui, getSensorStatus } = require("../src/services/sensors");

const USAGE = `
Uso:
  npm run sensors -- add <devEui> ["Nombre"]   Registra un sensor (devEui: 16 caracteres hexadecimales)
  npm run sensors -- list                      Lista los sensores registrados
`;

function fail(message) {
  console.error(`\nError: ${message}\n${USAGE}`);
  process.exit(1);
}

async function add(prisma, args) {
  if (!args[1]) fail("Falta el devEui del sensor (está en la etiqueta del sensor o en el gateway).");

  const devEui = normalizeDevEui(args[1]);
  if (!/^[0-9a-f]{16}$/.test(devEui)) {
    fail(`"${args[1]}" no es un devEui válido: tienen que ser 16 caracteres entre 0-9 y a-f, por ejemplo 24e124136e314474.`);
  }
  const name = args[2]?.trim() || null;

  const existing = await prisma.sensor.findUnique({ where: { devEui } });
  if (existing) {
    console.log(`El sensor ${devEui} ya estaba registrado${existing.name ? ` como "${existing.name}"` : ""}. No se cambió nada.`);
    return;
  }

  await prisma.sensor.create({ data: { devEui, name } });
  console.log(`
Sensor registrado: ${devEui}${name ? ` ("${name}")` : ""}

Sus lecturas se guardan a partir de ahora. Falta asignarle una sala:
en el frontend, Sensores > el sensor > Configurar.
`);
}

async function list(prisma) {
  const sensors = await prisma.sensor.findMany({
    include: { room: { include: { cinema: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (sensors.length === 0) {
    console.log("No hay sensores registrados.");
    return;
  }

  console.table(
    sensors.map((sensor) => ({
      devEui: sensor.devEui,
      nombre: sensor.name ?? "-",
      sala: sensor.room ? `${sensor.room.cinema?.name ?? "?"} · ${sensor.room.name}` : "(sin sala)",
      estado: getSensorStatus(sensor.lastSeen),
      "última lectura": sensor.lastSeen ? sensor.lastSeen.toISOString().slice(0, 16).replace("T", " ") : "-",
    }))
  );
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!["add", "list"].includes(command)) fail(command ? `Comando desconocido "${command}".` : "Falta el comando.");

  const prisma = require("../src/lib/prisma");
  try {
    if (command === "add") await add(prisma, args);
    if (command === "list") await list(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
