import { describe, it, expect } from "vitest";
import { createCipheriv, createDecipheriv } from "node:crypto";
import {
  RENPHO_AES_KEY,
  base64ToBytes,
  bytesToBase64,
  deriveSealKey,
  open,
  renphoDecrypt,
  renphoEncrypt,
  renphoEncryptEmpty,
  seal,
  sha256Hex,
} from "./crypto";

/** Reference implementation: Node's OpenSSL-backed AES-128-ECB, as the reference servers use. */
function nodeEncrypt(bytes: Buffer): string {
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(RENPHO_AES_KEY, "utf8"), null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]).toString("base64");
}
function nodeDecrypt(b64: string): string {
  const decipher = createDecipheriv("aes-128-ecb", Buffer.from(RENPHO_AES_KEY, "utf8"), null);
  return Buffer.concat([decipher.update(Buffer.from(b64, "base64")), decipher.final()]).toString("utf8");
}

describe("Renpho AES-128-ECB (aes-js vs node:crypto)", () => {
  const loginBody = JSON.stringify({
    questionnaire: {},
    login: { password: "hunter2", areaCode: "US", appRevision: "7.0.0", cellphoneType: "RenphoHealthMCP", systemType: "11", email: "a@b.co", platform: "android" },
    bindingList: { deviceTypes: ["2"] },
  });

  it("produces byte-identical ciphertext to node for a login payload", () => {
    expect(renphoEncrypt(loginBody)).toBe(nodeEncrypt(Buffer.from(loginBody, "utf8")));
  });

  it("handles exact block multiples (PKCS#7 adds a full padding block)", () => {
    const sixteen = "0123456789abcdef";
    expect(renphoEncrypt(sixteen)).toBe(nodeEncrypt(Buffer.from(sixteen)));
    expect(base64ToBytes(renphoEncrypt(sixteen)).length).toBe(32);
  });

  it("handles multi-byte UTF-8", () => {
    const text = '{"accountName":"Aïdan ✓ 体重"}';
    expect(renphoEncrypt(text)).toBe(nodeEncrypt(Buffer.from(text, "utf8")));
    expect(renphoDecrypt(renphoEncrypt(text))).toBe(text);
  });

  it("encrypts the empty byte array exactly like the app (single padding block)", () => {
    expect(renphoEncryptEmpty()).toBe(nodeEncrypt(Buffer.alloc(0)));
    expect(renphoDecrypt(renphoEncryptEmpty())).toBe("");
  });

  it("decrypts large multi-block payloads produced by node", () => {
    const big = JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ id: 5919278420902642176n.toString(), timeStamp: 1771059525 + i, weight: 88.15 + i / 100 })));
    expect(renphoDecrypt(nodeEncrypt(Buffer.from(big)))).toBe(big);
    expect(nodeDecrypt(renphoEncrypt(big))).toBe(big);
  });

  it("rejects ciphertext that is not a whole number of blocks", () => {
    expect(() => renphoDecrypt(bytesToBase64(new Uint8Array(20)))).toThrow(/AES blocks/);
  });
});

describe("base64 helpers", () => {
  it("round-trips arbitrary bytes, including > 32 KiB", () => {
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 31) & 0xff);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe("KV sealing (AES-GCM)", () => {
  it("round-trips and produces distinct ciphertexts per call (random IV)", async () => {
    const key = await deriveSealKey("secret");
    const a = await seal(key, '{"token":"abc"}');
    const b = await seal(key, '{"token":"abc"}');
    expect(a).not.toBe(b);
    expect(await open(key, a)).toBe('{"token":"abc"}');
    expect(await open(key, b)).toBe('{"token":"abc"}');
  });

  it("fails to open with a different secret or a tampered payload", async () => {
    const key = await deriveSealKey("secret");
    const other = await deriveSealKey("secret2");
    const sealed = await seal(key, "hello");
    await expect(open(other, sealed)).rejects.toThrow();
    const tampered = base64ToBytes(sealed);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(open(key, bytesToBase64(tampered))).rejects.toThrow();
    await expect(open(key, "AAAA")).rejects.toThrow(/too short/);
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
