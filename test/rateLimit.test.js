/**
 * Tests del límite de pedidos sin base de datos: se arma una app Express
 * mínima con los mismos middlewares y rutas falsas.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { FixedWindowStore, ipKey } = require("../src/lib/rateLimit");
const { createRateLimiter, historyLimit } = require("../src/middleware/rateLimit");
const { errorHandler } = require("../src/middleware/errorHandler");
const { requestId } = require("../src/middleware/requestId");
const { clientIp, resolveClientIp } = require("../src/lib/clientIp");

const SETTINGS = {
  enabled: true,
  anonymous: { perMinute: 5, perDay: 8, historyPerMinute: 2, historyPerDay: 3 },
  client: { perMinute: 10, perDay: 20, historyPerMinute: 4, historyPerDay: 6, writesPerMinute: 2 },
  authFailures: { limit: 3, windowMinutes: 10 },
};

const CLIENTS = {
  "sk_admin": { id: "admin", type: "admin", name: "Admin", permissions: ["*"] },
  "sk_tercero": { id: "c1", type: "client", name: "Tercero", permissions: ["sensors:write"] },
};

/** Igual que identifyClient pero sin base: claves fijas. */
function fakeIdentify(req, res, next) {
  const key = req.get("X-API-Key");
  if (!key) {
    req.client = null;
    return next();
  }
  const client = CLIENTS[key];
  if (!client) return res.status(401).json({ error: { code: "INVALID_API_KEY" } });
  req.client = client;
  next();
}

async function startApp(settings = SETTINGS) {
  const app = express();
  app.set("trust proxy", 1);
  const limiter = createRateLimiter(settings);
  app.locals.rateLimiter = limiter;

  app.use(requestId);
  app.post("/api/telemetry", (req, res) => res.sendStatus(200));
  app.use(clientIp("cf-connecting-ip"));
  app.get(["/health"], limiter.anonymous, (req, res) => res.json({ ok: true }));
  app.use("/api", limiter.authFailures);
  app.use("/api", fakeIdentify);
  app.use(limiter.requests);
  app.get("/api/light", (req, res) => res.json({ ok: true }));
  app.get("/api/heavy", historyLimit, (req, res) => res.json({ ok: true }));
  app.patch("/api/write", (req, res) => res.json({ ok: true }));
  app.get("/api/me", (req, res) => res.json(limiter.status(req)));
  app.use(errorHandler);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    limiter,
    close: () => new Promise((resolve) => server.close(resolve)),
    call: async (method, path, { key, ip = "203.0.113.10", cf } = {}) => {
      const headers = { "X-Forwarded-For": ip };
      if (key) headers["X-API-Key"] = key;
      if (cf) headers["CF-Connecting-IP"] = cf;
      const res = await fetch(base + path, { method, headers });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: res.status, headers: res.headers, body };
    },
  };
}

async function repeat(n, fn) {
  const results = [];
  for (let i = 0; i < n; i++) results.push(await fn(i));
  return results;
}

// ─── Piezas sueltas ─────────────────────────────────────────────

test("FixedWindowStore cuenta, vence y se reinicia", () => {
  const store = new FixedWindowStore(1000);
  assert.equal(store.increment("a", 0).count, 1);
  assert.equal(store.increment("a", 500).count, 2);
  assert.deepEqual(store.peek("a", 999), { count: 2, resetAt: 1000 });
  assert.equal(store.peek("a", 1000).count, 0, "al vencer, peek devuelve 0");
  assert.equal(store.increment("a", 1000).count, 1, "al vencer, arranca una ventana nueva");
  assert.equal(store.increment("b", 1000).count, 1, "cada clave tiene su contador");
});

test("FixedWindowStore no crece sin límite", () => {
  const store = new FixedWindowStore(60000, { maxKeys: 100 });
  for (let i = 0; i < 1000; i++) store.increment(`k${i}`, 0);
  assert.ok(store.size <= 100, `tamaño ${store.size}`);
  store.prune(60000);
  assert.equal(store.size, 0, "las ventanas vencidas se borran");
});

