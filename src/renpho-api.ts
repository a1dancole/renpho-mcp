/**
 * Client for the Renpho Health cloud API (`cloud.renpho.com`) — the backend of
 * the blue-icon "Renpho Health" app, *not* the legacy `renpho.qnclouds.com`
 * API. Reverse-engineered protocol (credit: forkerer/RenphoGarminSync-CLI and
 * StartupBros-com/renpho-mcp-server):
 *
 *   - Every request is `POST { encryptData: base64(AES-128-ECB(json)) }`.
 *   - Every response is `{ code, msg, data }` with `data` encrypted the same
 *     way; `code === 101` means success.
 *   - Login returns a bearer `token` (+ `expAt`) that goes in a `token` header
 *     alongside `userId`, `appVersion` and `platform`.
 *   - `device/count` lists the per-device data tables; scale measurements are
 *     then paged out of `scale/queryAllMeasureDataList` per table.
 *
 * Responsibilities here: session caching (in-memory + sealed KV), transport
 * with retry/re-login, page caching, and an order-agnostic paginator that
 * only pulls the pages a date range actually needs. Shaping for Claude lives
 * in measurements.ts.
 */
import { deriveSealKey, open, renphoDecrypt, renphoEncrypt, renphoEncryptEmpty, seal } from "./crypto";
import { parseRenphoJson } from "./json";
import type { RawMeasurement } from "./measurements";

export const API_BASE = "https://cloud.renpho.com";

export const ENDPOINTS = {
  login: "renpho-aggregation/user/login",
  deviceCount: "renpho-aggregation/device/count",
  tokenTime: "RenphoHealth/app/sync/getTokenTime",
  familyMembers: "RenphoHealth/centerUser/queryFamilyMemberList",
  /** Legacy scale rows; `device/count` describes these. */
  measurements: "RenphoHealth/scale/queryAllMeasureDataList",
  /**
   * Newer store used by impedance / multi-frequency scales (e.g. MorphoScan).
   * `device/count` does NOT count these rows (credit: danvaneijck/renpho-api),
   * so it is paged blind until a short page.
   */
  bodyComposition: "RenphoHealth/scale/queryBodyCompositionMeasureData",
  /** Smart tape-measure circumferences (no table/user id; paged by pageNum/pageSize). */
  girthMeasurements: "RenphoHealth/renpho/girth/queryAllGirthsDataList",
} as const;

/** Which measurement store a row was read from. */
export type MeasurementEndpoint = "legacy" | "bodyComposition";

const ENDPOINT_PATH: Record<MeasurementEndpoint, string> = {
  legacy: ENDPOINTS.measurements,
  bodyComposition: ENDPOINTS.bodyComposition,
};

/** Rows are tagged with the store they came from under this key (stripped from output). */
export const ENDPOINT_TAG = "__endpoint";

const APP_VERSION = "7.0.0";
const PLATFORM = "android";

/** Records per page requested from queryAllMeasureDataList. */
export const PAGE_SIZE = 200;
/** Hard stop per table per scan (PAGE_SIZE × this = max records considered). */
export const MAX_PAGES_PER_TABLE = 30;

/** If the login response carries no usable `expAt`, assume this lifetime. */
const SESSION_TTL_FALLBACK_MS = 50 * 60 * 1000;
/** Refresh the session this long before Renpho says it expires. */
const SESSION_SAFETY_MS = 2 * 60 * 1000;
/** Measurement pages are keyed by the table's record count, so a new weigh-in
 *  changes the key; this TTL only bounds staleness for in-place edits. */
const PAGE_TTL_SECONDS = 6 * 60 * 60;
/** Body-composition pages have no count to key on, so they only live briefly. */
const BODY_COMP_PAGE_TTL_SECONDS = 15 * 60;
/** device/count is the freshness signal for pages — memoise only briefly. */
const DEVICE_INFO_MEMO_MS = 30 * 1000;

