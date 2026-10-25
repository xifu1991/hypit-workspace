import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const SCRYPT_KEY_LENGTH = 64;

export function hashPassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("password must contain at least 8 characters");
  }
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1], "base64url");
    const expected = Buffer.from(parts[2], "base64url");
    const actual = scryptSync(String(password), salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function randomToken(prefix = "") {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function tokenPrefix(token) {
  return String(token).slice(0, 14);
}

export function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const item of String(header).split(";")) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    const name = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      continue;
    }
  }
  return cookies;
}

export function rechargeCode() {
  const chunks = [];
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(20);
  for (let index = 0; index < 20; index += 1) {
    chunks.push(alphabet[bytes[index] % alphabet.length]);
  }
  return `HG-${chunks.slice(0, 5).join("")}-${chunks.slice(5, 10).join("")}-${chunks
    .slice(10, 15)
    .join("")}-${chunks.slice(15, 20).join("")}`;
}
