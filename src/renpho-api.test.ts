/**
 * End-to-end tests of the client against a fake Renpho backend that speaks
 * the real wire format (AES-128-ECB envelopes, 64-bit ids, paged tables),
 * so transport, decryption, big-int handling, ordering detection and user
 * selection are all exercised together.
 */
import { describe, it, expect } from "vitest";
import { API_BASE, ENDPOINTS, PAGE_SIZE, RenphoAuthError, RenphoClient, parseScaleTables, summarizeDeviceCategories } from "./renpho-api";
import { renphoDecrypt, renphoEncrypt } from "./crypto";

const DAY = 86_400;
const NOW_MS = 1_780_000_000_000; // 2026-06-03T00:26:40Z
const NOW = Math.floor(NOW_MS / 1000);

const ACCOUNT_ID = "5245536005636456320";
const OTHER_SUB = "5245536005636456999";
const TABLE = "measurements_info_16";

interface FakeRecord {
  id: string;
  ts: number;
  weight: number;
  bUserId?: string;
  subUserId: string;
}

interface FakeOptions {
  records: FakeRecord[];
  order?: "asc" | "desc";
  /** What device/count reports (defaults to records.length). */
  reportedCount?: number;
  expAtMs?: number;
  password?: string;
  scaleUserIds?: string[];
}

/** Build JSON by hand so 64-bit ids are emitted as bare integers, like Renpho does. */
function recordJson(r: FakeRecord): string {
  return `{"id":${r.id},"timeStamp":${r.ts},"weight":${r.weight},"bodyfat":21.5,"muscle":65.1,"subUserId":${r.subUserId}${r.bUserId ? `,"bUserId":${r.bUserId}` : ""},"method":18,"internalModel":"ES-CS20M"}`;
}

