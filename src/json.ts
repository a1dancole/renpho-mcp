/**
 * Renpho ids (account, scale-user, measurement) are 64-bit integers such as
 * 5919278420902642176 — far beyond JavaScript's 2^53 safe-integer range, so a
 * naive JSON.parse silently rounds them and the ids no longer match across
 * calls. We pre-process the decrypted JSON text and quote any integer literal
 * of 16+ digits so those values arrive as strings. No real measurement value
 * ever has 16 digits, so this is safe to apply blindly.
 *
 * The scan is string-aware (it never touches digits inside a JSON string,
 * including escaped JSON stored in fields like `extraField`).
 */
export function quoteBigInts(json: string): string {
  let out = "";
  let i = 0;
  const n = json.length;
  let inString = false;

  while (i < n) {
    const ch = json[i];

    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Copy the escaped character verbatim (handles \" and \\).
        if (i + 1 < n) out += json[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      // Consume a JSON number token.
      let j = i;
      if (json[j] === "-") j++;
      const digitsStart = j;
      while (j < n && json[j] >= "0" && json[j] <= "9") j++;
      const digitCount = j - digitsStart;
      // Fraction / exponent make it a float — never an id; copy as-is.
      const isFloat = json[j] === "." || json[j] === "e" || json[j] === "E";
      let k = j;
      if (isFloat) {
        while (k < n && /[0-9.eE+-]/.test(json[k])) k++;
      }
      const token = json.slice(i, isFloat ? k : j);
      out += !isFloat && digitCount >= 16 ? `"${token}"` : token;
      i = isFloat ? k : j;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/** JSON.parse with big-integer ids preserved as strings. */
export function parseRenphoJson<T = unknown>(text: string): T {
  return JSON.parse(quoteBigInts(text)) as T;
}
