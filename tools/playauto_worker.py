"""
사무실 PC에서 도는 플레이오토 전송기.

플레이오토는 등록된 IP(사무실)에서만 API를 받는다. 그래서 창고네비 서버는 '반영' 건을
'전송 대기'로만 남기고, 이 프로그램이 1분마다 그 목록을 가져와 사무실 IP로 플레이오토에 보낸 뒤
결과(전송 완료 / 실패)를 창고네비 DB에 기록한다.

실행:
  py -3 tools\\playauto_worker.py          # 계속 돈다(기본 60초 간격)
  py -3 tools\\playauto_worker.py --once   # 한 번만 처리하고 끝낸다(점검용)

설정: 같은 폴더의 .env 파일(tools\\.env). 예시는 tools\\playauto_worker.env.example 참고.
표준 라이브러리만 쓴다(설치할 패키지 없음).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

VERSION = "2026-11-10"
WORKER_NAME = "playauto"
ACTOR_NAME = "사무실 전송기"
PLAYAUTO_API = "https://openapi.playauto.io/api"
HERE = Path(__file__).resolve().parent
LOG_FILE = HERE / "playauto_worker.log"
KST = dt.timezone(dt.timedelta(hours=9))


# ---------------- 설정 · 기록 ----------------
def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def log(message: str) -> None:
    line = f"[{dt.datetime.now(KST):%Y-%m-%d %H:%M:%S}] {message}"
    print(line, flush=True)
    try:
        with LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


class Config:
    def __init__(self) -> None:
        env = {**load_env(HERE / ".env"), **{k: v for k, v in os.environ.items() if k.startswith(("SUPABASE_", "PLAYAUTO_", "WORKER_"))}}
        self.supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
        self.service_key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
        self.api_key = env.get("PLAYAUTO_API_KEY", "")
        self.email = env.get("PLAYAUTO_EMAIL", "")
        self.password = env.get("PLAYAUTO_PASSWORD", "")
        self.depot_no = int(env.get("PLAYAUTO_DEPOT_NO") or 0)
        self.interval = max(15, int(env.get("WORKER_INTERVAL_SECONDS") or 60))
        missing = [name for name, value in (
            ("SUPABASE_URL", self.supabase_url),
            ("SUPABASE_SERVICE_ROLE_KEY", self.service_key),
            ("PLAYAUTO_API_KEY", self.api_key),
            ("PLAYAUTO_EMAIL", self.email),
            ("PLAYAUTO_PASSWORD", self.password),
        ) if not value]
        if missing:
            raise SystemExit(f"설정이 비어 있습니다: {', '.join(missing)} (tools\\.env 확인)")

    def mask(self, text: str) -> str:
        for secret in (self.password, self.api_key, self.email, self.service_key):
            if secret:
                text = text.replace(secret, "***")
        return text


# ---------------- HTTP ----------------
def http(method: str, url: str, headers: dict[str, str], body: object | None, timeout: float = 10) -> tuple[int, str]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")
    except (urllib.error.URLError, socket.timeout, TimeoutError) as err:
        reason = getattr(err, "reason", err)
        raise RuntimeError(f"응답이 없습니다 ({reason})") from None


class Warehouse:
    """창고네비 DB(Supabase) 함수 호출."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def rpc(self, name: str, args: dict | None = None):
        headers = {"apikey": self.cfg.service_key, "Content-Type": "application/json"}
        # 예전 service_role 키(JWT)는 Authorization 에도 넣는다. 새 secret 키(sb_secret_...)는 apikey 만 보낸다.
        if not self.cfg.service_key.startswith("sb_"):
            headers["Authorization"] = f"Bearer {self.cfg.service_key}"
        status, text = http(
            "POST",
            f"{self.cfg.supabase_url}/rest/v1/rpc/{name}",
            headers,
            args or {},
        )
        if status >= 400:
            try:
                message = json.loads(text).get("message") or text
            except ValueError:
                message = text
            raise RuntimeError(f"창고네비 DB 오류 ({name}): {message[:200]}")
        return json.loads(text) if text else None


class PlayautoAuthError(RuntimeError):
    """로그인이 안 되면 모든 건이 실패하므로, 건별 실패로 기록하지 않고 다음 주기에 다시 시도한다."""


