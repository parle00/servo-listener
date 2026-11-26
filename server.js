require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const signalR = require("@microsoft/signalr");

const { SIGNALR_URL, SIGNALR_USERNAME, SIGNALR_PASSWORD } = process.env;

if (!SIGNALR_URL || !SIGNALR_USERNAME || !SIGNALR_PASSWORD) {
  throw new Error("SignalR bağlantı bilgileri eksik.");
}

// GPIO12 ve GPIO13 donanım PWM pinleridir (PWM kanal 0 ve 1).
// Yazılım PWM'i (lgpio.tx_servo) Linux zamanlamasına bağlı olduğu için
// darbeler oynar ve servo titrer. Donanım PWM'inde darbeyi çip üretir.
// Kurulum (/boot/firmware/config.txt, sonra reboot):
//   dtoverlay=pwm-2chan,pin=12,func=4,pin2=13,func2=4
const PWM_CHANNEL_X = 0; // GPIO12
const PWM_CHANNEL_Y = 1; // GPIO13

const PWM_PERIOD_NS = 20_000_000; // 50 Hz

// Çoğu servo (SG90, MG90S, MG996R) 0-180° için ~500-2500 µs ister;
// 1000-2000 µs sadece ~90° hareket verir. Uçlarda servo dayanıp
// vızlıyorsa .env'den daraltın (örn. SERVO_MIN_US=600, SERVO_MAX_US=2400).
const SERVO_MIN_US = Number(process.env.SERVO_MIN_US ?? 500);
const SERVO_MAX_US = Number(process.env.SERVO_MAX_US ?? 2500);

const PWM_SYSFS = "/sys/class/pwm";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findPwmChip() {
  if (process.env.PWM_CHIP !== undefined) {
    return path.join(PWM_SYSFS, `pwmchip${process.env.PWM_CHIP}`);
  }

  const chips = fs.existsSync(PWM_SYSFS)
    ? fs.readdirSync(PWM_SYSFS).filter((name) => name.startsWith("pwmchip"))
    : [];

  // Pi 5: 1f00098000.pwm | Pi 4: fe20c000.pwm | Pi 3 ve öncesi: 3f20c000.pwm / 2020c000.pwm
  // (Pi 5'teki fan PWM'i 1f0009c000.pwm'dir, ona dokunmuyoruz.)
  const chip = chips.find((name) =>
    /(1f00098000|20c000)\.pwm\//.test(
      fs.realpathSync(path.join(PWM_SYSFS, name)),
    ),
  );

  if (!chip) {
    throw new Error(
      "Donanım PWM bulunamadı. /boot/firmware/config.txt dosyasına " +
        "'dtoverlay=pwm-2chan,pin=12,func=4,pin2=13,func2=4' ekleyip yeniden başlatın. " +
        `(Bulunan: ${chips.join(", ") || "yok"})`,
    );
  }

  return path.join(PWM_SYSFS, chip);
}

async function writeWithRetry(file, value) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, String(value));
      return;
    } catch (error) {
      // export sonrası dosyalar ve udev izinleri birkaç ms gecikebilir.
      if (attempt >= 20 || !["EACCES", "ENOENT"].includes(error.code)) {
        throw error;
      }
      await sleep(100);
    }
  }
}

async function setupChannel(chip, channel) {
  const dir = path.join(chip, `pwm${channel}`);

  if (!fs.existsSync(dir)) {
    fs.writeFileSync(path.join(chip, "export"), String(channel));
  }

  const duty = path.join(dir, "duty_cycle");
  const enable = path.join(dir, "enable");

  await writeWithRetry(path.join(dir, "period"), PWM_PERIOD_NS);
  await writeWithRetry(duty, 0); // ilk açı gelene kadar darbe yok
  await writeWithRetry(enable, 1);

  return { duty, enable, lastDuty: null };
}

function setServo(servo, angle) {
  const pulseUs =
    SERVO_MIN_US + (angle / 180) * (SERVO_MAX_US - SERVO_MIN_US);
  const duty = Math.round(pulseUs * 1000);

  if (duty === servo.lastDuty) {
    return false;
  }

  fs.writeFileSync(servo.duty, String(duty));
  servo.lastDuty = duty;
  return true;
}

function parseAngle(value) {
  const angle = typeof value === "string" ? Number.parseFloat(value) : value;

  if (typeof angle !== "number" || !Number.isFinite(angle)) {
    return null;
  }

  return Math.min(180, Math.max(0, angle));
}

let servoX = null;
let servoY = null;

function handleAngles(data) {
  const x = parseAngle(data?.x ?? data?.X);
  const y = parseAngle(data?.y ?? data?.Y);

  if (x === null || y === null) {
    console.error("Geçersiz açı:", data);
    return;
  }

  const finalX = 180 - x;
  const finalY = y;

  try {
    const changedX = setServo(servoX, finalX);
    const changedY = setServo(servoY, finalY);

    if (changedX || changedY) {
      console.log(
        `Servo X: ${+finalX.toFixed(1)}° | Servo Y: ${+finalY.toFixed(1)}°`,
      );
    }
  } catch (error) {
    console.error("PWM yazma hatası:", error.message);
  }
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

connection.on("ReceiveAngles", handleAngles);

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

// Kamera yayını (VDO.Ninja / WebRTC). Ayrı bir alt süreçte çalışır;
// kamera tarafında hata olsa bile servo kontrolü etkilenmez.
const camera = require("./camera").start();

function shutdown() {
  camera.stop();

  for (const servo of [servoX, servoY]) {
    if (!servo) continue;

    try {
      fs.writeFileSync(servo.enable, "0");
    } catch {
      // kapanırken hata önemli değil
    }
  }

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  const chip = findPwmChip();

  servoX = await setupChannel(chip, PWM_CHANNEL_X);
  servoY = await setupChannel(chip, PWM_CHANNEL_Y);

  console.log(
    `Donanım PWM hazır (${path.basename(chip)}, ${SERVO_MIN_US}-${SERVO_MAX_US} µs).`,
  );

  start();
}

main().catch((error) => {
  console.error("PWM başlatılamadı:", error.message);

  if (error.code === "EACCES") {
    console.error(
      "İzin hatası: kullanıcıyı 'gpio' grubuna ekleyin (sudo usermod -aG gpio $USER) ya da sudo ile çalıştırın.",
    );
  }

  process.exit(1);
});
