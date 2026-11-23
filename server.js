require("dotenv").config();

const signalR = require("@microsoft/signalr");
const { SerialPort } = require("serialport");

const {
  SIGNALR_URL,
  SIGNALR_USERNAME,
  SIGNALR_PASSWORD,
  SERIAL_PORT = "/dev/ttyUSB0",
} = process.env;

if (!SIGNALR_URL || !SIGNALR_USERNAME || !SIGNALR_PASSWORD) {
  throw new Error("SignalR bağlantı bilgileri eksik.");
}

// Arduino Serial
const serialPort = new SerialPort({
  path: SERIAL_PORT,
  baudRate: 9600,
  autoOpen: false,
});

let arduinoReady = false;
let isWriting = false;
let latestAngles = null;
let serialRetryTimer = null;

function openSerial() {
  if (serialPort.isOpen || serialPort.opening) return;

  serialPort.open((error) => {
    if (error) {
      console.error("Arduino bağlantı hatası:", error.message);
      scheduleSerialReconnect();
    }
  });
}

function scheduleSerialReconnect() {
  if (serialRetryTimer) return;

  serialRetryTimer = setTimeout(() => {
    serialRetryTimer = null;
    openSerial();
  }, 3000);
}

serialPort.on("open", () => {
  console.log("Arduino bağlandı:", SERIAL_PORT);

  // Arduino USB bağlantısında resetlenebilir.
  setTimeout(() => {
    if (!serialPort.isOpen) return;

    arduinoReady = true;
    console.log("Arduino hazır.");

    sendToArduino();
  }, 2000);
});

serialPort.on("close", () => {
  arduinoReady = false;
  isWriting = false;

  console.log("Arduino bağlantısı kapandı.");
  scheduleSerialReconnect();
});

serialPort.on("error", (error) => {
  console.error("Serial hatası:", error.message);
});

// Arduino'ya açıları gönder
function sendToArduino() {
  if (!arduinoReady || !serialPort.isOpen) return;
  if (isWriting || latestAngles === null) return;

  const { x, y } = latestAngles;
  latestAngles = null;
  isWriting = true;
  finalX = 180 - x;
  finalY = y;

  const command = `${finalX},${finalY}\n`;

  serialPort.write(command, (error) => {
    if (error) {
      console.error("Serial yazma hatası:", error.message);
      isWriting = false;
      return;
    }

    serialPort.drain((error) => {
      isWriting = false;

      if (error) {
        console.error("Serial drain hatası:", error.message);
        return;
      }

      console.log("Arduino:", command.trim());

      // Beklerken yeni açı geldiyse sonuncuyu gönder.
      if (latestAngles !== null) {
        sendToArduino();
      }
    });
  });
}

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

  latestAngles = { x, y };

  sendToArduino();
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
  try {
    await connection.start();
    console.log("SignalR bağlantısı başarılı.");
  } catch (error) {
    console.error("SignalR bağlantı hatası:", error.message);
    setTimeout(start, 5000);
  }
}

openSerial();
start();
