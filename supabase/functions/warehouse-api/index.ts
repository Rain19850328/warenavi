import { createClient } from "npm:@supabase/supabase-js@2";

const FUNCTION_PREFIXES = [
  "/functions/v1/warehouse-api",
  "/warehouse-api",
];

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

    if (req.method === "GET" && path === "/") {
      return json(req, { ok: true, service: "warehouse-api" });
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

    if (req.method === "POST" && path === "/inbound") {
      const payload = await req.json();
      const { data, error } = await supabase.rpc("warehouse_post_inbound", {
        p_rack_code: payload.rack_code,
        p_item_code: payload.item_code,
        p_qty: payload.qty,
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
      });
      if (error) throw error;
      return json(req, data);
    }

    if (req.method === "POST" && path === "/set_location") {
      const payload = await req.json();
      const { data, error } = await supabase.rpc("warehouse_post_set_location", {
        p_item_code: payload.item_code,
        p_location: payload.location,
      });
      if (error) throw error;
      return json(req, data);
    }

    return json(req, { detail: `Unsupported route: ${req.method} ${path}` }, 404);
  } catch (error) {
    return json(req, { detail: errorMessage(error) }, 400);
  }
});