const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const MAX_HTTP_RETRIES = 2;
/** Envelope codes that mean "your token is no longer good". */
const AUTH_FAILURE_CODES = new Set([401, 403]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Envelope `code` values observed in the Renpho app (RenphoStatusCode). */
export const STATUS_MESSAGES: Record<number, string> = {
  101: "success",
  102: "email already registered",
  104: "wrong password",
  106: "email not registered",
  108: "added repeatedly",
  111: "email verification error",
  112: "email verification code expired",
  116: "previous password wrong",
  118: "password reset failed",
  140: "email domain error",
  401: "unauthorized — session token expired or invalid",
  403: "forbidden",
  429: "too many requests — Renpho rate limit",
  500: "Renpho server error",
  502: "bad gateway",
  1004: "password format error",
  1009: "email format error",
  1015: "too many verification codes",
  20001: "email or password incorrect",
  20002: "account already bound",
  20003: "data synchronisation limit reached",
  20004: "account does not exist",
  50005: "user does not exist",
  [-1]: "service exception",
  [-100]: "device binding exception",
  [-109]: "service exception",
  [-113]: "service exception",
  [-114]: "decryption failed — payload encryption rejected by Renpho",
  [-115]: "service exception",
};

export class RenphoApiError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly httpStatus?: number,
    public readonly path?: string,
  ) {
    super(message);
    this.name = "RenphoApiError";
  }
}

/** Login itself was rejected (bad credentials etc.) — distinct so the auth page can react. */
export class RenphoAuthError extends RenphoApiError {
  constructor(message: string, code?: number, httpStatus?: number) {
    super(message, code, httpStatus, ENDPOINTS.login);
    this.name = "RenphoAuthError";
  }
}

export interface Session {
  token: string;
  /** Renpho account id as a string (ids exceed 2^53). */
  userId: string;
  /** Unix ms. */
  issuedAt?: number;
  /** Unix ms. */
  expiresAt: number;
  /** The `login` object of the login response, minus the token/password. */
  login: Record<string, unknown>;
  /** Devices bound to the account, as reported at login (diagnostics). */
  bindingList?: unknown;
}

export interface ScaleTable {
  table_name: string;
  count: number;
  /** Scale-user (profile) ids whose records live in this table. */
  user_ids: string[];
}

export interface DeviceCategory {
  category: string;
  handled: boolean;
  has_data: boolean;
  detail: string;
}

export interface DeviceInfo {
  raw: Record<string, unknown>;
  tables: ScaleTable[];
  categories: DeviceCategory[];
}

interface Envelope {
  code: number;
  msg?: string;
  data?: string | null;
}

export interface RenphoClientOptions {
  email: string;
  password: string;
  /** Namespaces cache keys; SHA-256 of the email. */
  userHash: string;
  /** KV namespace for sealed session + page caching. Omit to disable caching. */
  cache?: KVNamespace;
  /** Secret for sealing cache values. Caching is disabled without it. */
  sealSecret?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override "now" in ms (tests). */
  now?: () => number;
}

export interface TableScan {
  table_name: string;
  /** Which store this scan read. */
  endpoint: MeasurementEndpoint;
  /** Record count reported by device/count (legacy store only; unknown for bodyComposition). */
  count?: number;
  pages_fetched: number;
  records: number;
  /** Which direction the API pages in: "asc" = last page is newest. */
  order: "asc" | "desc" | "single" | "empty";
  /** True if MAX_PAGES_PER_TABLE stopped the scan before the range was covered. */
  truncated: boolean;
  /** Set when this store errored; the other store's rows are still returned. */
  error?: string;
}

export interface ScanResult {
  records: RawMeasurement[];
  tables: TableScan[];
}

export interface ScanOptions {
  /** Inclusive lower bound, unix seconds. */
  startSec?: number;
  /** Exclusive upper bound, unix seconds. */
  endSec?: number;
  /** Stop once this many records (before user filtering) are in range. Only used without startSec. */
  limit?: number;
  /** Restrict to these tables (default: every scale table). */
  tables?: ScaleTable[];
}

