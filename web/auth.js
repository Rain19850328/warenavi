(() => {
  const STORAGE_KEY = "warenavi.supabase.session";
  const REFRESH_MARGIN_MS = 90 * 1000;

  let session = loadSession();
  let authGatePromise = null;
  let authGateResolve = null;
  let uiMounted = false;

  function getConfig() {
    const config = window.APP_CONFIG || {};
    if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
      throw new Error("SUPABASE_URL 또는 SUPABASE_ANON_KEY 설정이 필요합니다.");
    }
    return config;
  }

  function authUrl(path) {
    const { SUPABASE_URL } = getConfig();
    return `${SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/${path}`;
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      return normalizeSession(parsed);
    } catch (_) {
      return null;
    }
  }

  function normalizeSession(data) {
    if (!data || typeof data !== "object") return null;
    const expiresAt = Number(data.expires_at || 0);
    const safeExpiresAt = Number.isFinite(expiresAt) && expiresAt > 0
      ? expiresAt > 10_000_000_000 ? expiresAt : expiresAt * 1000
      : Date.now() + Number(data.expires_in || 3600) * 1000;

    return {
      access_token: typeof data.access_token === "string" ? data.access_token : "",
      refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : "",
      expires_at: safeExpiresAt,
      user: data.user && typeof data.user === "object" ? data.user : null,
    };
  }

  function persistSession() {
    if (!session) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function saveSession(data) {
    const next = normalizeSession({
      ...session,
      ...data,
      user: data.user || session?.user || null,
    });
    if (!next?.access_token) {
      throw new Error("인증 토큰을 받지 못했습니다.");
    }
    session = next;
    persistSession();
    renderAuthShell();
    closeAuthScreen();
    return session;
  }

  function clearSession() {
    session = null;
    persistSession();
    renderAuthShell();
  }

  function getStoredUserName() {
    const user = session?.user || {};
    const metadata = user.user_metadata && typeof user.user_metadata === "object"
      ? user.user_metadata
      : {};
    return (
      metadata.display_name ||
      metadata.name ||
      user.email ||
      ""
    );
  }

  async function authRequest(path, options = {}) {
    const { SUPABASE_ANON_KEY } = getConfig();
    const headers = {
      apikey: SUPABASE_ANON_KEY,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    };

    const response = await fetch(authUrl(path), {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }

    if (!response.ok) {
      throw new Error(
        data?.msg ||
        data?.error_description ||
        data?.message ||
        data?.error ||
        response.statusText ||
        "인증 요청에 실패했습니다."
      );
    }

    return data || {};
  }

  async function hydrateUser() {
    if (!session?.access_token) {
      throw new Error("로그인이 필요합니다.");
    }
    const user = await authRequest("user", { token: session.access_token });
    session = {
      ...session,
      user,
    };
    persistSession();
    renderAuthShell();
    return user;
  }

  async function refreshSession() {
    if (!session?.refresh_token) {
      throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
    }
    const data = await authRequest("token?grant_type=refresh_token", {
      method: "POST",
      body: { refresh_token: session.refresh_token },
    });
    saveSession(data);
    if (!session.user) {
      await hydrateUser();
    }
    return session;
  }

  async function ensureSession() {
    getConfig();

    if (!session?.access_token) {
      throw new Error("로그인이 필요합니다.");
    }

    if (!session.expires_at || (session.expires_at - REFRESH_MARGIN_MS) <= Date.now()) {
      try {
        await refreshSession();
      } catch (error) {
        console.warn("refreshSession skipped", error);
      }
    }

    return session;
  }

  function ensureUi() {
    if (uiMounted) return;

    const container = document.querySelector(".container") || document.body;

    const authShell = document.createElement("section");
    authShell.id = "authShell";
    authShell.className = "auth-shell";
    authShell.hidden = true;
    authShell.innerHTML = `
      <div class="auth-shell__user">
        <strong id="authShellName"></strong>
        <button id="authLogoutBtn" type="button" class="auth-shell__logout">로그아웃</button>
      </div>
    `;
    container.prepend(authShell);

    const authScreen = document.createElement("section");
    authScreen.id = "authScreen";
    authScreen.className = "auth-screen";
    authScreen.hidden = true;
    authScreen.innerHTML = `
      <div class="auth-card">
        <div class="auth-card__head">
          <h1>Sellingon Warenavi</h1>
          <p>회원가입 후 로그인하면 작업 기록이 사용자 기준으로 저장됩니다.</p>
        </div>
        <div class="auth-tabs" role="tablist" aria-label="auth tabs">
          <button id="authTabSignin" type="button" class="is-active">로그인</button>
          <button id="authTabSignup" type="button">회원가입</button>
        </div>
        <p id="authStatus" class="auth-status" hidden></p>
        <form id="authSigninForm" class="auth-form">
          <label>
            <span>이메일</span>
            <input id="authSigninEmail" type="email" autocomplete="email" required />
          </label>
          <label>
            <span>비밀번호</span>
            <input id="authSigninPassword" type="password" autocomplete="current-password" required />
          </label>
          <button id="authSigninSubmit" type="submit">로그인</button>
        </form>
        <form id="authSignupForm" class="auth-form" hidden>
          <label>
            <span>이름</span>
            <input id="authSignupName" type="text" autocomplete="name" placeholder="작업자 이름" />
          </label>
          <label>
            <span>이메일</span>
            <input id="authSignupEmail" type="email" autocomplete="email" required />
          </label>
          <label>
            <span>비밀번호</span>
            <input id="authSignupPassword" type="password" autocomplete="new-password" minlength="6" required />
          </label>
          <button id="authSignupSubmit" type="submit">회원가입</button>
        </form>
      </div>
    `;
    document.body.append(authScreen);

    document.getElementById("authTabSignin")?.addEventListener("click", () => switchMode("signin"));
    document.getElementById("authTabSignup")?.addEventListener("click", () => switchMode("signup"));
    document.getElementById("authLogoutBtn")?.addEventListener("click", () => {
      logout().catch((error) => {
        console.error(error);
      });
    });
    document.getElementById("authSigninForm")?.addEventListener("submit", handleSignin);
    document.getElementById("authSignupForm")?.addEventListener("submit", handleSignup);

    uiMounted = true;
    renderAuthShell();
  }

  function setStatus(message, isError = false) {
    const el = document.getElementById("authStatus");
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      el.classList.remove("is-error", "is-success");
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle("is-error", !!isError);
    el.classList.toggle("is-success", !isError);
  }

  function setBusy(formId, busy) {
    const form = document.getElementById(formId);
    if (!form) return;
    form.querySelectorAll("input, button").forEach((el) => {
      el.disabled = busy;
    });
  }

  function switchMode(mode) {
    const signinTab = document.getElementById("authTabSignin");
    const signupTab = document.getElementById("authTabSignup");
    const signinForm = document.getElementById("authSigninForm");
    const signupForm = document.getElementById("authSignupForm");
    if (!signinTab || !signupTab || !signinForm || !signupForm) return;

    const signinActive = mode !== "signup";
    signinTab.classList.toggle("is-active", signinActive);
    signupTab.classList.toggle("is-active", !signinActive);
    signinForm.hidden = !signinActive;
    signupForm.hidden = signinActive;
    setStatus("");

    const focusTarget = signinActive
      ? document.getElementById("authSigninEmail")
      : document.getElementById("authSignupName");
    focusTarget?.focus();
  }

  function openAuthScreen(mode = "signin", message = "") {
    ensureUi();
    const screen = document.getElementById("authScreen");
    if (!screen) return;
    screen.hidden = false;
    screen.style.display = "flex";
    document.body.classList.add("auth-open");
    switchMode(mode);
    setStatus(message, false);
  }

  function closeAuthScreen() {
    const screen = document.getElementById("authScreen");
    if (!screen) return;
    screen.hidden = true;
    screen.style.display = "none";
    document.body.classList.remove("auth-open");
    setStatus("");
  }

  function renderAuthShell() {
    if (!uiMounted) return;

    const shell = document.getElementById("authShell");
    const nameEl = document.getElementById("authShellName");
    if (!shell || !nameEl) return;

    const user = session?.user;
    if (!user) {
      shell.hidden = true;
      nameEl.textContent = "";
      return;
    }

    shell.hidden = false;
    nameEl.textContent = getStoredUserName() || "작업자";
  }

  function resolveAuthGate() {
    if (!authGateResolve) return;
    authGateResolve(session);
    authGateResolve = null;
    authGatePromise = null;
  }

  async function handleSignin(event) {
    event.preventDefault();
    setBusy("authSigninForm", true);
    setStatus("");

    try {
      const email = document.getElementById("authSigninEmail")?.value?.trim() || "";
      const password = document.getElementById("authSigninPassword")?.value || "";
      const data = await authRequest("token?grant_type=password", {
        method: "POST",
        body: { email, password },
      });
      saveSession(data);
      try {
        await hydrateUser();
      } catch (error) {
        console.warn("hydrateUser failed after signin", error);
      }
      closeAuthScreen();
      resolveAuthGate();
      window.location.reload();
      return;
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      setBusy("authSigninForm", false);
    }
  }

  async function handleSignup(event) {
    event.preventDefault();
    setBusy("authSignupForm", true);
    setStatus("");

    try {
      const name = document.getElementById("authSignupName")?.value?.trim() || "";
      const email = document.getElementById("authSignupEmail")?.value?.trim() || "";
      const password = document.getElementById("authSignupPassword")?.value || "";

      const data = await authRequest("signup", {
        method: "POST",
        body: {
          email,
          password,
          data: { display_name: name || email.split("@")[0] || "작업자" },
        },
      });

      if (data.access_token) {
        saveSession(data);
        try {
          await hydrateUser();
        } catch (error) {
          console.warn("hydrateUser failed after signup", error);
        }
        closeAuthScreen();
        resolveAuthGate();
        window.location.reload();
        return;
      }

      switchMode("signin");
      setStatus("회원가입이 완료되었습니다. 이메일 확인 후 로그인해 주세요.", false);
      const signinEmail = document.getElementById("authSigninEmail");
      if (signinEmail) signinEmail.value = email;
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      setBusy("authSignupForm", false);
    }
  }

  async function requireSession() {
    ensureUi();

    if (session?.access_token) {
      closeAuthScreen();
      if (!session.user) {
        hydrateUser()
          .then(() => renderAuthShell())
          .catch((error) => console.warn("hydrateUser skipped during boot", error));
      } else {
        renderAuthShell();
      }
      return session;
    }

    try {
      const current = await ensureSession();
      closeAuthScreen();
      if (!current.user) {
        hydrateUser()
          .then(() => renderAuthShell())
          .catch((error) => console.warn("hydrateUser skipped during boot", error));
      } else {
        renderAuthShell();
      }
      return current;
    } catch (error) {
      openAuthScreen("signin", error.message || "로그인이 필요합니다.");
      if (!authGatePromise) {
        authGatePromise = new Promise((resolve) => {
          authGateResolve = resolve;
        });
      }
      return authGatePromise;
    }
  }

  async function getApiHeaders() {
    getConfig();
    if (!session?.access_token) {
      throw new Error("로그인이 필요합니다.");
    }
    if (!session.expires_at || (session.expires_at - REFRESH_MARGIN_MS) <= Date.now()) {
      refreshSession().catch((error) => console.warn("refreshSession skipped in headers", error));
    }
    const headers = {
      Authorization: `Bearer ${session.access_token}`,
    };
    const { SUPABASE_ANON_KEY } = getConfig();
    if (SUPABASE_ANON_KEY) {
      headers.apikey = SUPABASE_ANON_KEY;
    }
    return headers;
  }

  async function logout() {
    if (session?.access_token) {
      try {
        await authRequest("logout", {
          method: "POST",
          token: session.access_token,
        });
      } catch (_) {
        // Ignore logout endpoint errors and clear local session anyway.
      }
    }

    clearSession();
    openAuthScreen("signin", "로그아웃되었습니다.");
    if (!authGatePromise) {
      authGatePromise = new Promise((resolve) => {
        authGateResolve = resolve;
      });
    }
  }

  window.WarehouseAuth = {
    getApiHeaders,
    getSession: () => session,
    getUser: () => session?.user || null,
    logout,
    render: renderAuthShell,
    requireSession,
  };

  ensureUi();
  if (session?.access_token) {
    closeAuthScreen();
    renderAuthShell();
  }
})();
