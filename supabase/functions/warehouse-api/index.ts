import { createClient } from "npm:@supabase/supabase-js@2";
import * as xlsx from "npm:xlsx";

const FUNCTION_PREFIXES = [
  "/functions/v1/warehouse-api",
  "/warehouse-api",
];

type AuthContext = {
  userId: string;
  email: string;
  name: string;
};

// ---- 권한: 직원(staff) < 매니저(manager) < 관리자(admin) ----
type Role = "staff" | "manager" | "admin";
type RoleInfo = { role: Role; bootstrap: boolean };
const ROLE_RANK: Record<Role, number> = { staff: 1, manager: 2, admin: 3 };
const ROLE_LABELS: Record<Role, string> = { staff: "직원", manager: "매니저", admin: "관리자" };
// 여기에 없는 경로는 로그인한 누구나 쓸 수 있다(조회, 상품 수정, 요청 보내기, 이형포장 등).
const ROUTE_MIN_ROLE: Record<string, Role> = {
  "POST /stock_checks/record": "manager",
  "POST /stock_checks/resolve": "manager",
  "POST /display_requests/status": "manager",
  "POST /soldout_items/add": "manager",
  "POST /inbound": "admin",
  "POST /outbound": "admin",
  "POST /move": "admin",
  "POST /set_location": "admin",
  "POST /new_inbound_list/import": "admin",
  "POST /new_inbound_list/process": "admin",
  "POST /stock_status": "admin",
  "POST /soldout_items/remove": "admin",
  "GET /users": "admin",
  "POST /users/role": "admin",
};
const USERS_PER_PAGE = 200;
const USERS_MAX_PAGES = 10;

function asRole(value: unknown): Role {
  return value === "admin" || value === "manager" ? value : "staff";
}

function corsHeaders(req: Request) {
  const allowedOrigin = Deno.env.get("ALLOWED_ORIGIN") || "*";
  const requestOrigin = req.headers.get("origin");
  const origin = allowedOrigin === "*" ? "*" : requestOrigin === allowedOrigin ? allowedOrigin : allowedOrigin;

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(req),
  });
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return "Unknown error";
  }
}

function getPath(url: URL) {
  const prefix = FUNCTION_PREFIXES.find((value) => url.pathname.startsWith(value));
  const raw = prefix ? url.pathname.slice(prefix.length) : url.pathname;
  return raw || "/";
}

function getPositiveInt(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

// 날짜 파라미터: 비어 있으면 null(SQL에서 KST 오늘), 형식이 틀리면 400.
function getDateParam(value: unknown, label = "날짜"): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`${label} 형식이 올바르지 않습니다. (YYYY-MM-DD)`);
  }
  return text;
}

function getUuidParam(value: unknown, label: string, required = true): string | null {
  const text = String(value ?? "").trim();
  if (!text) {
    if (required) throw new Error(`${label}이(가) 지정되지 않았습니다.`);
    return null;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
    throw new Error(`${label} 형식이 올바르지 않습니다.`);
  }
  return text;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  let payload: unknown = null;
  try {
    payload = await req.json();
  } catch (_) {
    throw new Error("요청 본문 형식이 올바르지 않습니다.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("요청 본문 형식이 올바르지 않습니다.");
  }
  return payload as Record<string, unknown>;
}

// 새 경로용 RPC 호출: 오류를 {detail:"<메시지>"} 로 그대로 내려주기 위해 Error로 바꿔 던진다.
async function callRpc(name: string, args: Record<string, unknown> = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message || "요청을 처리하지 못했습니다.");
  return data;
}

const roleCache = new WeakMap<AuthContext, Promise<RoleInfo>>();

// 요청 하나에서 권한은 한 번만 조회한다.
function getRoleInfo(auth: AuthContext): Promise<RoleInfo> {
  let pending = roleCache.get(auth);
  if (!pending) {
    pending = callRpc("warehouse_get_user_role", { p_user_id: auth.userId }).then((data) => {
      const row = data && typeof data === "object" ? data as Record<string, unknown> : {};
      return { role: asRole(row.role), bootstrap: row.bootstrap === true };
    });
    roleCache.set(auth, pending);
  }
  return pending;
}

// 화면은 401/403 을 '로그인 만료'로 처리하므로 권한 부족은 일반 오류(400)로 알린다.
async function requireRole(auth: AuthContext, min: Role) {
  const info = await getRoleInfo(auth);
  if (ROLE_RANK[info.role] < ROLE_RANK[min]) {
    throw new Error(`이 작업은 ${ROLE_LABELS[min]} 권한이 필요합니다.`);
  }
}