export type Selection = "scale_user" | "bound" | "fallback_scale_user" | "all" | "none";

export interface MeasurementQuery extends ScanOptions {
  /** Return only records whose scale-user (profile) id matches. */
  scaleUserId?: string;
  /** Return records for every user in the account's tables. */
  includeAllUsers?: boolean;
  /** Cap on returned (post-selection) records, newest first. */
  take?: number;
}

export interface MeasurementResult {
  /** Newest first. */
  records: RawMeasurement[];
  selection: Selection;
  /** In-range records that belong to other users/profiles and were filtered out. */
  hidden: number;
  scanned: number;
  tables: TableScan[];
}

const tsOf = (r: RawMeasurement): number => Number(r.timeStamp) || 0;
const idOf = (r: RawMeasurement): string => String(r.id ?? "");

/** Port of the reference server's category summary: every key of device/count. */
export function summarizeDeviceCategories(raw: Record<string, unknown>): DeviceCategory[] {
  return Object.entries(raw).map(([category, value]) => {
    const handled = category === "scale";
    if (Array.isArray(value)) {
      const tables = value
        .filter((e): e is Record<string, unknown> => e != null && typeof e === "object")
        .map((e) => {
          const tableName = typeof e.tableName === "string" ? e.tableName : null;
          const count = typeof e.count === "number" ? e.count : null;
          return tableName ? `${tableName}${count != null ? ` (${count} records)` : ""}` : JSON.stringify(e);
        });
      return {
        category,
        handled,
        has_data: value.length > 0,
        detail: value.length === 0 ? "empty list" : `${value.length} entries: ${tables.join(", ")}`,
      };
    }
    if (value != null && typeof value === "object") {
      const numericTotal = Object.values(value).some((f) => typeof f === "number" && f > 0);
      return { category, handled, has_data: numericTotal, detail: JSON.stringify(value) };
    }
    if (typeof value === "number") {
      return { category, handled, has_data: value > 0, detail: String(value) };
    }
    return { category, handled, has_data: value != null, detail: String(value) };
  });
}

/** Turn the `scale` entries of device/count into ScaleTable[] (ids as strings). */
export function parseScaleTables(raw: Record<string, unknown>): ScaleTable[] {
  const scale = raw.scale;
  if (!Array.isArray(scale)) return [];
  return scale
    .filter((e): e is Record<string, unknown> => e != null && typeof e === "object")
    .map((e) => ({
      table_name: String(e.tableName ?? ""),
      count: typeof e.count === "number" ? e.count : Number(e.count) || 0,
      user_ids: Array.isArray(e.userIds) ? e.userIds.map((id) => String(id)) : [],
    }))
    .filter((t) => t.table_name !== "");
}

export class RenphoClient {
  private readonly email: string;
  private readonly password: string;
  private readonly userHash: string;
  private readonly cache?: KVNamespace;
  private readonly sealSecret?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private session?: Session;
  private sealKeyPromise?: Promise<CryptoKey>;
  private deviceInfoMemo?: { info: DeviceInfo; at: number };
  private loginInFlight?: Promise<Session>;

