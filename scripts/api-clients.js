#!/usr/bin/env node
/**
 * Administración de claves de API para terceros. Se ejecuta en tu computadora,
 * contra la base configurada en backend/.env. No hay ningún endpoint para esto:
 * solo vos podés crear o revocar claves.
 *
 *   npm run clients -- create --name "App de Juan" --permissions sensors:write
 *   npm run clients -- list
 *   npm run clients -- revoke <id>
 *   npm run clients -- admin-key
 */

require("dotenv").config({ quiet: true });

const { PERMISSIONS, isKnownPermission } = require("../src/lib/permissions");
const { generateApiKey, hashApiKey, keyPrefixOf } = require("../src/lib/apiKeys");

const USAGE = `
Uso:
  npm run clients -- create --name "<nombre>" [--permissions <p1,p2>]
  npm run clients -- list
  npm run clients -- revoke <id>
  npm run clients -- admin-key

Permisos disponibles:
${Object.entries(PERMISSIONS)
  .map(([name, description]) => `  ${name.padEnd(16)} ${description}`)
  .join("\n")}

Sin --permissions, la clave no puede escribir nada (la lectura es pública igual).
`;

function readFlag(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function fail(message) {
  console.error(`\nError: ${message}\n${USAGE}`);
  process.exit(1);
}

async function create(prisma, args) {
  const name = readFlag(args, "--name")?.trim();
  if (!name) fail('Falta --name "<nombre del cliente>".');

  const permissions = (readFlag(args, "--permissions") ?? "")
    .split(",")
    .map((permission) => permission.trim())
    .filter(Boolean);

  const unknown = permissions.filter((permission) => !isKnownPermission(permission));
  if (unknown.length > 0) fail(`Permiso(s) desconocido(s): ${unknown.join(", ")}.`);

  const key = generateApiKey();
  const client = await prisma.apiClient.create({
    data: {
      name,
      keyHash: hashApiKey(key),
      keyPrefix: keyPrefixOf(key),
      permissions: [...new Set(permissions)],
    },
  });

  console.log(`
Cliente creado
  id:        ${client.id}
  nombre:    ${client.name}
  permisos:  ${client.permissions.length ? client.permissions.join(", ") : "(ninguno: solo lectura)"}

  CLAVE:     ${key}

Copiala ahora y entregásela por un canal privado: no se guarda y no se puede volver a ver.
Si se pierde, revocá este cliente y creá otro.
`);
}

async function list(prisma) {
  const clients = await prisma.apiClient.findMany({ orderBy: { createdAt: "asc" } });

  if (clients.length === 0) {
    console.log("No hay clientes creados.");
    return;
  }

  console.table(
    clients.map((client) => ({
      id: client.id,
      nombre: client.name,
      clave: `${client.keyPrefix}…`,
      permisos: client.permissions.join(", ") || "(solo lectura)",
      estado: client.revokedAt ? `revocado ${client.revokedAt.toISOString().slice(0, 10)}` : "activo",
      "último uso": client.lastUsedAt ? client.lastUsedAt.toISOString().slice(0, 16).replace("T", " ") : "-",
    }))
  );
}

async function revoke(prisma, args) {
  const id = args[1];
  if (!id) fail("Falta el id del cliente (lo ves con `npm run clients -- list`).");

  const client = await prisma.apiClient.findUnique({ where: { id } });
  if (!client) fail(`No existe un cliente con id "${id}".`);
  if (client.revokedAt) {
    console.log(`El cliente "${client.name}" ya estaba revocado.`);
    return;
  }

  await prisma.apiClient.update({ where: { id }, data: { revokedAt: new Date() } });
  console.log(`Cliente "${client.name}" revocado. Su clave deja de funcionar en menos de 1 minuto.`);
}

function adminKey() {
  console.log(`
Clave de administrador generada:

  ${generateApiKey()}

1. En Render > tu servicio > Environment, creá la variable ADMIN_API_KEY con este valor.
2. En tu frontend, en Configuración > Acceso de administrador, pegá la misma clave.
No la compartas: tiene todos los permisos.
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "admin-key") return adminKey();
  if (!["create", "list", "revoke"].includes(command)) fail(command ? `Comando desconocido "${command}".` : "Falta el comando.");

  const prisma = require("../src/lib/prisma");
  try {
    if (command === "create") await create(prisma, args);
    if (command === "list") await list(prisma);
    if (command === "revoke") await revoke(prisma, args);
  } catch (error) {
    if (error?.code === "P2021") fail("Falta la tabla ApiClient. Ejecutá primero `npx prisma migrate deploy`.");
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
