/**
 * Two unrelated bits of cryptography live here:
 *
 *  1. Renpho transport encryption. Every request body and response `data`
 *     field of the Renpho Health API is AES-128-ECB (PKCS#7) with a fixed key
 *     baked into the mobile app, base64-encoded. WebCrypto deliberately has no
 *     ECB mode, so we use the small pure-JS `aes-js` implementation.
 *
 *  2. Sealing for our own KV cache. Session tokens and measurement pages are
 *     health data / bearer credentials, so nothing goes into KV in the clear:
 *     values are AES-256-GCM encrypted with a key derived from the
 *     SESSION_ENCRYPTION_KEY secret.
 */
import aesjs from "aes-js";

/** Static key shipped inside the Renpho Health app (see RenphoGarminSync-CLI). */
export const RENPHO_AES_KEY = "ed*wijdi$h6fe3ew";

const renphoKeyBytes = aesjs.utils.utf8.toBytes(RENPHO_AES_KEY);

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** AES-128-ECB + PKCS#7 encrypt arbitrary bytes, base64 encoded. */
export function renphoEncryptBytes(plain: Uint8Array): string {
  const padded = aesjs.padding.pkcs7.pad(plain);
  const ecb = new aesjs.ModeOfOperation.ecb(renphoKeyBytes);
  return bytesToBase64(ecb.encrypt(padded));
}

/** Encrypt a UTF-8 string (normally a JSON document). */
export function renphoEncrypt(text: string): string {
  return renphoEncryptBytes(aesjs.utils.utf8.toBytes(text));
}

/**
 * Some endpoints (device/count, family members) are called by the app with an
 * encrypted *empty byte array* rather than "{}" — a single padding block.
 */
export function renphoEncryptEmpty(): string {
  return renphoEncryptBytes(new Uint8Array(0));
}

/** Decrypt a base64 AES-128-ECB payload back to its UTF-8 text. */
export function renphoDecrypt(b64: string): string {
  const cipherBytes = base64ToBytes(b64);
  if (cipherBytes.length === 0 || cipherBytes.length % 16 !== 0) {
    throw new Error(`Renpho payload is not a whole number of AES blocks (${cipherBytes.length} bytes)`);
  }
  const ecb = new aesjs.ModeOfOperation.ecb(renphoKeyBytes);
  const padded = ecb.decrypt(cipherBytes);
  return aesjs.utils.utf8.fromBytes(aesjs.padding.pkcs7.strip(padded));
}

// ---------------------------------------------------------------------------
// KV sealing (AES-256-GCM)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Derive a non-extractable AES-GCM key from an arbitrary secret string. */
export async function deriveSealKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Encrypt text → base64(iv || ciphertext+tag). */
export async function seal(key: CryptoKey, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(text)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToBase64(out);
}

/** Inverse of `seal`. Throws if the payload was tampered with or the key differs. */
export async function open(key: CryptoKey, sealed: string): Promise<string> {
  const bytes = base64ToBytes(sealed);
  if (bytes.length < 13) throw new Error("Sealed payload too short");
  const iv = bytes.subarray(0, 12);
  const ct = bytes.subarray(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return decoder.decode(plain);
}

/** Lower-case hex SHA-256 of a string. Used to namespace cache keys per user. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
