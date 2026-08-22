const prisma = require("../lib/prisma");

async function evaluateSensorAlert(sensorId) {
  const sensor = await prisma.sensor.findUnique({
    where: {
      id: sensorId
    },
    include: {
      room: {
        include: {
          profile: true
        }
      }
    }
  });

  if (!sensor) {
    console.log("Sensor no encontrado para evaluar alerta:", sensorId);
    return;
  }

  const profile = sensor.room?.profile;

  if (!profile) {
    console.log(
      `El sensor ${sensor.name || sensor.devEui} no tiene una sala o perfil asignado`
    );
    return;
  }

  const temperature = sensor.temperature;
  const humidity = sensor.humidity;

  let alertType = null;

  if (temperature !== null) {
    if (temperature > profile.temperatureMax) {
      alertType = "temperature_high";
    } else if (temperature < profile.temperatureMin) {
      alertType = "temperature_low";
    }
  }

  if (!alertType && humidity !== null) {
    if (humidity > profile.humidityMax) {
      alertType = "humidity_high";
    } else if (humidity < profile.humidityMin) {
      alertType = "humidity_low";
    }
  }

  if (alertType) {
    const existingAlert = await prisma.alert.findFirst({
      where: {
        sensorId: sensor.id,
        type: alertType,
        active: true
      }
    });

    if (!existingAlert) {
      await prisma.alert.create({
        data: {
          sensorId: sensor.id,
          type: alertType,
          temperature: temperature ?? 0,
          humidity: humidity ?? 0,
          active: true
        }
      });

      console.log(
        `🚨 ALERTA CREADA: ${alertType} - Sensor: ${sensor.name || sensor.devEui}`
      );
    } else {
      console.log(
        `⚠️ Ya existe una alerta activa: ${alertType} - Sensor: ${sensor.name || sensor.devEui}`
      );
    }
  } else {
    const resolvedAlerts = await prisma.alert.updateMany({
      where: {
        sensorId: sensor.id,
        active: true
      },
      data: {
        active: false,
        resolvedAt: new Date()
      }
    });

    if (resolvedAlerts.count > 0) {
      console.log(
        `✅ Alertas resueltas para: ${sensor.name || sensor.devEui}`
      );
    }
  }
}

module.exports = { evaluateSensorAlert };