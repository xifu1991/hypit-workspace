import { createHash, createHmac, randomUUID } from "node:crypto";
import { HttpError } from "./errors.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function providerFailure(message, details = {}) {
  return new HttpError(502, message, "provider_failed", details);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSilenceWav(milliseconds = 500, sampleRate = 16_000) {
  const sampleCount = Math.round((sampleRate * milliseconds) / 1000);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function encodeQuery(value) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function utcDate(now = new Date()) {
  return now.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

export function signTosUrl({
  method,
  endpoint,
  region,
  bucket,
  key,
  accessKey,
  secretKey,
  expiresSeconds,
  now = new Date(),
}) {
  const parsed = new URL(
    endpoint.includes("://") ? endpoint : `https://${endpoint}`,
  );
  const endpointHost = parsed.port
    ? `${parsed.hostname}:${parsed.port}`
    : parsed.hostname;
  const host = endpointHost.startsWith(`${bucket}.`)
    ? endpointHost
    : `${bucket}.${endpointHost}`;
  const path = `/${key.split("/").map(encodeQuery).join("/")}`;
  const date = utcDate(now);
  const dateStamp = date.slice(0, 8);
  const scope = `${dateStamp}/${region}/tos/request`;
  const credential = `${accessKey}/${scope}`;
  const params = [
    ["X-Tos-Algorithm", "TOS4-HMAC-SHA256"],
    ["X-Tos-Credential", credential],
    ["X-Tos-Date", date],
    ["X-Tos-Expires", String(expiresSeconds)],
    ["X-Tos-SignedHeaders", "host"],
  ];
  const canonicalQuery = [...params]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${encodeQuery(name)}=${encodeQuery(value)}`)
    .join("&");
  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "TOS4-HMAC-SHA256",
    date,
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(secretKey, dateStamp), region), "tos"),
    "request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");
  const query = [...params, ["X-Tos-Signature", signature]]
    .map(([name, value]) => `${encodeQuery(name)}=${encodeQuery(value)}`)
    .join("&");
  return `${parsed.protocol}//${host}${path}?${query}`;
}

export function parseWavDurationMs(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 44) {
    throw new Error("A valid WAV file is required");
  }
  if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("A valid RIFF/WAVE file is required");
  }
  let offset = 12;
  let byteRate;
  let sampleRate;
  let channels;
  let bits;
  let dataBytes;
  while (offset + 8 <= audio.length) {
    const id = audio.toString("ascii", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= audio.length) {
      channels = audio.readUInt16LE(body + 2);
      sampleRate = audio.readUInt32LE(body + 4);
      byteRate = audio.readUInt32LE(body + 8);
      bits = audio.readUInt16LE(body + 14);
    }
    if (id === "data") {
      dataBytes = Math.min(size, audio.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!byteRate || !dataBytes) throw new Error("WAV file has no readable audio data");
  if (sampleRate !== 16_000 || channels !== 1 || bits !== 16) {
    throw new Error("ASR audio must be 16 kHz mono 16-bit PCM WAV");
  }
  if (byteRate !== sampleRate * channels * (bits / 8)) {
    throw new Error("WAV byte rate does not match its PCM format");
  }
  return Math.max(1, Math.round((dataBytes / byteRate) * 1000));
}

function ttsBody(config, text, speaker) {
  return {
    req_params: {
      text,
      speaker,
      audio_params: {
        format: config.format,
        sample_rate: config.sampleRate,
      },
    },
  };
}

function parseFailure(body) {
  try {
    const parsed = JSON.parse(body);
    const source =
      parsed && typeof parsed === "object" && parsed.header && typeof parsed.header === "object"
        ? parsed.header
        : parsed;
    return {
      code: source?.code === undefined ? undefined : String(source.code),
      message: source?.message === undefined ? undefined : String(source.message),
    };
  } catch {
    return { message: String(body).split(/\r?\n/u)[0]?.slice(0, 400) };
  }
}

function parseTtsStream(text) {
  const chunks = [];
  let usage;
  let failure;
  let complete = false;
  for (const line of String(text).split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      throw providerFailure("Doubao TTS returned malformed stream data");
    }
    const code = message.code === undefined ? undefined : String(message.code);
    if (message.usage && typeof message.usage === "object") usage = message.usage;
    if (code !== undefined && code !== "0" && code !== "20000000") {
      failure = { code, message: String(message.message ?? "unknown error") };
      break;
    }
    if (typeof message.data === "string" && message.data.length > 0) {
      chunks.push(Buffer.from(message.data, "base64"));
    }
    if (code === "20000000") complete = true;
  }
  if (failure) {
    throw providerFailure(
      `Doubao TTS failed code=${failure.code ?? "unknown"}: ${failure.message}`,
      failure,
    );
  }
  if (!complete) throw providerFailure("Doubao TTS stream ended before completion");
  const audio = Buffer.concat(chunks);
  if (audio.length === 0) throw providerFailure("Doubao TTS returned no audio");
  return { audio, usage };
}

export class MockProvider {
  constructor() {
    this.name = "mock";
  }

  async synthesize({ text, speakerName }) {
    if (text.includes("[FAIL_PROVIDER]")) {
      throw providerFailure("Mock provider failure requested by test text");
    }
    await delay(20);
    return {
      audio: makeSilenceWav(500),
      format: "wav",
      requestId: randomUUID(),
      logId: `mock-tts-${randomUUID()}`,
      usage: {
        mock: true,
        text_bytes: Buffer.byteLength(text, "utf8"),
        speaker_name: speakerName,
      },
    };
  }

  async transcribe({ audio, tenantId, jobId }) {
    if (!audio.length) throw providerFailure("Mock ASR received no audio");
    await delay(20);
    const durationMs = parseWavDurationMs(audio);
    return {
      result: {
        text: "mock transcription",
        utterances: [
          {
            text: "mock transcription",
            start_time: 0,
            end_time: durationMs,
            words: [
              { text: "mock", start_time: 0, end_time: Math.min(200, durationMs) },
              {
                text: "transcription",
                start_time: Math.min(200, durationMs),
                end_time: durationMs,
              },
            ],
          },
        ],
      },
      requestId: randomUUID(),
      logId: `mock-asr-${randomUUID()}`,
      objectKey: `mock/${tenantId}/${jobId}.wav`,
      tosBytes: audio.length,
    };
  }

  async health() {
    return { mode: "mock", ready: true };
  }
}

export class VolcProvider {
  constructor(config) {
    this.config = config;
    this.name = "volc";
  }

  validate() {
    const missing = [];
    if (!this.config.tts.apiKey) missing.push("VOLC_TTS_API_KEY");
    if (!this.config.asr.apiKey) missing.push("VOLC_ASR_API_KEY");
    if (!this.config.tos.bucket) missing.push("VOLC_TOS_BUCKET");
    if (!this.config.tos.accessKey) missing.push("VOLC_TOS_ACCESS_KEY");
    if (!this.config.tos.secretKey) missing.push("VOLC_TOS_SECRET_KEY");
    if (missing.length > 0) {
      throw new Error(`Volc provider is missing: ${missing.join(", ")}`);
    }
  }

  async synthesize({ text, speakerId }) {
    const requestId = randomUUID();
    const response = await fetch(
      `${this.config.tts.endpoint}/api/v3/tts/unidirectional`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Resource-Id": this.config.tts.resourceId,
          "X-Api-Request-Id": requestId,
          "X-Control-Require-Usage-Tokens-Return": "*",
          "X-Api-Key": this.config.tts.apiKey,
        },
        body: JSON.stringify(ttsBody(this.config.tts, text, speakerId)),
        signal: AbortSignal.timeout(5 * 60_000),
      },
    );
    const logId =
      response.headers.get("x-tt-logid") ??
      response.headers.get("X-Tt-Logid") ??
      undefined;
    const body = await response.text();
    if (!response.ok) {
      const detail = parseFailure(body);
      throw providerFailure(
        `Doubao TTS HTTP ${response.status} code=${detail.code ?? "unknown"}: ${detail.message ?? "unknown error"}`,
        { requestId, logId, ...detail },
      );
    }
    const parsed = parseTtsStream(body);
    return {
      ...parsed,
      format: this.config.tts.format,
      requestId,
      logId,
    };
  }

  signTos(method, key) {
    return signTosUrl({
      method,
      endpoint: this.config.tos.endpoint,
      region: this.config.tos.region,
      bucket: this.config.tos.bucket,
      key,
      accessKey: this.config.tos.accessKey,
      secretKey: this.config.tos.secretKey,
      expiresSeconds: this.config.tos.presignSeconds,
    });
  }

  async putTosObject(key, audio) {
    const url = this.signTos("PUT", key);
    const response = await fetch(url, {
      method: "PUT",
      body: audio,
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok) {
      throw providerFailure(
        `Volc TOS upload failed with HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`,
      );
    }
    return this.signTos("GET", key);
  }

  async deleteTosObject(key) {
    const url = this.signTos("DELETE", key);
    const response = await fetch(url, {
      method: "DELETE",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`TOS delete failed with HTTP ${response.status}`);
    }
  }

  asrHeaders(requestId) {
    return {
      "Content-Type": "application/json",
      "X-Api-Resource-Id": this.config.asr.resourceId,
      "X-Api-Request-Id": requestId,
      "X-Api-Sequence": "-1",
      "X-Api-Key": this.config.asr.apiKey,
    };
  }

  async postAsr(url, requestId, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: this.asrHeaders(requestId),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2 * 60_000),
    });
    const text = await response.text();
    let parsed = {};
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw providerFailure("Doubao ASR returned invalid JSON");
      }
    }
    const status = response.headers.get("x-api-status-code");
    const message = response.headers.get("x-api-message") ?? "unknown error";
    if (!response.ok) {
      throw providerFailure(`Doubao ASR HTTP ${response.status}: ${text.slice(0, 400)}`);
    }
    return { body: parsed, status, message };
  }

  async transcribe({ audio, tenantId, jobId }) {
    const requestId = randomUUID();
    const objectKey = `${this.config.tos.prefix}/${tenantId}/${jobId}-${requestId}.wav`;
    let uploaded = false;
    try {
      const audioUrl = await this.putTosObject(objectKey, audio);
      uploaded = true;
      const submitted = await this.postAsr(
        `${this.config.asr.endpoint}/api/v3/auc/bigmodel/submit`,
        requestId,
        {
          user: { uid: requestId },
          audio: {
            url: audioUrl,
            format: "wav",
            rate: 16_000,
            bits: 16,
            channel: 1,
          },
          request: {
            model_name: "bigmodel",
            enable_itn: true,
            enable_punc: true,
            enable_ddc: false,
            enable_speaker_info: this.config.asr.enableSpeaker,
            show_utterances: true,
          },
        },
      );
      if (
        submitted.status &&
        !["0", "20000000"].includes(submitted.status)
      ) {
        throw providerFailure(
          `Doubao ASR submit status=${submitted.status}: ${submitted.message}`,
        );
      }
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await delay(3_000);
        const query = await this.postAsr(
          `${this.config.asr.endpoint}/api/v3/auc/bigmodel/query`,
          requestId,
          {},
        );
        const status = query.status;
        if (
          status &&
          ["0", "20000000"].includes(status) &&
          (query.body.result !== undefined || Array.isArray(query.body.utterances))
        ) {
          return {
            result: query.body,
            requestId,
            logId: undefined,
            objectKey,
            tosBytes: audio.length,
          };
        }
        if (
          status &&
          !["0", "20000000", "20000001", "20000002"].includes(status)
        ) {
          throw providerFailure(
            `Doubao ASR query status=${status}: ${query.message}`,
          );
        }
      }
      throw providerFailure("Doubao ASR polling timed out");
    } finally {
      if (uploaded) {
        await this.deleteTosObject(objectKey).catch(() => undefined);
      }
    }
  }

  async health() {
    try {
      this.validate();
      return { mode: "volc", ready: true };
    } catch (error) {
      return {
        mode: "volc",
        ready: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function createProvider(config) {
  if (config.providerMode === "mock") return new MockProvider();
  const provider = new VolcProvider(config.volc);
  provider.validate();
  return provider;
}