  constructor(opts: RenphoClientOptions) {
    this.email = opts.email;
    this.password = opts.password;
    this.userHash = opts.userHash;
    this.cache = opts.cache;
    this.sealSecret = opts.sealSecret;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => Date.now());
  }

  // -------------------------------------------------------------------------
  // Cache primitives (all values sealed; failures never break a request)
  // -------------------------------------------------------------------------

  get cacheEnabled(): boolean {
    return Boolean(this.cache && this.sealSecret);
  }

  private sealKey(): Promise<CryptoKey> {
    if (!this.sealKeyPromise) this.sealKeyPromise = deriveSealKey(this.sealSecret!);
    return this.sealKeyPromise;
  }

  private key(...parts: Array<string | number>): string {
    return `v1:${this.userHash}:${parts.join(":")}`;
  }

  private async cacheGet<T>(key: string): Promise<T | undefined> {
    if (!this.cacheEnabled) return undefined;
    try {
      const sealed = await this.cache!.get(key, "text");
      if (!sealed) return undefined;
      return JSON.parse(await open(await this.sealKey(), sealed)) as T;
    } catch {
      return undefined;
    }
  }

  private async cachePut(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.cacheEnabled) return;
    try {
      const sealed = await seal(await this.sealKey(), JSON.stringify(value));
      await this.cache!.put(key, sealed, { expirationTtl: Math.max(60, Math.floor(ttlSeconds)) });
    } catch {
      // A failed write just means no caching this time.
    }
  }

  /** Delete every cached entry for this user (session + pages). Returns the count. */
  async purgeCache(): Promise<number> {
    this.session = undefined;
    this.deviceInfoMemo = undefined;
    if (!this.cache) return 0;
    const prefix = this.key("");
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await this.cache.list({ prefix, cursor });
      await Promise.all(page.keys.map((k) => this.cache!.delete(k.name)));
      count += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return count;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  private sessionUsable(s: Session | undefined): s is Session {
    return Boolean(s && s.token && s.expiresAt - SESSION_SAFETY_MS > this.now());
  }

  /** A valid session: in-memory → sealed KV → fresh login. */
  async getSession(force = false): Promise<Session> {
    if (!force && this.sessionUsable(this.session)) return this.session;

    if (!force) {
      const cached = await this.cacheGet<Session>(this.key("session"));
      if (this.sessionUsable(cached)) {
        this.session = cached;
        return cached;
      }
    }

    // Coalesce concurrent logins (tools fan out several calls at once).
    if (!this.loginInFlight) {
      this.loginInFlight = this.login().finally(() => (this.loginInFlight = undefined));
    }
    const session = await this.loginInFlight;
    this.session = session;
    await this.cachePut(this.key("session"), session, (session.expiresAt - this.now()) / 1000 - 60);
    return session;
  }

  /** Whether a cached session exists (diagnostics). */
  async peekSession(): Promise<Session | undefined> {
    return this.session ?? (await this.cacheGet<Session>(this.key("session")));
  }

  private async login(): Promise<Session> {
    const loginData = {
      questionnaire: {},
      login: {
        password: this.password,
        areaCode: "US",
        appRevision: APP_VERSION,
        cellphoneType: "RenphoHealthMCP",
        systemType: "11",
        email: this.email,
        platform: PLATFORM,
      },
      bindingList: { deviceTypes: ["2"] },
    };

    const env = await this.postEnvelope(ENDPOINTS.login, renphoEncrypt(JSON.stringify(loginData)), {});
    if (env.code !== 101) {
      throw new RenphoAuthError(
        `Renpho login failed: ${describeCode(env.code, env.msg)}`,
        env.code,
      );
    }
    if (!env.data) throw new RenphoAuthError("Renpho login returned no data", env.code);

    const payload = parseRenphoJson<{ login?: Record<string, unknown>; bindingList?: unknown }>(renphoDecrypt(env.data));
    const login = payload.login;
    if (!login || typeof login.token !== "string" || login.id === undefined) {
      throw new RenphoAuthError("Renpho login response did not include a token/user id");
    }

    const nowMs = this.now();
    const expAt = toMillis(login.expAt);
    const issAt = toMillis(login.issAt);
    const expiresAt = expAt && expAt > nowMs ? expAt : nowMs + SESSION_TTL_FALLBACK_MS;

    const { token, encryptedPassword: _ep, password: _pw, ...rest } = login as Record<string, unknown> & {
      token: string;
    };
    return {
      token,
      userId: String(login.id),
      issuedAt: issAt,
      expiresAt,
      login: rest,
      bindingList: payload.bindingList,
    };
  }

  /** Probe `getTokenTime` — Renpho's own view of when the session expires. */
  async getTokenTime(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>(ENDPOINTS.tokenTime, null);
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private authHeaders(session: Session): Record<string, string> {
    return {
      token: session.token,
      userId: session.userId,
      appVersion: APP_VERSION,
      platform: PLATFORM,
    };
  }

  /** POST an encrypted body and parse the `{code,msg,data}` envelope, retrying transient failures. */
  private async postEnvelope(
    path: string,
    encryptData: string,
    headers: Record<string, string>,
    attempt = 0,
  ): Promise<Envelope> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API_BASE}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
        body: JSON.stringify({ encryptData }),
      });
    } catch (err) {
      if (attempt < MAX_HTTP_RETRIES) {
        await sleep(backoffMs(attempt));
        return this.postEnvelope(path, encryptData, headers, attempt + 1);
      }
      throw new RenphoApiError(
        `Network error calling ${path}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        undefined,
        path,
      );
    }

    if (RETRYABLE_HTTP.has(res.status) && attempt < MAX_HTTP_RETRIES) {
      await sleep(backoffMs(attempt, res.headers.get("Retry-After")));
      return this.postEnvelope(path, encryptData, headers, attempt + 1);
    }

    const text = await res.text();
    let env: Envelope;
    try {
      env = JSON.parse(text) as Envelope;
    } catch {
      throw new RenphoApiError(
        `Renpho ${path} returned HTTP ${res.status} with a non-JSON body: ${text.slice(0, 200)}`,
        undefined,
        res.status,
        path,
      );
    }
    if (typeof env.code !== "number") {
      throw new RenphoApiError(
        `Renpho ${path} returned HTTP ${res.status} without an envelope code: ${text.slice(0, 200)}`,
        undefined,
        res.status,
        path,
      );
    }
    return env;
  }

  /**
   * Authenticated call returning the *decrypted text* of `data`. `body: null`
   * sends the app's "empty" payload — an encrypted empty byte array by
   * default, or "{}" when `emptyAsObject` is set.
   */
  async callRaw(
    path: string,
    body: Record<string, unknown> | null,
    opts: { emptyAsObject?: boolean } = {},
    retriedAuth = false,
  ): Promise<string> {
    const session = await this.getSession();
    const encryptData =
      body === null
        ? opts.emptyAsObject
          ? renphoEncrypt("{}")
          : renphoEncryptEmpty()
        : renphoEncrypt(JSON.stringify(body));

    const env = await this.postEnvelope(path, encryptData, this.authHeaders(session));

    if (AUTH_FAILURE_CODES.has(env.code) && !retriedAuth) {
      // Token rejected: drop it, log in again, retry exactly once.
      this.session = undefined;
      await this.getSession(true);
      return this.callRaw(path, body, opts, true);
    }
    if (env.code !== 101) {
      throw new RenphoApiError(`Renpho ${path} failed: ${describeCode(env.code, env.msg)}`, env.code, undefined, path);
    }
    if (!env.data) return "null";
    return renphoDecrypt(env.data);
  }

  /** Authenticated call returning parsed JSON (big-int ids as strings). */
  async call<T = unknown>(
    path: string,
    body: Record<string, unknown> | null,
    opts: { emptyAsObject?: boolean } = {},
  ): Promise<T> {
    return parseRenphoJson<T>(await this.callRaw(path, body, opts));
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  /** device/count: which data tables exist and how many records each holds. */
  async getDeviceInfo(force = false): Promise<DeviceInfo> {
    if (!force && this.deviceInfoMemo && this.now() - this.deviceInfoMemo.at < DEVICE_INFO_MEMO_MS) {
      return this.deviceInfoMemo.info;
    }
    // The app sends an encrypted empty byte array; some deployments only
    // accept an encrypted "{}" — try both before giving up.
    let raw: Record<string, unknown> | null;
    try {
      raw = await this.call<Record<string, unknown> | null>(ENDPOINTS.deviceCount, null);
    } catch (first) {
      try {
        raw = await this.call<Record<string, unknown> | null>(ENDPOINTS.deviceCount, null, { emptyAsObject: true });
      } catch {
        throw first;
      }
    }
    const info: DeviceInfo = {
      raw: raw ?? {},
      tables: parseScaleTables(raw ?? {}),
      categories: summarizeDeviceCategories(raw ?? {}),
    };
    this.deviceInfoMemo = { info, at: this.now() };
    return info;
  }

  /** Family-member profiles linked to the account. */
  async getFamilyMembers(): Promise<Record<string, unknown>[]> {
    const res = await this.call<unknown>(ENDPOINTS.familyMembers, null);
    if (Array.isArray(res)) return res as Record<string, unknown>[];
    if (res && typeof res === "object" && Array.isArray((res as { list?: unknown }).list)) {
      return (res as { list: Record<string, unknown>[] }).list;
    }
    return [];
  }

  /**
   * One page of a table from either store. Cached (sealed): legacy pages are
   * keyed by the device/count record count (a new weigh-in changes the key);
   * body-composition pages have no count, so they get a short TTL instead.
   */
  async fetchPage(
    table: ScaleTable,
    pageNum: number,
    pageSize = PAGE_SIZE,
    endpoint: MeasurementEndpoint = "legacy",
  ): Promise<RawMeasurement[]> {
    const key = this.key(
      "page",
      endpoint,
      table.table_name,
      table.user_ids.join(","),
      endpoint === "legacy" ? table.count : "-",
      pageSize,
      pageNum,
    );
    const cached = await this.cacheGet<RawMeasurement[]>(key);
    if (cached) return cached;

    const res = await this.call<unknown>(ENDPOINT_PATH[endpoint], {
      pageNum,
      pageSize,
      userIds: table.user_ids,
      tableName: table.table_name,
    });
    const rows: RawMeasurement[] = (
      Array.isArray(res)
        ? (res as RawMeasurement[])
        : res && typeof res === "object" && Array.isArray((res as { list?: unknown }).list)
          ? (res as { list: RawMeasurement[] }).list
          : []
    ).map((r) => ({ ...r, [ENDPOINT_TAG]: endpoint }));

    if (rows.length) {
      await this.cachePut(key, rows, endpoint === "legacy" ? PAGE_TTL_SECONDS : BODY_COMP_PAGE_TTL_SECONDS);
    }
    return rows;
  }

  /** Scan helpers shared by both stores. */
  private scanHelpers(opts: ScanOptions, pages: RawMeasurement[][], scan: TableScan) {
    const minTs = (rows: RawMeasurement[]) => (rows.length ? Math.min(...rows.map(tsOf)) : Infinity);
    const maxTs = (rows: RawMeasurement[]) => (rows.length ? Math.max(...rows.map(tsOf)) : -Infinity);
    const oldEnough = (rows: RawMeasurement[]) => opts.startSec !== undefined && rows.length > 0 && minTs(rows) < opts.startSec;
    const inRangeCount = () =>
      pages.flat().filter((r) => (opts.endSec === undefined || tsOf(r) < opts.endSec) && (opts.startSec === undefined || tsOf(r) >= opts.startSec)).length;
    const enough = () => opts.limit !== undefined && opts.startSec === undefined && inRangeCount() >= opts.limit;
    const budgetLeft = () => scan.pages_fetched < MAX_PAGES_PER_TABLE;
    return { minTs, maxTs, oldEnough, enough, budgetLeft };
  }

  /**
   * Pull the pages of one table's *legacy* store needed to cover a time
   * window (or a record count), regardless of which way the API orders its
   * pages. Strategy: fetch the last page and the one before it, compare their
   * newest timestamps to learn the direction, then keep walking toward older
   * records until a page dips below `startSec` (or `limit` is met).
   */
  async scanTable(table: ScaleTable, opts: ScanOptions): Promise<{ records: RawMeasurement[]; scan: TableScan }> {
    const pageSize = PAGE_SIZE;
    const pages: RawMeasurement[][] = [];
    const scan: TableScan = { table_name: table.table_name, endpoint: "legacy", count: table.count, pages_fetched: 0, records: 0, order: "empty", truncated: false };

    if (table.count <= 0) return { records: [], scan };

    const fetchTracked = async (p: number) => {
      const rows = await this.fetchPage(table, p, pageSize, "legacy");
      scan.pages_fetched++;
      pages.push(rows);
      scan.records += rows.length;
      return rows;
    };
    const { maxTs, oldEnough, enough, budgetLeft } = this.scanHelpers(opts, pages, scan);

    const totalPages = Math.max(1, Math.ceil(table.count / pageSize));
    const lastRows = await fetchTracked(totalPages);

    if (totalPages === 1) {
      scan.order = lastRows.length ? "single" : "empty";
    } else {
      const prevRows = await fetchTracked(totalPages - 1);
      const asc = maxTs(lastRows) >= maxTs(prevRows);
      scan.order = asc ? "asc" : "desc";

      if (asc) {
        // Newest records are on the highest page. Walk downward.
        let stop = oldEnough(prevRows) || oldEnough(lastRows) || enough();
        for (let p = totalPages - 2; !stop && p >= 1; p--) {
          if (!budgetLeft()) {
            scan.truncated = true;
            break;
          }
          const rows = await fetchTracked(p);
          if (!rows.length) break;
          stop = oldEnough(rows) || enough();
        }
      } else {
        // Page 1 is newest; the two pages already fetched are the oldest.
        let stop = false;
        for (let p = 1; !stop && p <= totalPages - 2; p++) {
          if (!budgetLeft()) {
            scan.truncated = true;
            break;
          }
          const rows = await fetchTracked(p);
          if (!rows.length) break;
          stop = oldEnough(rows) || enough();
        }
      }
    }

    // `count` can lag behind the table (records synced since device/count ran):
    // when the newest page is full in ascending order, probe forward.
    if (scan.order !== "desc" && lastRows.length >= pageSize) {
      let p = totalPages;
      let rows = lastRows;
      while (rows.length >= pageSize && budgetLeft()) {
        rows = await fetchTracked(++p);
        if (!rows.length) break;
      }
    }

    return { records: pages.flat(), scan };
  }

  /**
   * Pull one table's *body-composition* store. There is no record count for
   * it, so we page forward from 1: if page 1 is newest-first we can stop as
   * soon as a page dips below `startSec`; if it is oldest-first we must walk
   * to the last (short) page to reach the newest rows. Errors are captured on
   * the scan rather than thrown, so an account whose backend lacks this store
   * still gets its legacy rows.
   */
  async scanBodyCompositionTable(table: ScaleTable, opts: ScanOptions): Promise<{ records: RawMeasurement[]; scan: TableScan }> {
    const pageSize = PAGE_SIZE;
    const pages: RawMeasurement[][] = [];
    const scan: TableScan = { table_name: table.table_name, endpoint: "bodyComposition", pages_fetched: 0, records: 0, order: "empty", truncated: false };

    const fetchTracked = async (p: number) => {
      const rows = await this.fetchPage(table, p, pageSize, "bodyComposition");
      scan.pages_fetched++;
      pages.push(rows);
      scan.records += rows.length;
      return rows;
    };
    const { maxTs, oldEnough, enough, budgetLeft } = this.scanHelpers(opts, pages, scan);

    try {
      const first = await fetchTracked(1);
      if (!first.length) return { records: [], scan };
      if (first.length < pageSize) {
        scan.order = "single";
        return { records: first, scan };
      }

      const second = await fetchTracked(2);
      if (!second.length) {
        scan.order = "single";
        return { records: first, scan };
      }
      const newestFirst = maxTs(first) >= maxTs(second);
      scan.order = newestFirst ? "desc" : "asc";

      let rows = second;
      let stop = newestFirst && (oldEnough(first) || oldEnough(second) || enough());
      for (let p = 3; !stop && rows.length >= pageSize; p++) {
        if (!budgetLeft()) {
          scan.truncated = true;
          break;
        }
        rows = await fetchTracked(p);
        if (newestFirst) stop = oldEnough(rows) || enough();
      }
    } catch (err) {
      scan.error = err instanceof Error ? err.message : String(err);
    }

    return { records: pages.flat(), scan };
  }

  /**
   * Scan every (or the given) scale table across BOTH stores and merge,
   * deduped by id (a row present in both keeps the body-composition copy,
   * which carries the richer field set), newest first.
   */
  async scanMeasurements(opts: ScanOptions = {}): Promise<ScanResult> {
    const tables = opts.tables ?? (await this.getDeviceInfo()).tables;
    const [legacy, body] = await Promise.all([
      Promise.all(tables.map((t) => this.scanTable(t, opts))),
      Promise.all(tables.map((t) => this.scanBodyCompositionTable(t, opts))),
    ]);
    const byId = new Map<string, RawMeasurement>();
    for (const r of [...body, ...legacy].flatMap((x) => x.records)) {
      const id = idOf(r);
      const existing = byId.get(id);
      if (!existing || (r[ENDPOINT_TAG] === "bodyComposition" && existing[ENDPOINT_TAG] !== "bodyComposition")) {
        byId.set(id, r);
      }
    }
    const records = Array.from(byId.values()).sort((a, b) => tsOf(b) - tsOf(a));
    return { records, tables: [...legacy.map((x) => x.scan), ...body.map((x) => x.scan)] };
  }

  /**
   * Measurements for the signed-in user (or a chosen scale-user/profile).
   * Selection rules, in order:
   *   1. `scaleUserId` given → records whose `subUserId` matches.
   *   2. records bound to this account (`bUserId` == account id, or the
   *      account id used directly as the scale user).
   *   3. Nothing bound yet (Wi-Fi scales upload before the app binds) → the
   *      first scale-user id the account owns.
   */
  async getMeasurements(query: MeasurementQuery = {}): Promise<MeasurementResult> {
    const session = await this.getSession();
    const info = await this.getDeviceInfo();
    let tables = info.tables;
    if (query.scaleUserId) {
      const matching = tables.filter((t) => t.user_ids.includes(query.scaleUserId!));
      if (matching.length) tables = matching;
    }

    const scan = await this.scanMeasurements({ ...query, tables });
    const inRange = scan.records.filter(
      (r) => (query.startSec === undefined || tsOf(r) >= query.startSec) && (query.endSec === undefined || tsOf(r) < query.endSec),
    );

    let selected: RawMeasurement[];
    let selection: Selection;
    if (query.includeAllUsers) {
      selected = inRange;
      selection = "all";
    } else if (query.scaleUserId) {
      selected = inRange.filter((r) => String(r.subUserId ?? "") === query.scaleUserId);
      selection = "scale_user";
    } else {
      const bound = inRange.filter((r) => String(r.bUserId ?? "") === session.userId || String(r.subUserId ?? "") === session.userId);
      if (bound.length) {
        selected = bound;
        selection = "bound";
      } else {
        const scaleUserIds = Array.from(new Set(info.tables.flatMap((t) => t.user_ids)));
        selected = scaleUserIds.length ? inRange.filter((r) => String(r.subUserId ?? "") === scaleUserIds[0]) : [];
        selection = selected.length ? "fallback_scale_user" : "none";
      }
    }

    if (query.take !== undefined) selected = selected.slice(0, query.take);

    return {
      records: selected,
      selection,
      hidden: inRange.length - selected.length,
      scanned: scan.records.length,
      tables: scan.tables,
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function describeCode(code: number, msg?: string): string {
  const known = STATUS_MESSAGES[code];
  const parts = [`code ${code}`];
  if (known && known !== "success") parts.push(known);
  if (msg && msg !== known) parts.push(`msg="${msg}"`);
  return parts.join(", ");
}

/** Renpho timestamps are usually unix ms; tolerate seconds and strings. */
function toMillis(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

function backoffMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const secs = parseInt(retryAfter, 10);
    if (!Number.isNaN(secs)) return Math.min(secs * 1000, 10_000);
  }
  return Math.min(2 ** attempt * 400 + Math.random() * 200, 5_000);
}