class Playauto:
    def __init__(self, cfg: Config, wh: Warehouse) -> None:
        self.cfg = cfg
        self.wh = wh
        self.token = ""
        self.token_day = ""
        self.last_call = 0.0
        self.last_work = 0.0

    # 플레이오토 한도: 초당 3회, 재고 수정은 초당 1회.
    def _fetch(self, method: str, path: str, headers: dict[str, str], body: object, work: bool = False) -> tuple[int, str]:
        now = time.monotonic()
        gap = max(0.0, self.last_call + 0.34 - now, (self.last_work + 1.0 - now) if work else 0.0)
        if gap:
            time.sleep(gap)
        self.last_call = time.monotonic()
        if work:
            self.last_work = self.last_call
        try:
            self.wh.rpc("warehouse_playauto_take", {"p_calls": 1})   # 하루 호출 수 기록(실패해도 계속)
        except Exception:
            pass
        try:
            return http(method, f"{PLAYAUTO_API}{path}", headers, body, timeout=10)
        except RuntimeError as err:
            raise RuntimeError(f"플레이오토 {err}") from None

    def auth(self, force: bool = False) -> str:
        today = dt.datetime.now(KST).strftime("%Y-%m-%d")
        if not force and self.token and self.token_day == today:
            return self.token
        status, text = self._fetch(
            "POST", "/auth",
            {"x-api-key": self.cfg.api_key, "Content-Type": "application/json"},
            {"email": self.cfg.email, "password": self.cfg.password},
        )
        try:
            body = json.loads(text)
        except ValueError:
            body = None
        token = body[0].get("token") if isinstance(body, list) and body and isinstance(body[0], dict) else ""
        if status != 200 or not isinstance(token, str) or not token:
            detail = self.cfg.mask(" ".join(text.split()))[:240]
            raise PlayautoAuthError(f"플레이오토 인증 실패 (HTTP {status}) · 응답: {detail or '없음'}")
        self.token, self.token_day = token, today
        return token

    def call(self, method: str, path: str, body: object) -> dict:
        def send(token: str) -> tuple[int, str]:
            return self._fetch(method, path, {
                "x-api-key": self.cfg.api_key,
                "Authorization": f"Token {token}",
                "Content-Type": "application/json; charset=UTF-8",
            }, body, work=(method == "PUT"))

        status, text = send(self.auth())
        if status in (401, 403):
            status, text = send(self.auth(force=True))
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        if not isinstance(data, dict):
            raise RuntimeError(f"플레이오토 응답을 읽지 못했습니다 (HTTP {status})")
        return data

    def lookup(self, sku: str) -> dict | None:
        data = self.call("POST", "/stock/condition", {
            "start": 0,
            "limit": 5,
            "search_key": "sku_cd",
            "search_word": sku,
            "search_type": "exact",
            "date_type": "wdate",
            "sdate": "2000-01-01",
            "edate": dt.datetime.now(KST).strftime("%Y-%m-%d"),
        })
        rows = data.get("results") if isinstance(data.get("results"), list) else []
        return next((row for row in rows if str(row.get("sku_cd", "")) == sku), None)

    def send_stock(self, sku: str, counted: int, live_at_count: int | None) -> tuple[str, str]:
        """창고네비 서버의 sendStockToPlayauto 와 같은 규칙. (상태, 메시지)를 돌려준다."""
        current = self.lookup(sku)
        if not current:
            return "failed", f"플레이오토에 등록되지 않은 SKU입니다 ({sku})"
        now_real = to_int(current.get("stock_cnt_real"))
        qty, note = counted, ""
        # 재고실사 때 조회한 플레이오토 재고가 있으면, 그 뒤 팔리거나 들어온 만큼 보정한다.
        if live_at_count is not None and now_real is not None and now_real != live_at_count:
            moved = now_real - live_at_count
            qty = max(0, counted + moved)
            note = f" (센 수량 {counted}, 센 뒤 {'판매 ' + str(-moved) if moved < 0 else '입고 ' + str(moved)} 반영)"
        depot_no = to_int(current.get("depot_no")) or self.cfg.depot_no
        if not depot_no:
            return "failed", "플레이오토 배송처 코드를 알 수 없습니다"
        safe_now = max(0, to_int(current.get("stock_cnt_safe")) or 0)

        def edit(safe: int) -> dict:
            return self.call("PUT", "/stock/edit/v1.2", {
                "sku_cd": sku,
                "depots": [{"depot_no": depot_no, "real_stock": qty, "safe_stock": safe}],
            })

        def failed(res: dict) -> bool:
            return str(res.get("result", "")) == "실패" or bool(res.get("error_code"))

        # 안전재고는 그대로 보낸다. 실재고보다 커서 거절되면 그때만 실재고에 맞춰 다시 보낸다.
        res = edit(safe_now)
        if failed(res) and safe_now > qty:
            res = edit(qty)
        if failed(res):
            messages = res.get("messages")
            text = " ".join(str(m) for m in messages if m) if isinstance(messages, list) else ""
            return "failed", (text or json.dumps(res, ensure_ascii=False))[:300]

        after = self.lookup(sku)
        now = to_int(after.get("stock_cnt_real")) if after else None
        if now != qty:
            return "failed", f"전송했지만 플레이오토 실재고가 {now if now is not None else '확인 불가'}(으)로 조회됩니다 (보낸 값 {qty})"
        return "sent", f"실재고 {now_real} → {qty}{note}"