test("ipKey normaliza IPv4, IPv4-en-IPv6 e IPv6 por red /64", () => {
  assert.equal(ipKey("190.12.3.4"), "ip:190.12.3.4");
  assert.equal(ipKey("::ffff:190.12.3.4"), "ip:190.12.3.4");
  assert.equal(ipKey("2001:db8:abcd:12::1"), "ip6:2001:db8:abcd:12::/64");
  assert.equal(ipKey("2001:0db8:abcd:0012:ffff:1:2:3"), "ip6:2001:db8:abcd:12::/64", "misma red /64 = misma clave");
  assert.equal(ipKey("::1"), "ip6:0:0:0:0::/64");
  assert.equal(ipKey("fe80::1%eth0"), "ip6:fe80:0:0:0::/64");
  assert.equal(ipKey("64:ff9b::192.0.2.33"), "ip6:64:ff9b:0:0::/64");
  assert.equal(ipKey(undefined), "ip:unknown");
});

// ─── Middleware completo ────────────────────────────────────────

test("resolveClientIp: usa el header si trae una IP válida; si no, req.ip", () => {
  const fakeReq = (headers, ip = "172.68.175.59") => ({
    ip,
    get: (name) => headers[name.toLowerCase()],
  });
  const header = "cf-connecting-ip";
  assert.equal(resolveClientIp(fakeReq({ "cf-connecting-ip": "170.150.154.61" }), header), "170.150.154.61");
  assert.equal(resolveClientIp(fakeReq({ "cf-connecting-ip": " 2800:810:1::5 " }), header), "2800:810:1::5");
  assert.equal(resolveClientIp(fakeReq({}), header), "172.68.175.59", "sin header: req.ip");
  assert.equal(resolveClientIp(fakeReq({ "cf-connecting-ip": "no-es-ip" }), header), "172.68.175.59");
  assert.equal(resolveClientIp(fakeReq({ "cf-connecting-ip": "1.2.3.4, 5.6.7.8" }), header), "172.68.175.59");
  assert.equal(resolveClientIp(fakeReq({ "cf-connecting-ip": "170.150.154.61" }), null), "172.68.175.59", "header desactivado");
});

test("detrás de Cloudflare: el cupo sigue a CF-Connecting-IP aunque cambie el proxy", async () => {
  const app = await startApp();
  try {
    // Como en Render: cada pedido llega por un nodo de Cloudflare distinto.
    const results = await repeat(6, (i) =>
      app.call("GET", "/api/light", { ip: `172.68.175.${i + 1}`, cf: "170.150.154.61" })
    );
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200, 429]);

    const other = await app.call("GET", "/api/light", { ip: "172.68.175.1", cf: "190.12.3.4" });
    assert.equal(other.status, 200, "otra IP real, mismo nodo de Cloudflare: cupo propio");

    const me = await app.call("GET", "/api/me", { cf: "190.12.3.4" });
    assert.equal(me.body.requests.perMinute.remaining, 3);
  } finally {
    await app.close();
  }
});

test("anónimo: límite por minuto, headers y 429 con el formato de error", async () => {
  const app = await startApp();
  try {
    const ok = await repeat(5, () => app.call("GET", "/api/light"));
    assert.ok(ok.every((r) => r.status === 200));
    assert.equal(ok[0].headers.get("ratelimit-limit"), "5");
    assert.equal(ok[0].headers.get("ratelimit-remaining"), "4");
    assert.equal(ok[4].headers.get("ratelimit-remaining"), "0");
    assert.ok(Number(ok[0].headers.get("ratelimit-reset")) > 0);

    const blocked = await app.call("GET", "/api/light");
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, "RATE_LIMITED");
    assert.equal(blocked.body.error.limit.scope, "requests");
    assert.equal(blocked.body.error.limit.max, 5);
    assert.equal(blocked.body.error.limit.windowSeconds, 60);
    assert.ok(blocked.body.error.retryAfterSeconds > 0 && blocked.body.error.retryAfterSeconds <= 60);
    assert.equal(blocked.headers.get("retry-after"), String(blocked.body.error.retryAfterSeconds));
    assert.equal(blocked.headers.get("ratelimit-remaining"), "0");
    assert.match(blocked.body.error.message, /5 por minuto/);
    assert.ok(blocked.body.error.requestId, "incluye requestId");

    const otherIp = await app.call("GET", "/api/light", { ip: "198.51.100.7" });
    assert.equal(otherIp.status, 200, "otra IP tiene su propio cupo");
  } finally {
    await app.close();
  }
});

