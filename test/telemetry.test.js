// Tests de las reglas de la telemetría que no necesitan base de datos.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseTimestamp, toBatteryPercent, isRepeatedReading } = require("../src/routes/telemetry");

const now = new Date("2026-11-18T12:00:00Z");

test("gatewayTime: se respeta si es pasado o apenas adelantado", () => {
  assert.equal(parseTimestamp("2026-11-18T10:00:00Z", now).toISOString(), "2026-11-18T10:00:00.000Z");
  assert.equal(parseTimestamp("2026-11-18T12:04:59Z", now).toISOString(), "2026-11-18T12:04:59.000Z");
});

test("gatewayTime: en el futuro, inválido o ausente se reemplaza por la hora del servidor", (t) => {
  t.mock.method(console, "warn", () => {});
  assert.equal(parseTimestamp("2030-01-01T00:00:00Z", now), now, "futuro: congelaría el estado del sensor");
  assert.equal(parseTimestamp("no-es-fecha", now), now);
  assert.equal(parseTimestamp(undefined, now), now);
});

test("lectura repetida: mismos valores a menos de 30 s de la última (como pasó en septiembre, a 2 s)", () => {
  const sensor = { lastSeen: new Date("2026-09-20T04:06:13Z"), temperature: 21.6, humidity: 47 };
  const at = (seconds) => new Date(sensor.lastSeen.getTime() + seconds * 1000);
  assert.equal(isRepeatedReading(sensor, { temperature: 21.6, humidity: 47 }, at(2)), true);
  assert.equal(isRepeatedReading(sensor, { temperature: 21.6, humidity: 47 }, at(0)), true, "mismo timestamp");
  assert.equal(isRepeatedReading(sensor, { temperature: 21.6, humidity: 47 }, at(300)), false, "la siguiente lectura real, 5 min después");
  assert.equal(isRepeatedReading(sensor, { temperature: 21.7, humidity: 47 }, at(2)), false, "otro valor");
  assert.equal(isRepeatedReading(sensor, { temperature: 21.6, humidity: 47 }, at(-60)), false, "lectura vieja");
  assert.equal(isRepeatedReading(sensor, { temperature: null, humidity: null }, at(2)), false, "lectura vacía");
  assert.equal(isRepeatedReading({ ...sensor, lastSeen: null }, { temperature: 21.6, humidity: 47 }, at(2)), false, "primera lectura");
});

test("batería: porcentaje entero; sin dato no cambia el valor guardado", () => {
  assert.equal(toBatteryPercent(92), 92);
  assert.equal(toBatteryPercent(91.6), 92);
  assert.equal(toBatteryPercent(null), undefined);
  assert.equal(toBatteryPercent(undefined), undefined);
});
