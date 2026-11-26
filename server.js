require("dotenv").config();

const signalR = require("@microsoft/signalr");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const { SIGNALR_URL, SIGNALR_USERNAME, SIGNALR_PASSWORD } = process.env;

if (!SIGNALR_URL || !SIGNALR_USERNAME || !SIGNALR_PASSWORD) {
  throw new Error("SignalR bağlantı bilgileri eksik.");
}

const GPIO_X = 12;
const GPIO_Y = 13;

const gpioScript = `
import sys
import json
import lgpio

h = lgpio.gpiochip_open(0)

try:
    lgpio.gpio_claim_output(h, ${GPIO_X})
    lgpio.gpio_claim_output(h, ${GPIO_Y})

    print("READY", flush=True)

    for line in sys.stdin:
        try:
            data = json.loads(line)

            x = int(data["x"])
            y = int(data["y"])

            pulse_x = round(1000 + x / 180 * 1000)
            pulse_y = round(1000 + y / 180 * 1000)

            result_x = lgpio.tx_servo(h, ${GPIO_X}, pulse_x)
            result_y = lgpio.tx_servo(h, ${GPIO_Y}, pulse_y)

            if result_x < 0 or result_y < 0:
                raise RuntimeError("Servo PWM hatası")

            print("OK", flush=True)

        except Exception as error:
            print("ERROR: " + str(error), flush=True)

finally:
    lgpio.tx_servo(h, ${GPIO_X}, 0)
    lgpio.tx_servo(h, ${GPIO_Y}, 0)
    lgpio.gpiochip_close(h)
`;

const gpio = spawn("/usr/bin/python3", ["-u", "-c", gpioScript], {
  stdio: ["pipe", "pipe", "pipe"],
});

let gpioReady = false;
let isWriting = false;
let latestAngles = null;

const lines = readline.createInterface({
  input: gpio.stdout,
});

lines.on("line", (message) => {
  if (message === "READY") {
    gpioReady = true;
    console.log("GPIO hazır.");
    sendToServos();
    return;
  }

  isWriting = false;

  if (message === "OK") {
    console.log("Servo komutu uygulandı.");
  } else {
    console.error("GPIO:", message);
  }

  sendToServos();
});

gpio.stderr.on("data", (data) => {
  console.error("GPIO hatası:", data.toString());
});

gpio.on("exit", (code) => {
  console.error("GPIO işlemi kapandı:", code);
  process.exit(1);
});

function sendToServos() {
  if (!gpioReady || isWriting || latestAngles === null) {
    return;
  }

  const { x, y } = latestAngles;
  latestAngles = null;
  isWriting = true;

  const finalX = 180 - x;
  const finalY = y;

  gpio.stdin.write(
    JSON.stringify({
      x: finalX,
      y: finalY,
    }) + "\n",
  );

  console.log(`Servo X: ${finalX}° | Servo Y: ${finalY}°`);
}

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
  sendToServos();
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
    console.error("SignalR hatası:", error.message);
    setTimeout(start, 5000);
  }
}

process.on("SIGINT", () => {
  gpio.stdin.end();
  process.exit(0);
});

process.on("SIGTERM", () => {
  gpio.stdin.end();
  process.exit(0);
});

start();
