/**
 * Piezas del límite de pedidos, sin dependencias externas.
 *
 * - FixedWindowStore: cuenta pedidos por cliente en ventanas fijas (1 minuto,
 *   1 día...). La ventana de cada cliente arranca con su primer pedido.
 *   Vive en memoria: alcanza porque el backend corre en una sola instancia,
 *   y si el servicio se reinicia los contadores vuelven a cero (no pasa nada).
 * - ipKey: identifica a un cliente anónimo por su IP. Las IPv6 se agrupan por
 *   red /64, porque cada conexión hogareña recibe millones de direcciones y
 *   cambiar de una a otra no tiene que alcanzar para saltear el límite.
 */

const net = require("net");

const PRUNE_EVERY_MS = 60 * 1000;
const DEFAULT_MAX_KEYS = 20000;

class FixedWindowStore {
  constructor(windowMs, { maxKeys = DEFAULT_MAX_KEYS } = {}) {
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.entries = new Map();
    this.lastPrune = 0;
  }

  /** Estado actual sin contar el pedido: { count, resetAt }. */
  peek(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) return { count: 0, resetAt: now + this.windowMs };
    return { count: entry.count, resetAt: entry.resetAt };
  }

  /** Suma un pedido y devuelve el estado nuevo. */
  increment(key, now = Date.now()) {
    if (now - this.lastPrune >= PRUNE_EVERY_MS) this.prune(now);

    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      if (entry) this.entries.delete(key);
      if (this.entries.size >= this.maxKeys) this.prune(now, { force: true });
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
    }

    entry.count += 1;
    return { count: entry.count, resetAt: entry.resetAt };
  }

  /** Borra ventanas vencidas; si sigue lleno, descarta las más viejas (10 %). */
  prune(now = Date.now(), { force = false } = {}) {
    this.lastPrune = now;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }

    if (force && this.entries.size >= this.maxKeys) {
      let toDrop = Math.max(1, Math.ceil(this.maxKeys / 10));
      for (const key of this.entries.keys()) {
        this.entries.delete(key);
        if (--toDrop === 0) break;
      }
    }
  }

  get size() {
    return this.entries.size;
  }
}

/** Expande una IPv6 a sus 8 grupos (sin ceros a la izquierda). null si no es válida. */
function ipv6Groups(address) {
  const [head] = address.split("%"); // sin zona (fe80::1%eth0)
  if (!net.isIPv6(head)) return null;

  const toGroups = (part) => {
    if (!part) return [];
    const pieces = part.split(":");
    const last = pieces[pieces.length - 1];
    if (net.isIPv4(last)) {
      const [a, b, c, d] = last.split(".").map(Number);
      pieces.splice(-1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
    }
    return pieces;
  };

  let groups;
  if (head.includes("::")) {
    const [left, right] = head.split("::");
    const leftGroups = toGroups(left);
    const rightGroups = toGroups(right);
    const zeros = new Array(8 - leftGroups.length - rightGroups.length).fill("0");
    groups = [...leftGroups, ...zeros, ...rightGroups];
  } else {
    groups = toGroups(head);
  }

  return groups.map((group) => parseInt(group, 16).toString(16));
}

/** Clave de un cliente anónimo: "ip:1.2.3.4" o "ip6:2001:db8:0:1::/64". */
function ipKey(ip) {
  if (typeof ip !== "string" || ip.trim() === "") return "ip:unknown";

  let address = ip.trim();
  if (address.toLowerCase().startsWith("::ffff:") && net.isIPv4(address.slice(7))) {
    address = address.slice(7); // IPv4 escrita como IPv6
  }

  if (net.isIPv4(address)) return `ip:${address}`;

  const groups = ipv6Groups(address);
  if (groups) return `ip6:${groups.slice(0, 4).join(":")}::/64`;

  return `ip:${address}`;
}

module.exports = { FixedWindowStore, ipKey, ipv6Groups };
