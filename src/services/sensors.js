/**
 * Estado y forma pública de un sensor. Todas las rutas que devuelven un
 * sensor usan toSensorDTO, así el objeto es el mismo en todos lados.
 */

const config = require("../config");

/** Lo que hay que incluir en Prisma para armar un sensor completo. */
const SENSOR_INCLUDE = {
  room: {
    include: {
      cinema: true,
      profile: true,
    },
  },
};

function getSensorStatus(lastSeen, now = Date.now()) {
  if (!lastSeen) return "offline";

  const minutesSinceLastSeen = (now - new Date(lastSeen).getTime()) / (1000 * 60);
  return minutesSinceLastSeen < config.sensorOfflineMinutes ? "online" : "offline";
}

function isOnline(sensor, now = Date.now()) {
  return getSensorStatus(sensor.lastSeen, now) === "online";
}

function toRoomDTO(room) {
  return {
    id: room.id,
    cinemaId: room.cinemaId,
    name: room.name,
    type: room.type,
    profileId: room.profileId,
  };
}

function toCinemaRefDTO(cinema) {
  return {
    id: cinema.id,
    name: cinema.name,
    address: cinema.address,
  };
}

function toProfileDTO(profile) {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    temperatureMin: profile.temperatureMin,
    temperatureMax: profile.temperatureMax,
    humidityMin: profile.humidityMin,
    humidityMax: profile.humidityMax,
  };
}

/**
 * @param sensor  fila de Sensor
 * @param context sala, cine y perfil (por defecto se toman de sensor.room)
 */
function toSensorDTO(sensor, context = {}) {
  const room = context.room ?? sensor.room ?? null;
  const cinema = context.cinema ?? room?.cinema ?? null;
  const profile = context.profile ?? room?.profile ?? null;

  return {
    id: sensor.id,
    devEui: sensor.devEui,
    name: sensor.name,

    temperature: sensor.temperature,
    humidity: sensor.humidity,
    battery: sensor.battery,
    lastSeen: sensor.lastSeen,

    status: getSensorStatus(sensor.lastSeen),

    room: room ? toRoomDTO(room) : null,
    cinema: cinema ? toCinemaRefDTO(cinema) : null,
    profile: profile ? toProfileDTO(profile) : null,
  };
}

/** Los devEUI se guardan siempre en minúscula. */
function normalizeDevEui(devEui) {
  return String(devEui).trim().toLowerCase();
}

module.exports = {
  SENSOR_INCLUDE,
  getSensorStatus,
  isOnline,
  toSensorDTO,
  toRoomDTO,
  toCinemaRefDTO,
  toProfileDTO,
  normalizeDevEui,
};