function userDisplayName(user: { email?: string; user_metadata?: unknown }): string {
  const metadata = user.user_metadata && typeof user.user_metadata === "object"
    ? user.user_metadata as Record<string, unknown>
    : {};
  for (const key of ["display_name", "name"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return user.email || "";
}

// 계정 목록(auth.users)과 권한 표를 합친다.
async function listUsersWithRoles(auth: AuthContext) {
  const users = [];
  for (let page = 1; page <= USERS_MAX_PAGES; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: USERS_PER_PAGE });
    if (error) throw new Error("계정 목록을 불러오지 못했습니다.");
    users.push(...data.users);
    if (data.users.length < USERS_PER_PAGE) break;
  }

  const listed = await callRpc("warehouse_list_user_roles") as Record<string, unknown> | null;
  const roles = new Map<string, Record<string, unknown>>();
  for (const row of (Array.isArray(listed?.roles) ? listed.roles : [])) {
    if (row && typeof row === "object") roles.set(String((row as Record<string, unknown>).user_id), row as Record<string, unknown>);
  }

  return {
    me: auth.userId,
    bootstrap: listed?.has_admin !== true,
    users: users.map((user) => {
      const row = roles.get(user.id);
      return {
        id: user.id,
        email: user.email || "",
        name: userDisplayName(user),
        role: asRole(row?.role),
        role_assigned: Boolean(row),
        role_updated_at: row?.updated_at ?? null,
        role_updated_by: row?.updated_by_name ?? "",
        created_at: user.created_at ?? null,
        last_sign_in_at: user.last_sign_in_at ?? null,
      };
    }),
  };
}

// ---- 사진 검색(/scan_code): 라벨 사진에서 코드 글자를 읽어 DB와 대조한다 ----
const SCAN_MODEL = "claude-haiku-4-5-20251001";
const SCAN_TIMEOUT_MS = 15000;
const SCAN_MAX_BASE64_CHARS = 2_800_000; // 원본 약 2MB
const SCAN_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"];
const SCAN_MAX_CODES = 8;
const SCAN_PROMPT = [
  "이 사진은 창고의 상품 라벨 또는 선반(랙) 라벨입니다.",
  "라벨이 거꾸로(180도) 찍혔거나 옆으로 누웠거나 비스듬히 기울어져 있을 수 있습니다.",
  "먼저 글자가 어느 방향으로 놓였는지 판단하고, 머릿속으로 바로 세운 뒤에 읽어 주세요.",
  "사진에 인쇄된 글자 중 '코드'로 보이는 것만 골라 주세요. 형식 예시는 다음과 같습니다.",
  "- 랙 코드: SR1-05-02, SR2-A-03",
  "- 로케이션 코드: D-02-02-01 (영문·숫자가 하이픈으로 이어진 형태)",
  "- SKU 코드: 영문 1자 + 숫자 8자 (예: A00100301)",
  "상품명, 가격, 날짜, 전화번호, 수량 같은 글자는 넣지 마세요.",
  "뒤집히면 서로 바뀌어 보이는 글자(6과 9, 2와 5 등)나 비슷한 글자(0과 O, 1과 I, 8과 B)가 확실하지 않으면 가능한 읽기를 둘 다 넣으세요.",
  `보이는 그대로 대문자로 옮기고, 가장 또렷하고 크게 보이는 것부터 최대 ${SCAN_MAX_CODES}개까지만 넣으세요.`,
  "설명 없이 아래 형식의 JSON 객체 하나만 출력하세요.",
  '{"rotate": 0, "codes": ["A00100301", "D-02-02-01"]}',
  "rotate 는 글자가 바로 서려면 사진을 시계 방향으로 몇 도 돌려야 하는지입니다. 0, 90, 180, 270 중 하나만 쓰세요(이미 바로 서 있으면 0).",
  '코드가 없으면 codes 를 [] 로 두세요.',
].join("\n");

type ScanReading = { codes: string[]; rotate: number };

function cleanScanCodes(values: unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const code = String(value ?? "").replace(/\s+/g, "").toUpperCase();
    // 코드에 쓰이는 글자만 허용(검색어로 그대로 쓰이므로 엄격하게 거른다)
    if (!/^[A-Z0-9][A-Z0-9\-_.]{2,39}$/.test(code)) continue;
    if (!out.includes(code)) out.push(code);
    if (out.length >= SCAN_MAX_CODES) break;
  }
  return out;
}

function tryParseJson(text: string, open: string, close: string): unknown {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    return undefined;
  }
}

