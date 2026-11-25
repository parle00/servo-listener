require("dotenv").config();

const signalR = require("@microsoft/signalr");
const { Gpio } = require("pigpio");

const { SIGNALR_URL, SIGNALR_USERNAME, SIGNALR_PASSWORD } = process.env;

if (!SIGNALR_URL || !SIGNALR_USERNAME || !SIGNALR_PASSWORD) {
  throw new Error("SignalR bağlantı bilgileri eksik.");
}

// Raspberry Pi GPIO
const servoX = new Gpio(14, { mode: Gpio.OUTPUT });
const servoY = new Gpio(15, { mode: Gpio.OUTPUT });

// Açıyı servo PWM sinyaline dönüştür.
function angleToPulse(angle) {
  return Math.round(1000 + (angle / 180) * 1000);
}

// Servolara doğrudan yaz.
function sendToServos(x, y) {
  try {
    const finalX = 180 - x;
    const finalY = y;

    servoX.servoWrite(angleToPulse(finalX));
    servoY.servoWrite(angleToPulse(finalY));

    console.log(`Servo X: ${finalX}° | Servo Y: ${finalY}°`);

    return true;
  } catch (error) {
    console.error("Servo yazma hatası:", error.message);
    return false;
  }
}

// Başlangıç konumu
sendToServos(90, 90);

// SignalR
const credentials = Buffer.from(
  `${SIGNALR_USERNAME}:${SIGNALR_PASSWORD}`,
).toString("base64");

const connection = new signalR.HubConnectionBuilder()
  .withUrl(SIGNALR_URL, {
    headers: {
      Authorization: `Basic ${credentials}`,
    },
  })
  .withAutomaticReconnect([0, 2000, 5000, 10000])
  .build();

connection.on("ReceiveAngles", (data) => {
  const x = data?.x ?? data?.X;
  const y = data?.y ?? data?.Y;

  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    x > 180 ||
    y < 0 ||
    y > 180
  ) {
    console.error("Geçersiz açı:", data);
    return;
  }

  sendToServos(x, y);
});

connection.onreconnecting(() => {
  console.log("SignalR yeniden bağlanıyor...");
});

connection.onreconnected(() => {
  console.log("SignalR yeniden bağlandı.");
});

connection.onclose(() => {
  console.log("SignalR bağlantısı kapandı.");
  setTimeout(start, 5000);
});

async function start() {
  if (connection.state !== signalR.HubConnectionState.Disconnected) {
    return;
  }

  try {
    await connection.start();
    console.log("SignalR bağlantısı başarılı.");
  } catch (error) {
    console.error("SignalR bağlantı hatası:", error.message);
    setTimeout(start, 5000);
  }
}

function shutdown() {
  servoX.servoWrite(0);
  servoY.servoWrite(0);

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();
