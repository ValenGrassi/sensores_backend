/**
 * POST /api/telemetry — lo llama el gateway LoRaWAN instalado en el cine.
 *
 * IMPORTANTE: el gateway no se puede reconfigurar. Este endpoint mantiene
 * exactamente el contrato de siempre: mismo path, sin clave, mismos campos,
 * y responde 200 "OK" cuando la lectura se guardó.
 */

const express = require("express");
const prisma = require("../lib/prisma");
const { validator, requireJsonBody } = require("../lib/validation");
const { evaluateSensorAlerts } = require("../services/alerts");
const { normalizeDevEui } = require("../services/sensors");

const router = express.Router();

function parseTimestamp(gatewayTime) {
  if (!gatewayTime) return new Date();

  const timestamp = new Date(gatewayTime);
  if (Number.isNaN(timestamp.getTime())) {
    console.warn(`[telemetría] gatewayTime inválido (${JSON.stringify(gatewayTime)}); se usa la hora del servidor.`);
    return new Date();
  }
  return timestamp;
}

router.post("/", async (req, res) => {
  const body = requireJsonBody(req);

  console.log(`[telemetría] ${new Date().toISOString()} ${JSON.stringify(body)}`);

  const check = validator(body);

  if (body.devEUI === undefined || body.devEUI === null || body.devEUI === "") {
    check.issue("devEUI", "Es obligatorio.");
  } else if (typeof body.devEUI !== "string" || body.devEUI.trim() === "") {
    check.issue("devEUI", 'Tiene que ser un texto, por ejemplo "a84041000181c4b1".');
  }

  // undefined = el gateway no mandó el dato (se conserva el último valor del sensor)
  // null      = lo mandó vacío
  const temperature = check.nullableNumber("temperature");
  const humidity = check.nullableNumber("humidity");
  const battery = check.nullableNumber("battery");

  check.done();

  const devEui = normalizeDevEui(body.devEUI);
  const deviceName = typeof body.deviceName === "string" && body.deviceName.trim() ? body.deviceName.trim() : undefined;
  const timestamp = parseTimestamp(body.gatewayTime);

  const sensor = await prisma.sensor.upsert({
    where: { devEui },
    update: {
      temperature,
      humidity,
      battery: battery ?? undefined,
      lastSeen: timestamp,
    },
    create: {
      devEui,
      name: deviceName,
      temperature,
      humidity,
      battery: battery ?? undefined,
      lastSeen: timestamp,
    },
  });

  await prisma.measurement.create({
    data: {
      sensorId: sensor.id,
      timestamp,
      temperature: temperature ?? null,
      humidity: humidity ?? null,
      battery: battery ?? null,
    },
  });

  // Si falla la evaluación de alertas, la lectura ya quedó guardada: se responde
  // 200 igual para que el gateway no la reenvíe. La próxima lectura reevalúa todo.
  try {
    await evaluateSensorAlerts(sensor.id);
  } catch (error) {
    console.error(`[alertas] No se pudieron evaluar las alertas de ${devEui}:`, error);
  }

  res.sendStatus(200);
});

module.exports = router;
