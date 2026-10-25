import { resolve } from "node:path";

function integer(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function boolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

function text(name, fallback = "") {
  return (process.env[name] ?? fallback).trim();
}

export function loadConfig(overrides = {}) {
  const dataDir = resolve(overrides.dataDir ?? text("DATA_DIR", "./data"));
  const port = overrides.port ?? integer("PORT", 8787);
  const host = overrides.host ?? text("HOST", "127.0.0.1");
  const providerMode = overrides.providerMode ?? text("PROVIDER_MODE", "mock");

  if (!["mock", "volc"].includes(providerMode)) {
    throw new Error("PROVIDER_MODE must be mock or volc");
  }

  return {
    host,
    port,
    dataDir,
    dbPath: overrides.dbPath ?? resolve(dataDir, "gateway.sqlite"),
    outputDir: resolve(dataDir, "outputs"),
    appOrigin: String(overrides.appOrigin ?? text("APP_ORIGIN")).replace(/\/+$/u, ""),
    cookieSecure: overrides.cookieSecure ?? boolean("COOKIE_SECURE", true),
    allowNullOrigin:
      overrides.allowNullOrigin ?? boolean("ALLOW_NULL_ORIGIN", false),
    sessionTtlSeconds:
      overrides.sessionTtlSeconds ??
      Math.max(1, integer("SESSION_TTL_HOURS", 72)) * 3600,
    saasBridgeSecret: overrides.saasBridgeSecret ?? text("SAAS_BRIDGE_SECRET"),
    maxBodyBytes:
      overrides.maxBodyBytes ?? Math.max(1024, integer("MAX_BODY_BYTES", 64 * 1024 * 1024)),
    providerMode,
    admin: {
      username: overrides.adminUsername ?? text("ADMIN_USERNAME", "admin"),
      password: overrides.adminPassword ?? text("ADMIN_PASSWORD"),
    },
    prices: {
      asr: {
        unitSize: 1000,
        unit: "second",
        microfen:
          overrides.asrMicrofen ??
          integer("DEFAULT_ASR_MICROFEN_PER_SECOND", 1_000_000),
      },
      tts: {
        unitSize: 1000,
        unit: "1000_chars",
        microfen:
          overrides.ttsMicrofen ??
          integer("DEFAULT_TTS_MICROFEN_PER_1000_CHARS", 20_000),
      },
      tos: {
        unitSize: 1_048_576,
        unit: "MiB",
        microfen:
          overrides.tosMicrofen ??
          integer("DEFAULT_TOS_MICROFEN_PER_MIB", 1_000_000),
      },
    },
    volc: {
      tts: {
        endpoint: text("VOLC_TTS_ENDPOINT", "https://openspeech.bytedance.com").replace(/\/+$/u, ""),
        apiKey: text("VOLC_TTS_API_KEY"),
        resourceId: text("VOLC_TTS_RESOURCE_ID", "seed-icl-2.0"),
        defaultSpeaker: text("VOLC_TTS_DEFAULT_SPEAKER"),
        format: text("VOLC_TTS_FORMAT", "mp3"),
        sampleRate: integer("VOLC_TTS_SAMPLE_RATE", 24000),
      },
      asr: {
        endpoint: text("VOLC_ASR_ENDPOINT", "https://openspeech.bytedance.com").replace(/\/+$/u, ""),
        apiKey: text("VOLC_ASR_API_KEY"),
        resourceId: text("VOLC_ASR_RESOURCE_ID", "volc.seedasr.auc"),
        enableSpeaker: boolean("VOLC_ASR_ENABLE_SPEAKER", true),
      },
      tos: {
        endpoint: text("VOLC_TOS_ENDPOINT", "https://tos-cn-shanghai.volces.com"),
        region: text("VOLC_TOS_REGION", "cn-shanghai"),
        bucket: text("VOLC_TOS_BUCKET"),
        accessKey: text("VOLC_TOS_ACCESS_KEY"),
        secretKey: text("VOLC_TOS_SECRET_KEY"),
        prefix: text("VOLC_TOS_PREFIX", "hypit-tenant-gateway/asr").replace(/^\/+|\/+$/gu, ""),
        presignSeconds: integer("VOLC_TOS_PRESIGN_SECONDS", 3600),
      },
    },
  };
}
