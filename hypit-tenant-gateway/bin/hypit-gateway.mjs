#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  GatewayClient,
  synthesizeNarration,
} from "../src/client.mjs";

function usage() {
  return `Hypit tenant gateway client

Environment:
  HYPIT_GATEWAY_URL    Example: https://studio.example.com
  HYPIT_GATEWAY_TOKEN  Token created in the tenant dashboard (hgt_...)

Commands:
  tts <narration.json> --out <directory> [--speaker <name>] [--concurrency 2]
  asr <audio.wav> --out <transcript.json>
  me
`;
}

function option(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function positional(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith("--")) {
      index += 1;
      continue;
    }
    result.push(value);
  }
  return result;
}

const [command, ...args] = process.argv.slice(2);
if (!command || command === "--help" || command === "-h") {
  console.log(usage());
  process.exit(0);
}

const baseUrl = process.env.HYPIT_GATEWAY_URL;
const token = process.env.HYPIT_GATEWAY_TOKEN;
if (!baseUrl || !token) {
  console.error("HYPIT_GATEWAY_URL and HYPIT_GATEWAY_TOKEN are required.");
  console.error(usage());
  process.exit(2);
}

const client = new GatewayClient({ baseUrl, token });

if (command === "me") {
  const data = await client.me();
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

if (command === "tts") {
  const [narration] = positional(args);
  const outputDir = option(args, "--out");
  if (!narration || !outputDir) throw new Error("tts requires narration.json and --out");
  const result = await synthesizeNarration(client, {
    narrationPath: resolve(narration),
    outputDir: resolve(outputDir),
    speaker: option(args, "--speaker"),
    concurrency: option(args, "--concurrency", "1"),
    onProgress({ phase, index, line, result: item }) {
      if (phase === "start") {
        console.log(`[${index + 1}] TTS ${line.id}: ${line.text.length} characters`);
      } else {
        console.log(
          `[${index + 1}] ${item.file}  ${item.costFen} fen  balance ${item.balanceFen ?? "?"} fen${item.replay ? " (replay)" : ""}`,
        );
      }
    },
  });
  console.log(`\nManifest: ${result.manifestPath}`);
  console.log(
    `New charge: ${result.chargedFen} fen; replayed: ${result.replayedLines}/${result.lines.length} lines`,
  );
  process.exit(0);
}

if (command === "asr") {
  const [audioPath] = positional(args);
  const output = option(args, "--out");
  if (!audioPath || !output) throw new Error("asr requires an audio file and --out");
  const audio = await readFile(resolve(audioPath));
  const digest = createHash("sha256").update(audio).digest("hex");
  const result = await client.transcribe({
    audio,
    idempotencyKey: `asr:${digest}`,
  });
  const outputPath = resolve(output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `Transcript: ${outputPath}\nCharged: ${result.costFen} fen\nBalance: ${result.balanceFen ?? "?"} fen`,
  );
  process.exit(0);
}

console.error(`Unknown command: ${command}\n`);
console.error(usage());
process.exit(2);