test("un pedido rechazado no consume cupo, y el cupo diario corta aunque el minuto se renueve", async () => {
  const app = await startApp();
  try {
    await repeat(5, () => app.call("GET", "/api/light"));
    await repeat(3, () => app.call("GET", "/api/light")); // rechazados
    assert.equal(app.limiter.stores.requestsDay.peek("ip:203.0.113.10").count, 5, "los rechazados no suman");

    // Simula que pasó el minuto: se vacía solo la ventana de 1 minuto.
    app.limiter.stores.requestsMinute.entries.clear();
    const more = await repeat(3, () => app.call("GET", "/api/light"));
    assert.deepEqual(more.map((r) => r.status), [200, 200, 200]);

    const blocked = await app.call("GET", "/api/light");
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.limit.windowSeconds, 86400);
    assert.match(blocked.body.error.message, /8 por día/);
    assert.ok(blocked.body.error.retryAfterSeconds > 60, "espera hasta que se renueve el día");
  } finally {
    await app.close();
  }
});

test("headers informan el límite más cercano a agotarse", async () => {
  const app = await startApp();
  try {
    const first = await app.call("GET", "/api/light");
    assert.equal(first.headers.get("ratelimit-limit"), "5", "minuto (4 restantes) antes que día (7)");

    const heavy = await app.call("GET", "/api/heavy");
    assert.equal(heavy.headers.get("ratelimit-limit"), "2", "en historial manda el límite de historial");
    assert.equal(heavy.headers.get("ratelimit-remaining"), "1");
  } finally {
    await app.close();
  }
});

test("historial: límite propio por minuto y por día, que se suma al general", async () => {
  const app = await startApp();
  try {
    const statuses = (await repeat(3, () => app.call("GET", "/api/heavy"))).map((r) => r.status);
    assert.deepEqual(statuses, [200, 200, 429]);
    const blocked = await app.call("GET", "/api/heavy");
    assert.equal(blocked.body.error.limit.scope, "history");
    assert.match(blocked.body.error.message, /consultas de historial/);

    const light = await app.call("GET", "/api/light");
    assert.equal(light.status, 200, "las lecturas livianas siguen andando");

    // Pasa el minuto (de historial y general: el historial también cuenta en el general).
    app.limiter.stores.historyMinute.entries.clear();
    app.limiter.stores.requestsMinute.entries.clear();
    assert.equal((await app.call("GET", "/api/heavy")).status, 200);
    app.limiter.stores.historyMinute.entries.clear();
    const daily = await app.call("GET", "/api/heavy");
    assert.equal(daily.status, 429);
    assert.equal(daily.body.error.limit.windowSeconds, 86400);
  } finally {
    await app.close();
  }
});

test("clave de tercero: cupo por clave (no por IP) y límite de escrituras", async () => {
  const app = await startApp();
  try {
    const fromTwoIps = await repeat(10, (i) =>
      app.call("GET", "/api/light", { key: "sk_tercero", ip: i % 2 ? "198.51.100.1" : "198.51.100.2" })
    );
    assert.ok(fromTwoIps.every((r) => r.status === 200));
    assert.equal(fromTwoIps[0].headers.get("ratelimit-limit"), "10");
    const blocked = await app.call("GET", "/api/light", { key: "sk_tercero", ip: "198.51.100.3" });
    assert.equal(blocked.status, 429, "cambiar de IP no renueva el cupo de la clave");

    const anonSameIp = await app.call("GET", "/api/light", { ip: "198.51.100.1" });
    assert.equal(anonSameIp.status, 200, "el cupo de la clave no afecta a los anónimos de esa IP");

    app.limiter.stores.requestsMinute.entries.clear();
    const writes = await repeat(3, () => app.call("PATCH", "/api/write", { key: "sk_tercero" }));
    assert.deepEqual(writes.map((r) => r.status), [200, 200, 429]);
    assert.equal(writes[2].body.error.limit.scope, "writes");
    assert.equal((await app.call("GET", "/api/light", { key: "sk_tercero" })).status, 200, "leer sigue andando");
  } finally {
    await app.close();
  }
});

