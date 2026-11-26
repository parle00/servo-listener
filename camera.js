// USB kamera -> FFmpeg (H.264/RTP) -> werift (WebRTC) -> VDO.Ninja
//
// server.js bu modülü `require("./camera").start()` ile başlatır. Kamera
// ayrı bir alt süreçte (child process) çalışır; böylece WebRTC/FFmpeg
// tarafında oluşabilecek bir çökme ya da yük servo kontrolünü etkilemez.
// Alt süreç ölürse ana süreç onu birkaç saniye sonra yeniden başlatır.
//
// Tek başına test için: node camera.js

require("dotenv").config({ quiet: true });

const { fork, spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const fs = require("node:fs");

const LOG = "[Kamera]";

// Komut satırında bu işaret bulunan FFmpeg süreçleri bize aittir.
// Önceki çalışmadan artakalan (kameraya kilitli) FFmpeg'i bununla temizliyoruz.
const FFMPEG_MARKER = "servo-listener-camera";

function readConfig() {
  const env = process.env;
  const num = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  const password = env.CAMERA_PASSWORD ?? "someEncryptionKey123";

  return {
    device: env.CAMERA_DEVICE || "/dev/video0",
    streamId: (env.CAMERA_STREAM_ID || "").trim(),
    width: num(env.CAMERA_WIDTH, 640),
    height: num(env.CAMERA_HEIGHT, 480),
    fps: num(env.CAMERA_FPS, 30),
    bitrateKbps: num(env.CAMERA_BITRATE, 600),
    inputFormat: env.CAMERA_INPUT_FORMAT || "yuyv422",
    maxViewers: num(env.CAMERA_MAX_VIEWERS, 4),
    signalingUrl: env.CAMERA_SIGNALING_URL || "wss://wss.vdo.ninja:443",
    // VDO.Ninja varsayılan olarak bu parolayla signaling mesajlarını şifreler.
    // İzleme linkine &password=... eklemediyseniz değiştirmeyin.
    // "false" yazılırsa şifreleme kapanır (link'e &password=false gerekir).
    password: ["", "false", "0", "off"].includes(password.toLowerCase())
      ? null
      : password,
    turnUrl: env.CAMERA_TURN_URL || null,
    turnUsername: env.CAMERA_TURN_USERNAME,
    turnPassword: env.CAMERA_TURN_PASSWORD,
  };
}

// ---------------------------------------------------------------------------
// Ana süreç tarafı (server.js içinden çağrılır)
// ---------------------------------------------------------------------------

function start() {
  let child = null;
  let stopping = false;
  let restartTimer = null;
  let restartDelay = 2000;
  let startedAt = 0;

  const launch = () => {
    restartTimer = null;
    if (stopping) return;

    try {
      startedAt = Date.now();
      child = fork(__filename, [], {
        env: { ...process.env, CAMERA_WORKER: "1" },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
    } catch (error) {
      console.error(LOG, "Kamera süreci başlatılamadı:", error.message);
      scheduleRestart();
      return;
    }

    child.on("error", (error) => {
      console.error(LOG, "Kamera süreci hatası:", error.message);
    });

    child.on("exit", (code, signal) => {
      child = null;
      if (stopping) return;

      // Kalıcı yapılandırma hatası (örn. stream ID yok): tekrar deneme.
      if (code === 78) return;

      // Uzun süre düzgün çalıştıysa bekleme süresini sıfırla.
      if (Date.now() - startedAt > 60_000) restartDelay = 2000;

      console.error(
        LOG,
        `Kamera süreci kapandı (${signal ?? `kod ${code}`}), ` +
          `${restartDelay / 1000} sn sonra yeniden başlatılacak. Servo kontrolü etkilenmez.`,
      );
      scheduleRestart();
    });
  };

  const scheduleRestart = () => {
    if (stopping || restartTimer) return;
    restartTimer = setTimeout(launch, restartDelay);
    restartDelay = Math.min(restartDelay * 2, 30_000);
  };

  try {
    launch();
  } catch (error) {
    console.error(LOG, "Kamera başlatılamadı:", error.message);
  }

  return {
    stop() {
      stopping = true;
      clearTimeout(restartTimer);
      if (child && child.exitCode === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          // kapanırken hata önemli değil
        }
      }
    },
  };
}

module.exports = { start };

// ---------------------------------------------------------------------------
// Kamera alt süreci
// ---------------------------------------------------------------------------

function runWorker() {
  const config = readConfig();

  if (!config.streamId) {
    console.error(LOG, "CAMERA_STREAM_ID tanımlı değil, kamera yayını kapalı.");
    process.exit(78);
  }

  if (!/^[A-Za-z0-9_]+$/.test(config.streamId)) {
    console.error(
      LOG,
      "CAMERA_STREAM_ID yalnızca harf, rakam ve '_' içerebilir. Kamera yayını kapalı.",
    );
    process.exit(78);
  }

  let werift;
  let WebSocket;
  try {
    werift = require("werift");
    WebSocket = require("ws");
  } catch (error) {
    console.error(
      LOG,
      "Bağımlılıklar yüklenemedi (npm install çalıştırın):",
      error.message,
    );
    process.exit(78);
  }

  const { RTCPeerConnection, MediaStream, MediaStreamTrack, RtpPacket, useH264 } =
    werift;

  const viewUrl = `https://vdo.ninja/?view=${config.streamId}`;
  const salt = "vdo.ninja";
  const phrase = config.password ? config.password + salt : null;
  const aesKey = phrase
    ? crypto.createHash("sha256").update(phrase, "utf8").digest()
    : null;
  // VDO.Ninja, parolalı yayınlarda stream ID'nin sonuna parola özetinin
  // ilk 6 hex karakterini ekler; izleyici de aynı ID'yi arar.
  const signalingStreamId =
    config.streamId +
    (phrase
      ? crypto.createHash("sha256").update(phrase, "utf8").digest("hex").slice(0, 6)
      : "");

  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ];
  if (config.turnUrl) {
    iceServers.push({
      urls: config.turnUrl,
      username: config.turnUsername,
      credential: config.turnPassword,
    });
  }

  let stopping = false;

  // Bazı WebRTC hataları kütüphane içinden yakalanmamış olarak gelebilir.
  // Bu süreç yalnızca kamera içindir; loglayıp çalışmaya devam ediyoruz.
  process.on("unhandledRejection", (reason) => {
    console.error(LOG, "Yakalanmamış hata:", reason?.message ?? reason);
  });

  // ----------------------------------------------------------------- şifreleme

  function encrypt(value) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return [data.toString("hex"), iv.toString("hex")];
  }

  function decrypt(hex, ivHex) {
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      aesKey,
      Buffer.from(ivHex, "hex"),
    );
    const data = Buffer.concat([
      decipher.update(Buffer.from(hex, "hex")),
      decipher.final(),
    ]);
    return JSON.parse(data.toString("utf8"));
  }

  // ------------------------------------------------------- video kaynağı (RTP)

  // FFmpeg'in ürettiği RTP paketleri bu track'e yazılır. Her izleyici bunun
  // bir kopyasını (clone) alır; kopyalar aynı kaynağı paylaşır.
  const sourceTrack = new MediaStreamTrack({ kind: "video" });

  const rtpSocket = dgram.createSocket({ type: "udp4", recvBufferSize: 1 << 20 });
  let rtpPort = 0;
  let lastPacketAt = 0;
  let sourceChanged = false;

  rtpSocket.on("message", (packet) => {
    if (packet.length < 12 || packet[0] >> 6 !== 2) return;

    // RTCP (200-204) paketlerini atla; werift kendi RTCP'sini üretir.
    const payloadType = packet[1] & 0x7f;
    if (payloadType >= 72 && payloadType <= 76) return;

    lastPacketAt = Date.now();

    try {
      if (sourceChanged) {
        // FFmpeg yeniden başladı: göndericiler sıra no / zaman damgasını
        // kesintisiz sürdürsün, izleyicide görüntü donmasın.
        sourceChanged = false;
        sourceTrack.notifySourceChanged(RtpPacket.deSerialize(packet).header);
      }
      sourceTrack.writeRtp(packet);
    } catch (error) {
      console.error(LOG, "RTP yazma hatası:", error.message);
    }
  });

  rtpSocket.on("error", (error) => {
    console.error(LOG, "RTP soketi hatası:", error.message);
  });

  // ------------------------------------------------------------------- FFmpeg

  let ffmpeg = null;
  let ffmpegStartedAt = 0;
  let ffmpegRetryTimer = null;
  let ffmpegIdleTimer = null;
  let ffmpegRetryDelay = 2000;
  let cameraMissingLogged = false;

  function killStaleFfmpeg() {
    try {
      spawnSync("pkill", ["-f", FFMPEG_MARKER], { stdio: "ignore" });
    } catch {
      // pkill yoksa önemli değil
    }
  }

  function ffmpegArgs() {
    const { device, width, height, fps, bitrateKbps, inputFormat } = config;

    const input =
      device === "testsrc"
        ? // Kamera olmadan test: renkli test deseni
          ["-re", "-f", "lavfi", "-i", `testsrc=size=${width}x${height}:rate=${fps}`]
        : [
            "-f", "v4l2",
            "-thread_queue_size", "64",
            "-input_format", inputFormat,
            "-framerate", String(fps),
            "-video_size", `${width}x${height}`,
            "-i", device,
          ];

    return [
      "-hide_banner",
      "-loglevel", "error",
      "-nostdin",
      ...input,
      "-an",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-profile:v", "baseline",
      "-level:v", "3.1",
      "-pix_fmt", "yuv420p",
      "-b:v", `${bitrateKbps}k`,
      "-maxrate", `${bitrateKbps}k`,
      "-bufsize", `${bitrateKbps}k`,
      // Her saniye bir anahtar kare; yeni bağlanan izleyici en geç 1 sn'de görüntü alır.
      "-g", String(fps),
      "-keyint_min", String(fps),
      // SPS/PPS her anahtar karede tekrar gönderilsin (WebRTC için gerekli).
      "-x264-params", "repeat-headers=1",
      "-metadata", `title=${FFMPEG_MARKER}`,
      "-f", "rtp",
      "-payload_type", "96",
      `rtp://127.0.0.1:${rtpPort}?pkt_size=1200&rtcpport=${rtpPort}`,
    ];
  }

  function startFfmpeg() {
    ffmpegRetryTimer = null;
    if (stopping || ffmpeg || viewers.size === 0) return;

    if (config.device !== "testsrc" && !fs.existsSync(config.device)) {
      if (!cameraMissingLogged) {
        console.error(LOG, `${config.device} bulunamadı, kamera bekleniyor...`);
        cameraMissingLogged = true;
      }
      ffmpegRetryTimer = setTimeout(startFfmpeg, 3000);
      return;
    }

    cameraMissingLogged = false;
    const stderrTail = [];
    const proc = spawn("ffmpeg", ffmpegArgs(), {
      stdio: ["ignore", "ignore", "pipe"],
    });

    ffmpeg = proc;
    ffmpegStartedAt = Date.now();
    lastPacketAt = 0;
    sourceChanged = true;

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      stderrTail.push(...chunk.split("\n").filter(Boolean));
      stderrTail.splice(0, Math.max(0, stderrTail.length - 5));
    });

    proc.on("error", (error) => {
      if (error.code === "ENOENT") {
        console.error(LOG, "ffmpeg bulunamadı. Kurulum: sudo apt install -y ffmpeg");
      } else {
        console.error(LOG, "ffmpeg başlatılamadı:", error.message);
      }
    });

    proc.on("close", (code, signal) => {
      if (ffmpeg === proc) ffmpeg = null;
      if (stopping) return;

      if (viewers.size === 0) {
        console.log(LOG, "İzleyici kalmadı, kamera kapatıldı.");
        return;
      }

      // Düzgün çalıştıktan sonra koptuysa hızlıca yeniden dene.
      if (Date.now() - ffmpegStartedAt > 15_000) ffmpegRetryDelay = 2000;

      console.error(
        LOG,
        `Kamera akışı durdu (${signal ?? `kod ${code}`})` +
          (stderrTail.length ? `: ${stderrTail.join(" | ")}` : "") +
          ` — ${ffmpegRetryDelay / 1000} sn sonra yeniden bağlanılacak.`,
      );

      clearTimeout(ffmpegRetryTimer);
      ffmpegRetryTimer = setTimeout(startFfmpeg, ffmpegRetryDelay);
      ffmpegRetryDelay = Math.min(ffmpegRetryDelay * 2, 15_000);
    });

    console.log(
      LOG,
      `Kamera açıldı (${config.device}, ${config.width}x${config.height} @ ${config.fps} fps, ${config.bitrateKbps} kbps).`,
    );
  }

  function stopFfmpeg() {
    if (!ffmpeg) return;
    try {
      ffmpeg.kill("SIGTERM");
    } catch {
      // zaten kapanmış olabilir
    }
    const proc = ffmpeg;
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }, 2000).unref();
  }

  // Kamera yalnızca izleyici varken açık tutulur (CPU ve ısı tasarrufu).
  function updateFfmpeg() {
    if (stopping) return;
    if (viewers.size > 0) {
      clearTimeout(ffmpegIdleTimer);
      ffmpegIdleTimer = null;
      if (!ffmpeg && !ffmpegRetryTimer) {
        ffmpegRetryDelay = 2000;
        startFfmpeg();
      }
    } else if ((ffmpeg || ffmpegRetryTimer) && !ffmpegIdleTimer) {
      ffmpegIdleTimer = setTimeout(() => {
        ffmpegIdleTimer = null;
        if (viewers.size > 0) return;
        clearTimeout(ffmpegRetryTimer);
        ffmpegRetryTimer = null;
        stopFfmpeg();
      }, 10_000);
    }
  }

  // Kamera takılırsa (süreç açık ama görüntü yok) FFmpeg'i yeniden başlat.
  const watchdog = setInterval(() => {
    if (!ffmpeg || Date.now() - ffmpegStartedAt < 8000) return;
    if (Date.now() - Math.max(lastPacketAt, ffmpegStartedAt) > 5000) {
      console.error(LOG, "Kameradan görüntü gelmiyor, yeniden başlatılıyor...");
      ffmpeg.kill("SIGKILL");
    }
  }, 2000);

  // ---------------------------------------------------------------- izleyiciler

  const viewers = new Map(); // UUID -> viewer

  const shortId = (uuid) => String(uuid).slice(0, 8);

  async function createViewer(uuid, session) {
    const existing = viewers.get(uuid);
    if (existing) {
      // Aynı istek kısa sürede iki kez gelebilir (play + offerSDP).
      if (Date.now() - existing.createdAt < 3000) return;
      closeViewer(uuid, "yeniden bağlanıyor");
    }

    if (viewers.size >= config.maxViewers) {
      console.error(LOG, `İzleyici sınırı (${config.maxViewers}) dolu, istek reddedildi.`);
      return;
    }

    const pc = new RTCPeerConnection({
      codecs: { video: [useH264()], audio: [] },
      iceServers,
      bundlePolicy: "max-bundle",
    });
    const track = sourceTrack.clone();
    const viewer = {
      uuid,
      session: session || crypto.randomBytes(4).toString("hex"),
      pc,
      track,
      channel: null,
      createdAt: Date.now(),
      remoteSet: false,
      pendingCandidates: [],
      connected: false,
      disconnectTimer: null,
      pingTimer: null,
      missedPongs: 0,
    };
    viewers.set(uuid, viewer);
    updateFfmpeg();

    pc.addTransceiver(track, {
      direction: "sendonly",
      streams: [new MediaStream([track])],
    });

    // VDO.Ninja izleyicisi bu isimli veri kanalını bekler (ping/pong, bye vb.).
    const channel = pc.createDataChannel("sendChannel");
    viewer.channel = channel;
    channel.onMessage.subscribe((data) => {
      handleChannelMessage(viewer, data).catch((error) => {
        console.error(LOG, "Veri kanalı mesaj hatası:", error.message);
      });
    });

    pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate || !candidate.candidate) return;
      sendSignal({
        UUID: uuid,
        session: viewer.session,
        type: "local",
        candidates: [
          {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
          },
        ],
      });
    });

    pc.connectionStateChange.subscribe((state) => {
      if (viewers.get(uuid) !== viewer) return;

      if (state === "connected") {
        clearTimeout(viewer.disconnectTimer);
        viewer.disconnectTimer = null;
        if (!viewer.connected) {
          viewer.connected = true;
          console.log(LOG, `İzleyici bağlandı (${shortId(uuid)}), toplam: ${viewers.size}`);
          startPing(viewer);
        }
      } else if (state === "disconnected") {
        // Kısa kopmalar kendiliğinden düzelebilir; 15 sn bekle.
        if (!viewer.disconnectTimer) {
          viewer.disconnectTimer = setTimeout(
            () => closeViewer(uuid, "bağlantı koptu"),
            15_000,
          );
        }
      } else if (state === "failed" || state === "closed") {
        closeViewer(
          uuid,
          state === "closed"
            ? "kapandı"
            : viewer.connected
              ? "bağlantı koptu"
              : "bağlantı kurulamadı",
        );
      }
    });

    // Bağlantı 30 sn içinde kurulamazsa vazgeç.
    setTimeout(() => {
      if (viewers.get(uuid) === viewer && !viewer.connected) {
        closeViewer(uuid, "bağlantı zaman aşımı");
      }
    }, 30_000);

    try {
      await pc.setLocalDescription(await pc.createOffer());
      if (viewers.get(uuid) !== viewer) return;

      sendSignal({
        UUID: uuid,
        session: viewer.session,
        streamID: signalingStreamId,
        description: { type: "offer", sdp: pc.localDescription.sdp },
      });
      console.log(LOG, `İzleyici isteği (${shortId(uuid)}), bağlantı kuruluyor...`);
    } catch (error) {
      console.error(LOG, "Teklif (offer) oluşturulamadı:", error.message);
      closeViewer(uuid, "hata");
    }
  }

  function startPing(viewer) {
    // VDO.Ninja izleyicisi {"ping"} mesajına {"pong"} ile cevap verir.
    // Uzun süre cevap gelmezse izleyici gitmiş demektir.
    viewer.pingTimer = setInterval(() => {
      if (viewer.channel?.readyState !== "open") return;
      if (++viewer.missedPongs > 10) {
        closeViewer(viewer.uuid, "yanıt vermiyor");
        return;
      }
      sendChannel(viewer, { ping: String(Date.now()) });
    }, 3000);
  }

  function sendChannel(viewer, message) {
    try {
      if (viewer.channel?.readyState === "open") {
        viewer.channel.send(JSON.stringify(message));
      }
    } catch {
      // kanal kapanmış olabilir
    }
  }

  async function handleChannelMessage(viewer, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if ("pong" in msg) {
      viewer.missedPongs = 0;
    } else if ("ping" in msg) {
      viewer.missedPongs = 0;
      sendChannel(viewer, { pong: msg.ping });
    } else if ("bye" in msg) {
      closeViewer(viewer.uuid, "izleyici ayrıldı");
    } else if ("candidates" in msg || "candidate" in msg || "description" in msg) {
      await handleSdpAndIce(viewer, msg);
    }
  }

  async function handleSdpAndIce(viewer, msg) {
    if (msg.description) {
      const description = msg.vector
        ? decrypt(msg.description, msg.vector)
        : msg.description;

      if (description?.type === "answer" && !viewer.remoteSet) {
        await viewer.pc.setRemoteDescription(description);
        viewer.remoteSet = true;
        for (const candidate of viewer.pendingCandidates.splice(0)) {
          await addCandidate(viewer, candidate);
        }
      }
    }

    const key = "candidates" in msg ? "candidates" : "candidate" in msg ? "candidate" : null;
    if (!key) return;

    let candidates = msg.vector && !msg.description ? decrypt(msg[key], msg.vector) : msg[key];
    if (key === "candidate" && typeof candidates === "string") {
      // Şifresiz tekil format: {candidate: "...", sdpMLineIndex, sdpMid}
      candidates = { candidate: candidates, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex };
    }
    if (!Array.isArray(candidates)) candidates = [candidates];

    for (const candidate of candidates) {
      if (!candidate?.candidate) continue;
      if (viewer.remoteSet) {
        await addCandidate(viewer, candidate);
      } else {
        viewer.pendingCandidates.push(candidate);
      }
    }
  }

  async function addCandidate(viewer, candidate) {
    try {
      await viewer.pc.addIceCandidate(candidate);
    } catch {
      // Çözümlenemeyen (örn. mDNS) adaylar diğerleri varken sorun değil.
    }
  }

  function closeViewer(uuid, reason) {
    const viewer = viewers.get(uuid);
    if (!viewer) return;
    viewers.delete(uuid);

    clearTimeout(viewer.disconnectTimer);
    clearInterval(viewer.pingTimer);

    try {
      viewer.track.stop();
    } catch {
      // önemli değil
    }
    Promise.resolve()
      .then(() => viewer.pc.close())
      .catch(() => {});

    if (viewer.connected || reason !== "yeniden bağlanıyor") {
      console.log(
        LOG,
        `İzleyici ayrıldı (${shortId(uuid)}, ${reason}), kalan: ${viewers.size}`,
      );
    }
    updateFfmpeg();
  }

  // ------------------------------------------------- VDO.Ninja signaling (WSS)

  let ws = null;
  let wsReconnectTimer = null;
  let wsAlive = false;
  let wsEverConnected = false;

  function sendSignal(message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const out = { ...message };
    if (aesKey) {
      for (const key of ["description", "candidates", "candidate"]) {
        if (key in out) {
          [out[key], out.vector] = encrypt(out[key]);
          break;
        }
      }
    }

    try {
      ws.send(JSON.stringify(out));
    } catch (error) {
      console.error(LOG, "Signaling gönderme hatası:", error.message);
    }
  }

  function connectSignaling() {
    wsReconnectTimer = null;
    if (stopping) return;

    const socket = new WebSocket(config.signalingUrl);
    ws = socket;

    socket.on("open", () => {
      wsAlive = true;
      socket.send(JSON.stringify({ request: "seed", streamID: signalingStreamId }));
      console.log(
        LOG,
        wsEverConnected
          ? "VDO.Ninja bağlantısı yeniden kuruldu."
          : `VDO.Ninja'ya bağlandı. İzleme adresi: ${viewUrl}`,
      );
      wsEverConnected = true;
    });

    socket.on("pong", () => {
      wsAlive = true;
    });

    socket.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      handleSignal(msg).catch((error) => {
        console.error(LOG, "Signaling mesaj hatası:", error.message);
      });
    });

    socket.on("error", (error) => {
      console.error(LOG, "VDO.Ninja bağlantı hatası:", error.message);
    });

    socket.on("close", () => {
      if (ws === socket) ws = null;
      if (stopping) return;
      console.error(LOG, "VDO.Ninja bağlantısı kapandı, 5 sn sonra yeniden bağlanılacak.");
      // Kurulu WebRTC bağlantıları (izleyiciler) bundan etkilenmez.
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(connectSignaling, 5000);
    });
  }

  // Ölü WebSocket bağlantılarını fark etmek için ping.
  const wsHeartbeat = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!wsAlive) {
      ws.terminate();
      return;
    }
    wsAlive = false;
    ws.ping();
  }, 20_000);

  async function handleSignal(msg) {
    if (!msg || typeof msg !== "object") return;

    if (msg.alert || msg.error) {
      console.error(LOG, "VDO.Ninja:", msg.alert || msg.error);
    }

    const uuid = msg.UUID ?? msg.from;
    if (!uuid) return;

    if (msg.request === "offerSDP" || (msg.request === "play" && msg.streamID === signalingStreamId)) {
      await createViewer(uuid, msg.session);
      return;
    }

    if (msg.request === "bye" || msg.request === "cleanup") {
      closeViewer(uuid, "izleyici ayrıldı");
      return;
    }

    const viewer = viewers.get(uuid);
    if (!viewer) return;
    if (msg.session && msg.session !== viewer.session) return; // eski oturum

    if ("description" in msg || "candidates" in msg || "candidate" in msg) {
      if (msg.vector && !aesKey) {
        console.error(
          LOG,
          "İzleyici şifreli mesaj gönderdi ama CAMERA_PASSWORD kapalı. Parola ayarını kontrol edin.",
        );
        return;
      }
      try {
        await handleSdpAndIce(viewer, msg);
      } catch (error) {
        console.error(LOG, "İzleyici yanıtı işlenemedi:", error.message);
        if (msg.vector) {
          console.error(
            LOG,
            "Şifre çözülemedi; izleme linkindeki &password değeri CAMERA_PASSWORD ile aynı olmalı.",
          );
        }
      }
    }
  }

  // ------------------------------------------------------------ başlat / kapat

  function shutdown() {
    if (stopping) return;
    stopping = true;

    clearInterval(watchdog);
    clearInterval(wsHeartbeat);
    clearTimeout(wsReconnectTimer);
    clearTimeout(ffmpegRetryTimer);
    clearTimeout(ffmpegIdleTimer);

    for (const viewer of viewers.values()) {
      sendChannel(viewer, { bye: true });
    }
    for (const uuid of [...viewers.keys()]) {
      closeViewer(uuid, "yayın kapatılıyor");
    }

    stopFfmpeg();

    try {
      ws?.close();
    } catch {
      // önemli değil
    }
    try {
      rtpSocket.close();
    } catch {
      // önemli değil
    }

    // FFmpeg'in kapanmasına ve "bye" mesajlarının gitmesine kısa süre tanı.
    setTimeout(() => process.exit(0), 300).unref();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Ana süreç (server.js) beklenmedik şekilde ölürse kamerayı da kapat.
  process.on("disconnect", shutdown);

  killStaleFfmpeg();

  rtpSocket.bind(0, "127.0.0.1", () => {
    rtpPort = rtpSocket.address().port;
    connectSignaling();
  });
}

if (require.main === module) {
  runWorker();
}
