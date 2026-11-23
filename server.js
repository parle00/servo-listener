require("dotenv").config();

const signalR = require("@microsoft/signalr");

const { SIGNALR_URL, SIGNALR_USERNAME, SIGNALR_PASSWORD } = process.env;

if (!SIGNALR_URL || !SIGNALR_USERNAME || !SIGNALR_PASSWORD) {
  throw new Error("SignalR bağlantı bilgileri eksik.");
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
  console.log("X:", data.x, "Y:", data.y);
});

connection.onreconnecting(() => {
  console.log("SignalR yeniden bağlanıyor...");
});

connection.onreconnected(() => {
  console.log("SignalR yeniden bağlandı.");
});

connection.onclose(() => {
  console.log("Bağlantı kapandı.");
  setTimeout(start, 5000);
});

async function start() {
  try {
    await connection.start();
    console.log("SignalR bağlantısı başarılı.");
  } catch (error) {
    console.error("Bağlantı hatası:", error.message);
    setTimeout(start, 5000);
  }
}

start();
