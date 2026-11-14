const test = require("node:test");
const assert = require("node:assert/strict");
const { chooseResolution } = require("../src/services/measurements");

const DAY = 24 * 60 * 60 * 1000;

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
