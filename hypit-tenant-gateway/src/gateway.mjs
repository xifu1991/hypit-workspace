import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseWavDurationMs } from "./providers.mjs";
import { badRequest, conflict, HttpError } from "./errors.mjs";

function sameInput(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function extensionFor(format) {
  return (
    {
      mp3: ".mp3",
      wav: ".wav",
      pcm: ".pcm",
      ogg_opus: ".ogg",
    }[format] ?? ".bin"
  );
}

function withProviderDetails(error) {
  if (error instanceof HttpError) return error;
  const details =
    error && typeof error === "object" && "details" in error
      ? error.details
      : undefined;
  return new HttpError(
    502,
    error instanceof Error ? error.message : String(error),
    "provider_failed",
    details,
  );
}

export class GatewayService {
  constructor({ config, store, provider }) {
    this.config = config;
    this.store = store;
    this.provider = provider;
  }

  async prepareReplay(task, input) {
    if (!sameInput(task.input, input)) {
      throw conflict(
        "The idempotency key was already used with different request data",
        "idempotency_mismatch",
      );
    }
    if (["reserved", "processing"].includes(task.status)) {
      throw conflict("A request with this idempotency key is still running", "in_progress");
    }
    if (task.status === "failed") {
      throw new HttpError(
        409,
        task.error || "The original request failed",
        "previous_request_failed",
        { taskId: task.id },
      );
    }
    if (task.kind === "tts") {
      if (!task.outputPath) throw new Error("Completed TTS task has no output");
      const audio = await readFile(task.outputPath);
      return {
        replay: true,
        task,
        audio,
        format: task.response?.format ?? "wav",
      };
    }
    return {
      replay: true,
      task,
      response: task.response,
    };
  }

  async synthesizeTts({ tenantId, tokenId, idempotencyKey, text, speaker }) {
    const cleanText = String(text ?? "").trim();
    if (cleanText.length === 0) throw badRequest("text is required");
    if (cleanText.length > 50_000) throw badRequest("text exceeds 50000 characters");
    const voice = this.store.resolveVoice(tenantId, speaker);
    const quote = this.store.quoteService("tts", cleanText.length);
    const input = {
      text: cleanText,
      voiceName: voice.name,
      speakerId: voice.speakerId,
    };
    const reservation = this.store.reserveTask({
      tenantId,
      tokenId,
      kind: "tts",
      idempotencyKey,
      reservedFen: quote.amountFen,
      input,
    });
    if (reservation.existing) {
      return {
        ...(await this.prepareReplay(reservation.task, input)),
        wallet: this.store.wallet(tenantId),
      };
    }

    const task = reservation.task;
    this.store.markTaskProcessing(task.id);
    try {
      const synthesis = await this.provider.synthesize({
        text: cleanText,
        speakerName: voice.name,
        speakerId: voice.speakerId,
      });
      const tenantDir = resolve(this.config.outputDir, tenantId);
      await mkdir(tenantDir, { recursive: true });
      const format = synthesis.format ?? "wav";
      const outputPath = resolve(tenantDir, `${task.id}${extensionFor(format)}`);
      await writeFile(outputPath, synthesis.audio);
      const usageEvent = {
        service: "tts",
        quantity: cleanText.length,
        unitSize: quote.unitSize,
        unitPriceMicrofen: quote.unitPriceMicrofen,
        amountMicrofen: quote.amountMicrofen,
        amountFen: quote.amountFen,
        metadata: {
          voice: voice.name,
          chars: cleanText.length,
          audioBytes: synthesis.audio.length,
          format,
          providerUsage: synthesis.usage ?? null,
        },
      };
      const completed = this.store.completeTask({
        taskId: task.id,
        actualFen: quote.amountFen,
        usageEvents: [usageEvent],
        outputPath,
        response: {
          audioBytes: synthesis.audio.length,
          format,
          voice: voice.name,
        },
        providerRequestId: synthesis.requestId,
        providerLogId: synthesis.logId ?? null,
      });
      return {
        replay: false,
        task: completed,
        audio: synthesis.audio,
        format,
        wallet: this.store.wallet(tenantId),
      };
    } catch (error) {
      const failure = withProviderDetails(error);
      const details = failure.details ?? {};
      this.store.failTask({
        taskId: task.id,
        error: failure.message,
        usageEvents: [
          {
            service: "tts",
            quantity: cleanText.length,
            unitSize: quote.unitSize,
            unitPriceMicrofen: quote.unitPriceMicrofen,
            metadata: {
              voice: voice.name,
              chars: cleanText.length,
            },
          },
        ],
        providerRequestId: details.requestId ?? null,
        providerLogId: details.logId ?? null,
      });
      throw failure;
    }
  }

  async transcribeAsr({ tenantId, tokenId, idempotencyKey, audio }) {
    let durationMs;
    try {
      durationMs = parseWavDurationMs(audio);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : String(error));
    }
    const asrQuote = this.store.quoteService("asr", durationMs);
    const tosQuote = this.store.quoteService("tos", audio.length);
    const reservedFen = asrQuote.amountFen + tosQuote.amountFen;
    const input = {
      audioBytes: audio.length,
      durationMs,
      audioSha256: undefined,
    };
    input.audioSha256 = createHash("sha256").update(audio).digest("hex");
    const reservation = this.store.reserveTask({
      tenantId,
      tokenId,
      kind: "asr",
      idempotencyKey,
      reservedFen,
      input,
    });
    if (reservation.existing) {
      return {
        ...(await this.prepareReplay(reservation.task, input)),
        wallet: this.store.wallet(tenantId),
      };
    }

    const task = reservation.task;
    this.store.markTaskProcessing(task.id);
    try {
      const result = await this.provider.transcribe({
        audio,
        tenantId,
        jobId: task.id,
      });
      const usageEvents = [
        {
          service: "asr",
          quantity: durationMs,
          unitSize: asrQuote.unitSize,
          unitPriceMicrofen: asrQuote.unitPriceMicrofen,
          amountMicrofen: asrQuote.amountMicrofen,
          amountFen: asrQuote.amountFen,
          metadata: {
            durationMs,
            utterances:
              result.result?.result?.utterances?.length ??
              result.result?.utterances?.length ??
              null,
          },
        },
        {
          service: "tos",
          quantity: audio.length,
          unitSize: tosQuote.unitSize,
          unitPriceMicrofen: tosQuote.unitPriceMicrofen,
          amountMicrofen: tosQuote.amountMicrofen,
          amountFen: tosQuote.amountFen,
          metadata: {
            objectBytes: audio.length,
            temporaryObject: result.objectKey ?? null,
          },
        },
      ];
      const completed = this.store.completeTask({
        taskId: task.id,
        actualFen: reservedFen,
        usageEvents,
        response: result.result,
        providerRequestId: result.requestId,
        providerLogId: result.logId ?? null,
      });
      return {
        replay: false,
        task: completed,
        response: result.result,
        wallet: this.store.wallet(tenantId),
      };
    } catch (error) {
      const failure = withProviderDetails(error);
      const details = failure.details ?? {};
      this.store.failTask({
        taskId: task.id,
        error: failure.message,
        usageEvents: [
          {
            service: "asr",
            quantity: durationMs,
            unitSize: asrQuote.unitSize,
            unitPriceMicrofen: asrQuote.unitPriceMicrofen,
            metadata: { durationMs },
          },
          {
            service: "tos",
            quantity: audio.length,
            unitSize: tosQuote.unitSize,
            unitPriceMicrofen: tosQuote.unitPriceMicrofen,
            metadata: { objectBytes: audio.length },
          },
        ],
        providerRequestId: details.requestId ?? null,
        providerLogId: details.logId ?? null,
      });
      throw failure;
    }
  }
}
