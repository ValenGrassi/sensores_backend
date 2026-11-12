// Tests de la lógica de alertas (función pura, no necesita base de datos).
// Ejecutar con: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { planAlertChanges } = require("../src/services/alerts");

const profile = { temperatureMin: 18, temperatureMax: 24, humidityMin: 30, humidityMax: 60 };
const alert = (id, type) => ({ id, type });

test("todo en rango y sin alertas: no hace nada", () => {
  assert.deepEqual(planAlertChanges({ temperature: 20, humidity: 50 }, profile, []), { toResolve: [], toCreate: [] });
});

test("temperatura alta: crea temperature_high", () => {
  assert.deepEqual(planAlertChanges({ temperature: 30, humidity: 50 }, profile, []), {
    toResolve: [],
    toCreate: ["temperature_high"],
  });
});

test("temperatura y humedad fuera de rango: crea las dos (antes solo la de temperatura)", () => {
  assert.deepEqual(planAlertChanges({ temperature: 30, humidity: 80 }, profile, []), {
    toResolve: [],
    toCreate: ["temperature_high", "humidity_high"],
  });
});

test("la temperatura vuelve a rango pero la humedad sigue mal: resuelve solo la de temperatura", () => {
  const active = [alert("a1", "temperature_high"), alert("a2", "humidity_high")];
  assert.deepEqual(planAlertChanges({ temperature: 22, humidity: 80 }, profile, active), {
    toResolve: ["a1"],
    toCreate: [],
  });
});

test("pasa de alta a baja: resuelve la alta y crea la baja (antes quedaban las dos activas)", () => {
  const active = [alert("a1", "temperature_high")];
  assert.deepEqual(planAlertChanges({ temperature: 10, humidity: 50 }, profile, active), {
    toResolve: ["a1"],
    toCreate: ["temperature_low"],
  });
});

test("alerta ya activa del mismo tipo: no duplica", () => {
  const active = [alert("a1", "temperature_high")];
  assert.deepEqual(planAlertChanges({ temperature: 31, humidity: 50 }, profile, active), { toResolve: [], toCreate: [] });
});

test("duplicados de una carrera anterior: conserva la más vieja y resuelve el resto", () => {
  const active = [alert("old", "temperature_high"), alert("dup", "temperature_high")];
  assert.deepEqual(planAlertChanges({ temperature: 31, humidity: 50 }, profile, active), {
    toResolve: ["dup"],
    toCreate: [],
  });
});

test("sin dato de humedad: no toca las alertas de humedad", () => {
  const active = [alert("h1", "humidity_high")];
  assert.deepEqual(planAlertChanges({ temperature: 20, humidity: null }, profile, active), { toResolve: [], toCreate: [] });
});

test("sensor sin sala o perfil: resuelve todo", () => {
  const active = [alert("a1", "temperature_high"), alert("h1", "humidity_low")];
  assert.deepEqual(planAlertChanges({ temperature: 40, humidity: 5 }, null, active), {
    toResolve: ["a1", "h1"],
    toCreate: [],
  });
});

test("los límites son inclusivos: igual al máximo no es alerta", () => {
  assert.deepEqual(planAlertChanges({ temperature: 24, humidity: 30 }, profile, []), { toResolve: [], toCreate: [] });
});