// 응답은 {"rotate":0,"codes":[…]} 객체. 배열만 온 경우도 받아 준다.
function parseScanReading(text: string): ScanReading {
  const obj = tryParseJson(text, "{", "}");
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const record = obj as Record<string, unknown>;
    const rotate = Number(record.rotate);
    return {
      codes: cleanScanCodes(Array.isArray(record.codes) ? record.codes : []),
      rotate: [90, 180, 270].includes(rotate) ? rotate : 0,
    };
  }
  const list = tryParseJson(text, "[", "]");
  return { codes: cleanScanCodes(Array.isArray(list) ? list : []), rotate: 0 };
}

async function readCodesFromImage(imageBase64: string, mediaType: string): Promise<ScanReading> {
  const apiKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  if (!apiKey) throw new Error("사진 검색이 아직 설정되지 않았습니다.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: SCAN_MODEL,
        max_tokens: 300,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
            { type: "text", text: SCAN_PROMPT },
          ],
        }],
      }),
    });
  } catch (_) {
    throw new Error("사진을 읽는 데 시간이 너무 오래 걸립니다. 다시 시도해 주세요.");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // 키·본문은 남기지 않고 상태만 기록한다.
    console.error("scan_code: vision request failed", response.status);
    throw new Error("사진을 읽지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }

  const data = await response.json().catch(() => null);
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks
    .filter((block: { type?: string }) => block?.type === "text")
    .map((block: { text?: string }) => String(block?.text ?? ""))
    .join("\n");
  return parseScanReading(text);
}

type ScanMatch = { code: string; name: string; location_code: string };
type ScanCandidate = { text: string; kind: "item" | "rack"; matches: ScanMatch[] };

function isRackCodeText(text: string) {
  return /^SR\d+-[A-Z0-9]+-[A-Z0-9]+$/.test(text);
}

async function matchScanCode(text: string): Promise<ScanCandidate | null> {
  if (isRackCodeText(text)) {
    // 랙 코드는 형식이 맞으면 후보로 인정한다(빈 랙도 창고맵에서 찾을 수 있어야 한다).
    const data = await callRpc("warehouse_search_racks", { p_q: text, p_limit: 5 });
    const rows = Array.isArray(data?.results) ? data.results : [];
    return {
      text,
      kind: "rack",
      matches: rows.map((row: Record<string, unknown>) => ({
        code: String(row.sku ?? ""),
        name: String(row.name ?? ""),
        location_code: String(row.rack_code ?? ""),
      })),
    };
  }

  const data = await callRpc("warehouse_search_items", { p_q: text, p_limit: 20 });
  const rows = Array.isArray(data?.items) ? data.items : [];
  // 검색 함수는 상품명도 보므로, 코드나 로케이션에 그 글자가 들어 있는 상품만 남긴다.
  const matches: ScanMatch[] = rows
    .filter((row: Record<string, unknown>) =>
      String(row.code ?? "").toUpperCase().includes(text) ||
      String(row.location ?? "").toUpperCase().includes(text)
    )
    .slice(0, 5)
    .map((row: Record<string, unknown>) => ({
      code: String(row.code ?? ""),
      name: String(row.name ?? ""),
      location_code: String(row.location ?? ""),
    }));
  return matches.length ? { text, kind: "item", matches } : null;
}

// 헷갈리기 쉬운 글자를 바꿔 본 형태들. 첫 글자(SKU의 영문)는 그대로 둔다.
//   숫자로: O→0, I·L→1, B→8, S→5, Z→2, G→6
//   뒤집힘: 6↔9 (거꾸로 찍힌 라벨에서 서로 바뀌어 읽힌다)
function scanLookalikes(text: string): string[] {
  const head = text.slice(0, 1);
  const tail = text.slice(1);
  const toDigits = (value: string) =>
    value.replace(/O/g, "0").replace(/[IL]/g, "1").replace(/B/g, "8").replace(/S/g, "5").replace(/Z/g, "2").replace(/G/g, "6");
  const swap69 = (value: string) => value.replace(/[69]/g, (ch) => (ch === "6" ? "9" : "6"));
  const digits = head + toDigits(tail);
  const out: string[] = [];
  for (const variant of [digits, head + swap69(tail), head + swap69(toDigits(tail))]) {
    if (variant !== text && !out.includes(variant)) out.push(variant);
  }
  return out;
}

async function matchScanCodes(codes: string[]): Promise<ScanCandidate[]> {
  const found: ScanCandidate[] = [];
  const push = (candidate: ScanCandidate | null) => {
    if (candidate && !found.some((item) => item.text === candidate.text)) found.push(candidate);
  };
  for (const code of codes) push(await matchScanCode(code));
  if (!found.length) {
    for (const code of codes) {
      // 랙 코드는 형식만 맞으면 통과하므로 바꿔 보지 않는다.
      if (isRackCodeText(code)) continue;
      for (const alt of scanLookalikes(code)) {
        if (isRackCodeText(alt)) continue;
        push(await matchScanCode(alt));
      }
    }
  }
  return found;
}

function normalizeHeader(value: unknown) {
  return String(value ?? "").replace(/\s+/g, "").trim().toLowerCase();
}

function findInboundHeaderIndex(headerRow: unknown[], candidates: string[], excludes: string[] = []) {
  const normalized = Array.from(headerRow || [], (value) => normalizeHeader(value));
  const deny = excludes.map((value) => normalizeHeader(value));

  for (const candidate of candidates.map((value) => normalizeHeader(value))) {
    const exactIndex = normalized.findIndex((value) => value === candidate);
    if (exactIndex >= 0) return exactIndex;
  }

  for (const candidate of candidates.map((value) => normalizeHeader(value))) {
    const fuzzyIndex = normalized.findIndex((value) => {
      const safeValue = String(value || "");
      return safeValue.includes(candidate) && !deny.some((blocked) => blocked && safeValue.includes(blocked));
    });
    if (fuzzyIndex >= 0) return fuzzyIndex;
  }

  return -1;
}

function toInt(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  const parsed = Number.parseFloat(String(value ?? "").replace(/,/g, "").trim());
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed);
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function chunk<T>(values: T[], size: number) {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

type ParsedInboundItem = {
  id: string;
  sku_code: string;
  product_name: string;
  box_qty: number;
  inbound_qty: number;
  pending_qty: number;
};

async function lookupSkuCodesByName(names: string[]) {
  const mapping = new Map<string, string>();
  const targets = unique(
    names
      .map((value) => value.trim())
      .filter(Boolean),
  );

  for (const group of chunk(targets, 200)) {
    const { data, error } = await supabase.rpc("warehouse_lookup_item_codes_by_names", {
      p_names: group,
    });
    if (error) throw error;

    for (const row of data || []) {
      const name = String(row.name || "").trim();
      const code = String(row.code || "").trim();
      if (name && code && !mapping.has(name)) {
        mapping.set(name, code);
      }
    }
  }

  return mapping;
}

async function parseNewInboundWorkbook(contentBase64: string): Promise<ParsedInboundItem[]> {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(contentBase64), (char) => char.charCodeAt(0));
  } catch (_) {
    throw new Error("엑셀 파일 디코딩에 실패했습니다.");
  }

  const workbook = xlsx.read(bytes, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("엑셀 시트를 찾을 수 없습니다.");
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rows = xlsx.utils.sheet_to_json<(string | number | null)[]>(sheet, {
    header: 1,
    raw: false,
    blankrows: false,
  });

  const headerRow = rows[1] || [];
  const productIndex = findInboundHeaderIndex(headerRow, ["품명"], ["영어품명"]);
  const inboundIndex = findInboundHeaderIndex(headerRow, ["상세수량"]);
  const boxIndex = findInboundHeaderIndex(headerRow, ["박스수"]);

  if (productIndex < 0 || inboundIndex < 0 || boxIndex < 0) {
    throw new Error("엑셀 2행에서 품명, 상세수량, 박스수 컬럼을 찾을 수 없습니다.");
  }

  const parsed = rows
    .slice(2)
    .map((row) => {
      const productName = String(row?.[productIndex] ?? "").trim();
      if (!productName) return null;
      const boxQty = toInt(row?.[boxIndex]);
      const inboundQty = toInt(row?.[inboundIndex]);
      return {
        id: crypto.randomUUID(),
        sku_code: "",
        product_name: productName,
        box_qty: boxQty,
        inbound_qty: inboundQty,
        pending_qty: inboundQty,
      } satisfies ParsedInboundItem;
    })
    .filter((row): row is ParsedInboundItem => Boolean(row));

  const skuMap = await lookupSkuCodesByName(parsed.map((row) => row.product_name));
  for (const row of parsed) {
    row.sku_code = skuMap.get(row.product_name) || "";
  }

  return parsed;
}

async function normalizeNewInboundRows(rows: unknown[]): Promise<ParsedInboundItem[]> {
  const parsed = (rows || [])
    .map((row) => {
      const source = row && typeof row === "object" ? row as Record<string, unknown> : {};
      const productName = String(source.product_name ?? "").trim();
      if (!productName) return null;
      const inboundQty = toInt(source.inbound_qty);
      const pendingQty = source.pending_qty == null ? inboundQty : toInt(source.pending_qty);
      return {
        id: String(source.id ?? crypto.randomUUID()),
        sku_code: String(source.sku_code ?? "").trim(),
        product_name: productName,
        box_qty: toInt(source.box_qty),
        inbound_qty: inboundQty,
        pending_qty: pendingQty,
      } satisfies ParsedInboundItem;
    })
    .filter((row): row is ParsedInboundItem => Boolean(row));

  const needLookup = parsed.filter((row) => !row.sku_code).map((row) => row.product_name);
  const skuMap = needLookup.length ? await lookupSkuCodesByName(needLookup) : new Map<string, string>();
  for (const row of parsed) {
    if (!row.sku_code) {
      row.sku_code = skuMap.get(row.product_name) || "";
    }
  }

  return parsed;
}

async function getAuthContext(req: Request): Promise<AuthContext> {
  const header = req.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new Error("Authentication is required");
  }

  const token = match[1];
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    throw new Error("Invalid or expired session");
  }

  const user = data.user;
  const metadata = user.user_metadata && typeof user.user_metadata === "object"
    ? user.user_metadata as Record<string, unknown>
    : {};
  const name = typeof metadata.display_name === "string" && metadata.display_name.trim()
    ? metadata.display_name.trim()
    : typeof metadata.name === "string" && metadata.name.trim()
    ? metadata.name.trim()
    : user.email || "";

  if (!user.id) {
    throw new Error("Invalid authenticated user");
  }

  return { userId: user.id, email: user.email || "", name };
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  // 새 secret key(sb_secret_...)를 우선 쓰고, 없으면 기존 service_role 키로 넘어간다.
  // legacy 키를 비활성화해도 서버가 멈추지 않게 하기 위한 것.
  Deno.env.get("WAREHOUSE_SERVICE_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    "",
  {
    auth: { persistSession: false, autoRefreshToken: false },
  },
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }

  try {
    const url = new URL(req.url);
    const path = getPath(url);
    const auth = await getAuthContext(req);

    const minRole = ROUTE_MIN_ROLE[`${req.method} ${path}`];
    if (minRole) await requireRole(auth, minRole);

    if (req.method === "GET" && path === "/users") {
      return json(req, await listUsersWithRoles(auth));
    }

    if (req.method === "POST" && path === "/users/role") {
      const body = await readBody(req);
      const userId = getUuidParam(body.user_id, "계정");
      const { data, error } = await supabase.auth.admin.getUserById(userId as string);
      if (error || !data?.user) throw new Error("계정을 찾을 수 없습니다.");
      return json(
        req,
        await callRpc("warehouse_set_user_role", {
          p_user_id: userId,
          p_role: String(body.role ?? "").trim(),
          p_email: data.user.email || "",
          p_display_name: userDisplayName(data.user),
          p_actor_user_id: auth.userId,
          p_actor_email: auth.email,
          p_actor_name: auth.name,
        }),
      );
    }

    if (req.method === "GET" && path === "/") {
      return json(req, { ok: true, service: "warehouse-api", user: auth });
    }

    if (req.method === "GET" && path === "/config") {
      const { data, error } = await supabase.rpc("warehouse_get_config");
      if (error) throw error;
      return json(req, data);
    }

    if (req.method === "GET" && path === "/cells") {
      const row = url.searchParams.get("row") || "SR1";
      const { data, error } = await supabase.rpc("warehouse_get_cells", { p_row: row });
      if (error) throw error;
      return json(req, data);
    }

    if (req.method === "GET" && path === "/items") {
      const { data, error } = await supabase.rpc("warehouse_get_items", {
        p_q: url.searchParams.get("q") || "",
        p_limit: getPositiveInt(url.searchParams.get("limit"), 500),
      });
      if (error) throw error;
      return json(req, data);
    }

    if (req.method === "GET" && path === "/items_with_stock") {
      const { data, error } = await supabase.rpc("warehouse_get_items_with_stock", {
        p_q: url.searchParams.get("q") || "",
        p_limit: getPositiveInt(url.searchParams.get("limit"), 300),
      });
      if (error) throw error;
      return json(req, data);
    }

    if (req.method === "GET" && path === "/search_racks") {
      const { data, error } = await supabase.rpc("warehouse_search_racks", {
        p_q: url.searchParams.get("q") || "",
        p_limit: getPositiveInt(url.searchParams.get("limit"), 500),
      });
      if (error) throw error;
      return json(req, data);
    }

    if (req.method === "GET" && path === "/new_inbound_list") {
      const date = (url.searchParams.get("date") || "").trim();
      if (!date) throw new Error("date is required");
      const { data, error } = await supabase.rpc("warehouse_get_new_inbound_list", {
        p_date: date,
      });
      if (error) throw error;
      return json(req, data);
    }

    if (req.method === "POST" && path === "/new_inbound_list/import") {
      const payload = await req.json();
      const date = String(payload.date || "").trim();
      if (!date) throw new Error("date is required");
      const items = Array.isArray(payload.rows)
        ? await normalizeNewInboundRows(payload.rows)
        : await parseNewInboundWorkbook(String(payload.content_base64 || ""));
      const { data, error } = await supabase.rpc("warehouse_replace_new_inbound_list", {
        p_date: date,
        p_source_name: String(payload.filename || ""),
        p_items: items,
      });
      if (error) throw error;
      return json(req, data);
    }

    if (req.method === "POST" && path === "/new_inbound_list/process") {
      const payload = await req.json();
      const { data, error } = await supabase.rpc("warehouse_process_new_inbound_item", {
        p_date: payload.date,
        p_entry_id: payload.entry_id,
        p_action: payload.action,
        p_qty: payload.qty,
        p_rack_code: payload.rack_code || null,
        p_actor_user_id: auth.userId,
        p_actor_email: auth.email,
        p_actor_name: auth.name,
      });
      if (error) throw error;
      return json(req, data);
    }

    if (req.method === "GET" && path === "/movements") {
      const mineOnly = url.searchParams.get("mine") === "1";
      const { data, error } = await supabase.rpc("warehouse_get_movements", {
        p_limit: getPositiveInt(url.searchParams.get("limit"), 200),
        p_actor_user_id: mineOnly ? auth.userId : null,
        p_rack_code: url.searchParams.get("rack_code"),
      });
      if (error) throw error;
      return json(req, data);
    }

    if (req.method === "POST" && path === "/inbound") {
      const payload = await req.json();
      const { data, error } = await supabase.rpc("warehouse_post_inbound", {
        p_rack_code: payload.rack_code,
        p_item_code: payload.item_code,
        p_qty: payload.qty,
        p_actor_user_id: auth.userId,
        p_actor_email: auth.email,
        p_actor_name: auth.name,
        p_note: "",
        p_payload: {},
      });
      if (error) throw error;
      return json(req, data);
    }

    if (req.method === "POST" && path === "/outbound") {
      const payload = await req.json();
      const { data, error } = await supabase.rpc("warehouse_post_outbound", {
        p_rack_code: payload.rack_code,
        p_item_code: payload.item_code,
        p_qty: payload.qty,
        p_actor_user_id: auth.userId,
        p_actor_email: auth.email,
        p_actor_name: auth.name,
      });
      if (error) throw error;
      return json(req, data);
    }

    if (req.method === "POST" && path === "/move") {
      const payload = await req.json();
      const { data, error } = await supabase.rpc("warehouse_post_move", {
        p_from_rack: payload.from_rack,
        p_to_rack: payload.to_rack,
        p_item_code: payload.item_code,
        p_qty: payload.qty,
        p_actor_user_id: auth.userId,
        p_actor_email: auth.email,
        p_actor_name: auth.name,
      });
      if (error) throw error;
      return json(req, data);
    }

    if (req.method === "POST" && path === "/set_location") {
      const payload = await req.json();
      const { data, error } = await supabase.rpc("warehouse_post_set_location", {
        p_item_code: payload.item_code,
        p_location: payload.location,
        p_actor_user_id: auth.userId,
        p_actor_email: auth.email,
        p_actor_name: auth.name,
      });
      if (error) throw error;
      return json(req, data);
    }

    // ---- 상품조회 ----
    if (req.method === "GET" && path === "/item_options") {
      return json(req, await callRpc("warehouse_get_item_options"));
    }

    if (req.method === "POST" && path === "/scan_code") {
      const payload = await readBody(req);
      const mediaType = String(payload.media_type ?? "").trim().toLowerCase();
      const imageBase64 = String(payload.image_base64 ?? "").replace(/^data:[^,]*,/, "").trim();
      if (!SCAN_MEDIA_TYPES.includes(mediaType)) {
        throw new Error("지원하지 않는 사진 형식입니다. (JPEG, PNG, WebP)");
      }
      if (!imageBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) {
        throw new Error("사진 데이터가 올바르지 않습니다.");
      }
      if (imageBase64.length > SCAN_MAX_BASE64_CHARS) {
        throw new Error("사진이 너무 큽니다. 다시 찍어 주세요.");
      }
      const reading = await readCodesFromImage(imageBase64, mediaType);
      // rotate: 글자가 바로 서려면 시계 방향으로 돌려야 하는 각도. 화면이 못 찾았을 때 돌려서 다시 보낸다.
      return json(req, {
        candidates: await matchScanCodes(reading.codes),
        raw: reading.codes,
        rotate: reading.rotate,
      });
    }

    if (req.method === "GET" && path === "/items_search") {
      return json(
        req,
        await callRpc("warehouse_search_items", {
          p_q: url.searchParams.get("q") || "",
          p_limit: getPositiveInt(url.searchParams.get("limit"), 100),
        }),
      );
    }

    if (req.method === "GET" && path === "/item") {
      return json(
        req,
        await callRpc("warehouse_get_item", {
          p_code: (url.searchParams.get("code") || "").trim(),
        }),
      );
    }

    if (req.method === "POST" && path === "/item/update") {
      const payload = await readBody(req);
      const patch = payload.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new Error("수정 내용 형식이 올바르지 않습니다.");
      }
      return json(
        req,
        await callRpc("warehouse_update_item", {
          p_item_code: String(payload.item_code ?? "").trim(),
          p_patch: patch,
          p_actor_user_id: auth.userId,
          p_actor_email: auth.email,
          p_actor_name: auth.name,
        }),
      );
    }

    if (req.method === "POST" && path === "/stock_status") {
      const payload = await readBody(req);
      return json(
        req,
        await callRpc("warehouse_post_stock_status", {
          p_item_code: String(payload.item_code ?? "").trim(),
          p_value: String(payload.value ?? "").trim(),
          p_soldout_id: getUuidParam(payload.soldout_id, "품절관리 항목", false),
          p_actor_user_id: auth.userId,
          p_actor_email: auth.email,
          p_actor_name: auth.name,
        }),
      );
    }

    // ---- 재고확인 ----
    if (req.method === "GET" && path === "/stock_checks") {
      const openMismatch = url.searchParams.get("open_mismatch") === "1";
      return json(
        req,
        await callRpc("warehouse_get_stock_check_list", {
          p_date: openMismatch ? null : getDateParam(url.searchParams.get("date")),
          p_only_open_mismatch: openMismatch,
        }),
      );
    }

    if (req.method === "POST" && path === "/stock_checks/request") {
      const payload = await readBody(req);
      return json(
        req,
        await callRpc("warehouse_request_stock_check", {
          p_item_code: String(payload.item_code ?? "").trim(),
          p_source: String(payload.source ?? "").trim(),
          p_note: String(payload.note ?? ""),
          p_date: getDateParam(payload.date),
          p_actor_user_id: auth.userId,
          p_actor_email: auth.email,
          p_actor_name: auth.name,
        }),
      );
    }

    if (req.method === "POST" && path === "/stock_checks/record") {
      const payload = await readBody(req);
      let countedQty: number | null = null;
      if (payload.counted_qty != null && String(payload.counted_qty).trim() !== "") {
        countedQty = Number(payload.counted_qty);
        if (!Number.isInteger(countedQty) || countedQty < 0 || countedQty > 2000000000) {
          throw new Error("실제 수량은 0 이상의 정수로 입력하세요.");
        }
      }
      return json(
        req,
        await callRpc("warehouse_record_stock_check", {
          p_id: getUuidParam(payload.id, "재고확인 항목"),
          p_result: String(payload.result ?? "").trim(),
          p_counted_qty: countedQty,
          p_reason: String(payload.reason ?? ""),
          p_actor_user_id: auth.userId,
          p_actor_email: auth.email,
          p_actor_name: auth.name,
        }),
      );
    }

    if (req.method === "POST" && path === "/stock_checks/resolve") {
      const payload = await readBody(req);
      if (typeof payload.resolved !== "boolean") {
        throw new Error("처리 여부가 지정되지 않았습니다.");
      }
      return json(
        req,
        await callRpc("warehouse_resolve_stock_check", {
          p_id: getUuidParam(payload.id, "재고확인 항목"),
          p_resolved: payload.resolved,
          p_note: String(payload.note ?? ""),
          p_actor_user_id: auth.userId,
          p_actor_email: auth.email,
          p_actor_name: auth.name,
        }),
      );
    }

    // ---- 진열보충 ----
    if (req.method === "GET" && path === "/display_requests") {
      return json(
        req,
        await callRpc("warehouse_get_display_request_list", {
          p_date: getDateParam(url.searchParams.get("date")),
        }),
      );
    }

    if (req.method === "POST" && path === "/display_requests/request") {
      const payload = await readBody(req);
      return json(
        req,
        await callRpc("warehouse_request_display", {
          p_item_code: String(payload.item_code ?? "").trim(),
          p_source: String(payload.source ?? "").trim(),
          p_note: String(payload.note ?? ""),
          p_date: getDateParam(payload.date),
          p_actor_user_id: auth.userId,
          p_actor_email: auth.email,
          p_actor_name: auth.name,
        }),
      );
    }

    if (req.method === "POST" && path === "/display_requests/status") {
      const payload = await readBody(req);
      const rackCode = String(payload.rack_code ?? "").trim();
      const takeQty = Number(payload.qty);
      if (rackCode && !(Number.isInteger(takeQty) && takeQty > 0)) {
        throw new Error("가져올 수량을 1 이상의 정수로 입력하세요.");
      }
      return json(
        req,
        await callRpc("warehouse_set_display_request_status", {
          p_id: getUuidParam(payload.id, "진열 요청 항목"),
          p_status: String(payload.status ?? "").trim(),
          p_actor_user_id: auth.userId,
          p_actor_email: auth.email,
          p_actor_name: auth.name,
          // 가져온 스토리지렉 위치·수량(완료일 때만). 없으면 재고 차감 없이 완료.
          p_rack_code: rackCode || null,
          p_qty: rackCode ? takeQty : null,
        }),
      );
    }

    // ---- 이형포장 ----
    if (req.method === "GET" && path === "/irregular_items") {
      return json(
        req,
        await callRpc("warehouse_get_irregular_list", {
          p_date: getDateParam(url.searchParams.get("date")),
        }),
      );
    }

    if (req.method === "POST" && path === "/irregular_items/update") {
      const payload = await readBody(req);
      // 보낸 키만 적용한다. expected_box_count: null 은 "비움"이라 키 존재 여부로 구분.
      const patch: Record<string, unknown> = {};
      if ("status" in payload) patch.status = payload.status;
      if ("expected_box_count" in payload) patch.expected_box_count = payload.expected_box_count;
      return json(
        req,
        await callRpc("warehouse_update_irregular_item", {
          p_id: getUuidParam(payload.id, "이형포장 항목"),
          p_patch: patch,
          p_actor_user_id: auth.userId,
          p_actor_email: auth.email,
          p_actor_name: auth.name,
        }),
      );
    }

    // ---- 품절관리 ----
    if (req.method === "GET" && path === "/soldout_items") {
      return json(
        req,
        await callRpc("warehouse_get_soldout_list", {
          p_date: getDateParam(url.searchParams.get("date")),
        }),
      );
    }

    if (req.method === "POST" && path === "/soldout_items/add") {
      const payload = await readBody(req);
      return json(
        req,
        await callRpc("warehouse_add_soldout_item", {
          p_item_code: String(payload.item_code ?? "").trim(),
          p_source: String(payload.source ?? "").trim(),
          p_source_id: getUuidParam(payload.source_id, "출처 항목", false),
          p_date: getDateParam(payload.date),
          p_actor_user_id: auth.userId,
          p_actor_email: auth.email,
          p_actor_name: auth.name,
        }),
      );
    }

    if (req.method === "POST" && path === "/soldout_items/remove") {
      const payload = await readBody(req);
      return json(
        req,
        await callRpc("warehouse_remove_soldout_item", {
          p_id: getUuidParam(payload.id, "품절관리 항목"),
          p_actor_user_id: auth.userId,
          p_actor_email: auth.email,
          p_actor_name: auth.name,
        }),
      );
    }

    // ---- 작업로그 / 탭 뱃지 ----
    if (req.method === "GET" && path === "/action_logs") {
      // 쿼리스트링에서 '+'가 공백으로 풀린 ISO 오프셋(" 00:00")을 되돌린다.
      const beforeRaw = (url.searchParams.get("before") || "").trim()
        .replace(/(T\d{2}:\d{2}:\d{2}(?:\.\d+)?) (\d{2}:?\d{2})$/, "$1+$2");
      if (beforeRaw && Number.isNaN(Date.parse(beforeRaw))) {
        throw new Error("before 값 형식이 올바르지 않습니다.");
      }
      return json(
        req,
        await callRpc("warehouse_get_action_logs", {
          p_q: url.searchParams.get("q") || "",
          p_from: getDateParam(url.searchParams.get("from"), "시작일"),
          p_to: getDateParam(url.searchParams.get("to"), "종료일"),
          p_limit: Math.min(getPositiveInt(url.searchParams.get("limit"), 100), 500),
          p_before: beforeRaw || null,
        }),
      );
    }

    if (req.method === "GET" && path === "/tab_counts") {
      // 화면이 탭을 옮길 때마다 부르는 경로라, 내 권한도 함께 내려 바뀐 권한이 곧바로 반영되게 한다.
      const [counts, info] = await Promise.all([
        callRpc("warehouse_get_tab_counts", {
          p_date: getDateParam(url.searchParams.get("date")),
        }),
        getRoleInfo(auth),
      ]);
      return json(req, { ...(counts as Record<string, unknown>), role: info.role, role_bootstrap: info.bootstrap });
    }

    return json(req, { detail: `Unsupported route: ${req.method} ${path}` }, 404);
  } catch (error) {
    const message = errorMessage(error);
    const isAuthError = message === "Authentication is required" ||
      message === "Invalid or expired session" ||
      message === "Invalid authenticated user";
    return json(req, { detail: message }, isAuthError ? 401 : 400);
  }
});
