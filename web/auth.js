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

  function isSessionExpired(marginMs = 0) {
    if (!session?.expires_at) return true;
    return (session.expires_at - marginMs) <= Date.now();
  }

  async function ensureSession() {
    getConfig();

    if (!session?.access_token) {
      throw new Error("로그인이 필요합니다.");
    }

    if (isSessionExpired(REFRESH_MARGIN_MS)) {
      try {
        await refreshSession();
      } catch (error) {
        console.warn("refreshSession failed", error);
        // 이미 만료된 토큰은 그대로 쓸 수 없으므로 로그인 화면으로 넘긴다.
        if (isSessionExpired()) {
          throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
        }
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
      </div>
      <div class="auth-shell__actions">
        <button id="authChangePwBtn" type="button" class="auth-shell__changepw">비밀번호 변경</button>
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
        <form id="authChangePwForm" class="auth-form" hidden>
          <label>
            <span>현재 비밀번호</span>
            <input id="authChangePwCurrent" type="password" autocomplete="current-password" required />
          </label>
          <label>
            <span>새 비밀번호</span>
            <input id="authChangePwNext" type="password" autocomplete="new-password" minlength="6" required />
          </label>
          <label>
            <span>새 비밀번호 확인</span>
            <input id="authChangePwConfirm" type="password" autocomplete="new-password" minlength="6" required />
          </label>
          <button id="authChangePwSubmit" type="submit">비밀번호 변경</button>
          <button id="authChangePwCancel" type="button" class="auth-form__cancel">취소</button>
        </form>
      </div>
    `;
    document.body.append(authScreen);

    const authTitle = authScreen.querySelector(".auth-card__head h1");
    const authDesc = authScreen.querySelector(".auth-card__head p");
    const authTabs = authScreen.querySelector(".auth-tabs");
    const authSigninForm = document.getElementById("authSigninForm");
    const authSigninSubmit = document.getElementById("authSigninSubmit");
    const authSignupSubmit = document.getElementById("authSignupSubmit");
    const authTabSignin = document.getElementById("authTabSignin");
    const authTabSignup = document.getElementById("authTabSignup");
    const authSigninLabels = authScreen.querySelectorAll("#authSigninForm label span");
    const authSignupLabels = authScreen.querySelectorAll("#authSignupForm label span");
    const authSignupName = document.getElementById("authSignupName");
    const authStatus = document.getElementById("authStatus");
    const authHead = authScreen.querySelector(".auth-card__head");

    if (authTitle) authTitle.textContent = "SELLING-ON 창고네비";
    if (authDesc) authDesc.hidden = true;
    if (authSigninSubmit) authSigninSubmit.textContent = "로그인";
    if (authSignupSubmit) authSignupSubmit.textContent = "회원가입 완료";
    if (authTabSignin) authTabSignin.textContent = "로그인으로";
    if (authTabSignup) authTabSignup.textContent = "회원가입";
    if (authSigninLabels[0]) authSigninLabels[0].textContent = "이메일";
    if (authSigninLabels[1]) authSigninLabels[1].textContent = "비밀번호";
    if (authSignupLabels[0]) authSignupLabels[0].textContent = "이름";
    if (authSignupLabels[1]) authSignupLabels[1].textContent = "이메일";
    if (authSignupLabels[2]) authSignupLabels[2].textContent = "비밀번호";
    if (authSignupName) authSignupName.placeholder = "작업자 이름";
    if (authStatus && authHead) {
      authHead.after(authStatus);
    }
    if (authTabs && authSigninForm) {
      authSigninForm.after(authTabs);
    }

    document.getElementById("authTabSignin")?.addEventListener("click", () => switchMode("signin"));
    document.getElementById("authTabSignup")?.addEventListener("click", () => switchMode("signup"));
    document.getElementById("authLogoutBtn")?.addEventListener("click", () => {
      logout().catch((error) => {
        console.error(error);
      });
    });
    document.getElementById("authSigninForm")?.addEventListener("submit", handleSignin);
    document.getElementById("authSignupForm")?.addEventListener("submit", handleSignup);
    document.getElementById("authChangePwForm")?.addEventListener("submit", handleChangePassword);
    document.getElementById("authChangePwCancel")?.addEventListener("click", () => closeAuthScreen());
    document.getElementById("authChangePwBtn")?.addEventListener("click", () => openChangePassword());

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
    const heading = document.querySelector("#authScreen .auth-card__head h1");
    const desc = document.querySelector("#authScreen .auth-card__head p");
    const signinTab = document.getElementById("authTabSignin");
    const signupTab = document.getElementById("authTabSignup");
    const signinForm = document.getElementById("authSigninForm");
    const signupForm = document.getElementById("authSignupForm");
    if (!signinTab || !signupTab || !signinForm || !signupForm) return;

    const changeForm = document.getElementById("authChangePwForm");
    const tabs = document.querySelector("#authScreen .auth-tabs");

    const changeActive = mode === "change";
    const signinActive = !changeActive && mode !== "signup";

    if (tabs) tabs.hidden = changeActive;
    signinTab.hidden = changeActive || signinActive;
    signupTab.hidden = changeActive || !signinActive;
    signinTab.classList.remove("is-active");
    signupTab.classList.remove("is-active");
    signinForm.hidden = changeActive || !signinActive;
    signupForm.hidden = changeActive || signinActive;
    if (changeForm) changeForm.hidden = !changeActive;
    if (heading) {
      heading.textContent = changeActive
        ? "비밀번호 변경"
        : signinActive ? "SELLING-ON 창고네비" : "회원가입";
    }
    if (desc) {
      desc.hidden = true;
    }
    setStatus("");

    const focusTarget = changeActive
      ? document.getElementById("authChangePwCurrent")
      : signinActive
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

      await authRequest("signup", {
        method: "POST",
        body: {
          email,
          password,
          data: { display_name: name || email.split("@")[0] || "작업자" },
        },
      });

      switchMode("signin");
      const signinEmail = document.getElementById("authSigninEmail");
      if (signinEmail) signinEmail.value = email;
      setStatus("회원가입이 완료되었습니다. 이메일을 확인해 주세요.", false);
      const signinPassword = document.getElementById("authSigninPassword");
      if (signinPassword) signinPassword.value = "";
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      setBusy("authSignupForm", false);
    }
  }

  function openChangePassword() {
    ensureUi();
    if (!session?.access_token) {
      openAuthScreen("signin", "로그인이 필요합니다.");
      return;
    }
    clearChangePasswordFields();
    openAuthScreen("change");
  }

  function clearChangePasswordFields() {
    ["authChangePwCurrent", "authChangePwNext", "authChangePwConfirm"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
  }

  function translateAuthError(message) {
    const text = String(message || "");
    if (/invalid login credentials/i.test(text)) {
      return "현재 비밀번호가 올바르지 않습니다.";
    }
    if (/should be different/i.test(text)) {
      return "새 비밀번호는 현재 비밀번호와 다르게 입력해 주세요.";
    }
    if (/at least \d+ characters/i.test(text)) {
      return "비밀번호는 6자 이상이어야 합니다.";
    }
    return text || "비밀번호 변경에 실패했습니다.";
  }

  async function handleChangePassword(event) {
    event.preventDefault();

    const email = session?.user?.email || "";
    const current = document.getElementById("authChangePwCurrent")?.value || "";
    const next = document.getElementById("authChangePwNext")?.value || "";
    const confirm = document.getElementById("authChangePwConfirm")?.value || "";

    if (!email) {
      setStatus("사용자 정보를 확인할 수 없습니다. 다시 로그인해 주세요.", true);
      return;
    }
    if (next.length < 6) {
      setStatus("새 비밀번호는 6자 이상이어야 합니다.", true);
      return;
    }
    if (next !== confirm) {
      setStatus("새 비밀번호 두 개가 서로 다릅니다.", true);
      return;
    }
    if (next === current) {
      setStatus("새 비밀번호는 현재 비밀번호와 다르게 입력해 주세요.", true);
      return;
    }

    setBusy("authChangePwForm", true);
    setStatus("");

    try {
      // 현재 비밀번호로 다시 인증해서 본인 확인 + 새 토큰을 받는다.
      const reauth = await authRequest("token?grant_type=password", {
        method: "POST",
        body: { email, password: current },
      });
      if (!reauth?.access_token) {
        throw new Error("현재 비밀번호가 올바르지 않습니다.");
      }

      const updated = await authRequest("user", {
        method: "PUT",
        token: reauth.access_token,
        body: { password: next },
      });

      session = normalizeSession({
        ...reauth,
        user: updated?.id ? updated : (reauth.user || session?.user || null),
      });
      persistSession();
      renderAuthShell();
      clearChangePasswordFields();

      setStatus("비밀번호가 변경되었습니다.", false);
      setTimeout(() => closeAuthScreen(), 1500);
    } catch (error) {
      setStatus(translateAuthError(error?.message || error), true);
    } finally {
      setBusy("authChangePwForm", false);
    }
  }

  async function requireSession() {
    ensureUi();

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
    if (isSessionExpired(REFRESH_MARGIN_MS)) {
      await ensureSession();
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

  function handleUnauthorized(message) {
    clearSession();
    openAuthScreen("signin", message || "세션이 만료되었습니다. 다시 로그인해 주세요.");
    if (!authGatePromise) {
      authGatePromise = new Promise((resolve) => {
        authGateResolve = resolve;
      });
    }
    return authGatePromise;
  }

  window.WarehouseAuth = {
    getApiHeaders,
    getSession: () => session,
    getUser: () => session?.user || null,
    handleUnauthorized,
    logout,
    openChangePassword,
    render: renderAuthShell,
    requireSession,
  };

  ensureUi();
  if (session?.access_token) {
    closeAuthScreen();
    renderAuthShell();
  }
})();
