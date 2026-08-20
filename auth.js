/**
 * tmo auth module — auth-core + web/Capacitor adapter.
 *
 * auth-core: pure logic (no DOM, no platform APIs). The OAuth/magic-link
 * flow, the Worker API contract, session handling, and shortlist sync.
 * Portable to React Native: an RN adapter only supplies the platform hooks.
 *
 * web/Capacitor adapter: platform detection, storage, browser-open, and the
 * sign-in modal UI. Wired in at the bottom of this file.
 *
 * Login providers: Google and email magic link (uncapped); Spotify (capped at
 * 25 users in Spotify dev mode — also the music connection).
 */
(function () {
  "use strict";

  // Defaults to the production Worker. A host page may override it by setting
  // window.DEEPNORTH_WORKER_BASE before this script loads (used by the staging
  // test page) — production never sets it.
  const WORKER_BASE =
    window.DEEPNORTH_WORKER_BASE || "https://deepnorth-subscribe.n-m-woods1.workers.dev";

  // ── auth-core ─────────────────────────────────────────────────────────────

  /**
   * Platform hooks (all async):
   *   getSession()      → string | null
   *   setSession(token) → void
   *   clearSession()    → void
   *   openBrowser(url)  → void   (open OAuth/verify page)
   *   getReturnUrl()    → string (where the Worker sends the user back)
   */
  // Outbound ticket clicks are counted by the *app* Worker, which is a
  // different Worker from the auth/subscribe one above. Both read the same
  // sessions table, so a token minted here validates there.
  const APP_WORKER_BASE =
    window.DEEPNORTH_APP_WORKER_BASE || "https://deepnorth-app.n-m-woods1.workers.dev";

  // Must match the key used by the gig guide's inline dnClientId().
  function clickClientId() {
    try {
      return localStorage.getItem("dn-client-id");
    } catch (e) {
      return null;
    }
  }

  function createAuthCore(hooks) {
    let _user = null;
    let _ready = false;

    // Link this device's anonymous click id to the signed-in user, so
    // ticket-click reporting can distinguish people from devices. Attribution
    // is resolved server-side; the session token never enters a click URL.
    function linkClickIdentity(token) {
      const id = clickClientId();
      if (!id) return;
      fetch(`${APP_WORKER_BASE}/clicks/identify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ client_id: id }),
      }).catch(() => {});
    }

    function api(path, { method = "GET", body, token } = {}) {
      return fetch(`${WORKER_BASE}${path}`, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    }

    return {
      async init() {
        const token = await hooks.getSession();
        if (token) {
          try {
            const res = await api("/auth/me", { token });
            if (res.ok) {
              _user = await res.json();
              linkClickIdentity(token);
            } else {
              await hooks.clearSession();
              _user = null;
            }
          } catch {
            // Network error — keep any stale cache, don't sign the user out
          }
        }
        _ready = true;
        document.dispatchEvent(new CustomEvent("dn:auth-ready", { detail: { user: _user } }));
        return _user;
      },

      getUser() { return _user; },
      isReady() { return _ready; },

      /** Begin an OAuth login. provider: 'google' | 'spotify'. */
      async startLogin(provider) {
        const returnUrl = await hooks.getReturnUrl();
        hooks.openBrowser(
          `${WORKER_BASE}/auth/${provider}/login?return=${encodeURIComponent(returnUrl)}`,
        );
      },

      /** Request an email magic link. Returns true if the Worker accepted it. */
      async requestMagicLink(email) {
        const returnUrl = await hooks.getReturnUrl();
        try {
          const res = await api("/auth/email/request", {
            method: "POST",
            body: { email, return: returnUrl },
          });
          return res.ok;
        } catch {
          return false;
        }
      },

      /** Email + password sign-in. Resolves to {ok} or {ok:false, error}. */
      async passwordLogin(email, password) {
        try {
          const res = await api("/auth/password/login", {
            method: "POST",
            body: { email, password },
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) return { ok: false, error: data.error || "Sign-in failed." };
          await this.receiveSession(data.session);
          return { ok: true };
        } catch {
          return { ok: false, error: "Network error." };
        }
      },

      /** Create a password account — emails a confirmation link. */
      async passwordRegister(email, password) {
        const returnUrl = await hooks.getReturnUrl();
        try {
          const res = await api("/auth/password/register", {
            method: "POST",
            body: { email, password, return: returnUrl },
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) return { ok: false, error: data.error || "Sign-up failed." };
          return { ok: true };
        } catch {
          return { ok: false, error: "Network error." };
        }
      },

      async signOut() {
        const token = await hooks.getSession();
        if (token) api("/auth/logout", { method: "POST", token }).catch(() => {});
        await hooks.clearSession();
        _user = null;
        document.dispatchEvent(new CustomEvent("dn:auth-ready", { detail: { user: null } }));
      },

      /** Handle a session token received from a login redirect. */
      async receiveSession(token) {
        await hooks.setSession(token);
        try {
          const res = await api("/auth/me", { token });
          if (res.ok) _user = await res.json();
        } catch {}
        document.dispatchEvent(new CustomEvent("dn:auth-ready", { detail: { user: _user } }));
        if (_user) this.syncShortlist();
      },

      // ── Shortlist sync ──────────────────────────────────────────────────

      async syncShortlist() {
        const token = await hooks.getSession();
        if (!token || !_user) return;
        try {
          const res = await api("/shortlist", { token });
          if (!res.ok) return;
          const data = await res.json();
          document.dispatchEvent(
            new CustomEvent("dn:shortlist-synced", { detail: { ids: data.ids || [] } }),
          );
        } catch {}
      },

      async pushShortlist(ids) {
        const token = await hooks.getSession();
        if (!token) return;
        api("/shortlist", { method: "PUT", body: { ids }, token }).catch(() => {});
      },
    };
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ── Platform detection + hooks ────────────────────────────────────────────

  const isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform?.());

  const webHooks = {
    async getSession()      { return localStorage.getItem("dn-auth-token") || null; },
    async setSession(token) { localStorage.setItem("dn-auth-token", token); },
    async clearSession()    { localStorage.removeItem("dn-auth-token"); },
    async openBrowser(url)  { location.href = url; },
    async getReturnUrl()    { return location.origin + location.pathname + location.search; },
  };

  // The gig guide bundles no Capacitor runtime, so window.Capacitor.Plugins is
  // undefined inside the native app. Call plugins through the injected native
  // bridge's low-level transport instead.
  const nativeCall = (plugin, method, options) =>
    window.Capacitor.nativePromise(plugin, method, options || {});

  const capHooks = {
    async getSession() {
      const { value } = await nativeCall("Preferences", "get", { key: "dn-auth-token" });
      return value || null;
    },
    async setSession(token) {
      await nativeCall("Preferences", "set", { key: "dn-auth-token", value: token });
    },
    async clearSession() {
      await nativeCall("Preferences", "remove", { key: "dn-auth-token" });
    },
    async openBrowser(url) {
      await nativeCall("Browser", "open", { url });
    },
    async getReturnUrl() {
      // Per-variant scheme (matches applicationId) so the staging and
      // production app builds don't both claim the same OAuth deep link.
      try {
        const info = await nativeCall("App", "getInfo", {});
        return `${info.id}://auth`;
      } catch (e) {
        return "cool.tmo.app://auth";
      }
    },
  };

  const core = createAuthCore(isCapacitor ? capHooks : webHooks);

  // ── Session receipt ───────────────────────────────────────────────────────

  function checkWebFragment() {
    const match = (location.hash || "").match(/dn_session=([^&]+)/);
    if (!match) return;
    history.replaceState(null, "", location.href.replace(/#.*$/, ""));
    core.receiveSession(match[1]);
  }

  function setupCapacitorDeepLink() {
    if (!window.Capacitor?.addListener) return;
    window.Capacitor.addListener("App", "appUrlOpen", (event) => {
      const match = (event.url || "").match(/dn_session=([^&]+)/);
      if (match) {
        nativeCall("Browser", "close", {}).catch(() => {});
        core.receiveSession(match[1]);
      }
    });
  }

  // ── Sign-in panel + surface registry ──────────────────────────────────────
  //
  // The sign-in form lives in a reusable .dn-auth-panel fragment. Call
  // registerSignInHost(el) to embed it into a host element (the gig-guide
  // gate, the staging test page, etc.). Pages that don't register a host get
  // a fallback fixed overlay — functionally identical to the old modal.

  let _panel = null;
  let _signInHost = null;
  let _fallbackOverlay = null;

  function injectAuthStyles() {
    if (document.getElementById("dn-auth-styles")) return;
    const style = document.createElement("style");
    style.id = "dn-auth-styles";
    style.textContent = `
      .dn-auth-panel{background:#1a1a1a;color:#f0f0f0;border-radius:12px;
        max-width:360px;width:100%;padding:24px;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
      .dn-auth-panel h2{font-size:1.15rem;margin:0 0 4px;font-weight:700;}
      .dn-auth-panel p.dn-auth-sub{font-size:0.85rem;opacity:0.6;margin:0 0 18px;}
      .dn-auth-btn{display:flex;align-items:center;justify-content:center;gap:8px;
        width:100%;padding:11px 14px;margin-bottom:9px;border-radius:8px;
        border:1px solid #3a3a3a;background:#262626;color:#f0f0f0;
        font-size:0.9rem;cursor:pointer;}
      .dn-auth-btn:hover{background:#303030;}
      .dn-auth-divider{display:flex;align-items:center;gap:10px;
        margin:14px 0;font-size:0.75rem;opacity:0.4;}
      .dn-auth-divider::before,.dn-auth-divider::after{content:"";flex:1;
        height:1px;background:#3a3a3a;}
      .dn-auth-input{width:100%;padding:11px 14px;border-radius:8px;
        border:1px solid #3a3a3a;background:#0f0f0f;color:#f0f0f0;
        font-size:0.9rem;margin-bottom:9px;box-sizing:border-box;}
      .dn-auth-row{display:flex;gap:9px;}
      .dn-auth-row .dn-auth-btn{margin-bottom:0;flex:1;}
      .dn-auth-link{display:block;width:100%;background:none;border:none;
        color:#8ab4ff;font-size:0.82rem;cursor:pointer;margin-top:10px;padding:4px;}
      .dn-auth-link:hover{text-decoration:underline;}
      .dn-auth-primary{background:#e0441a;border-color:#e0441a;color:#fff;}
      .dn-auth-primary:hover{background:#c93b14;}
      .dn-auth-status{font-size:0.82rem;min-height:1.1em;margin:6px 0 0;}
      .dn-auth-status.dn-err{color:#ff8a6a;}
      .dn-auth-status.dn-ok{color:#7ad17a;}
      .dn-auth-fallback{position:fixed;inset:0;background:rgba(0,0,0,0.6);
        display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;}
      .dn-auth-fallback .dn-auth-panel{position:relative;}
      .dn-auth-fallback .dn-auth-close{position:absolute;top:14px;right:16px;background:none;
        border:none;color:#f0f0f0;font-size:1.3rem;cursor:pointer;opacity:0.5;}
    `;
    document.head.appendChild(style);
  }

  function buildAuthPanel() {
    injectAuthStyles();
    const panel = document.createElement("div");
    panel.className = "dn-auth-panel";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Sign in");
    panel.innerHTML = `
        <h2>Sign in to tmo</h2>
        <p class="dn-auth-sub">Sync your shortlist across devices.</p>
        <button class="dn-auth-btn" data-dn-provider="google">Continue with Google</button>
        <button class="dn-auth-btn" data-dn-provider="spotify">Continue with Spotify</button>
        <div class="dn-auth-divider">or</div>
        <input class="dn-auth-input" type="email" inputmode="email" data-dn-email
          placeholder="you@example.com" aria-label="Email address">
        <input class="dn-auth-input" type="password" data-dn-password
          placeholder="Password" aria-label="Password" autocomplete="current-password">
        <div class="dn-auth-row">
          <button class="dn-auth-btn dn-auth-primary" data-dn-login>Sign in</button>
          <button class="dn-auth-btn" data-dn-register>Create account</button>
        </div>
        <button class="dn-auth-link" data-dn-magic>Email me a link instead</button>
        <p class="dn-auth-status" role="status"></p>`;

    const status = panel.querySelector(".dn-auth-status");
    const emailInput = panel.querySelector("[data-dn-email]");
    const passwordInput = panel.querySelector("[data-dn-password]");
    const setStatus = (msg, kind) => {
      status.textContent = msg || "";
      status.className = "dn-auth-status" + (kind ? " dn-" + kind : "");
    };
    const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

    panel.querySelectorAll("[data-dn-provider]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setStatus("Redirecting…");
        core.startLogin(btn.dataset.dnProvider);
      });
    });

    panel.querySelector("[data-dn-login]").addEventListener("click", async (e) => {
      const email = (emailInput.value || "").trim();
      const password = passwordInput.value || "";
      if (!validEmail(email) || !password) {
        setStatus("Enter your email and password.", "err");
        return;
      }
      e.target.disabled = true;
      setStatus("Signing in…");
      const res = await core.passwordLogin(email, password);
      e.target.disabled = false;
      if (!res.ok) setStatus(res.error, "err");
      // success: dn:auth-ready fires and closeSignIn() hides the surface
    });

    panel.querySelector("[data-dn-register]").addEventListener("click", async (e) => {
      const email = (emailInput.value || "").trim();
      const password = passwordInput.value || "";
      if (!validEmail(email)) { setStatus("Enter a valid email address.", "err"); return; }
      if (password.length < 8) {
        setStatus("Password must be at least 8 characters.", "err");
        return;
      }
      e.target.disabled = true;
      setStatus("Creating account…");
      const res = await core.passwordRegister(email, password);
      e.target.disabled = false;
      if (res.ok) setStatus("Check your email to confirm your account.", "ok");
      else setStatus(res.error, "err");
    });

    panel.querySelector("[data-dn-magic]").addEventListener("click", async (e) => {
      const email = (emailInput.value || "").trim();
      if (!validEmail(email)) { setStatus("Enter a valid email address.", "err"); return; }
      e.target.disabled = true;
      setStatus("Sending…");
      const ok = await core.requestMagicLink(email);
      e.target.disabled = false;
      if (ok) setStatus("Check your email for a sign-in link.", "ok");
      else setStatus("Couldn't send the link. Try again.", "err");
    });

    passwordInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") panel.querySelector("[data-dn-login]").click();
    });

    return panel;
  }

  function getPanel() {
    if (!_panel) _panel = buildAuthPanel();
    return _panel;
  }

  function registerSignInHost(hostEl) {
    _signInHost = hostEl;
    hostEl.appendChild(getPanel());
  }

  function openSignIn() {
    if (_signInHost) {
      const gate = _signInHost.closest("#dn-gate");
      if (gate) {
        // Gate host: reveal the full-screen gate with the form visible
        gate.dataset.state = "prompt";
        document.documentElement.classList.add("dn-gate-open");
        const closeBtn = document.getElementById("dn-gate-close");
        if (closeBtn) closeBtn.hidden = false;
      }
      // Non-gate host (e.g. staging test page): panel already inline, no-op
      return;
    }
    // No registered host: use a fallback overlay (same UX as the old modal)
    if (!_fallbackOverlay) {
      injectAuthStyles();
      _fallbackOverlay = document.createElement("div");
      _fallbackOverlay.className = "dn-auth-fallback";
      const closeBtn = document.createElement("button");
      closeBtn.className = "dn-auth-close";
      closeBtn.setAttribute("aria-label", "Close");
      closeBtn.innerHTML = "&times;";
      closeBtn.addEventListener("click", closeSignIn);
      _fallbackOverlay.addEventListener("click", (e) => { if (e.target === _fallbackOverlay) closeSignIn(); });
      _fallbackOverlay.appendChild(closeBtn);
      _fallbackOverlay.appendChild(getPanel());
    }
    if (!_fallbackOverlay.isConnected) document.body.appendChild(_fallbackOverlay);
    _fallbackOverlay.style.display = "flex";
  }

  function closeSignIn() {
    if (_fallbackOverlay) _fallbackOverlay.style.display = "none";
    document.documentElement.classList.remove("dn-gate-open");
  }

  // Close the sign-in surface whenever sign-in completes (covers all paths:
  // OAuth redirect, magic link, and password login)
  document.addEventListener("dn:auth-ready", (e) => {
    if (e.detail && e.detail.user) closeSignIn();
  });

  // ── Public API ─────────────────────────────────────────────────────────────

  const debouncedPush = debounce((ids) => core.pushShortlist(ids), 1500);

  window.DeepNorthAuth = {
    /** Call once — verifies session, emits `dn:auth-ready`. */
    async init() {
      if (isCapacitor) setupCapacitorDeepLink();
      else checkWebFragment();
      const user = await core.init();
      if (user) core.syncShortlist();
      return user;
    },

    getUser: () => core.getUser(),
    isReady: () => core.isReady(),

    /** Open the sign-in screen (full-screen gate or fallback overlay). */
    signIn: () => openSignIn(),
    closeSignIn: () => closeSignIn(),
    signOut: () => core.signOut(),

    /** Embed the sign-in panel into hostEl (call before signIn()). */
    registerSignInHost: (el) => registerSignInHost(el),

    /** Direct provider entry points. */
    signInWithGoogle: () => core.startLogin("google"),
    signInWithSpotify: () => core.startLogin("spotify"),
    requestMagicLink: (email) => core.requestMagicLink(email),
    passwordLogin: (email, password) => core.passwordLogin(email, password),
    passwordRegister: (email, password) => core.passwordRegister(email, password),

    /** Called by the gig guide when the shortlist changes (debounced push). */
    pushShortlist: (ids) => debouncedPush(ids),
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => window.DeepNorthAuth.init());
  } else {
    window.DeepNorthAuth.init();
  }
})();
