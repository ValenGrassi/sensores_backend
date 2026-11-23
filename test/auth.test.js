// Cines y salas: solo la clave de administrador, nunca una de tercero.
const test = require("node:test");
const assert = require("node:assert/strict");
const { requireAdmin } = require("../src/middleware/auth");
const { PERMISSIONS } = require("../src/lib/permissions");

function run(client) {
  let passed = false;
  try {
    requireAdmin({ client }, {}, () => (passed = true));
  } catch (error) {
    return { status: error.status, code: error.code };
  }
  return { passed };
}

test("requireAdmin: sin clave -> 401", () => {
  assert.deepEqual(run(null), { status: 401, code: "API_KEY_REQUIRED" });
});

test("requireAdmin: clave de tercero con TODOS los permisos que se pueden dar -> 403", () => {
  const client = { type: "client", permissions: Object.keys(PERMISSIONS) };
  assert.deepEqual(run(client), { status: 403, code: "FORBIDDEN" });
});

test("requireAdmin: clave de administrador -> pasa", () => {
  assert.deepEqual(run({ type: "admin", permissions: ["*"] }), { passed: true });
});
