require("dotenv").config();

const signalR = require("@microsoft/signalr");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const { SIGNALR_URL, SIGNALR_USERNAME, SIGNALR_PASSWORD } = process.env;

if (!SIGNALR_URL || !SIGNALR_USERNAME || !SIGNALR_PASSWORD) {
  throw new Error("SignalR bağlantı bilgileri eksik.");
}

const GPIO_X = 17;
const GPIO_Y = 27;

const PWM_IDLE_TIMEOUT = 600;

const gpioScript = `
import sys
import json
import lgpio

GPIO_X = ${GPIO_X}
GPIO_Y = ${GPIO_Y}

h = lgpio.gpiochip_open(0)
claimed = []

try:
    lgpio.gpio_claim_output(h, GPIO_X)
    claimed.append(GPIO_X)

    lgpio.gpio_claim_output(h, GPIO_Y)
    claimed.append(GPIO_Y)

    print("READY", flush=True)

    for line in sys.stdin:
        try:
            data = json.loads(line)
            action = data.get("action")

            if action == "stop":
                lgpio.tx_servo(h, GPIO_X, 0)
                lgpio.tx_servo(h, GPIO_Y, 0)

                print("STOPPED", flush=True)
                continue

            if action == "move":
                x = int(data["x"])
                y = int(data["y"])

                pulse_x = round(1000 + x / 180 * 1000)
                pulse_y = round(1000 + y / 180 * 1000)

                lgpio.tx_servo(h, GPIO_X, pulse_x)
                lgpio.tx_servo(h, GPIO_Y, pulse_y)

                print("OK", flush=True)
                continue

            print("ERROR: Geçersiz komut", flush=True)

        except Exception as error:
            print("ERROR: " + str(error), flush=True)

finally:
    for pin in claimed:
        try:
            lgpio.tx_servo(h, pin, 0)
        except Exception:
            pass

    lgpio.gpiochip_close(h)
`;

const gpio = spawn("/usr/bin/python3", ["-u", "-c", gpioScript], {
  stdio: ["pipe", "pipe", "pipe"],
});

let gpioReady = false;
let isWriting = false;
let latestAngles = null;
let lastAngles = null;
let pwmStopTimer = null;
let shuttingDown = false;

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
  } else if (message === "STOPPED") {
    console.log("Servo PWM durduruldu.");
  } else {
    console.error("GPIO:", message);
  }

  if (latestAngles !== null) {
    sendToServos();
    return;
  }

  if (message === "OK") {
    schedulePwmStop();
  }
});

gpio.stderr.on("data", (data) => {
  console.error("GPIO hatası:", data.toString());
});

gpio.on("error", (error) => {
  console.error("Python başlatma hatası:", error.message);
});

gpio.on("exit", (code) => {
  gpioReady = false;
  clearTimeout(pwmStopTimer);

  if (shuttingDown) {
    process.exit(0);
  }

  console.error("GPIO işlemi kapandı:", code);
  process.exit(1);
});

function schedulePwmStop() {
  clearTimeout(pwmStopTimer);

  pwmStopTimer = setTimeout(() => {
    pwmStopTimer = null;

    if (!gpioReady || isWriting || latestAngles !== null) {
      return;
    }

    isWriting = true;

    gpio.stdin.write(JSON.stringify({ action: "stop" }) + "\n");
  }, PWM_IDLE_TIMEOUT);
}

function sendToServos() {
  if (!gpioReady || isWriting || latestAngles === null) {
    return;
  }

  clearTimeout(pwmStopTimer);
  pwmStopTimer = null;

  const { x, y } = latestAngles;

  latestAngles = null;
  isWriting = true;

  const finalX = 180 - x;
  const finalY = y;

  gpio.stdin.write(
    JSON.stringify({
      action: "move",
      x: finalX,
      y: finalY,
    }) + "\n",
  );

  console.log(`Servo X: ${finalX}° | Servo Y: ${finalY}°`);
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

  // Aynı açı tekrar geldiyse işlem yapma.
  if (lastAngles?.x === x && lastAngles?.y === y) {
    return;
  }

  lastAngles = { x, y };
  latestAngles = { x, y };

  clearTimeout(pwmStopTimer);
  pwmStopTimer = null;

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

  if (!shuttingDown) {
    setTimeout(start, 5000);
  }
});

async function start() {
  if (shuttingDown) {
    return;
  }

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

function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  clearTimeout(pwmStopTimer);

  gpio.stdin.end();

  connection.stop().catch(console.error);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();