function makeFake(opts: FakeOptions) {
  const order = opts.order ?? "asc";
  const password = opts.password ?? "pw";
  const scaleUserIds = opts.scaleUserIds ?? [ACCOUNT_ID, OTHER_SUB];
  const state = { logins: 0, tokenValid: true, requests: [] as string[], pageRequests: [] as number[] };
  let token = "";

  const envelope = (code: number, plaintext?: string) =>
    new Response(JSON.stringify({ code, msg: code === 101 ? "success" : "failure", data: plaintext === undefined ? undefined : renphoEncrypt(plaintext) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const sorted = () => [...opts.records].sort((a, b) => (order === "asc" ? a.ts - b.ts : b.ts - a.ts));

  const fetchImpl: typeof fetch = async (input, init) => {
    const path = String(input).replace(`${API_BASE}/`, "");
    state.requests.push(path);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as { encryptData: string };
    const plain = renphoDecrypt(body.encryptData);
    const req = plain === "" ? {} : (JSON.parse(plain) as Record<string, any>);

    if (path === ENDPOINTS.login) {
      state.logins++;
      if (req.login?.password !== password) return envelope(20001);
      token = `tok-${state.logins}`;
      state.tokenValid = true;
      const expAt = opts.expAtMs ?? NOW_MS + 3 * 3600 * 1000;
      return envelope(
        101,
        `{"questionnaire":{},"login":{"id":${ACCOUNT_ID},"email":"a@b.co","token":"${token}","encryptedPassword":"x","gender":1,"height":180,"weightGoal":82,"expAt":${expAt},"issAt":${NOW_MS}},"bindingList":{}}`,
      );
    }

    if (headers.token !== token || !state.tokenValid) return envelope(401);
    expect(headers.userId).toBe(ACCOUNT_ID);

    if (path === ENDPOINTS.deviceCount) {
      const count = opts.reportedCount ?? opts.records.length;
      return envelope(101, `{"scale":[{"userIds":[${scaleUserIds.join(",")}],"count":${count},"tableName":"${TABLE}"}],"girth":0,"treadmill":{"total":0}}`);
    }
    if (path === ENDPOINTS.familyMembers) {
      return envelope(101, `[{"id":${OTHER_SUB},"accountName":"Sam","gender":0}]`);
    }
    if (path === ENDPOINTS.measurements) {
      expect(req.tableName).toBe(TABLE);
      state.pageRequests.push(req.pageNum);
      const page = sorted().slice((req.pageNum - 1) * req.pageSize, req.pageNum * req.pageSize);
      return envelope(101, `[${page.map(recordJson).join(",")}]`);
    }
    if (path === ENDPOINTS.tokenTime) {
      return envelope(101, `{"issAt":${NOW_MS},"expAt":${NOW_MS + 3600_000},"userId":${ACCOUNT_ID},"token":"${token}"}`);
    }
    return envelope(-1);
  };

  return { fetchImpl, state, invalidateToken: () => (state.tokenValid = false) };
}

/** Enough records for several pages: one a day, newest = now, ids unique 19-digit. */
function dailyRecords(n: number, sub = ACCOUNT_ID, bound: string | undefined = ACCOUNT_ID, idPrefix = "59192784209026"): FakeRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${idPrefix}${String(10000 + i).padStart(5, "0")}`,
    ts: NOW - i * DAY,
    weight: 88 - i * 0.01,
    subUserId: sub,
    bUserId: bound,
  }));
}

class FakeKV {
  store = new Map<string, string>();
  puts = 0;
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.puts++;
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
  async list({ prefix }: { prefix?: string; cursor?: string }) {
    return { keys: Array.from(this.store.keys()).filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })), list_complete: true as const, cursor: undefined };
  }
}

function client(fake: ReturnType<typeof makeFake>, extra: Partial<ConstructorParameters<typeof RenphoClient>[0]> = {}) {
  return new RenphoClient({ email: "a@b.co", password: "pw", userHash: "hash", fetchImpl: fake.fetchImpl, now: () => NOW_MS, ...extra });
}

describe("login / session", () => {
  it("logs in over the encrypted envelope, keeps the 64-bit user id exact, uses expAt", async () => {
    const fake = makeFake({ records: [] });
    const session = await client(fake).getSession();
    expect(session.userId).toBe(ACCOUNT_ID);
    expect(session.token).toBe("tok-1");
    expect(session.expiresAt).toBe(NOW_MS + 3 * 3600 * 1000);
    expect(session.login).not.toHaveProperty("token");
    expect(session.login).not.toHaveProperty("encryptedPassword");
    expect(session.login.weightGoal).toBe(82);
  });

  it("falls back to a 50-minute lifetime when expAt is missing or in the past", async () => {
    const fake = makeFake({ records: [], expAtMs: NOW_MS - 1 });
    expect((await client(fake).getSession()).expiresAt).toBe(NOW_MS + 50 * 60 * 1000);
  });

  it("surfaces bad credentials as RenphoAuthError with the decoded status", async () => {
    const fake = makeFake({ records: [], password: "other" });
    await expect(client(fake).getSession()).rejects.toThrow(RenphoAuthError);
    await expect(client(fake).getSession()).rejects.toThrow(/20001.*email or password incorrect/);
  });

  it("re-logs in once when the token is rejected, then retries the call", async () => {
    const fake = makeFake({ records: dailyRecords(3) });
    const c = client(fake);
    await c.getDeviceInfo();
    expect(fake.state.logins).toBe(1);
    fake.invalidateToken();
    const info = await c.getDeviceInfo(true);
    expect(fake.state.logins).toBe(2);
    expect(info.tables).toEqual([{ table_name: TABLE, count: 3, user_ids: [ACCOUNT_ID, OTHER_SUB] }]);
  });

  it("coalesces concurrent logins", async () => {
    const fake = makeFake({ records: [] });
    const c = client(fake);
    await Promise.all([c.getSession(), c.getSession(), c.getSession()]);
    expect(fake.state.logins).toBe(1);
  });
});

describe("device/count parsing", () => {
  it("stringifies ids and summarises every category", () => {
    const raw = { scale: [{ userIds: ["5245536005636456320", 7], count: 387, tableName: "measurements_info_16" }], girth: 0, treadmill: { total: 0 }, bodyScan: [{ userIds: [3], count: 9, tableName: "morpho_2" }] };
    expect(parseScaleTables(raw)).toEqual([{ table_name: "measurements_info_16", count: 387, user_ids: ["5245536005636456320", "7"] }]);
    const cats = Object.fromEntries(summarizeDeviceCategories(raw).map((c) => [c.category, c]));
    expect(cats.scale).toMatchObject({ handled: true, has_data: true });
    expect(cats.girth).toMatchObject({ handled: false, has_data: false });
    expect(cats.treadmill.has_data).toBe(false);
    expect(cats.bodyScan).toMatchObject({ handled: false, has_data: true });
    expect(cats.bodyScan.detail).toContain("morpho_2 (9 records)");
  });
});

describe("pagination", () => {
  it("ascending tables: walks back from the last page only as far as the window needs", async () => {
    const fake = makeFake({ records: dailyRecords(450), order: "asc" }); // 3 pages: 200/200/50 (page 3 newest)
    const c = client(fake);
    const res = await c.scanMeasurements({ startSec: NOW - 30 * DAY });
    expect(fake.state.pageRequests).toEqual([3, 2]);
    expect(res.tables[0]).toMatchObject({ order: "asc", pages_fetched: 2, truncated: false });
    expect(res.records.length).toBe(250);
    expect(res.records[0].id).toBe("5919278420902610000"); // newest first
    expect(res.records[0].timeStamp).toBe(NOW);
  });

  it("ascending tables: covers a long window with every page", async () => {
    const fake = makeFake({ records: dailyRecords(450), order: "asc" });
    const res = await client(fake).scanMeasurements({ startSec: NOW - 400 * DAY });
    expect(fake.state.pageRequests).toEqual([3, 2, 1]);
    expect(res.records.length).toBe(450);
  });

  it("descending tables: detects the order and walks from page 1", async () => {
    const fake = makeFake({ records: dailyRecords(450), order: "desc" }); // page 1 newest
    const res = await client(fake).scanMeasurements({ startSec: NOW - 30 * DAY });
    expect(fake.state.pageRequests).toEqual([3, 2, 1]);
    expect(res.tables[0].order).toBe("desc");
    const inRange = res.records.filter((r) => Number(r.timeStamp) >= NOW - 30 * DAY);
    expect(inRange.length).toBe(31);
  });

  it("probes past a stale device/count so freshly synced readings are not missed", async () => {
    const fake = makeFake({ records: dailyRecords(450), order: "asc", reportedCount: 400 });
    const res = await client(fake).scanMeasurements({ startSec: NOW - 10 * DAY });
    // Reported 2 pages; page 2 is full so page 3 is probed; it is short (50), so no page 4.
    expect(fake.state.pageRequests).toEqual([2, 1, 3]);
    expect(res.records[0].timeStamp).toBe(NOW);
    expect(res.records.length).toBe(450);
  });

  it("stops on `limit` when no start is given", async () => {
    const fake = makeFake({ records: dailyRecords(450), order: "asc" });
    const res = await client(fake).scanMeasurements({ limit: 20 });
    expect(fake.state.pageRequests).toEqual([3, 2]); // page 3 has 50 ≥ 20, but ordering needs page 2 too
    expect(res.records.length).toBe(250);
  });

  it("single-page tables", async () => {
    const fake = makeFake({ records: dailyRecords(5) });
    const res = await client(fake).scanMeasurements({});
    expect(res.tables[0]).toMatchObject({ order: "single", pages_fetched: 1 });
    expect(res.records.map((r) => r.id).length).toBe(5);
  });

  it("empty tables are skipped without a request", async () => {
    const fake = makeFake({ records: [] });
    const res = await client(fake).scanMeasurements({});
    expect(res.tables[0].order).toBe("empty");
    expect(fake.state.pageRequests).toEqual([]);
  });
});

describe("user selection", () => {
  const mine = dailyRecords(5, ACCOUNT_ID, ACCOUNT_ID);
  const partner = dailyRecords(4, OTHER_SUB, OTHER_SUB, "59192784209027");
  const unbound = { id: "5919278420902699999", ts: NOW + 3600, weight: 87, subUserId: ACCOUNT_ID, bUserId: undefined };

  it("prefers records bound to the account and reports the hidden count", async () => {
    const fake = makeFake({ records: [...mine, ...partner] });
    const res = await client(fake).getMeasurements({ startSec: NOW - 30 * DAY });
    expect(res.selection).toBe("bound");
    expect(res.records.length).toBe(5);
    expect(res.hidden).toBe(4);
    expect(res.scanned).toBe(9);
  });

  it("filters by scale_user_id and can include everyone", async () => {
    const fake = makeFake({ records: [...mine, ...partner] });
    const c = client(fake);
    const theirs = await c.getMeasurements({ scaleUserId: OTHER_SUB });
    expect(theirs.selection).toBe("scale_user");
    expect(theirs.records.length).toBe(4);
    const all = await c.getMeasurements({ includeAllUsers: true });
    expect(all.selection).toBe("all");
    expect(all.records.length).toBe(9);
  });

  it("falls back to the first scale user when nothing is bound yet", async () => {
    const fake = makeFake({ records: [unbound, ...partner], scaleUserIds: [ACCOUNT_ID, OTHER_SUB] });
    const res = await client(fake).getMeasurements({});
    // `subUserId === account id` counts as bound, so the unbound record is selected under the bound rule.
    expect(res.selection).toBe("bound");
    expect(res.records.map((r) => r.id)).toEqual([unbound.id]);

    const fake2 = makeFake({ records: partner, scaleUserIds: [OTHER_SUB] });
    const res2 = await client(fake2).getMeasurements({});
    expect(res2.selection).toBe("fallback_scale_user");
    expect(res2.records.length).toBe(4);
  });

  it("applies `take` after selection and honours the time window", async () => {
    const fake = makeFake({ records: mine });
    const res = await client(fake).getMeasurements({ startSec: NOW - 2 * DAY, endSec: NOW, take: 1 });
    expect(res.records.length).toBe(1);
    expect(res.records[0].timeStamp).toBe(NOW - DAY); // endSec is exclusive
  });
});

describe("KV cache", () => {
  it("seals the session and pages, serves repeats from cache, and purges per user", async () => {
    const kv = new FakeKV();
    const fake = makeFake({ records: dailyRecords(10) });
    const c = client(fake, { cache: kv as unknown as KVNamespace, sealSecret: "s3cret" });
    expect(c.cacheEnabled).toBe(true);

    await c.getMeasurements({});
    const pageRequestsAfterFirst = fake.state.pageRequests.length;
    expect(pageRequestsAfterFirst).toBe(1);
    // Nothing in KV is readable without the key.
    for (const v of kv.store.values()) expect(v).not.toMatch(/tok-1|timeStamp/);
    expect(Array.from(kv.store.keys()).every((k) => k.startsWith("v1:hash:"))).toBe(true);

    // A fresh client (new DO instance) reuses the sealed session + page.
    const c2 = client(fake, { cache: kv as unknown as KVNamespace, sealSecret: "s3cret" });
    await c2.getMeasurements({});
    expect(fake.state.logins).toBe(1);
    expect(fake.state.pageRequests.length).toBe(pageRequestsAfterFirst);

    const purged = await c2.purgeCache();
    expect(purged).toBeGreaterThanOrEqual(2);
    expect(kv.store.size).toBe(0);
    await c2.getSession();
    expect(fake.state.logins).toBe(2);
  });

  it("is disabled without a seal secret", async () => {
    const kv = new FakeKV();
    const fake = makeFake({ records: [] });
    const c = client(fake, { cache: kv as unknown as KVNamespace });
    expect(c.cacheEnabled).toBe(false);
    await c.getSession();
    expect(kv.puts).toBe(0);
  });
});

describe("misc endpoints", () => {
  it("family members and token time decode with big ids intact", async () => {
    const fake = makeFake({ records: [] });
    const c = client(fake);
    const family = await c.getFamilyMembers();
    expect(family).toEqual([{ id: OTHER_SUB, accountName: "Sam", gender: 0 }]);
    const tt = await c.getTokenTime();
    expect(tt.userId).toBe(ACCOUNT_ID);
    expect(PAGE_SIZE).toBe(200);
  });
});
