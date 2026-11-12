/**
 * Lógica de alertas.
 *
 * Cada métrica (temperatura y humedad) se evalúa por separado contra el perfil
 * de la sala del sensor, y el resultado se "reconcilia" con las alertas activas:
 *
 *   valor > máximo  -> debe haber una alerta activa <métrica>_high
 *   valor < mínimo  -> debe haber una alerta activa <métrica>_low
 *   valor en rango  -> no debe haber alertas activas de esa métrica
 *   sin valor       -> no se toca nada de esa métrica (falta de dato ≠ normalidad)
 *
 * Todo lo que no corresponde se resuelve, y lo que falta se crea, en una sola
 * transacción. Como el resultado depende solo del estado actual, se puede
 * ejecutar las veces que haga falta: si una ejecución falla, la siguiente
 * deja todo correcto.
 *
 * Un sensor sin sala (o sin perfil) no se monitorea: se resuelven sus alertas.
 */

const prisma = require("../lib/prisma");

const METRICS = [
  { key: "temperature", min: "temperatureMin", max: "temperatureMax" },
  { key: "humidity", min: "humidityMin", max: "humidityMax" },
];

const ALERT_TYPES = ["temperature_high", "temperature_low", "humidity_high", "humidity_low"];

function classify(value, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  if (value > max) return "high";
  if (value < min) return "low";
  return "ok";
}

/**
 * Función pura: decide qué alertas resolver y cuáles crear.
 *
 * @param readings     { temperature, humidity } actuales del sensor
 * @param profile      perfil de la sala, o null si el sensor no está asignado
 * @param activeAlerts alertas activas del sensor, de la más vieja a la más nueva
 * @returns { toResolve: string[] (ids), toCreate: string[] (tipos) }
 */
function planAlertChanges(readings, profile, activeAlerts) {
  if (!profile) {
    return { toResolve: activeAlerts.map((alert) => alert.id), toCreate: [] };
  }

  const toResolve = [];
  const toCreate = [];

  for (const metric of METRICS) {
    const state = classify(readings[metric.key], profile[metric.min], profile[metric.max]);
    if (state === "unknown") continue;

    const wantedType = state === "ok" ? null : `${metric.key}_${state}`;
    const current = activeAlerts.filter((alert) => alert.type.startsWith(`${metric.key}_`));

    let kept = false;
    for (const alert of current) {
      if (alert.type === wantedType && !kept) {
        kept = true; // se conserva la más vieja (cuándo empezó el problema)
      } else {
        toResolve.push(alert.id); // tipo que ya no corresponde, o duplicado
      }
    }

    if (wantedType && !kept) {
      toCreate.push(wantedType);
    }
  }

  return { toResolve, toCreate };
}

/**
 * Evalúa las alertas de un sensor con sus valores actuales y aplica los cambios.
 * Se llama al recibir telemetría, al cambiar un perfil y al mover un sensor de sala.
 */
async function evaluateSensorAlerts(sensorId) {
  const [sensor, activeAlerts] = await Promise.all([
    prisma.sensor.findUnique({
      where: { id: sensorId },
      include: { room: { include: { profile: true } } },
    }),
    prisma.alert.findMany({
      where: { sensorId, active: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, type: true },
    }),
  ]);

  if (!sensor) return null;

  const plan = planAlertChanges(sensor, sensor.room?.profile ?? null, activeAlerts);
  if (plan.toResolve.length === 0 && plan.toCreate.length === 0) return plan;

  const now = new Date();
  const operations = [];

  if (plan.toResolve.length > 0) {
    operations.push(
      prisma.alert.updateMany({
        where: { id: { in: plan.toResolve }, active: true },
        data: { active: false, resolvedAt: now },
      })
    );
  }

  for (const type of plan.toCreate) {
    operations.push(
      prisma.alert.create({
        data: {
          sensorId: sensor.id,
          type,
          temperature: sensor.temperature ?? null,
          humidity: sensor.humidity ?? null,
          active: true,
        },
      })
    );
  }

  await prisma.$transaction(operations);

  const label = sensor.name || sensor.devEui;
  for (const type of plan.toCreate) console.log(`[alertas] Creada ${type} - ${label}`);
  if (plan.toResolve.length > 0) console.log(`[alertas] Resueltas ${plan.toResolve.length} - ${label}`);

  return plan;
}

/** Forma pública de una alerta: agrega el devEui del sensor para no tener que cruzar datos. */
function toAlertDTO(alert) {
  return {
    id: alert.id,
    sensorId: alert.sensorId,
    devEui: alert.sensor?.devEui ?? null,
    type: alert.type,
    temperature: alert.temperature,
    humidity: alert.humidity,
    createdAt: alert.createdAt,
    resolvedAt: alert.resolvedAt,
    active: alert.active,
  };
}

module.exports = { ALERT_TYPES, planAlertChanges, evaluateSensorAlerts, toAlertDTO };
