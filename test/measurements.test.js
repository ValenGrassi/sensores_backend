const test = require("node:test");
const assert = require("node:assert/strict");
const { chooseResolution, resolveDateRange } = require("../src/services/measurements");
const { validator } = require("../src/lib/validation");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-22T12:00:00Z");

test("rango de fechas: preset, from/to o nada", () => {
  assert.deepEqual(resolveDateRange({}, NOW), { range: {} }, "sin filtros = todo, como antes");
  assert.deepEqual(resolveDateRange({ preset: "all" }, NOW), { range: {} });
  assert.deepEqual(resolveDateRange({ preset: "7d" }, NOW), { range: { gte: new Date(NOW - 7 * DAY) } });
  assert.deepEqual(resolveDateRange({ preset: "3m" }, NOW), { range: { gte: new Date(NOW - 91 * DAY) } });
  const from = new Date("2026-11-01T00:00:00Z");
  const to = new Date("2026-11-10T00:00:00Z");
  assert.deepEqual(resolveDateRange({ from, to }, NOW), { range: { gte: from, lte: to } });
  assert.deepEqual(resolveDateRange({ from }, NOW), { range: { gte: from } }, "solo desde");
  assert.deepEqual(resolveDateRange({ to }, NOW), { range: { lte: to } }, "solo hasta");
});

test("rango de fechas: combinaciones inválidas explican qué hacer", () => {
  const from = new Date("2026-11-10T00:00:00Z");
  const to = new Date("2026-11-01T00:00:00Z");
  assert.match(resolveDateRange({ preset: "7d", from }, NOW).issue.message, /preset o from\/to/);
  assert.deepEqual(resolveDateRange({ from, to }, NOW).issue.field, "from");
});

test("validador de fechas: ISO 8601 sí; otros formatos no", () => {
  const check = validator({
    a: "2026-11-20",
    b: "2026-11-20T15:00:00Z",
    c: "2026-11-20T12:00:00-03:00",
    d: "20/11/2026",
    e: "2026-13-45",
    f: "ayer",
  });
  assert.equal(check.date("a").toISOString(), "2026-11-20T00:00:00.000Z");
  assert.equal(check.date("b").toISOString(), "2026-11-20T15:00:00.000Z");
  assert.equal(check.date("c").toISOString(), "2026-11-20T15:00:00.000Z");
  assert.equal(check.date("falta"), undefined);
  for (const field of ["d", "e", "f"]) assert.equal(check.date(field), undefined, field);
  assert.deepEqual(check.details.map((d) => d.field), ["d", "e", "f"]);
});

test("auto elige la resolución más detallada que permite el rango", () => {
  assert.equal(chooseResolution("auto", 1 * DAY).resolution, "raw"); // 24h
  assert.equal(chooseResolution("auto", 7 * DAY).resolution, "raw"); // 7d
  assert.equal(chooseResolution("auto", 7 * DAY + 1).resolution, "hour");
  assert.equal(chooseResolution("auto", 30 * DAY).resolution, "hour"); // 30d
  assert.equal(chooseResolution("auto", 91 * DAY).resolution, "hour"); // 3m
  assert.equal(chooseResolution("auto", 182 * DAY).resolution, "day"); // 6m
  assert.equal(chooseResolution(undefined, 0).resolution, "raw", "sensor sin datos");
});

test("una resolución explícita se respeta si el rango lo permite", () => {
  assert.equal(chooseResolution("day", 1 * DAY).resolution, "day");
  assert.equal(chooseResolution("hour", 7 * DAY).resolution, "hour");
  assert.equal(chooseResolution("raw", 7 * DAY).resolution, "raw");
  assert.equal(chooseResolution("day", 3650 * DAY).resolution, "day");
});

test("una resolución explícita demasiado detallada para el rango explica qué usar", () => {
  const raw = chooseResolution("raw", 30 * DAY);
  assert.equal(raw.resolution, undefined);
  assert.match(raw.issue, /hasta 7 días y este abarca 30/);
  assert.match(raw.issue, /"hour" o "day"/);

  const hour = chooseResolution("hour", 182 * DAY);
  assert.match(hour.issue, /hasta 92 días y este abarca 182/);
  assert.match(hour.issue, /Usá "day"/);
});
