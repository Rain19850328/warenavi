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
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
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

    return json(req, { detail: `Unsupported route: ${req.method} ${path}` }, 404);
  } catch (error) {
    return json(req, { detail: errorMessage(error) }, 400);
  }
});
