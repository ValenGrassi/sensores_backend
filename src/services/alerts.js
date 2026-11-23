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
 * Para abrir una alerta hacen falta READINGS_TO_OPEN lecturas seguidas fuera de
 * rango en la misma dirección (evita alertas por un valor suelto). Para cerrarla
 * alcanza una lectura en rango. Las lecturas sin ese dato no cuentan.
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

/** Lecturas seguidas fuera de rango necesarias para abrir una alerta. */
const READINGS_TO_OPEN = 2;

/** Cuántas lecturas recientes se miran (alcanza aunque haya algunas sin datos). */
const RECENT_READINGS = 10;

function isValue(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function classify(value, min, max) {
  if (!isValue(value)) return "unknown";
  if (value > max) return "high";
  if (value < min) return "low";
  return "ok";
}

/**
 * Función pura: decide qué alertas resolver y cuáles crear.
 *
 * @param readings     últimas lecturas { temperature, humidity }, de la más nueva a la más vieja
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
    const classifyValue = (value) => classify(value, profile[metric.min], profile[metric.max]);
    const state = classifyValue(readings[0]?.[metric.key]);
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
      // Se abre solo si las últimas lecturas con dato están todas igual de mal.
      const lastValues = readings.map((reading) => reading[metric.key]).filter(isValue).slice(0, READINGS_TO_OPEN);
      const confirmed = lastValues.length === READINGS_TO_OPEN && lastValues.every((value) => classifyValue(value) === state);
      if (confirmed) toCreate.push(wantedType);
    }
  }

  return { toResolve, toCreate };
}

/**
 * Evalúa las alertas de un sensor con sus valores actuales y aplica los cambios.
 * Se llama al recibir telemetría, al cambiar un perfil y al mover un sensor de sala.
 *
 * Si dos evaluaciones del mismo sensor corren a la vez, las dos pueden decidir
 * crear la misma alerta. La base acepta una sola (índice único de alertas
 * activas) y rechaza la otra con P2002; esa evaluación se repite una vez con el
 * estado actualizado, y así queda todo consistente.
 */
async function evaluateSensorAlerts(sensorId, attempt = 1) {
  const [sensor, activeAlerts, recent] = await Promise.all([
    prisma.sensor.findUnique({
      where: { id: sensorId },
      include: { room: { include: { profile: true } } },
    }),
    prisma.alert.findMany({
      where: { sensorId, active: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, type: true },
    }),
    prisma.measurement.findMany({
      where: { sensorId },
      orderBy: { timestamp: "desc" },
      take: RECENT_READINGS,
      select: { temperature: true, humidity: true },
    }),
  ]);

  if (!sensor) return null;

  // Sin histórico (sensor recién registrado): se usa su estado actual.
  const readings = recent.length > 0 ? recent : [sensor];
  const plan = planAlertChanges(readings, sensor.room?.profile ?? null, activeAlerts);
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

  try {
    await prisma.$transaction(operations);
  } catch (error) {
    if (error?.code === "P2002" && attempt === 1) return evaluateSensorAlerts(sensorId, 2);
    throw error;
  }

  const label = sensor.name || sensor.devEui;
  for (const type of plan.toCreate) console.log(`[alertas] Creada ${type} - ${label}`);
  if (plan.toResolve.length > 0) console.log(`[alertas] Resueltas ${plan.toResolve.length} - ${label}`);

  return plan;
}

/** Lo que hay que incluir en Prisma para armar una alerta completa. */
const ALERT_INCLUDE = {
  sensor: {
    select: {
      devEui: true,
      name: true,
      room: { select: { id: true, name: true, cinema: { select: { id: true, name: true } } } },
    },
  },
};

/**
 * Forma pública de una alerta. Agrega el sensor y su ubicación ACTUAL (sala y
 * cine), para no tener que cruzar con /api/sensors. null si no tiene sala.
 */
function toAlertDTO(alert) {
  const room = alert.sensor?.room ?? null;
  return {
    id: alert.id,
    sensorId: alert.sensorId,
    devEui: alert.sensor?.devEui ?? null,
    sensorName: alert.sensor?.name ?? null,
    roomId: room?.id ?? null,
    roomName: room?.name ?? null,
    cinemaId: room?.cinema?.id ?? null,
    cinemaName: room?.cinema?.name ?? null,
    type: alert.type,
    temperature: alert.temperature,
    humidity: alert.humidity,
    createdAt: alert.createdAt,
    resolvedAt: alert.resolvedAt,
    active: alert.active,
  };
}

module.exports = { ALERT_TYPES, READINGS_TO_OPEN, ALERT_INCLUDE, planAlertChanges, evaluateSensorAlerts, toAlertDTO };