test("admin: sin límites", async () => {
  const app = await startApp();
  try {
    const results = await repeat(30, () => app.call("GET", "/api/heavy", { key: "sk_admin" }));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(results[0].headers.get("ratelimit-limit"), null, "sin headers de límite");
    const me = await app.call("GET", "/api/me", { key: "sk_admin" });
    assert.deepEqual(me.body, { enabled: true, tier: "admin", unlimited: true });
  } finally {
    await app.close();
  }
});

test("claves inválidas: tras varios 401 desde una IP, 429 para pedidos con clave", async () => {
  const app = await startApp();
  try {
    const attempts = await repeat(4, () => app.call("GET", "/api/light", { key: "sk_falsa" }));
    assert.deepEqual(attempts.map((r) => r.status), [401, 401, 401, 429]);
    assert.equal(attempts[3].body.error.limit.scope, "auth");
    assert.match(attempts[3].body.error.message, /clave de API inválida/);

    assert.equal((await app.call("GET", "/api/light")).status, 200, "sin clave sigue pudiendo leer");
    assert.equal(
      (await app.call("GET", "/api/light", { key: "sk_falsa", ip: "198.51.100.9" })).status,
      401,
      "otra IP no está bloqueada"
    );
  } finally {
    await app.close();
  }
});

test("rutas públicas (/health) se limitan por IP aunque manden clave", async () => {
  const app = await startApp();
  try {
    const results = await repeat(6, () => app.call("GET", "/health", { key: "sk_admin" }));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200, 429]);
  } finally {
    await app.close();
  }
});

test("la telemetría nunca se limita ni consume el cupo de la IP", async () => {
  const app = await startApp();
  try {
    const results = await Promise.all(
      Array.from({ length: 200 }, () => app.call("POST", "/api/telemetry"))
    );
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(results[0].headers.get("ratelimit-limit"), null);
    const read = await app.call("GET", "/api/light");
    assert.equal(read.headers.get("ratelimit-remaining"), "4", "la IP del gateway conserva todo su cupo");
  } finally {
    await app.close();
  }
});

test("pedidos concurrentes: nunca pasan más que el límite", async () => {
  const app = await startApp({ ...SETTINGS, anonymous: { ...SETTINGS.anonymous, perMinute: 50, perDay: 1000 } });
  try {
    const results = await Promise.all(Array.from({ length: 120 }, () => app.call("GET", "/api/light")));
    assert.equal(results.filter((r) => r.status === 200).length, 50);
    assert.equal(results.filter((r) => r.status === 429).length, 70);
  } finally {
    await app.close();
  }
});

test("/me informa límites y restantes; deshabilitado no limita nada", async () => {
  const app = await startApp();
  try {
    await app.call("GET", "/api/light");
    const me = await app.call("GET", "/api/me");
    assert.equal(me.body.tier, "anonymous");
    assert.equal(me.body.requests.perMinute.limit, 5);
    assert.equal(me.body.requests.perMinute.remaining, 3, "cuenta el pedido anterior y el propio /me");
    assert.equal(me.body.history.perDay.limit, 3);

    const client = await app.call("GET", "/api/me", { key: "sk_tercero" });
    assert.equal(client.body.tier, "client");
    assert.equal(client.body.writes.perMinute.limit, 2);
  } finally {
    await app.close();
  }

  const disabled = await startApp({ ...SETTINGS, enabled: false });
  try {
    const results = await repeat(12, () => disabled.call("GET", "/api/heavy"));
    assert.ok(results.every((r) => r.status === 200));
    assert.deepEqual((await disabled.call("GET", "/api/me")).body, { enabled: false });
  } finally {
    await disabled.close();
  }
});
