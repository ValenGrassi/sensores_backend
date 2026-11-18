// Tests de la lógica de alertas (función pura, no necesita base de datos).
// Ejecutar con: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { planAlertChanges, READINGS_TO_OPEN } = require("../src/services/alerts");

const profile = { temperatureMin: 18, temperatureMax: 24, humidityMin: 30, humidityMax: 60 };
const alert = (id, type) => ({ id, type });
const r = (temperature, humidity) => ({ temperature, humidity });
/** La misma lectura repetida: lo necesario para confirmar una alerta. */
const twice = (temperature, humidity) => [r(temperature, humidity), r(temperature, humidity)];
const nothing = { toResolve: [], toCreate: [] };

test("hacen falta 2 lecturas seguidas para abrir", () => {
  assert.equal(READINGS_TO_OPEN, 2);
});

test("todo en rango y sin alertas: no hace nada", () => {
  assert.deepEqual(planAlertChanges(twice(20, 50), profile, []), nothing);
});

test("temperatura alta 2 lecturas seguidas: crea temperature_high", () => {
  assert.deepEqual(planAlertChanges(twice(30, 50), profile, []), { toResolve: [], toCreate: ["temperature_high"] });
});

test("una sola lectura alta (la anterior estaba bien): todavía no abre", () => {
  assert.deepEqual(planAlertChanges([r(30, 50), r(22, 50)], profile, []), nothing);
});

test("primera lectura del sensor fuera de rango: todavía no abre", () => {
  assert.deepEqual(planAlertChanges([r(30, 50)], profile, []), nothing);
});

test("parpadeo en el límite (23,9 / 24,1 / 23,9 / 24,1): nunca abre", () => {
  const sequence = [23.9, 24.1, 23.9, 24.1];
  for (let i = 1; i <= sequence.length; i++) {
    const readings = sequence.slice(0, i).reverse().map((t) => r(t, 50));
    assert.deepEqual(planAlertChanges(readings, profile, []), nothing, `después de ${sequence.slice(0, i).join(", ")}`);
  }
});

test("una lectura sin datos en el medio no corta la racha", () => {
  const readings = [r(30, 50), r(null, null), r(31, 50)];
  assert.deepEqual(planAlertChanges(readings, profile, []), { toResolve: [], toCreate: ["temperature_high"] });
});

test("temperatura y humedad fuera de rango 2 veces: crea las dos", () => {
  assert.deepEqual(planAlertChanges(twice(30, 80), profile, []), {
    toResolve: [],
    toCreate: ["temperature_high", "humidity_high"],
  });
});

test("la temperatura vuelve a rango (1 lectura alcanza) pero la humedad sigue mal: resuelve solo la de temperatura", () => {
  const active = [alert("a1", "temperature_high"), alert("a2", "humidity_high")];
  assert.deepEqual(planAlertChanges([r(22, 80), r(30, 80)], profile, active), { toResolve: ["a1"], toCreate: [] });
});

test("pasa de alta a baja: resuelve la alta enseguida y abre la baja con la 2.ª lectura baja", () => {
  const active = [alert("a1", "temperature_high")];
  assert.deepEqual(planAlertChanges([r(10, 50), r(30, 50)], profile, active), { toResolve: ["a1"], toCreate: [] });
  assert.deepEqual(planAlertChanges([r(10, 50), r(11, 50), r(30, 50)], profile, []), {
    toResolve: [],
    toCreate: ["temperature_low"],
  });
});

test("alerta ya activa del mismo tipo: no duplica, aunque la lectura anterior estuviera bien", () => {
  const active = [alert("a1", "temperature_high")];
  assert.deepEqual(planAlertChanges(twice(31, 50), profile, active), nothing);
  assert.deepEqual(planAlertChanges([r(31, 50), r(22, 50)], profile, active), nothing);
});

test("duplicados de una carrera anterior: conserva la más vieja y resuelve el resto", () => {
  const active = [alert("old", "temperature_high"), alert("dup", "temperature_high")];
  assert.deepEqual(planAlertChanges(twice(31, 50), profile, active), { toResolve: ["dup"], toCreate: [] });
});

test("sin dato de humedad en la última lectura: no toca las alertas de humedad", () => {
  const active = [alert("h1", "humidity_high")];
  assert.deepEqual(planAlertChanges([r(20, null), r(20, 80)], profile, active), nothing);
});

test("sensor sin sala o perfil: resuelve todo", () => {
  const active = [alert("a1", "temperature_high"), alert("h1", "humidity_low")];
  assert.deepEqual(planAlertChanges(twice(40, 5), null, active), { toResolve: ["a1", "h1"], toCreate: [] });
});

test("los límites son inclusivos: igual al máximo no es alerta", () => {
  assert.deepEqual(planAlertChanges(twice(24, 30), profile, []), nothing);
});
