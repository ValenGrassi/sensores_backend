/**
 * POST /api/telemetry — lo llama el gateway LoRaWAN instalado en el cine.
 *
 * IMPORTANTE: el gateway no se puede reconfigurar. Este endpoint mantiene
 * exactamente el contrato de siempre: mismo path, sin clave, mismos campos,
 * y responde 200 "OK" cuando recibió la lectura.
 *
 * Qué hace con cada lectura:
 *   1. Sensor desconocido: si TELEMETRY_AUTO_CREATE=false (por defecto) la
 *      descarta y lo deja en el log. Igual responde 200, para que el gateway
 *      no la reintente.
 *   2. Lectura repetida: si tiene la misma temperatura y humedad que la última
 *      del sensor y llegó menos de 30 s después, es la misma transmisión enviada
 *      dos veces. Se ignora (en ago–sep 2026 pasó con 581 lecturas, a 2–3 s).
 *   3. Histórico: guarda todas las demás.
 *   4. Estado actual del sensor: lo actualiza solo si la lectura es más nueva
 *      que la última conocida. Una lectura vieja o reenviada no lo pisa.
 *   5. Alertas: se evalúan solo con la lectura más nueva.
 *
 * No hay índice único en Measurement(sensorId, timestamp): las repeticiones
 * reales llegan con timestamps distintos, así que no las frenaría.
 */

const express = require("express");
const prisma = require("../lib/prisma");
const config = require("../config");
const { validator, requireJsonBody } = require("../lib/validation");
const { evaluateSensorAlerts } = require("../services/alerts");
const { normalizeDevEui } = require("../services/sensors");

const router = express.Router();

/** Una lectura con fecha más adelantada que esto se toma como reloj del gateway mal configurado. */
const MAX_FUTURE_MS = 5 * 60 * 1000;

function parseTimestamp(gatewayTime, now = new Date()) {
  if (!gatewayTime) return now;

  const timestamp = new Date(gatewayTime);
  if (Number.isNaN(timestamp.getTime())) {
    console.warn(`[telemetría] gatewayTime inválido (${JSON.stringify(gatewayTime)}); se usa la hora del servidor.`);
    return now;
  }
  // Una fecha futura dejaría al sensor "congelado": las lecturas reales
  // siguientes parecerían viejas y no actualizarían su estado.
  if (timestamp.getTime() - now.getTime() > MAX_FUTURE_MS) {
    console.warn(`[telemetría] gatewayTime en el futuro (${JSON.stringify(gatewayTime)}); se usa la hora del servidor.`);
    return now;
  }
  return timestamp;
}

/** Los sensores reportan cada 5 minutos: dos lecturas iguales a menos de esto son la misma. */
const REPEAT_WINDOW_MS = 30 * 1000;

/** ¿Es la misma lectura que la última del sensor, recibida otra vez? */
function isRepeatedReading(sensor, reading, timestamp) {
  if (!sensor.lastSeen) return false;
  const gap = timestamp.getTime() - sensor.lastSeen.getTime();
  if (gap < 0 || gap > REPEAT_WINDOW_MS) return false;

  return (
    typeof reading.temperature === "number" &&
    typeof reading.humidity === "number" &&
    reading.temperature === sensor.temperature &&
    reading.humidity === sensor.humidity
  );
}

/** La batería del sensor es un porcentaje entero. undefined/null = no cambia. */
function toBatteryPercent(battery) {
  return typeof battery === "number" ? Math.round(battery) : undefined;
}

async function findSensor(devEui, deviceName) {
  const sensor = await prisma.sensor.findUnique({ where: { devEui } });
  if (sensor || !config.telemetryAutoCreate) return sensor;

  return prisma.sensor.upsert({
    where: { devEui },
    update: {},
    create: { devEui, name: deviceName },
  });
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

  const sensor = await findSensor(devEui, deviceName);
  if (!sensor) {
    const label = deviceName ? ` ("${deviceName}")` : "";
    console.warn(
      `[telemetría] Sensor desconocido ${devEui}${label}: lectura descartada. ` +
        `Para registrarlo: npm run sensors -- add ${devEui}`
    );
    return res.sendStatus(200);
  }

  if (isRepeatedReading(sensor, { temperature, humidity }, timestamp)) {
    console.log(`[telemetría] Lectura repetida de ${devEui} (igual a la de ${sensor.lastSeen.toISOString()}): se ignora.`);
    return res.sendStatus(200);
  }

  // 1) Histórico.
  await prisma.measurement.create({
    data: {
      sensorId: sensor.id,
      timestamp,
      temperature: temperature ?? null,
      humidity: humidity ?? null,
      battery: battery ?? null,
    },
  });

  // 2) Estado actual, solo si esta lectura es la más nueva. La condición va en
  //    la misma consulta, así dos lecturas simultáneas no se pisan entre sí.
  const updated = await prisma.sensor.updateMany({
    where: { id: sensor.id, OR: [{ lastSeen: null }, { lastSeen: { lt: timestamp } }] },
    data: {
      temperature,
      humidity,
      battery: toBatteryPercent(battery),
      lastSeen: timestamp,
    },
  });

  const isLatest = updated.count > 0 || sensor.lastSeen?.getTime() === timestamp.getTime();
  if (!isLatest) {
    console.log(
      `[telemetría] Lectura vieja de ${devEui} (${timestamp.toISOString()}, la última es ` +
        `${sensor.lastSeen.toISOString()}): va al histórico, no cambia el estado.`
    );
    return res.sendStatus(200);
  }

  // 3) Si falla la evaluación de alertas, la lectura ya quedó guardada: se responde
  //    200 igual para que el gateway no la reenvíe. La próxima lectura reevalúa todo.
  try {
    await evaluateSensorAlerts(sensor.id);
  } catch (error) {
    console.error(`[alertas] No se pudieron evaluar las alertas de ${devEui}:`, error);
  }

  res.sendStatus(200);
});

module.exports = router;
module.exports.parseTimestamp = parseTimestamp;
module.exports.toBatteryPercent = toBatteryPercent;
module.exports.isRepeatedReading = isRepeatedReading;
