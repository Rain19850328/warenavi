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
      return json(
        req,
        await callRpc("warehouse_get_tab_counts", {
          p_date: getDateParam(url.searchParams.get("date")),
        }),
      );
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