def to_int(value) -> int | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return int(number) if number.is_integer() else None


# ---------------- 한 주기 ----------------
def run_cycle(cfg: Config, wh: Warehouse, pa: Playauto) -> str:
    """대기 건을 처리하고, 화면에 보일 상태 문구를 돌려준다."""
    queue = wh.rpc("warehouse_playauto_queue", {"p_limit": 20}) or []
    if not queue:
        return "대기 건 없음"
    log(f"전송 대기 {len(queue)}건")
    done = failed = 0
    for row in queue:
        item_id = row.get("id")
        sku = str(row.get("item_code") or "").strip()
        # 그사이 화면에서 판단을 취소했거나 이미 보냈을 수 있으니 다시 확인한다.
        latest = wh.rpc("warehouse_get_stock_check_item", {"p_id": item_id}) or {}
        if latest.get("review_status") != "applied" or latest.get("playauto_status") != "pending":
            continue
        counted = to_int(latest.get("counted_qty"))
        if not sku or counted is None or counted < 0:
            status, message = "failed", "보낼 상품코드 또는 실재고 수량이 올바르지 않습니다"
        else:
            try:
                status, message = pa.send_stock(sku, counted, to_int(latest.get("live_stock")))
            except PlayautoAuthError:
                raise   # 남은 건은 대기로 두고 다음 주기에 다시 시도
            except Exception as err:   # 시간 초과 등: 이 건만 실패로 남긴다(화면에서 다시 전송 가능)
                status, message = "failed", cfg.mask(str(err))[:300]
        wh.rpc("warehouse_set_stock_check_playauto", {
            "p_id": item_id,
            "p_status": status,
            "p_message": message,
            "p_actor_name": ACTOR_NAME,
        })
        log(f"{sku} {row.get('item_name') or ''} → {'완료' if status == 'sent' else '실패'}: {message}")
        if status == "sent":
            done += 1
        else:
            failed += 1
    return f"전송 완료 {done}건 · 실패 {failed}건"


def ping(wh: Warehouse, info: dict) -> None:
    try:
        wh.rpc("warehouse_worker_ping", {"p_worker": WORKER_NAME, "p_info": info})
    except Exception as err:
        log(f"작동 기록 실패: {err}")


def main() -> None:
    parser = argparse.ArgumentParser(description="창고네비 → 플레이오토 재고 전송기")
    parser.add_argument("--once", action="store_true", help="한 번만 처리하고 끝낸다")
    args = parser.parse_args()

    cfg = Config()
    wh = Warehouse(cfg)
    pa = Playauto(cfg, wh)
    log(f"전송기 시작 (버전 {VERSION}, 간격 {cfg.interval}초, PC {socket.gethostname()})")

    while True:
        info = {"version": VERSION, "host": socket.gethostname(), "error": ""}
        try:
            info["result"] = run_cycle(cfg, wh, pa)
        except PlayautoAuthError as err:
            info["error"] = str(err)
            log(str(err))
        except Exception as err:
            info["error"] = cfg.mask(str(err))[:300]
            log(f"오류: {info['error']}")
        ping(wh, info)
        if args.once:
            break
        # 로그인이 막히면(IP 미등록 등) 호출 수를 아끼려고 5분 쉬었다가 다시 시도한다.
        time.sleep(max(cfg.interval, 300) if info["error"].startswith("플레이오토 인증 실패") else cfg.interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("전송기 종료")
        sys.exit(0)
