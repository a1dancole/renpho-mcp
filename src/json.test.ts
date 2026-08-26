import { describe, it, expect } from "vitest";
import { parseRenphoJson, quoteBigInts } from "./json";

describe("quoteBigInts", () => {
  it("quotes 16+ digit integers in objects and arrays, leaves everything else", () => {
    const input = '{"id":5919278420902642176,"timeStamp":1771059525,"weight":88.15,"userIds":[5245536005636456320,42],"neg":-5245536005636456320,"exp":1.5e3}';
    expect(quoteBigInts(input)).toBe(
      '{"id":"5919278420902642176","timeStamp":1771059525,"weight":88.15,"userIds":["5245536005636456320",42],"neg":"-5245536005636456320","exp":1.5e3}',
    );
  });

  it("never touches digits inside strings, including escaped JSON", () => {
    const input = '{"extraField":"{\\"id\\":5919278420902642176}","note":"call 12345678901234567890","q":"a\\\\"}';
    expect(quoteBigInts(input)).toBe(input);
    expect(() => JSON.parse(quoteBigInts(input))).not.toThrow();
  });

  it("copes with whitespace around tokens", () => {
    expect(quoteBigInts('{ "id" : 5919278420902642176 , "x": [ 1 , 5919278420902642177 ] }')).toBe(
      '{ "id" : "5919278420902642176" , "x": [ 1 , "5919278420902642177" ] }',
    );
  });
});

describe("parseRenphoJson", () => {
  it("returns big ids as exact strings", () => {
    const parsed = parseRenphoJson<{ id: string; bUserId: string; weight: number }>(
      '{"id":5919278420902642176,"bUserId":5245536005636456320,"weight":88.15}',
    );
    expect(parsed.id).toBe("5919278420902642176");
    expect(parsed.bUserId).toBe("5245536005636456320");
    expect(parsed.weight).toBe(88.15);
    // The naive parse would have rounded it.
    expect(String(JSON.parse('{"id":5919278420902642176}').id)).not.toBe("5919278420902642176");
  });
});
