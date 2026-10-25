import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

const extensionByFormat = {
  mp3: ".mp3",
  wav: ".wav",
  pcm: ".pcm",
  ogg_opus: ".ogg",
};

export class GatewayClientError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = "GatewayClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (text.length === 0) throw new Error(`${name} is required`);
  return text;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeFileStem(value) {
  const stem = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return stem.length > 0 ? stem.slice(0, 80) : "line";
}

async function atomicWrite(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

async function responseError(response) {
  const raw = await response.text();
  let payload = {};
  try {
    payload = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    payload = {};
  }
  return new GatewayClientError(
    payload.message || raw.slice(0, 400) || `Gateway request failed with HTTP ${response.status}`,
    {
      status: response.status,
      code: payload.code,
      details: payload.details,
    },
  );
}

export class GatewayClient {
  constructor({ baseUrl, token, timeoutMs = 10 * 60_000, fetchImpl = fetch }) {
    this.baseUrl = requiredText(baseUrl, "Gateway base URL").replace(/\/+$/u, "");
    this.token = requiredText(token, "Gateway token");
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      ...extra,
    };
  }

  async synthesize({ text, speaker, idempotencyKey }) {
    const cleanText = requiredText(text, "TTS text");
    let key = requiredText(idempotencyKey, "Idempotency key");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.fetchImpl(`${this.baseUrl}/gateway/v1/tts`, {
        method: "POST",
        headers: this.headers({
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        }),
        body: JSON.stringify({
          text: cleanText,
          ...(String(speaker ?? "").trim().length === 0
            ? {}
            : { speaker: String(speaker).trim() }),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        const error = await responseError(response);
        if (attempt === 0 && error.code === "previous_request_failed") {
          key = `${key}:retry:${randomUUID()}`;
          continue;
        }
        throw error;
      }
      return {
        audio: Buffer.from(await response.arrayBuffer()),
        format: response.headers.get("x-hypit-format") || "wav",
        taskId: response.headers.get("x-hypit-task-id"),
        costFen: Number(response.headers.get("x-hypit-cost-fen") ?? 0),
        balanceFen:
          response.headers.get("x-hypit-balance-fen") === null ||
          response.headers.get("x-hypit-balance-fen") === ""
            ? null
            : Number(response.headers.get("x-hypit-balance-fen")),
        replay: response.headers.get("x-hypit-idempotent-replay") === "1",
      };
    }
    throw new Error("TTS retry loop ended unexpectedly");
  }

  async transcribe({ audio, idempotencyKey }) {
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      throw new Error("ASR audio must be a non-empty Buffer");
    }
    let key = requiredText(idempotencyKey, "Idempotency key");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.fetchImpl(`${this.baseUrl}/gateway/v1/asr`, {
        method: "POST",
        headers: this.headers({
          "Content-Type": "audio/wav",
          "Idempotency-Key": key,
        }),
        body: audio,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        const error = await responseError(response);
        if (attempt === 0 && error.code === "previous_request_failed") {
          key = `${key}:retry:${randomUUID()}`;
          continue;
        }
        throw error;
      }
      return response.json();
    }
    throw new Error("ASR retry loop ended unexpectedly");
  }

  async me() {
    const response = await this.fetchImpl(`${this.baseUrl}/gateway/v1/me`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw await responseError(response);
    return response.json();
  }
}

export async function readNarration(path) {
  const raw = await readFile(path);
  const document = JSON.parse(raw.toString("utf8"));
  if (!document || typeof document !== "object" || !Array.isArray(document.lines)) {
    throw new Error("narration.json must contain a lines array");
  }
  if (document.lines.length === 0) throw new Error("narration.json has no lines");
  const seen = new Set();
  const lines = document.lines.map((line, index) => {
    const id = requiredText(line?.id, `lines[${index}].id`);
    const text = requiredText(line?.text, `lines[${index}].text`);
    if (seen.has(id)) throw new Error(`Duplicate narration line id: ${id}`);
    seen.add(id);
    return {
      id,
      text,
      ...(String(line.speaker ?? "").trim().length === 0
        ? {}
        : { speaker: String(line.speaker).trim() }),
    };
  });
  return {
    fileName: basename(path),
    sourceSha256: sha256(raw),
    lines,
  };
}

export async function synthesizeNarration(
  client,
  { narrationPath, outputDir, speaker, concurrency = 1, onProgress } = {},
) {
  const narration = await readNarration(requiredText(narrationPath, "Narration path"));
  const destination = resolve(requiredText(outputDir, "Output directory"));
  const workers = Math.max(1, Math.min(8, Number(concurrency) || 1));
  await mkdir(destination, { recursive: true });

  const manifestPath = resolve(destination, "manifest.json");
  const results = new Array(narration.lines.length);
  let cursor = 0;
  let manifestWrite = Promise.resolve();

  function saveManifest() {
    manifestWrite = manifestWrite.then(() =>
      atomicWrite(
        manifestPath,
        `${JSON.stringify(
          {
            format: "hypit-gateway-narration@1",
            source: narration.fileName,
            sourceSha256: narration.sourceSha256,
            completed: results.filter(Boolean).length,
            total: narration.lines.length,
            lines: results.filter(Boolean),
          },
          null,
          2,
        )}\n`,
      ),
    );
    return manifestWrite;
  }

  async function runWorker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= narration.lines.length) return;
      const line = narration.lines[index];
      const requestedSpeaker =
        line.speaker ?? String(speaker ?? "").trim();
      const idempotencyKey = `narration:${narration.sourceSha256}:${sha256(
        JSON.stringify({
          index,
          id: line.id,
          text: line.text,
          speaker: requestedSpeaker,
        }),
      )}`;
      onProgress?.({ phase: "start", index, line });
      const result = await client.synthesize({
        text: line.text,
        speaker: requestedSpeaker,
        idempotencyKey,
      });
      const extension = extensionByFormat[result.format] ?? extname(result.format || "");
      const file = `${safeFileStem(line.id)}${extension || ".bin"}`;
      await atomicWrite(resolve(destination, file), result.audio);
      results[index] = {
        id: line.id,
        textSha256: sha256(line.text),
        speaker: requestedSpeaker || null,
        file,
        format: result.format,
        bytes: result.audio.length,
        taskId: result.taskId,
        costFen: result.costFen,
        balanceFen: result.balanceFen,
        replay: result.replay,
      };
      await saveManifest();
      onProgress?.({ phase: "complete", index, line, result: results[index] });
    }
  }

  await Promise.all(Array.from({ length: workers }, () => runWorker()));
  await manifestWrite;
  return {
    manifestPath,
    lines: results,
    costFen: results.reduce((sum, item) => sum + item.costFen, 0),
    chargedFen: results
      .filter((item) => !item.replay)
      .reduce((sum, item) => sum + item.costFen, 0),
    replayedLines: results.filter((item) => item.replay).length,
  };
}
