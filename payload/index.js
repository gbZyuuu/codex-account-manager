/**
 * Live accounts - the real quota of EVERY Codex account, inside the popover.
 *
 * WHY THIS TWEAK EXISTS
 * Reading quota through the webview session with `webContents.executeJavaScript`
 * only reaches the ACTIVE account - the others would have no number at all. Here
 * the call goes out from the `main` half (Node), one per account, in parallel, with
 * the token from each `auth.json`. No webview, no privileged account.
 *
 * ZERO QUOTA COST
 *   GET https://chatgpt.com/backend-api/wham/usage
 * A GET with no body, no model, no prompt. The URL is asserted verbatim in
 * codex-rs/backend-client/src/client/rate_limit_resets.rs::rate_limit_status_url
 * of `openai/codex` itself, whose comment calls consumers of that variant
 * "passive account usage readers". We do NOT send
 * `x-openai-codex-luna-reserve`, which would opt into APPLYING Reserve.
 *
 * TWO FINDINGS MEASURED ON THIS MACHINE, both noted where they matter:
 *  1. The renderer half runs under `eval` on `tweak-host://` and has NO
 *     `require`. All Node stays in the `main` branch.
 *  2. The aggregated menu text arrives CONCATENATED with no spaces
 *     ("...Alt+Win+PSettingsCtrl+,Sign out"), so \b anchors never match.
 *     See findMenu().
 */

const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEKLY_SECONDS = 7 * 24 * 60 * 60;
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";
const CACHE_TTL_MS = 60_000;

// ─────────────────────────── main half (Node) ───────────────────────────

function startMain(api) {
  const nodeRequire = eval("require");
  const fs = nodeRequire("fs");
  const path = nodeRequire("path");
  const os = nodeRequire("os");
  const https = nodeRequire("https");
  const { spawn } = nodeRequire("child_process");
  const { randomUUID } = nodeRequire("crypto");

  /**
   * IDEMPOTENT IPC REGISTRATION - without this, the tweak dies on the first reload.
   *
   * The previous host's `api.ipc.handle` was a raw `ipcMain.handle`:
   *   packages/runtime/src/main.ts  ->  ipcMain.handle(ch(c), ...)
   *   with the full channel in the form `cam:<id>:<channel>`
   * `ipcMain.handle` THROWS "Attempted to register a second handler" when the
   * channel already exists, and the runtime exposes no removal path at all:
   * `makeMainIpc` returns an unsubscribe for `.on()`, but NOTHING for `.handle()`.
   *
   * A hot reload does stopAllMainTweaks -> clearTweakModuleCache ->
   * loadAllMainTweaks in the SAME process. Since our `stop()` unregistered
   * nothing, the second `start` blew up and the log showed, forever:
   *   [error] tweak co.gbzyuu.codex-account-manager failed to start: {}
   * (that `{}` is an Error: message/stack are not enumerable in JSON).
   *
   * Two defenses, on purpose:
   *  1. `stop()` removes everything it registered - the correct path.
   *  2. every registration removes the channel BEFORE creating it - this repairs a
   *     process already poisoned by a stop that never ran (crash, runtime version
   *     swap), without requiring an app restart.
   */
  const { ipcMain } = nodeRequire("electron");
  const tweakId = (api.manifest && api.manifest.id) || "co.gbzyuu.codex-account-manager";
  const registered = [];

  function handle(channel, fn) {
    const full = `cam:${tweakId}:${channel}`;
    try {
      ipcMain.removeHandler(full);
    } catch {
      // The channel did not exist yet: that is the normal case on the first start.
    }
    // CAREFUL: this is the host's `api.ipc.handle`, NOT this wrapper. A
    // replace-all from "api.ipc.handle(" to "handle(" once turned this line into
    // infinite recursion, and the host reported only
    // "failed to start: {}" - RangeError: Maximum call stack size exceeded.
    api.ipc.handle(channel, fn);
    registered.push(full);
  }

  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const accountsDir = path.join(codexHome, "auth_accounts");
  const authFile = path.join(codexHome, "auth.json");
  const backupsDir = path.join(codexHome, "auth_backups_accounts_live");
  let cache = { at: 0, rows: null };

  function decodeJwt(jwt) {
    try {
      const parts = String(jwt).split(".");
      if (parts.length !== 3 || !parts[1]) return null;
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(
        Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf8"),
      );
    } catch {
      return null;
    }
  }

  function readAuth(file, label) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
    const tokens = doc && doc.tokens;
    if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token) return null;
    const claims = decodeJwt(tokens.id_token) || {};
    const auth = claims[AUTH_CLAIM] || {};
    const profile = claims[PROFILE_CLAIM] || {};
    const access = decodeJwt(tokens.access_token) || {};
    return {
      label,
      file,
      email: claims.email || profile.email || null,
      plan: auth.chatgpt_plan_type || null,
      accountId: tokens.account_id || auth.chatgpt_account_id || null,
      isFedramp: Boolean(auth.chatgpt_account_is_fedramp),
      accessToken: tokens.access_token,
      refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : null,
      exp: typeof access.exp === "number" ? access.exp : null,
    };
  }

  /** Active account first, then each saved file, without duplicating by e-mail. */
  function collect() {
    const list = [];
    const seen = new Set();
    const active = readAuth(authFile, "__active__");
    if (active) {
      active.current = true;
      list.push(active);
      if (active.email) seen.add(active.email.toLowerCase());
    }
    let names = [];
    try {
      names = fs.readdirSync(accountsDir).filter((n) => n.toLowerCase().endsWith(".json"));
    } catch {
      names = [];
    }
    for (const name of names) {
      const label = path.basename(name, ".json");
      const parsed = readAuth(path.join(accountsDir, name), label);
      if (!parsed) continue;
      const key = (parsed.email || label).toLowerCase();
      if (seen.has(key)) {
        // Same e-mail as the active account: keep the file name for the switch.
        const first = list.find((a) => (a.email || "").toLowerCase() === key);
        if (first && first.label === "__active__") first.label = label;
        continue;
      }
      seen.add(key);
      parsed.current = false;
      list.push(parsed);
    }
    return list;
  }

  /**
   * Where this session's snapshot should live.
   *
   * Reuses the file that ALREADY represents this e-mail instead of creating another
   * one: the folder on this machine had `account.json` and a
   * `<address>@gmail.com.json` with identical bytes, because the third-party
   * switcher names by position (`account`, `account-2`) and we name by e-mail.
   * `collect()` deduplicates for display, but two files for the same account mean
   * one of them ends up with a stale refresh token - and refresh tokens ROTATE.
   */
  function snapshotPathFor(active) {
    const email = (active.email || "").toLowerCase();
    if (email) {
      let names = [];
      try {
        names = fs.readdirSync(accountsDir).filter((n) => n.toLowerCase().endsWith(".json"));
      } catch {
        names = [];
      }
      for (const name of names) {
        const full = path.join(accountsDir, name);
        const parsed = readAuth(full, path.basename(name, ".json"));
        if (parsed && parsed.email && parsed.email.toLowerCase() === email) return full;
      }
    }
    const base = (active.email || "account").replace(/[^a-zA-Z0-9@._-]/g, "_");
    return path.join(accountsDir, `${base}.json`);
  }

  /**
   * Persists the ACTIVE session into `auth_accounts` and returns the label.
   *
   * THIS IS THE FIX FOR "the account I added disappears". A freshly signed-in
   * account exists ONLY in auth.json: `account:add` saves the PREVIOUS account and
   * clears the file, and the sign-in that follows writes auth.json without leaving
   * a snapshot. `account:switch` then overwrote that auth.json and the credential
   * vanished from the list - it only survived in auth_backups_accounts_live, which
   * the panel does not read.
   *
   * It always overwrites the existing snapshot and never skips when the file is
   * already there: the access token expires and the refresh token rotates, so an
   * old snapshot is a sign-in that will fail later.
   *
   * `avoid` protects the path of the snapshot we are about to READ during a switch,
   * so we never write over the destination.
   */
  function saveActiveSnapshot(active, avoid) {
    fs.mkdirSync(accountsDir, { recursive: true });
    const target = snapshotPathFor(active);
    if (avoid && path.resolve(target) === path.resolve(avoid)) return null;
    const tmp = `${target}.calive-tmp`;
    fs.copyFileSync(authFile, tmp);
    fs.renameSync(tmp, target);
    return path.basename(target, ".json");
  }

  function request(options, body) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
        );
      });
      req.on("error", reject);
      req.setTimeout(20_000, () => req.destroy(new Error("timeout")));
      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * JSON body, NOT form-encoded - the classic mistake of reimplementations.
   * The refresh token ROTATES: without persisting the new one, the next refresh
   * fails as reused and the account drops to a re-login.
   */
  async function refresh(account) {
    if (!account.refreshToken) throw new Error("no refresh_token");
    const payload = JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
    });
    const res = await request(
      {
        method: "POST",
        hostname: "auth.openai.com",
        path: "/oauth/token",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "codex-cli",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      payload,
    );
    if (res.status !== 200) throw new Error(`refresh HTTP ${res.status}`);
    const parsed = JSON.parse(res.body);
    if (!parsed.access_token) throw new Error("refresh without access_token");
    const doc = JSON.parse(fs.readFileSync(account.file, "utf8"));
    doc.tokens = doc.tokens || {};
    doc.tokens.access_token = parsed.access_token;
    if (parsed.refresh_token) doc.tokens.refresh_token = parsed.refresh_token;
    if (parsed.id_token) doc.tokens.id_token = parsed.id_token;
    doc.last_refresh = new Date().toISOString();
    const tmp = `${account.file}.calive-tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, account.file);
    api.log.info(`[codex-account-manager] token refreshed: ${account.email || account.label}`);
    return { ...account, accessToken: parsed.access_token };
  }

  function windowSeconds(w) {
    for (const k of ["limit_window_seconds", "window_seconds"]) {
      if (typeof w[k] === "number" && w[k] > 0) return w[k];
    }
    for (const k of ["window_duration_mins", "windowDurationMins", "window_minutes"]) {
      if (typeof w[k] === "number" && w[k] > 0) return w[k] * 60;
    }
    return null;
  }

  /**
   * Unknown durations already reported, so the log says it ONCE per duration and
   * not once per account on every read.
   */
  const unknownWindows = new Set();

  /** By DURATION, never by position: the backend may return only the weekly one. */
  function classify(s) {
    if (s === null) return null;
    if (Math.abs(s - FIVE_HOUR_SECONDS) / FIVE_HOUR_SECONDS < 0.01) return "fiveHour";
    if (Math.abs(s - WEEKLY_SECONDS) / WEEKLY_SECONDS < 0.01) return "weekly";
    /**
     * A new window - monthly, daily, whatever it is - is still discarded on
     * purpose: showing a number we cannot label would be worse than not showing it.
     *
     * What changed is that discarding it SILENTLY left the discovery up to chance:
     * the only clue would be the panel stopping to make sense, with nothing saying
     * why. Now the log records the exact duration, and a single line of code is
     * enough to adopt the new window.
     */
    if (!unknownWindows.has(s)) {
      unknownWindows.add(s);
      api.log.info(
        `[codex-account-manager] unrecognized limit window: ${s}s ` +
          `(~${Math.round((s / 3600) * 10) / 10}h). Ignored in the panel.`,
      );
    }
    return null;
  }

  /**
   * Requires used_percent: without it, rendering would be claiming "full account".
   *
   * The reset leaves here already resolved to ABSOLUTE MILLISECONDS, a single shape
   * so the renderer never has to guess the unit. Measured on the real payload:
   *   "limit_window_seconds": 18000, "reset_after_seconds": 16224,
   *   "reset_at": 1789284117            (epoch in SECONDS, not ms)
   * `reset_after_seconds` wins because it is relative and immune to local clock
   * drift; anchoring it on our own Date.now() at the moment of the read gives the
   * correct absolute instant even when the machine clock is wrong.
   */
  function parseWindow(w) {
    if (!w || typeof w !== "object" || typeof w.used_percent !== "number") return null;
    let resetAtMs = null;
    if (typeof w.reset_after_seconds === "number" && w.reset_after_seconds >= 0) {
      resetAtMs = Date.now() + w.reset_after_seconds * 1000;
    } else if (typeof w.reset_at === "number" && w.reset_at > 0) {
      resetAtMs = w.reset_at < 1e12 ? w.reset_at * 1000 : w.reset_at;
    }
    return {
      key: classify(windowSeconds(w)),
      remaining: Math.max(0, 100 - w.used_percent),
      resetAtMs,
    };
  }

  async function usageFor(account) {
    const headers = {
      Authorization: `Bearer ${account.accessToken}`,
      "User-Agent": "codex-cli",
      Accept: "application/json",
      // A quota read must never be served from a cache. This is a plain GET to a
      // stable URL, which is exactly the shape any intermediary feels free to
      // reuse, and a reused body is a panel showing numbers from before the reset.
      // NOT MEASURED which layer was caching, if any; these two headers are the
      // cheap way to take the question off the table.
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    };
    if (account.accountId) headers["ChatGPT-Account-Id"] = account.accountId;
    if (account.isFedramp) headers["X-OpenAI-Fedramp"] = "true";
    const res = await request({
      method: "GET",
      hostname: "chatgpt.com",
      path: "/backend-api/wham/usage",
      headers,
    });
    if (res.status === 401) {
      const e = new Error("401");
      e.unauthorized = true;
      throw e;
    }
    // 5xx is transient and was observed on this machine as an intermittent HTTP 503
    // on one account. One extra attempt avoids painting the row as an error because
    // of a momentary backend hiccup. A GET with no body, so retrying is cheap and
    // consumes no quota.
    if (res.status >= 500) {
      await new Promise((r) => setTimeout(r, 400));
      const again = await request({
        method: "GET",
        hostname: "chatgpt.com",
        path: "/backend-api/wham/usage",
        headers,
      });
      if (again.status === 200) return JSON.parse(again.body);
      throw new Error(`HTTP ${again.status}`);
    }
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return JSON.parse(res.body);
  }

  function toRow(account, payload) {
    const rl = (payload && payload.rate_limit) || {};
    const w = {};
    for (const slot of ["primary_window", "secondary_window"]) {
      const p = parseWindow(rl[slot]);
      if (p && p.key && !w[p.key]) w[p.key] = p;
    }
    const credits = payload && payload.rate_limit_reset_credits;
    return {
      label: account.label,
      email: account.email,
      plan: (payload && payload.plan_type) || account.plan,
      current: Boolean(account.current),
      fiveHour: w.fiveHour || null,
      weekly: w.weekly || null,
      // From the backend; never inferred from the percentage.
      blocked:
        typeof rl.limit_reached === "boolean"
          ? rl.limit_reached
          : typeof rl.allowed === "boolean"
            ? !rl.allowed
            : null,
      // `rate_limit_reset_credits.available_count` - the same number the native
      // menu shows as "N resets available". Zero is a valid and informative value,
      // so 0 has to arrive as 0 and never become null.
      resets: credits && typeof credits.available_count === "number" ? credits.available_count : null,
      error: null,
    };
  }

  async function rowFor(account) {
    try {
      let live = account;
      if (live.exp !== null && live.exp * 1000 - Date.now() <= 5 * 60 * 1000) {
        live = await refresh(live);
      }
      try {
        return toRow(live, await usageFor(live));
      } catch (e) {
        if (!e || !e.unauthorized) throw e;
        live = await refresh(live);
        return toRow(live, await usageFor(live));
      }
    } catch (e) {
      return {
        label: account.label,
        email: account.email,
        plan: account.plan,
        current: Boolean(account.current),
        fiveHour: null,
        weekly: null,
        blocked: null,
        resets: null,
        error: String((e && e.message) || e),
      };
    }
  }

  /**
   * Always live. The 60s TTL was removed on purpose: the read is a free GET, so
   * there is no reason to show a stale number. `cache` stays only as a
   * last-known-value so the panel can paint something immediately while the
   * request runs, never as the final answer.
   */
  handle("usage:all", async () => {
    const rows = await Promise.all(collect().map(rowFor));
    cache = { at: Date.now(), rows };
    return { rows, cached: false };
  });

  handle("usage:last", async () => ({ rows: cache.rows, cached: true }));

  /**
   * Switches the active account by copying the saved snapshot over `auth.json`.
   *
   * Before writing, it keeps the current auth.json in
   * `~/.codex/auth_backups_accounts_live/`. That protects the CREDENTIAL, not the
   * conversations: the app filters the conversation list by the active account
   * while the database records no per-row owner, so the sidebar may look empty
   * after a switch. The data is still in thread_history_1.sqlite.
   */
  handle("account:switch", async (opts) => {
    const label = opts && opts.label;
    if (!label || typeof label !== "string" || /[\\/]/.test(label)) {
      throw new Error("invalid account name");
    }
    const source = path.join(accountsDir, `${label}.json`);
    if (!fs.existsSync(source)) throw new Error(`snapshot missing: ${label}`);
    fs.mkdirSync(backupsDir, { recursive: true });
    if (fs.existsSync(authFile)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(authFile, path.join(backupsDir, `auth-${stamp}.json`));
    }

    // The account that is LEAVING becomes a snapshot BEFORE any write to
    // auth.json. Without this line, switching accounts erased the freshly added
    // one: it existed only in auth.json and the next step overwrites it.
    const outgoing = readAuth(authFile, "__active__");
    if (outgoing) {
      const kept = saveActiveSnapshot(outgoing, source);
      if (kept) api.log.info(`[codex-account-manager] outgoing account preserved as ${kept}`);
    }

    const tmp = `${authFile}.calive-tmp`;
    fs.copyFileSync(source, tmp);
    fs.renameSync(tmp, authFile);
    cache = { at: 0, rows: null };
    api.log.info(`[codex-account-manager] active account switched to ${label}`);
    return { ok: true };
  });

  /**
   * Reopens the app. `app.relaunch()` respawns `process.execPath`, which on the
   * mirrored MSIX app never comes back - it was measured: Codex closed and did not
   * open. Here we fire our own decoupled launcher, which points at the correct
   * ChatGPT.exe of the mirror.
   */
  /**
   * Saves the current session as a snapshot and clears auth.json, so the app opens
   * on the sign-in screen. This is the complete "add account", without going
   * through Settings.
   *
   * It keeps auth.json in auth_backups_accounts_live before clearing: without that,
   * a failure here would cost the sign-in of the active account.
   */
  handle("account:add", async () => {
    const active = readAuth(authFile, "__active__");
    if (!active) throw new Error("no active session to preserve");
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(authFile, path.join(backupsDir, `auth-${stamp}.json`));
    // Always overwrites. The previous version did `if (!existsSync) copy`, which
    // left a snapshot with a stale refresh token when the account already had a
    // file - and refresh tokens rotate, so that sign-in would die later.
    const saved = saveActiveSnapshot(active);
    fs.rmSync(authFile, { force: true });
    cache = { at: 0, rows: null };
    api.log.info(`[codex-account-manager] session saved as ${saved}; auth cleared for a new sign-in`);
    return { ok: true, saved };
  });

  /**
   * Forgets an account: deletes the snapshot from `auth_accounts`. It is
   * destructive (that account's sign-in is lost), which is why the file is copied
   * to auth_backups_accounts_live first, with a `removed-` prefix. The UI still
   * requires a second confirmation click.
   *
   * It never removes the ACTIVE account: deleting its snapshot would leave
   * auth.json with no saved counterpart, and the next switch would have no way back.
   */
  handle("account:remove", async (opts) => {
    const label = opts && opts.label;
    if (!label || typeof label !== "string" || /[\\/]/.test(label) || label === "__active__") {
      throw new Error("invalid account name");
    }
    const source = path.join(accountsDir, `${label}.json`);
    if (!fs.existsSync(source)) throw new Error(`snapshot missing: ${label}`);
    const active = readAuth(authFile, "__active__");
    const candidate = readAuth(source, label);
    if (
      active &&
      candidate &&
      active.email &&
      candidate.email &&
      active.email.toLowerCase() === candidate.email.toLowerCase()
    ) {
      throw new Error("do not remove the active account");
    }
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(source, path.join(backupsDir, `removed-${label}-${stamp}.json`));
    fs.rmSync(source, { force: true });
    cache = { at: 0, rows: null };
    api.log.info(`[codex-account-manager] snapshot removed: ${label}`);
    return { ok: true };
  });

  function findAccount(label) {
    const list = collect();
    if (!label) return list.find((a) => a.current) || null;
    return list.find((a) => a.label === label) || null;
  }

  function authHeaders(account, extra) {
    const headers = {
      Authorization: `Bearer ${account.accessToken}`,
      "User-Agent": "codex-cli",
      Accept: "application/json",
    };
    if (account.accountId) headers["ChatGPT-Account-Id"] = account.accountId;
    if (account.isFedramp) headers["X-OpenAI-Fedramp"] = "true";
    return Object.assign(headers, extra || {});
  }

  async function resetCreditsFor(account) {
    const res = await request({
      method: "GET",
      hostname: "chatgpt.com",
      path: "/backend-api/wham/rate-limit-reset-credits",
      headers: authHeaders(account),
    });
    if (res.status === 401) {
      const e = new Error("401");
      e.unauthorized = true;
      throw e;
    }
    if (res.status !== 200) throw new Error(`credits HTTP ${res.status}`);
    return JSON.parse(res.body);
  }

  /**
   * The numbers that a reset is supposed to CHANGE, as one comparable string.
   *
   * Used to tell a confirmed reset from a request the server accepted but has not
   * applied to the quota yet. Both windows plus the credit count, because a reset
   * moves at least one of the three; comparing the raw `used_percent` rather than
   * our rounded `remaining` keeps a sub-1% move from reading as "nothing changed".
   */
  function usedFingerprint(payload) {
    const rl = (payload && payload.rate_limit) || {};
    const bits = [];
    for (const slot of ["primary_window", "secondary_window"]) {
      const w = rl[slot];
      bits.push(w && typeof w.used_percent === "number" ? String(w.used_percent) : "-");
    }
    const credits = payload && payload.rate_limit_reset_credits;
    bits.push(
      credits && typeof credits.available_count === "number" ? String(credits.available_count) : "-",
    );
    return bits.join("/");
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function consumeReset(account, creditId, requestId) {
    const payload = JSON.stringify({ credit_id: creditId, redeem_request_id: requestId });
    return request(
      {
        method: "POST",
        hostname: "chatgpt.com",
        path: "/backend-api/wham/rate-limit-reset-credits/consume",
        headers: authHeaders(account, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        }),
      },
      payload,
    );
  }

  /**
   * Consumes ONE limit reset from the given account.
   *
   * The endpoint and the contract were READ from the app's own bundle, not
   * inferred. `resources/app.asar` -> `webview/assets/app-initial-f094ef01c64d.js`,
   * VERBATIM:
   *   function N5i(){return _O.safeGet(`/wham/rate-limit-reset-credits`)}
   *   function F5i(e){let{creditId:t,redeemRequestId:n}=e;return _O.safePost(
   *     `/wham/rate-limit-reset-credits/consume`,
   *     {requestBody:{credit_id:t,redeem_request_id:n}})}
   * with the prefix from the same file: lFn=`https://chatgpt.com/backend-api`.
   *
   *   GET  /backend-api/wham/rate-limit-reset-credits
   *        -> { available_count, credits: [{ status: "available"|..., id, reset_type }] }
   *   POST /backend-api/wham/rate-limit-reset-credits/consume
   *        -> { code: "reset"|"already_redeemed"|"no_credit"|"nothing_to_reset",
   *             credit?: { id, reset_type } }
   *
   * IDEMPOTENCY: `redeem_request_id` is reused on retry. The app keeps the UUID
   * OUTSIDE the try and only reuses it when there was a transport failure
   * (`t??={...,redeemRequestId:crypto.randomUUID()}` + `hasTransportFailure`).
   * Generating a fresh UUID on retry would spend a SECOND credit.
   *
   * `credit_id` could be null - the app distinguishes
   * `redemptionMethod: creditId==null?"automatic":"selected_credit"` - but here we
   * send the explicit id of the first `available` credit, so a retry lands on the
   * same credit.
   *
   * NOT VERIFIED ON THIS MACHINE: the app authenticates this call through the
   * desktop session (cookie), while here we reuse the `Authorization: Bearer` that
   * already works for `/wham/usage`, under the same `/backend-api/wham/` prefix that
   * the app's `shouldInferCodexApiAuth` covers. I did NOT run a real consume: it
   * spends a credit and that is irreversible. If the backend refuses, we return the
   * raw HTTP for diagnosis instead of faking success.
   */
  handle("account:reset", async (opts) => {
    const label = opts && opts.label;
    const account = findAccount(label);
    if (!account) throw new Error(`account not found: ${label || "(active)"}`);

    let live = account;
    if (live.exp !== null && live.exp * 1000 - Date.now() <= 5 * 60 * 1000) {
      live = await refresh(live);
    }
    let credits;
    try {
      credits = await resetCreditsFor(live);
    } catch (e) {
      if (!e || !e.unauthorized) throw e;
      live = await refresh(live);
      credits = await resetCreditsFor(live);
    }

    const available = ((credits && credits.credits) || []).filter(
      (c) => c && c.status === "available",
    );
    if (!available.length) {
      api.log.info(`[codex-account-manager] no reset credit: ${live.email || live.label}`);
      return { code: "no_credit", remaining: 0 };
    }

    // Snapshot of the numbers BEFORE spending the credit. Without a "before" there
    // is nothing to compare against, and every later read would look like a
    // successful change. One extra free GET, only on this path.
    let before = null;
    try {
      before = usedFingerprint(await usageFor(live));
    } catch (e) {
      api.log.warn(`[codex-account-manager] could not snapshot usage before the reset: ${String(e)}`);
    }

    const creditId = available[0].id;
    const requestId = randomUUID();
    let res = await consumeReset(live, creditId, requestId);
    // Only a TRANSPORT failure justifies a retry, and with the SAME requestId.
    if (res.status >= 500) {
      api.log.warn(`[codex-account-manager] consume HTTP ${res.status}; retry with the same requestId`);
      res = await consumeReset(live, creditId, requestId);
    }
    if (res.status !== 200) {
      throw new Error(`consume HTTP ${res.status}: ${String(res.body).slice(0, 200)}`);
    }
    const parsed = JSON.parse(res.body);
    cache = { at: 0, rows: null };
    api.log.info(
      `[codex-account-manager] reset consumed on ${live.email || live.label}: code=${parsed.code}`,
    );

    /**
     * A 200 on the consume is NOT the quota being back.
     *
     * MEASURED SYMPTOM: the panel showed the "usage reset" note next to a 5 h bar
     * still at 0%, and only a close/reopen of the popover brought the real numbers.
     * The old code read usage exactly once, immediately after the consume, and
     * whatever came back became the truth - so a server that had accepted the
     * request but not yet applied it painted stale numbers and then sat there,
     * because the next scheduled fetch was 20 seconds away.
     *
     * So we now re-read until the numbers actually MOVE, with growing delays, and
     * report whether it was confirmed. `confirmed:false` is not a failure: the
     * credit was spent and the renderer keeps polling fast until it converges. The
     * point is that the panel never claims a change it has not seen.
     */
    const CONFIRM_DELAYS_MS = [400, 700, 1100, 1600, 2200, 3000];
    let row = null;
    let confirmed = false;
    for (const wait of CONFIRM_DELAYS_MS) {
      await sleep(wait);
      let payload;
      try {
        payload = await usageFor(live);
      } catch (e) {
        // A failed read here is not a failed reset; try the next delay.
        continue;
      }
      row = toRow(live, payload);
      if (before === null || usedFingerprint(payload) !== before) {
        confirmed = true;
        break;
      }
    }
    api.log.info(
      `[codex-account-manager] reset ${confirmed ? "confirmed by the server" : "not yet visible in usage"}: ` +
        `${live.email || live.label}`,
    );

    return { code: parsed.code, remaining: Math.max(0, available.length - 1), confirmed, row };
  });

  /**
   * Finds the Codex executable AT RUNTIME. No pinned version.
   *
   * The previous version carried a literal path with the package version written
   * inside it, which would break on the next Codex update and on any other machine.
   * On this machine the number ALREADY diverged when this was measured: the running
   * process came from a mirror at 26.903.9818.0 while the package installed in
   * WindowsApps was already 26.908.4834.0 - that is, the hardcoded path pointed at
   * an app five versions behind with nothing warning about it.
   *
   * Priority:
   *  1. `process.execPath` - we are INSIDE the app's main process, so this is
   *     literally the binary that opened this window. It is the exact answer and
   *     does not depend on knowing version, publisher or channel.
   *  2. the most recent mirror found in the known mirror folders.
   *  3. local Codex installs (Squirrel / Programs).
   */
  function newestFile(paths) {
    let best = null;
    for (const p of paths) {
      try {
        const st = fs.statSync(p);
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
      } catch {
        // A nonexistent path is the common case here; we move on.
      }
    }
    return best ? best.path : null;
  }

  function listDirs(dir) {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(dir, d.name));
    } catch {
      return [];
    }
  }

  function resolveCodexExe() {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");

    const self = process.execPath;
    if (self && /chatgpt\.exe$/i.test(path.basename(self)) && fs.existsSync(self)) {
      return { path: self, how: "process.execPath" };
    }

    const mirror = newestFile(
      listDirs(path.join(local, "codex-account-manager", "apps")).map((d) =>
        path.join(d, "app", "ChatGPT.exe"),
      ),
    );
    if (mirror) return { path: mirror, how: "own mirror" };

    const squirrel = newestFile(
      listDirs(path.join(local, "codex"))
        .filter((d) => /[\\/]app-/i.test(d))
        .map((d) => path.join(d, "ChatGPT.exe"))
        .concat([path.join(local, "Programs", "Codex", "ChatGPT.exe")]),
    );
    if (squirrel) return { path: squirrel, how: "local install" };

    return { path: self, how: "fallback process.execPath" };
  }

  /**
   * Id of the open conversation, so the app reopens where it was.
   *
   * MEASURED in the bundle: there is no session restore. ZERO occurrences of
   * `restoreLastSession`, `lastThread`, `lastRoute`, `persistedRoute`; the only
   * persisted window state is `electron-main-window-bounds`, which keeps geometry
   * and no route at all. Coming back to the home screen is by design.
   *
   * What does exist is deep linking: `codex://threads/<uuid>` passed as an ARGUMENT
   * to the executable arrives through `initialArgv:process.argv` and is drained at
   * the end of startup by `flushPendingDeepLinks`. There is no `--thread`.
   *
   * Since none of this is persisted, the id has to be captured BEFORE killing the
   * app. The renderer sends its own (exact, taken from the `/local/<uuid>` route);
   * if it does not arrive, we fall back to the most recent rollout, whose FILE NAME
   * carries the thread id:
   *   sessions/2026/09/13/rollout-2026-09-13T11-22-27-<threadUuid>_<otherUuid>.jsonl
   */
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  function newestRolloutThreadId() {
    const root = path.join(codexHome, "sessions");
    // Walks down the highest year/month/day in lexicographic order (zero-padded names).
    let dirs = [root];
    for (let depth = 0; depth < 3; depth += 1) {
      const next = [];
      for (const d of dirs) {
        const kids = listDirs(d).sort();
        // The last three days/months cover the case where today has no rollout yet.
        next.push(...kids.slice(-3));
      }
      if (!next.length) break;
      dirs = next;
    }
    const files = [];
    for (const d of dirs) {
      try {
        for (const name of fs.readdirSync(d)) {
          if (name.toLowerCase().endsWith(".jsonl")) files.push(path.join(d, name));
        }
      } catch {
        // Unreadable directory: skip it.
      }
    }
    const newest = newestFile(files);
    if (!newest) return null;
    const base = path.basename(newest);
    // Anchored on the `_` that separates the two uuids in the rollout name.
    const anchored = new RegExp(`-(${UUID_RE.source})_`, "i").exec(base);
    if (anchored) return anchored[1];
    const loose = UUID_RE.exec(base);
    return loose ? loose[0] : null;
  }

  handle("app:relaunch", async (opts) => {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");

    /**
     * CURRENT APPROACH: an external watcher that waits for the process to DISAPPEAR.
     *
     * The three previous attempts shared the same underlying defect - whoever
     * launched the new app depended on the process that was dying, or waited a
     * fixed amount of time in the dark:
     *
     *  1. plain `app.relaunch()` -> respawn of process.execPath, which on the
     *     mirrored MSIX app is not the binary that opens the window.
     *  2. `cmd` + a 4s `ping` -> a BLIND wait. If the app took longer than that to
     *     die, the new one came up with the singleton lock still held and exited.
     *     On top of opening a black console.
     *  3. `app.relaunch({execPath})` -> same result as 1.
     *
     * Now an independent watcher polls through WMI until there is NO ChatGPT.exe
     * process of the mirror left, and only then runs the binary. The condition is
     * an observed fact, not a clock.
     *
     * It runs under `wscript`, not `cmd` or PowerShell, because wscript is the only
     * Windows script host that creates no console - that is what opened the black
     * window in attempt 2.
     *
     * The WMI filter matches the EXACT ExecutablePath of the binary we are going to
     * relaunch. It used to be a `LIKE` on a folder name, which only worked for the
     * mirrored app: on a normal Codex install the filter would never match, the loop
     * would end by timeout and the new app would come up with the singleton lock
     * still held.
     */
    const resolved = resolveCodexExe();
    const execPath = resolved.path;

    // Deep link to come back to the conversation. The renderer sends the exact id
    // from the route; if it does not arrive, we use the most recent rollout.
    const wanted =
      opts && typeof opts.thread === "string" && UUID_RE.test(opts.thread)
        ? UUID_RE.exec(opts.thread)[0]
        : newestRolloutThreadId();
    const deepLink = wanted ? `codex://threads/${wanted}` : "";

    // WQL escapes a backslash by doubling it; without this the filter never matches.
    const wql = execPath.replace(/\\/g, "\\\\").replace(/'/g, "''");

    const vbs = path.join(backupsDir, "relaunch-watcher.vbs");
    const script = [
      "' Codex relaunch watcher, written by the codex-account-manager tweak.",
      "' Waits for the process to disappear and only then runs it again.",
      "Option Explicit",
      "Dim exePath, deepLink, svc, procs, waited, deadline, cmdline",
      "exePath = WScript.Arguments(0)",
      "If WScript.Arguments.Count > 1 Then",
      "  deepLink = WScript.Arguments(1)",
      "Else",
      "  deepLink = \"\"",
      "End If",
      "Set svc = GetObject(\"winmgmts:\\\\.\\root\\cimv2\")",
      "waited = 0",
      "deadline = 60000",
      "Do",
      "  WScript.Sleep 400",
      "  waited = waited + 400",
      "  Set procs = svc.ExecQuery(\"SELECT ProcessId FROM Win32_Process WHERE \" & _",
      `    "ExecutablePath='${wql}'")`,
      "  If procs.Count = 0 Then Exit Do",
      "Loop While waited < deadline",
      "' Slack for the OS to release the single-instance lock.",
      "WScript.Sleep 1500",
      "Dim sh",
      "Set sh = CreateObject(\"WScript.Shell\")",
      "cmdline = \"\"\"\" & exePath & \"\"\"\"",
      "If deepLink <> \"\" Then cmdline = cmdline & \" \"\"\" & deepLink & \"\"\"\"",
      "sh.Run cmdline, 1, False",
      "",
    ].join("\r\n");

    try {
      fs.mkdirSync(backupsDir, { recursive: true });
      fs.writeFileSync(vbs, script, "latin1");
      const args = ["//nologo", vbs, execPath];
      if (deepLink) args.push(deepLink);
      const child = spawn("wscript.exe", args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      api.log.info(
        `[codex-account-manager] watcher armed via ${resolved.how}: ${execPath}` +
          `${deepLink ? ` -> ${deepLink}` : " (no conversation to restore)"}`,
      );
    } catch (e) {
      api.log.warn(`[codex-account-manager] could not arm the watcher: ${String(e)}`);
      throw e;
    }

    // The watcher only acts once this process disappears, so we can exit right away.
    setTimeout(() => {
      try {
        eval("require")("electron").app.exit(0);
      } catch (e) {
        api.log.warn(`[codex-account-manager] exit failed: ${String(e)}`);
      }
    }, 250);
    return { ok: true, via: execPath };
  });

  /**
   * Guarantees a snapshot of the active account AT START, without waiting for a
   * switch.
   *
   * This covers the case `account:switch` alone does not: a sign-in performed
   * outside the panel (the sign-in screen after "Add another account", Codex
   * Settings, or the third-party switcher) leaves the account alive only in
   * auth.json. If the next write to that file comes from any path other than ours,
   * the credential is lost without ever having appeared in auth_accounts.
   *
   * It is idempotent and refreshes tokens: it reuses the file of the same e-mail and
   * overwrites it.
   */
  try {
    const active = readAuth(authFile, "__active__");
    if (active) {
      const kept = saveActiveSnapshot(active);
      if (kept) api.log.info(`[codex-account-manager] active account snapshot ensured: ${kept}`);
    }
  } catch (e) {
    api.log.warn(`[codex-account-manager] could not ensure the active snapshot: ${String(e)}`);
  }

  api.log.info(`[codex-account-manager] main half ready; CODEX_HOME=${codexHome}`);

  return () => {
    for (const full of registered) {
      try {
        ipcMain.removeHandler(full);
      } catch (e) {
        api.log.warn(`[codex-account-manager] removeHandler failed on ${full}: ${String(e)}`);
      }
    }
    registered.length = 0;
    api.log.info("[codex-account-manager] main half released");
  };
}

// ───────────────────────── renderer half (no require) ─────────────────────

/**
 * ─────────────────────────── language ───────────────────────────
 *
 * MEASURED in the app bundle (`resources/app.asar`), not inferred:
 *
 *  - the app uses react-intl with ONE catalog per language in
 *    `webview/assets/<locale>-<hash>.js`, 64 locales, generated from
 *    `../locales/<locale>.json`. English has NO catalog: it is the inline
 *    `defaultMessage` values in the code.
 *  - the provider resolves the locale and writes, in a `useEffect`, VERBATIM
 *    (`app-initial-f094ef01c64d.js`):
 *        S=()=>{document.documentElement.lang=x,document.documentElement.dir=qj(x)}
 *    That is the ONLY occurrence of `documentElement.lang` in the whole app code,
 *    and it is a WRITE. That is why `documentElement.lang` is the reliable read.
 *  - `navigator.language` does exist in the bundle, but its 6 occurrences are
 *    fingerprinting, Statsig (`browserLocale`) and mapbox-gl. It does NOT feed the
 *    UI, so using it would be guessing.
 *  - ZERO occurrences of a language `<meta>`, of `__NEXT_DATA__`, and of a language
 *    key in `localStorage`.
 *  - the host API does not expose a locale: it has manifest/storage/log/process/
 *    settings/react/ipc/fs/codex and nothing else. The panel detects it on its own.
 *
 * TWO TRAPS, both confirmed:
 *  1. `webview/index.html:2` is born with a HARDCODED `<html lang="en">`. Anyone
 *     reading before the first effect sees "en" even on a Portuguese app. That is
 *     why a raw "en" is treated as "not resolved yet" and we observe the attribute.
 *  2. `lang` says which locale was RESOLVED, not that the texts are translated:
 *     with the `enable_i18n` gate off the app shows English with lang="pt-BR".
 *     That affects only the NATIVE labels; ours follow `lang`.
 */
const STRINGS = {
  en: {
    quota: "Usage remaining",
    connected: (n) => `${n} connected ${n === 1 ? "subscription" : "subscriptions"}`,
    fiveHour: "5 h",
    weekly: "Weekly",
    noWindows: "quota not reported",
    subscription: (n) => `Subscription ${n}`,
    current: "current",
    addAnother: "Add another subscription",
    manage: "Manage subscriptions",
    activate: "Activate",
    forget: "Forget",
    confirmForget: "Confirm?",
    resets: (n) => `${n} ${n === 1 ? "reset" : "resets"}`,
    resetsTitle: "Usage limit resets available on this subscription",
    useReset: "Use reset?",
    resetting: "resetting…",
    resetDone: "usage reset",
    resetNone: "no resets available",
    resetAlready: "this reset was already used",
    resetNothing: "usage does not need a reset right now",
    showEmail: "Show email",
    hideEmail: "Hide email",
    now: "now",
    min: "min",
    // Short month names for the reset column. A fixed table, because
    // toLocaleDateString adds separators that do not fit in 84px.
    months: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
    limitReached: "limit reached",
    noSnapshot: "this subscription has no saved snapshot",
    switching: (who) => `switching to ${who}…`,
    reopening: "subscription switched. reopening Codex…",
    savingSession: "saving current session…",
    savedAs: (who) => `saved as ${who}. reopening to sign in…`,
    failed: (why) => `failed: ${why}`,
    unavailable: (why) => `usage unavailable: ${why}`,
    resetsAt: (caption, when) => `${caption}: resets ${when}`,
    nativeFallback: "native usage menu restored — use it to reset",
  },
  pt: {
    quota: "Cota restante",
    connected: (n) => `${n} ${n === 1 ? "assinatura conectada" : "assinaturas conectadas"}`,
    fiveHour: "5 h",
    weekly: "Semanal",
    noWindows: "cota nao informada",
    subscription: (n) => `Assinatura ${n}`,
    current: "atual",
    addAnother: "Adicionar outra assinatura",
    manage: "Gerenciar assinaturas",
    activate: "Ativar",
    forget: "Esquecer",
    confirmForget: "Confirmar?",
    resets: (n) => `${n} ${n === 1 ? "redefini\u00e7\u00e3o" : "redefini\u00e7\u00f5es"}`,
    resetsTitle: "Redefini\u00e7\u00f5es de limite dispon\u00edveis nesta assinatura",
    useReset: "Usar redefini\u00e7\u00e3o?",
    resetting: "redefinindo\u2026",
    resetDone: "cota redefinida",
    resetNone: "nenhuma redefini\u00e7\u00e3o dispon\u00edvel",
    resetAlready: "esta redefini\u00e7\u00e3o j\u00e1 foi usada",
    resetNothing: "a cota n\u00e3o precisa de redefini\u00e7\u00e3o agora",
    showEmail: "Mostrar e-mail",
    hideEmail: "Esconder e-mail",
    now: "agora",
    min: "min",
    months: ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"],
    limitReached: "limite atingido",
    noSnapshot: "esta assinatura n\u00e3o tem snapshot salvo",
    switching: (who) => `trocando para ${who}\u2026`,
    reopening: "assinatura trocada. reabrindo o Codex\u2026",
    savingSession: "salvando sess\u00e3o atual\u2026",
    savedAs: (who) => `sess\u00e3o salva como ${who}. reabrindo para login\u2026`,
    failed: (why) => `falhou: ${why}`,
    unavailable: (why) => `cota indispon\u00edvel: ${why}`,
    resetsAt: (caption, when) => `${caption}: volta em ${when}`,
    nativeFallback: "menu nativo de uso restaurado \u2014 use ele para redefinir",
  },
};

function startRenderer(api) {
  const MARK = "data-cam-panel";

  /**
   * Matches by language PREFIX, reproducing what the app itself does in
   * `KAt={es:"es-419",fr:"fr-FR",pt:"pt-BR",zh:"zh-CN"}`: this way pt-BR and pt-PT
   * fall into the same bucket, and so do es-419/es-ES.
   */
  let dict = STRINGS.en;
  /**
   * Never throws. `document.documentElement` can be NULL.
   *
   * Measured: under a preload that runs at `document-start`, this function blew up
   * with `Cannot read properties of null (reading 'lang')` and took down the start
   * in 12 of 16 frames - including the main window's, which is precisely the only
   * one that matters. The panel simply did not appear, with no symptom on screen.
   * Under the previous host this never showed up because it loaded the panel later;
   * the fragility was here the whole time, just covered up.
   */
  function refreshDict() {
    const el = typeof document !== "undefined" && document ? document.documentElement : null;
    const raw = el && el.lang ? String(el.lang) : "";
    // A raw "en" = the static index.html, the provider has not written the real one yet.
    const prefix = raw && raw !== "en" ? raw.split("-")[0].toLowerCase() : "en";
    dict = STRINGS[prefix] || STRINGS.en;
  }
  refreshDict();

  /** Translated label; a function when it needs an argument. */
  function t(key, ...args) {
    const value = dict[key] !== undefined ? dict[key] : STRINGS.en[key];
    return typeof value === "function" ? value(...args) : value;
  }

  let cachedRows = null;
  let busy = false;
  // "list" or "manage". The gear toggles between them, without opening Codex Settings.
  let view = "list";
  // Label of the account with "Forget" armed, waiting for the second click.
  let confirming = null;
  // Label of the account with the quota reset armed (two clicks, like the app).
  let confirmingReset = null;
  // Accounts with the e-mail revealed by the eye. Starts empty: masked by default.
  const revealed = new Set();
  // Transient per-account message (the result of the reset).
  const notes = new Map();

  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  /**
   * Id of the conversation open right now, read from the renderer route.
   *
   * The app's internal route for a local conversation is `/local/<uuid>` - confirmed
   * in the bundle: `function fm(e){let t=e?.match(/^\/local\/([^/?#]+)/)`. We prefer
   * the prefixed form; if the route is not in the URL (in-memory router), we accept
   * any UUID present, and if nothing shows up main uses the most recent rollout.
   */
  function currentThreadId() {
    try {
      const hay = `${location.pathname}${location.search}${location.hash}`;
      const scoped = new RegExp(`/local/(${UUID_RE.source})`, "i").exec(hay);
      if (scoped) return scoped[1];
      const loose = UUID_RE.exec(hay);
      if (loose) return loose[0];
      api.log.info("[codex-account-manager] route without conversation id; main will use the most recent rollout");
      return null;
    } catch (e) {
      api.log.warn(`[codex-account-manager] reading the route failed: ${String(e)}`);
      return null;
    }
  }

  const compact = (el) => String((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  /**
   * NO \b anchors. Measured in this machine's log: the aggregated menu text comes
   * concatenated with no spaces -
   *   "<name>PlusUsage remainingShow mascotAlt+Win+PSettingsCtrl+,Sign out"
   * Between the "P" of "Alt+Win+P" and the "S" of "Settings" there is no word
   * boundary, so \bsettings... never matches. The specificity comes from the three
   * combined conditions plus the visibility check.
   */
  /**
   * THERE IS NO attribute hook on the "Usage remaining" item. This was MEASURED, and
   * the previous attempt at using one is recorded here so it is not repeated.
   *
   * In the bundle, the item is the SubTrigger of a `DropdownMenu.Sub`, and the Radix
   * primitive does declare the attribute (`app-initial-f094ef01c64d.js`, VERBATIM):
   *   jsx(ys.button,{type:`button`,role:`menuitem`,id:c.triggerId,
   *     "aria-haspopup":`menu`,"aria-expanded":p,...})
   * It looked like the perfect selector, language-independent. But the live DOM says
   * otherwise - output of this tweak's own diagnostic:
   *   menu shape: items=5 haspopupMenu=0 haspopupAny=0 menuitem=5
   * ZERO `aria-haspopup` on any item. The `asChild` chain
   * (SubTrigger -> Rd.Item -> MenuItem -> div) does not propagate the attribute down
   * to the final element. Also ZERO `data-testid`, own `id` and `aria-label` (I swept
   * all 267 `data-testid` values in the bundle).
   *
   * Two signals remain: the label TEXT (translated, 64 languages) and the keyboard
   * SHORTCUT (not translated). The shortcut is what makes the detection universal.
   */
  /**
   * Containers that may be the account popover. Used to FIND the menu and to FILTER
   * mutations - the filter is what avoids sweeping the whole screen on every DOM
   * change.
   */
  /**
   * `[data-radix-popper-content-wrapper]` LEFT this selector, and that is half of the
   * fix for the Settings freeze.
   *
   * That attribute matches ANY live Radix popper - tooltip, select, a dropdown of the
   * Settings screen itself - and not only the account popover. Every matched candidate
   * paid for an item count, a `textContent` read of the entire subtree and a
   * `getBoundingClientRect` (synchronous layout). On a screen full of poppers that
   * multiplied the cost of every sweep.
   *
   * The wrapper was not necessary: it CONTAINS the menu content, and the content has
   * `role="menu"` or `data-radix-menu-content`. Looking for the content directly
   * finds the same menu through a cheaper and more specific path.
   */
  const MENU_SEL = '[role="menu"], [data-radix-menu-content]';
  /**
   * Used only to walk UP from our panel to the container holding it, on a cold path
   * (restoring the native item). Here the wrapper is useful and costs nothing,
   * because `closest` climbs the parent chain instead of sweeping the document.
   */
  const MENU_CLOSEST_SEL = `${MENU_SEL}, [data-radix-popper-content-wrapper]`;

  function findMenu() {
    const nodes = document.querySelectorAll(MENU_SEL);
    for (const node of nodes) {
      // Deliberate order, from cheapest to most expensive. `visible()` MOVED to the
      // end: it calls `getBoundingClientRect`, which FORCES a layout calculation, and
      // it used to be the second gate - that is, it paid reflow on every candidate,
      // including the ones about to be discarded by text right after. Now only the
      // candidate that already matched by text or by shape pays reflow, at most one
      // per sweep.
      //   1. count menu items  - DOM only, does not touch layout (and now counts ONCE)
      //   2. compact()         - subtree text, already restricted to real menus
      //   3. visible()         - getBoundingClientRect, FORCES layout
      const itemCount = node.querySelectorAll('[role="menuitem"]').length;
      if (itemCount < 3) continue;
      const text = compact(node);
      // The English label "rate limits remaining" NO LONGER exists: a grep across
      // 8,012 webview files returned ZERO occurrences. It became "usage remaining"
      // (`composer.mode.rateLimit.heading`). The old matcher was dead code.
      const byText =
        /(settings|configura[c\u00e7][o\u00f5]es|defini[c\u00e7][o\u00f5]es)/i.test(text) &&
        /(log out|sair|terminar sess[a\u00e3]o)/i.test(text) &&
        /(usage remaining|uso restante|utiliza[c\u00e7][a\u00e3]o restante|personal account|conta pessoal)/i.test(
          text,
        );
      // STRUCTURAL fallback, for the other 62 languages: the account popover is the
      // only visible menu that has exactly one sub-trigger and several items.
      // MEASURED on this machine's live DOM:
      //   menu shape: items=5 haspopupMenu=0 haspopupAny=0 menuitem=5
      // In other words: `aria-haspopup` does NOT exist on any item. Radix's `asChild`
      // chain (SubTrigger -> Rd.Item -> MenuItem -> div) does not propagate the
      // attribute, so any fallback based on it is dead code.
      //
      // The remaining language-independent signal is the keyboard SHORTCUT: the
      // Settings item shows "Ctrl+," and the mascot one "Alt+Win+P". That showed up in
      // the aggregated text measured in the log:
      //   "...Usage remainingShow mascotAlt+Win+PSettingsCtrl+,Sign out"
      // A shortcut is not translated, so it works in any of the 64 languages.
      const byShape = itemCount >= 4 && /(ctrl\+,|\u2318,|cmd\+,)/i.test(text);
      if (!byText && !byShape) continue;
      // Last gate, and the only one that touches layout.
      if (!visible(node)) continue;
      // No wrapper unwrapping: `MENU_SEL` already looks for the menu content
      // directly, so `node` IS the menu.
      return node;
    }
    return null;
  }

  /**
   * Returns `{ el, isNativeUsage }` instead of just the element.
   *
   * `isNativeUsage` is what authorizes hiding: the anchor may have landed on the
   * Settings item or on the menu's first child, and hiding EITHER of those would
   * erase the wrong thing. We only hide when we know that row is the native usage one.
   */
  function findAnchor(menu) {
    const items = Array.from(menu.querySelectorAll('button, a, [role="menuitem"]'));
    const byText = items.find((el) =>
      /(usage remaining|uso restante|utiliza[c\u00e7][a\u00e3]o restante)/i.test(compact(el)),
    );
    if (byText) return { el: byText, isNativeUsage: true };
    const settings = items.find((el) =>
      /(settings|configura[c\u00e7][o\u00f5]es|defini[c\u00e7][o\u00f5]es)/i.test(compact(el)),
    );
    if (settings) return { el: settings, isNativeUsage: false };
    const first = Array.from(menu.children).find((c) => c instanceof HTMLElement);
    return first ? { el: first, isNativeUsage: false } : null;
  }

  /**
   * A ONE-TIME diagnostic of the real menu shape.
   *
   * It exists because the selector `[role="menuitem"][aria-haspopup="menu"]`, read
   * from the bundle, did NOT match in the live DOM: the "Usage remaining" item stayed
   * visible while the TEXT anchor hit that same row. Radix's `asChild` chain
   * (SubTrigger -> Rd.Item -> MenuItem -> div) may not propagate `aria-haspopup` down
   * to the final element. Instead of guessing which attribute survived, we print the
   * real attributes.
   */
  function dumpMenuShape(menu) {
    if (said.has("shape")) return;
    said.add("shape");
    const rows = Array.from(menu.querySelectorAll('button, a, [role="menuitem"], [aria-haspopup]'));
    const lines = rows.slice(0, 14).map((el, i) => {
      const attrs = ["role", "aria-haspopup", "aria-expanded", "data-state", "data-testid", "id"]
        .map((a) => (el.hasAttribute(a) ? `${a}=${el.getAttribute(a)}` : null))
        .filter(Boolean)
        .join(" ");
      return `#${i} <${el.tagName.toLowerCase()}> ${attrs || "(no attributes)"} :: ${compact(el).slice(0, 28)}`;
    });
    api.log.info(
      `[codex-account-manager] menu shape: items=${rows.length} ` +
        `haspopupMenu=${menu.querySelectorAll('[aria-haspopup="menu"]').length} ` +
        `haspopupAny=${menu.querySelectorAll("[aria-haspopup]").length} ` +
        `menuitem=${menu.querySelectorAll('[role="menuitem"]').length}`,
    );
    for (const line of lines) api.log.info(`[codex-account-manager] ${line}`);
  }

  const FG = "var(--color-token-text-primary,currentColor)";
  const DIM = "var(--color-token-text-secondary,currentColor)";
  const HOVER = "color-mix(in srgb,currentColor 8%,transparent)";

  /** Green at 100, amber in the middle, red at 0. */
  function barColor(remaining) {
    const pct = Math.max(0, Math.min(100, remaining));
    const hue = Math.round((pct / 100) * 130); // 0 red -> 130 green
    const light = pct <= 12 ? 52 : 45;
    return `hsl(${hue} 72% ${light}%)`;
  }

  function avatar(seed, size) {
    const s = size || 22;
    const text = String(seed || "?");
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360;
    const el = document.createElement("span");
    el.textContent = (text.trim()[0] || "?").toUpperCase();
    el.style.cssText =
      `flex:none;width:${s}px;height:${s}px;border-radius:50%;display:flex;` +
      `align-items:center;justify-content:center;font-size:${Math.round(s * 0.5)}px;` +
      `font-weight:600;color:#fff;background:hsl(${hash} 58% 45%);` +
      "user-select:none;";
    return el;
  }

  function gaugeIcon() {
    const span = document.createElement("span");
    span.setAttribute("aria-hidden", "true");
    span.style.cssText =
      "flex:none;width:22px;height:22px;display:flex;align-items:center;justify-content:center;" +
      `color:${DIM};`;
    span.innerHTML =
      '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
      '<circle cx="10" cy="10" r="7.25" stroke="currentColor" stroke-width="1.5"/>' +
      '<path d="M10 10 13.2 7.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
      "</svg>";
    return span;
  }

  function progressBar(remaining) {
    const track = document.createElement("span");
    track.style.cssText =
      "display:block;height:4px;border-radius:999px;overflow:hidden;" +
      "background:color-mix(in srgb,currentColor 14%,transparent);";
    const fill = document.createElement("span");
    const pct = Math.max(0, Math.min(100, remaining));
    fill.style.cssText =
      `display:block;height:100%;width:${pct}%;border-radius:999px;` +
      `background:${barColor(pct)};transition:width 220ms ease,background 220ms ease;`;
    track.appendChild(fill);
    return track;
  }

  /**
   * EVERY reset text comes from ONE single delta, rounded to the minute.
   *
   * The first version had one function for the absolute time and another for the
   * duration, each calling `Date.now()`. The few milliseconds between the two calls
   * pushed the delta below the boundary and produced, measured:
   *   exactly 1 hour -> "60 min"          (should be "1h00")
   *   exactly 24h    -> "23:54 · 24h00"   (time and duration contradicting each other)
   *   6 days         -> "5d"              (floor over 5.9999 days)
   * Rounding to the minute first absorbs that slack, and deriving both halves from the
   * SAME value makes it impossible for them to disagree.
   */
  function resetParts(resetAtMs) {
    const delta = resetAtMs - Date.now();
    if (delta <= 0) return null;
    const mins = Math.max(1, Math.round(delta / 60000));
    return { mins, hours: Math.floor(mins / 60), days: Math.floor(mins / 1440) };
  }

  /**
   * The ABSOLUTE instant when the window comes back: time of day when it is less than
   * a day away, a date when it is further. It is the native menu's "when does it come
   * back", which shows `00:43` for the 5h one and `Sep 17` for the weekly one.
   *
   * Month from a fixed table instead of toLocaleDateString: the localized version
   * returns "17 de set." with that " de " in the middle, which does not fit the column.
   * The table follows the panel language, so an English UI never shows Portuguese
   * month names.
   */
  function resetAbs(resetAtMs, parts) {
    const d = new Date(resetAtMs);
    if (parts.mins < 1440) {
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    const months = t("months");
    return `${d.getDate()} ${months[d.getMonth()]}`;
  }

  /** How much is LEFT, in days, hours or minutes depending on the distance. */
  function resetRel(parts) {
    if (parts.mins < 60) return `${parts.mins} ${t("min")}`;
    if (parts.mins < 1440) {
      return `${parts.hours}h${String(parts.mins % 60).padStart(2, "0")}`;
    }
    return `${parts.days}d`;
  }

  /** "04:21 · 4h30" or "19 sep · 6d". Empty when the backend did not report it. */
  function resetText(win) {
    if (!win || typeof win.resetAtMs !== "number") return "";
    const parts = resetParts(win.resetAtMs);
    // `t("now")` and not a literal: this string is shown in the panel and the panel
    // follows the app language.
    if (!parts) return t("now");
    return `${resetAbs(win.resetAtMs, parts)} \u00b7 ${resetRel(parts)}`;
  }

  /** One "label / bar / percentage / reset" row for a limit window. */
  function windowLine(caption, win) {
    const row = document.createElement("span");
    // 44px in the first column fits "Semanal" at 10px without wrapping; using the same
    // words as the native block avoids "Sem.", which in Portuguese reads as "without".
    // 84px in the last one fits "04:21 · 4h30" and "19 sep · 6d" with no ellipsis.
    row.style.cssText =
      "display:grid;grid-template-columns:44px minmax(0,1fr) 32px 84px;column-gap:6px;" +
      "align-items:center;";
    const cap = document.createElement("span");
    cap.textContent = caption;
    cap.style.cssText = `font-size:10px;color:${DIM};white-space:nowrap;`;
    const pct = document.createElement("span");
    pct.textContent = win ? `${Math.round(win.remaining)}%` : "-";
    pct.style.cssText =
      `font-size:10px;color:${DIM};text-align:right;font-variant-numeric:tabular-nums;`;
    const reset = document.createElement("span");
    reset.textContent = resetText(win);
    reset.style.cssText =
      `font-size:10px;color:${DIM};text-align:right;white-space:nowrap;` +
      "font-variant-numeric:tabular-nums;";
    // No `title`: the panel already shows time and duration on the row itself, and the
    // system tooltip appearing on top of the menu only got in the way.
    row.append(cap, progressBar(win ? win.remaining : 0), pct, reset);
    return row;
  }

  function resetsText(count) {
    if (typeof count !== "number") return "";
    return t("resets", count);
  }

  /** The window with the least quota left: that is the one blocking use right now. */
  function limitingWindow(entry) {
    const both = [entry.fiveHour, entry.weekly].filter(Boolean);
    if (!both.length) return null;
    return both.reduce((a, b) => (b.remaining < a.remaining ? b : a));
  }

  function hoverable(el) {
    el.addEventListener("mouseenter", () => {
      el.style.background = HOVER;
    });
    el.addEventListener("mouseleave", () => {
      el.style.background = el.dataset.baseBg || "transparent";
    });
    // The Radix menu closes on the first pointerdown; stopping propagation keeps the
    // panel open while the action runs.
    el.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
  }

  /**
   * The aggregate of BOTH windows, summing what is left on each account. It goes past
   * 100% on purpose: with 3 accounts the ceiling is 300%, and the number answers "how
   * much quota do I have in total", which is the whole reason for having several
   * accounts.
   */
  function headerRow(rows, panel) {
    const sum = (key) => {
      const usable = rows.filter((r) => r[key]);
      if (!usable.length) return null;
      return usable.reduce((s, r) => s + r[key].remaining, 0);
    };
    const totalFive = sum("fiveHour");
    const totalWeek = sum("weekly");

    const el = document.createElement("div");
    el.style.cssText =
      "display:grid;grid-template-columns:26px minmax(0,1fr) auto auto;column-gap:8px;" +
      "align-items:center;padding:7px 10px 7px 10px;";
    el.appendChild(gaugeIcon());
    const mid = document.createElement("span");
    mid.style.cssText = "display:flex;flex-direction:column;min-width:0;";
    const t1 = document.createElement("span");
    t1.textContent = t("quota");
    t1.style.cssText = `font-size:13px;color:${FG};`;
    const t2 = document.createElement("span");
    t2.textContent = t("connected", rows.length);
    t2.style.cssText = `font-size:11px;color:${DIM};`;
    mid.append(t1, t2);
    el.appendChild(mid);

    const agg = document.createElement("span");
    agg.style.cssText =
      "display:flex;flex-direction:column;align-items:flex-end;gap:1px;flex:none;";
    // Same rule as the body: a row no account reported is not drawn. With the 5-hour
    // limit removed, the header shows only `Weekly`, instead of a `5 h -` that suggests
    // there is a limit whose read failed.
    for (const [cap, total] of [
      [t("fiveHour"), totalFive],
      [t("weekly"), totalWeek],
    ].filter(([, total]) => total !== null)) {
      const line = document.createElement("span");
      line.style.cssText =
        `font-size:11px;color:${DIM};font-variant-numeric:tabular-nums;white-space:nowrap;`;
      const value = document.createElement("b");
      value.textContent = total === null ? "-" : `${Math.round(total)}%`;
      value.style.cssText = `color:${FG};font-weight:600;`;
      line.append(`${cap} `, value);
      agg.appendChild(line);
    }
    el.appendChild(agg);
    if (panel) el.appendChild(gearButton(panel));
    return el;
  }

  /**
   * STABLE order by e-mail, and the subscription number comes from this order.
   *
   * `collect()` returns the ACTIVE account first, which was fine for the old list but
   * is bad now: if the number came from the delivered position, "Subscription 2" would
   * change owner on every account switch, and the label would stop identifying
   * anything. Ordering by e-mail pins the number to the account.
   */
  function orderRows(rows) {
    return rows
      .slice()
      .sort((a, b) =>
        String(a.email || a.label || "")
          .toLowerCase()
          .localeCompare(String(b.email || b.label || "").toLowerCase()),
      );
  }

  /**
   * "N resets" that becomes a button when there is credit.
   *
   * Two clicks, just like the app: the native modal does `Use reset` -> `Confirm`
   * (`codex.rateLimitResetPromptModal.useReset` / `.confirmReset`). Consuming a credit
   * is IRREVERSIBLE, so a single click is not enough.
   */
  function resetsControl(entry, panel) {
    const key = entry.label || entry.email || "";
    const note = notes.get(key);
    if (note) {
      const el = document.createElement("span");
      el.textContent = note;
      el.style.cssText = `font-size:10px;flex:none;white-space:nowrap;color:${DIM};`;
      return el;
    }
    const count = entry.resets;
    if (typeof count !== "number") {
      return document.createElement("span");
    }
    if (count <= 0) {
      const el = document.createElement("span");
      el.textContent = resetsText(count);
      // Zero is not an error, but it is a real limitation: no highlight, and no button.
      el.style.cssText = `font-size:10px;flex:none;white-space:nowrap;color:${DIM};`;
      return el;
    }
    const armed = confirmingReset === key;
    const el = document.createElement("span");
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.textContent = armed ? t("useReset") : resetsText(count);
    el.setAttribute("aria-label", t("resetsTitle"));
    el.dataset.baseBg = armed
      ? "color-mix(in srgb,currentColor 16%,transparent)"
      : "color-mix(in srgb,currentColor 10%,transparent)";
    el.style.cssText =
      "font-size:10px;flex:none;white-space:nowrap;cursor:pointer;padding:2px 7px;" +
      `border-radius:999px;background:${el.dataset.baseBg};color:${FG};`;
    hoverable(el);
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (busy) return;
      if (!armed) {
        confirmingReset = key;
        render(panel, cachedRows || [], false);
        return;
      }
      void useReset(entry, panel);
    });
    return el;
  }

  /**
   * Replaces ONE row in the cache, matching by label.
   *
   * Used when main returns a row it read after a mutation. Replacing just that entry
   * keeps the other accounts' numbers untouched, so a reset on one subscription cannot
   * blank out the four rows around it while a full fetch is still in flight.
   */
  function mergeRow(row) {
    if (!row || !cachedRows) return;
    const at = cachedRows.findIndex((r) => r && r.label === row.label);
    if (at < 0) return;
    cachedRows = cachedRows.slice();
    cachedRows[at] = row;
  }

  const RESET_CODES = {
    reset: "resetDone",
    already_redeemed: "resetAlready",
    no_credit: "resetNone",
    nothing_to_reset: "resetNothing",
  };

  async function useReset(entry, panel) {
    const key = entry.label || entry.email || "";
    confirmingReset = null;
    busy = true;
    notes.set(key, t("resetting"));
    render(panel, cachedRows || [], true);
    try {
      const res = await api.ipc.invoke("account:reset", { label: entry.label });
      notes.set(key, t(RESET_CODES[res.code] || "resetDone"));
      api.log.info(
        `[codex-account-manager] reset: ${key} code=${res.code} confirmed=${Boolean(res.confirmed)}`,
      );
      // The row main hands back was read AFTER the consume, so it is fresher than
      // anything in `cachedRows`. Merging it means the bar moves in the same frame
      // the note appears, instead of waiting for the next fetch to come back.
      if (res.row) mergeRow(res.row);
      busy = false;
      // Only keep hammering when the server had not applied it yet. A confirmed
      // reset needs no fast mode; the merged row is already the new truth.
      if (!res.confirmed) startFastMode();
      await load(panel);
    } catch (e) {
      // The native path was hidden by us; if ours fails, we give it back instead of
      // leaving the user with NO way to reset.
      revealNativeUsage(panel);
      notes.set(key, `${t("failed", String((e && e.message) || e))} \u2014 ${t("nativeFallback")}`);
      api.log.warn(`[codex-account-manager] reset failed: ${String(e)}`);
      busy = false;
      render(panel, cachedRows || [], false);
    }
    /**
     * The note is transient, and REMOVING it has to repaint.
     *
     * This used to be a bare `notes.delete(key)`. Deleting from the map changes no
     * pixels, so the "usage reset" text stayed on screen until something else
     * happened to redraw - and since `drawIfChanged` only redraws when the signature
     * moves, "something else" could be minutes away, or never. The note outliving the
     * event it described is the same class of bug as the stale bar: the panel showing
     * a past state as if it were the present.
     *
     * `lastDrawn` is cleared so the redraw is unconditional: the row content did not
     * change, only the note did, and the signature does not track notes.
     */
    setTimeout(() => {
      notes.delete(key);
      if (!panel.isConnected) return;
      lastDrawn = null;
      render(panel, cachedRows || [], false);
    }, 8000);
  }

  function maskEmail(email) {
    if (!email) return "";
    const [user, domain] = String(email).split("@");
    if (!domain) return "\u2022".repeat(7);
    const head = user.slice(0, 2);
    return `${head}${"\u2022".repeat(Math.max(3, user.length - 2))}@${domain}`;
  }

  /**
   * The eye that reveals/hides the e-mail of that row.
   *
   * `<span role="button">` and not `<button>`: the whole row IS ALREADY a `<button>`
   * and HTML does not allow a button inside a button - the browser restructures the DOM
   * and the click stops working.
   */
  function eyeButton(key, revealedNow, onToggle) {
    const btn = document.createElement("span");
    btn.setAttribute("role", "button");
    btn.tabIndex = 0;
    // `aria-label` without `title`: the screen reader still announces the button, but no
    // tooltip appears when the mouse rests on it.
    btn.setAttribute("aria-label", revealedNow ? t("hideEmail") : t("showEmail"));
    btn.setAttribute("aria-pressed", revealedNow ? "true" : "false");
    btn.dataset.baseBg = "transparent";
    btn.style.cssText =
      `flex:none;cursor:pointer;display:inline-flex;align-items:center;color:${DIM};` +
      "padding:1px 2px;border-radius:5px;";
    btn.innerHTML = revealedNow
      ? '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
        '<path d="M3 3l14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
        '<path d="M6.2 6.3C4.5 7.4 3 9 2.2 10c1.6 2.2 4.4 4.6 7.8 4.6 1.3 0 2.5-.3 3.5-.9" ' +
        'stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
        '<path d="M16.2 12.3c.7-.7 1.3-1.5 1.6-2.3-1.6-2.2-4.4-4.6-7.8-4.6-.4 0-.8 0-1.2.1" ' +
        'stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
      : '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
        '<path d="M2.2 10C3.8 7.8 6.6 5.4 10 5.4s6.2 2.4 7.8 4.6c-1.6 2.2-4.4 4.6-7.8 4.6S3.8 12.2 2.2 10Z" ' +
        'stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
        '<circle cx="10" cy="10" r="2.1" stroke="currentColor" stroke-width="1.5"/></svg>';
    hoverable(btn);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onToggle(key);
    });
    return btn;
  }

  /**
   * `slot` is the STABLE subscription number (see orderRows). The title no longer uses
   * the e-mail: showing the local part on top and masking "ab•••••@gmail.com" below
   * hides nothing, because the local part of the e-mail is precisely what identifies the
   * account. Now the title is just "Subscription N", as in the reference, and the
   * e-mail sits behind the eye.
   */
  function accountRow(entry, panel, slot) {
    const el = document.createElement("button");
    el.type = "button";
    const base = entry.current ? "color-mix(in srgb,currentColor 7%,transparent)" : "transparent";
    el.dataset.baseBg = base;
    el.style.cssText =
      "width:100%;border:0;text-align:left;font:inherit;cursor:pointer;border-radius:8px;" +
      "display:grid;grid-template-columns:26px minmax(0,1fr) auto;column-gap:8px;" +
      `align-items:center;padding:6px 12px 6px 10px;background:${base};color:${FG};`;
    // The avatar is still seeded by the e-mail: the color identifies the account without
    // revealing the text, and it is the only way for the row to keep a visual identity
    // while masked.
    el.appendChild(avatar(entry.email || entry.label));

    const mid = document.createElement("span");
    mid.style.cssText = "display:flex;flex-direction:column;min-width:0;gap:3px;";
    const line1 = document.createElement("span");
    const plan = entry.plan ? ` \u00b7 ${entry.plan}` : "";
    line1.textContent = `${t("subscription", slot)}${plan}${
      entry.current ? ` \u00b7 ${t("current")}` : ""
    }`;
    line1.style.cssText =
      "font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    mid.appendChild(line1);

    if (entry.error) {
      const err = document.createElement("span");
      err.textContent = entry.error;
      err.style.cssText = `font-size:10px;color:${DIM};`;
      mid.appendChild(err);
    } else {
      // E-mail on the left, available resets on the right, on the same row: it uses
      // vertical space that already existed instead of creating a fourth row per
      // account.
      const idLine = document.createElement("span");
      idLine.style.cssText = "display:flex;align-items:center;gap:4px;min-width:0;";
      const key = entry.label || entry.email || "";
      const shown = revealed.has(key);
      const masked = document.createElement("span");
      masked.textContent = shown ? entry.email || "" : maskEmail(entry.email);
      masked.style.cssText =
        `font-size:10px;color:${DIM};letter-spacing:0.4px;flex:0 1 auto;min-width:0;` +
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      idLine.appendChild(masked);
      if (entry.email) {
        idLine.appendChild(
          eyeButton(key, shown, (k) => {
            if (revealed.has(k)) revealed.delete(k);
            else revealed.add(k);
            render(panel, cachedRows || [], false);
          }),
        );
      }
      const spacer = document.createElement("span");
      spacer.style.cssText = "flex:1 1 auto;min-width:0;";
      idLine.appendChild(spacer);
      idLine.appendChild(resetsControl(entry, panel));
      mid.appendChild(idLine);
      /**
       * ONLY the windows the backend reported in this read.
       *
       * When both exist, both show up: the 5h one decides whether you can work right
       * now, the weekly one decides whether the account lasts the rest of the week, and
       * showing only the weekly hid the limit that blocks first.
       *
       * But Codex sometimes removes the 5-hour limit and leaves only the weekly one.
       * Before, the "5 h" row kept being drawn with an empty bar - and an empty bar
       * reads as EXHAUSTED, the opposite of "this limit does not exist right now". The
       * `-` in the percentage was the only clue, and it went unnoticed next to a bar at
       * zero.
       *
       * There is no stored state here: the windows are derived from the response on
       * every refresh, so if the 5-hour limit comes back, the row comes back by itself
       * on the next read. Nothing needs to be re-enabled.
       */
      const windows = [
        [t("fiveHour"), entry.fiveHour],
        [t("weekly"), entry.weekly],
      ].filter(([, win]) => win);
      if (windows.length) {
        for (const [cap, win] of windows) mid.appendChild(windowLine(cap, win));
      } else if (entry.loading) {
        // Skeleton: the two empty rows reserve the height while the read runs. Two, not
        // one, because before reading there is no way to know how many windows will
        // arrive, and two is the normal case - erring on the side of reserving too much
        // shrinks the panel a little, while reserving too little would make the menu grow
        // and Radix reposition, which is the ugly visible effect.
        mid.appendChild(windowLine(t("fiveHour"), null));
        mid.appendChild(windowLine(t("weekly"), null));
      } else {
        /**
         * No known window is NOT the same as "no limit": it is missing data. Hiding
         * everything silently would turn a failed read into a clean, reassuring screen,
         * which is the worst possible outcome here. One row saying the quota did not
         * arrive is honest and takes less space than two empty bars.
         */
        const unknown = document.createElement("span");
        unknown.textContent = t("noWindows");
        unknown.style.cssText = `font-size:10px;color:${DIM};`;
        mid.appendChild(unknown);
      }
    }

    // The big number is the window that BLOCKS first, not the weekly one: with the 5h at
    // 0% the account is unusable right now, even with a full weekly.
    const limiting = limitingWindow(entry);
    const right = document.createElement("span");
    right.style.cssText =
      `flex:none;font-size:13px;font-weight:600;color:${FG};font-variant-numeric:tabular-nums;`;
    right.textContent = limiting ? `${Math.round(limiting.remaining)}%` : "-";
    el.appendChild(mid);
    el.appendChild(right);

    // NO `title` on the row. Everything the tooltip used to show - both windows, the
    // percentages, the reset times and the reset count - is already visible on the row
    // itself, so the tooltip was repetition floating over the menu. It also had a side
    // effect: it leaked the e-mail even with the eye closed, you just had to hover.
    //
    // The string that fed that `title` was assembled here and read by nobody after the
    // attribute was dropped; it was removed so no row pays a `toLocaleString` per render
    // for a value that is thrown away.

    hoverable(el);
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (entry.current || busy) return;
      void switchTo(entry, panel);
    });
    return el;
  }

  function actionRow(text, panel, handler, glyph) {
    const el = document.createElement("button");
    el.type = "button";
    el.dataset.baseBg = "transparent";
    el.style.cssText =
      "width:100%;border:0;background:transparent;text-align:left;font:inherit;cursor:pointer;" +
      "border-radius:8px;display:grid;grid-template-columns:26px minmax(0,1fr);column-gap:8px;" +
      `align-items:center;padding:6px 12px 6px 10px;color:${FG};font-size:13px;`;
    const icon = document.createElement("span");
    icon.textContent = glyph || "+";
    icon.setAttribute("aria-hidden", "true");
    icon.style.cssText = `display:flex;align-items:center;justify-content:center;color:${DIM};font-size:15px;`;
    const label = document.createElement("span");
    label.textContent = text;
    label.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    el.append(icon, label);
    hoverable(el);
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!busy) void handler(panel);
    });
    return el;
  }

  function status(panel, text) {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = `padding:5px 12px 7px 36px;font-size:11px;color:${DIM};`;
    panel.appendChild(el);
  }

  function divider() {
    const el = document.createElement("div");
    el.style.cssText =
      "height:1px;margin:4px 10px;background:color-mix(in srgb,currentColor 12%,transparent);";
    return el;
  }

  /**
   * No cache label: the values are always live. While the request runs, the rows go
   * slightly dimmed instead of the panel emptying out - emptying changed the menu height
   * and Radix repositioned, which showed up as the popover closing by itself twice when
   * opening.
   */
  function render(panel, rows, pending) {
    panel.textContent = "";
    panel.style.opacity = pending ? "0.55" : "1";
    const ordered = orderRows(rows);
    if (view === "manage") {
      panel.appendChild(manageHeader(panel));
      ordered.forEach((entry, i) => panel.appendChild(manageRow(entry, panel, i + 1)));
      panel.appendChild(actionRow(t("addAnother"), panel, addAccount));
      panel.appendChild(divider());
      return;
    }
    panel.appendChild(headerRow(ordered, panel));
    ordered.forEach((entry, i) => panel.appendChild(accountRow(entry, panel, i + 1)));
    panel.appendChild(actionRow(t("addAnother"), panel, addAccount));
    panel.appendChild(divider());
  }

  /** A skeleton the same height as the real rows, so the size does not jump. */
  function skeleton(panel, count) {
    panel.textContent = "";
    panel.style.opacity = "0.55";
    const rows = [];
    for (let i = 0; i < Math.max(1, count); i += 1) {
      rows.push({
        label: `\u2026`,
        email: null,
        plan: null,
        current: false,
        fiveHour: null,
        weekly: null,
        blocked: null,
        resets: null,
        error: null,
        /**
         * Marks what is a SKELETON, not an account with no quota.
         *
         * Both windows are null here because nothing has been read yet, which is
         * different from "the backend did not report it". Without this mark, the row
         * would say "quota not reported" while loading - a false statement - and would
         * lose the height this skeleton exists precisely to reserve.
         */
        loading: true,
      });
    }
    panel.appendChild(headerRow(rows, panel));
    rows.forEach((entry, i) => panel.appendChild(accountRow(entry, panel, i + 1)));
    panel.appendChild(actionRow(t("addAnother"), panel, addAccount));
    panel.appendChild(divider());
  }

  /**
   * A signature of what is DRAWN. It keeps the periodic refresh from rebuilding the DOM
   * when nothing changed - rebuilding on every tick would lose the hover and flash the
   * panel for no reason.
   */
  function signature(rows) {
    return orderRows(rows)
      .map((r) =>
        [
          r.label,
          r.current ? "1" : "0",
          r.resets,
          r.error || "",
          r.fiveHour ? `${Math.round(r.fiveHour.remaining)}/${resetText(r.fiveHour)}` : "-",
          r.weekly ? `${Math.round(r.weekly.remaining)}/${resetText(r.weekly)}` : "-",
        ].join("|"),
      )
      .join(";");
  }

  let lastDrawn = null;
  // How many rows the skeleton should have on the first opening. Starts at 3 and then
  // takes the real count, so the height does not jump when the numbers arrive.
  let lastCount = 3;

  function draw(panel, rows, pending) {
    lastDrawn = signature(rows);
    render(panel, rows, pending);
  }

  function drawIfChanged(panel, rows) {
    if (signature(rows) === lastDrawn) return;
    draw(panel, rows, false);
  }

  /**
   * Keeps the panel alive while it is open.
   *
   * The numbers used to freeze at the moment of opening: they only changed if you closed
   * and reopened the popover. A 2s tick repaints the reset counters from the cache, and
   * every fifth tick (10s) goes to the network again.
   *
   * The split exists for thrift: repainting is local and nearly free - `drawIfChanged`
   * only touches the DOM when the signature moved - while fetching costs one request PER
   * ACCOUNT. Hitting the network on every 2s tick with five accounts would be 150
   * requests per minute: free in quota terms, but an invitation to a 429.
   *
   * FAST MODE exists because a mutation we caused ourselves is exactly when a stale
   * number is least acceptable. After a reset the tick fetches EVERY time until either
   * the numbers move or the window expires, which is what turns "it reset but the panel
   * did not update" into a panel that converges on its own.
   */
  const TICK_MS = 2000;
  const TICKS_PER_FETCH = 5;
  const FAST_WINDOW_MS = 20000;
  let poll = 0;
  let fastUntil = 0;

  /** Fetch on every tick for a while: used right after a reset. */
  function startFastMode() {
    fastUntil = Date.now() + FAST_WINDOW_MS;
  }

  function fastActive() {
    return Date.now() < fastUntil;
  }

  function stopPolling() {
    if (poll) window.clearInterval(poll);
    poll = 0;
    fastUntil = 0;
  }

  function startPolling(panel) {
    stopPolling();
    let ticks = 0;
    poll = window.setInterval(() => {
      if (!panel.isConnected) {
        stopPolling();
        return;
      }
      if (busy) return;
      ticks += 1;
      if (fastActive() || ticks % TICKS_PER_FETCH === 0) void load(panel, true);
      else if (cachedRows) drawIfChanged(panel, cachedRows);
    }, TICK_MS);
  }

  async function load(panel, quiet) {
    if (busy) return;
    busy = true;
    try {
      const res = await api.ipc.invoke("usage:all", {});
      cachedRows = res.rows;
      if (res.rows && res.rows.length) lastCount = res.rows.length;
      // Fast mode ends when the numbers actually move, not when a timer says so:
      // converging is the whole reason it was turned on.
      if (fastActive() && signature(res.rows) !== lastDrawn) fastUntil = 0;
      if (panel.isConnected) {
        if (quiet) drawIfChanged(panel, res.rows);
        else draw(panel, res.rows, false);
      }
    } catch (e) {
      // On a background refresh a failure must not wipe the panel: keep the last known
      // value and try again on the next tick.
      if (quiet) {
        api.log.warn(`[codex-account-manager] refresh failed (keeping the last value): ${String(e)}`);
        busy = false;
        return;
      }
      if (panel.isConnected) {
        panel.textContent = "";
        panel.style.opacity = "1";
        status(panel, t("unavailable", String((e && e.message) || e)));
        panel.appendChild(divider());
      }
      api.log.warn(`[codex-account-manager] read failed: ${String(e)}`);
    } finally {
      busy = false;
    }
  }

  async function switchTo(entry, panel) {
    if (entry.label === "__active__") {
      status(panel, t("noSnapshot"));
      return;
    }
    busy = true;
    panel.textContent = "";
    status(panel, t("switching", entry.email || entry.label));
    try {
      // Captures the conversation BEFORE killing the app. There is nowhere to read this
      // afterwards: the app persists no route at all (ZERO `lastRoute`/
      // `restoreLastSession`; the only saved window state is
      // `electron-main-window-bounds`, geometry only).
      const thread = currentThreadId();
      await api.ipc.invoke("account:switch", { label: entry.label });
      panel.textContent = "";

      // The external watcher (see app:relaunch in main) was measured reopening the app on
      // its own, so the switch is back to a single click.
      status(panel, t("reopening"));
      await api.ipc.invoke("app:relaunch", { thread });
    } catch (e) {
      panel.textContent = "";
      status(panel, t("failed", String((e && e.message) || e)));
      api.log.warn(`[codex-account-manager] switch failed: ${String(e)}`);
    } finally {
      busy = false;
    }
  }

  /**
   * Adds an account entirely from the panel: saves the current session as a snapshot,
   * clears auth.json and reopens the app, which comes up on the sign-in screen. Nothing
   * goes through Settings.
   *
   * It is the only destructive path in the panel, which is why main copies auth.json to
   * auth_backups before removing it.
   */
  async function addAccount(panel) {
    busy = true;
    panel.textContent = "";
    panel.style.opacity = "1";
    status(panel, t("savingSession"));
    try {
      const res = await api.ipc.invoke("account:add", {});
      panel.textContent = "";
      status(panel, t("savedAs", res.saved));
      // We do NOT pass a conversation here: the app will open on the sign-in screen, and
      // a thread deep link would hit the `readThread` gate and be dropped silently.
      await api.ipc.invoke("app:relaunch", {});
    } catch (e) {
      panel.textContent = "";
      status(panel, t("failed", String((e && e.message) || e)));
      api.log.warn(`[codex-account-manager] add account failed: ${String(e)}`);
    } finally {
      busy = false;
    }
  }

  /**
   * The gear in the header corner: opens the panel's own ACCOUNT MANAGER.
   *
   * The previous version looked for the native "Settings" item in the menu and clicked
   * it. That was wrong by definition: it took you to Codex settings, which is exactly
   * what must not happen - the management has to live entirely in the panel. Now it only
   * toggles `view` and re-renders the same element, without leaving the popover.
   */
  function gearButton(panel) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", t("manage"));
    btn.dataset.baseBg = "transparent";
    btn.style.cssText =
      "flex:none;border:0;background:transparent;cursor:pointer;padding:2px;border-radius:6px;" +
      `display:flex;align-items:center;justify-content:center;color:${DIM};`;
    btn.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
      '<circle cx="10" cy="10" r="2.6" stroke="currentColor" stroke-width="1.5"/>' +
      '<path d="M10 3.2v1.6M10 15.2v1.6M3.2 10h1.6M15.2 10h1.6M5.2 5.2l1.1 1.1M13.7 13.7l1.1 1.1M14.8 5.2l-1.1 1.1M6.3 13.7l-1.1 1.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
      "</svg>";
    hoverable(btn);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (busy) return;
      view = view === "manage" ? "list" : "manage";
      confirming = null;
      render(panel, cachedRows || [], false);
    });
    return btn;
  }

  /** Header of the management view, with the way back to the list. */
  function manageHeader(panel) {
    const el = document.createElement("button");
    el.type = "button";
    el.dataset.baseBg = "transparent";
    el.style.cssText =
      "width:100%;border:0;background:transparent;text-align:left;font:inherit;cursor:pointer;" +
      "border-radius:8px;display:grid;grid-template-columns:26px minmax(0,1fr);column-gap:8px;" +
      `align-items:center;padding:7px 12px 7px 10px;color:${FG};font-size:13px;`;
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.style.cssText = `display:flex;align-items:center;justify-content:center;color:${DIM};`;
    icon.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
      '<path d="M12 4.5 6.5 10l5.5 5.5" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const label = document.createElement("span");
    label.textContent = t("manage");
    label.style.cssText = "font-weight:600;";
    el.append(icon, label);
    hoverable(el);
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (busy) return;
      view = "list";
      confirming = null;
      render(panel, cachedRows || [], false);
    });
    return el;
  }

  function pillButton(text, tone) {
    const btn = document.createElement("span");
    btn.setAttribute("role", "button");
    btn.tabIndex = 0;
    btn.textContent = text;
    btn.dataset.baseBg = "color-mix(in srgb,currentColor 10%,transparent)";
    btn.style.cssText =
      "flex:none;font-size:11px;padding:3px 8px;border-radius:999px;cursor:pointer;" +
      `background:${btn.dataset.baseBg};color:${tone === "danger" ? "hsl(4 72% 62%)" : FG};`;
    hoverable(btn);
    // The pill is born with 10% ink, and the default 8% hover would make it LIGHTER on
    // mouseover. This listener runs afterwards and fixes the direction.
    btn.addEventListener("mouseenter", () => {
      btn.style.background = "color-mix(in srgb,currentColor 20%,transparent)";
    });
    return btn;
  }

  /**
   * A management row: activate and forget, without leaving the panel.
   *
   * Forgetting is destructive, so it requires TWO clicks: the first swaps the label to
   * "Confirm?" and only the second calls the IPC. Without that, one wrong click would
   * cost an account's sign-in.
   */
  function manageRow(entry, panel, slot) {
    const el = document.createElement("div");
    el.style.cssText =
      "display:grid;grid-template-columns:26px minmax(0,1fr) auto;column-gap:8px;" +
      "align-items:center;padding:6px 12px 6px 10px;border-radius:8px;";
    el.appendChild(avatar(entry.email || entry.label));

    const mid = document.createElement("span");
    mid.style.cssText = "display:flex;flex-direction:column;min-width:0;";
    const line1 = document.createElement("span");
    line1.textContent = `${t("subscription", slot)}${entry.current ? ` \u00b7 ${t("current")}` : ""}`;
    line1.style.cssText =
      `font-size:13px;color:${FG};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
    // The bottom line used to show the FILE NAME (`account-2.json`), which is a
    // meaningless internal detail: the third-party switcher is what names by position,
    // and that is why random names appeared next to e-mail-based ones. Here the e-mail is
    // what counts, because it is what identifies the subscription.
    const idLine = document.createElement("span");
    idLine.style.cssText = "display:flex;align-items:center;gap:4px;min-width:0;";
    const key = entry.label || entry.email || "";
    const shown = revealed.has(key);
    const line2 = document.createElement("span");
    line2.textContent = entry.email
      ? shown
        ? entry.email
        : maskEmail(entry.email)
      : t("noSnapshot");
    line2.style.cssText =
      `font-size:10px;color:${DIM};flex:0 1 auto;min-width:0;` +
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    idLine.appendChild(line2);
    if (entry.email) {
      idLine.appendChild(
        eyeButton(key, shown, (k) => {
          if (revealed.has(k)) revealed.delete(k);
          else revealed.add(k);
          render(panel, cachedRows || [], false);
        }),
      );
    }
    mid.append(line1, idLine);
    el.appendChild(mid);

    const actions = document.createElement("span");
    actions.style.cssText = "display:flex;gap:6px;align-items:center;flex:none;";
    if (!entry.current && entry.label !== "__active__") {
      const use = pillButton(t("activate"));
      use.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) void switchTo(entry, panel);
      });
      actions.appendChild(use);
    }
    if (!entry.current && entry.label !== "__active__") {
      const armed = confirming === entry.label;
      const del = pillButton(armed ? t("confirmForget") : t("forget"), "danger");
      del.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (busy) return;
        if (!armed) {
          confirming = entry.label;
          render(panel, cachedRows || [], false);
          return;
        }
        void removeAccount(entry, panel);
      });
      actions.appendChild(del);
    }
    el.appendChild(actions);
    return el;
  }

  async function removeAccount(entry, panel) {
    busy = true;
    try {
      await api.ipc.invoke("account:remove", { label: entry.label });
      confirming = null;
    } catch (e) {
      confirming = null;
      panel.textContent = "";
      status(panel, t("failed", String((e && e.message) || e)));
      panel.appendChild(divider());
      api.log.warn(`[codex-account-manager] removal failed: ${String(e)}`);
      busy = false;
      return;
    }
    busy = false;
    await load(panel);
  }

  const HIDDEN_NATIVE = "data-cam-hid";

  /**
   * Hides the native "Usage remaining" item - our panel already shows both windows for
   * ALL subscriptions, and that item only duplicated the active one's information.
   *
   * We hide the ELEMENT, not through a global CSS rule: the selector
   * `[role="menuitem"][aria-haspopup="menu"]` is generic and a global rule would erase
   * any submenu of any menu in the app. Here it is resolved inside the already
   * identified account popover, and only when there is exactly one.
   *
   * We keep the original `display` in `dataset` so the item can be given back: the only
   * way to reset the quota through the native UI is from inside it, so if OUR reset
   * fails we need to show it again (see useReset).
   */
  function hideNativeUsage(item) {
    if (!item || item.hasAttribute(HIDDEN_NATIVE)) return;
    // Deduplicated: the guard above is the `data-cam-hid` attribute, which React wipes on
    // every re-render of the container. Without dedup, this log reappeared every time the
    // menu remounted and each line was a synchronous disk write in main.
    diag("hiding the native item", compact(item).slice(0, 40));
    // Hide ONLY the anchor, without climbing to the parents: our panel was inserted as
    // its immediate sibling (`anchor.before(panel)`) and appears correctly above the row,
    // which proves the anchor is the menu row itself. Climbing would hide the container
    // that also holds our panel.
    item.setAttribute(HIDDEN_NATIVE, item.style.display || "");
    item.style.display = "none";
  }

  function revealNativeUsage(panel) {
    const menu = panel.closest(MENU_CLOSEST_SEL);
    const scope = menu || document;
    for (const item of Array.from(scope.querySelectorAll(`[${HIDDEN_NATIVE}]`))) {
      item.style.display = item.getAttribute(HIDDEN_NATIVE) || "";
      item.removeAttribute(HIDDEN_NATIVE);
    }
  }

  const said = new Set();
  function diag(reason, extra) {
    if (said.has(reason)) return;
    said.add(reason);
    api.log.info(`[codex-account-manager] ${reason}${extra ? ` ${extra}` : ""}`);
  }

  function inject() {
    const menu = findMenu();
    if (!menu) {
      diag("menu not found");
      return;
    }
    diag("menu recognized");
    if (menu.querySelector(`[${MARK}]`)) return;
    dumpMenuShape(menu);
    const found = findAnchor(menu);
    if (!found || !found.el || !found.el.parentElement) {
      diag("anchor not found");
      return;
    }
    const anchor = found.el;
    diag("anchor found", `${compact(anchor).slice(0, 40)} native=${found.isNativeUsage}`);

    // Every popover opening starts on the list, never on the management view: `view`
    // lives in the tweak scope and would survive the menu closing.
    view = "list";
    confirming = null;
    confirmingReset = null;

    const panel = document.createElement("div");
    panel.setAttribute(MARK, "panel");
    panel.style.cssText = "display:flex;flex-direction:column;min-width:0;";
    anchor.before(panel);

    // After inserting the panel: the native item IS the anchor, and hiding it earlier
    // would lose the position reference.
    if (found.isNativeUsage) hideNativeUsage(anchor);

    // Paints the last known value (or a skeleton of the same size) and updates over it.
    // The height does not change between the two states.
    if (cachedRows) draw(panel, cachedRows, true);
    else skeleton(panel, lastCount);
    void load(panel);
    startPolling(panel);
  }

  let scheduled = 0;
  /**
   * Is there any chance this mutation is our menu?
   *
   * WHY THIS EXISTS: the observer listens on `document.documentElement` with
   * `subtree: true`, that is, EVERY DOM change in the window. On screens that re-render a
   * lot - the Settings search rebuilds the list on every keystroke - that fired the
   * complete menu search on every frame. And the search is expensive:
   * `getBoundingClientRect` forces a SYNCHRONOUS layout calculation and `textContent`
   * walks the entire subtree. Synchronous layout in bursts is the classic way to lock up
   * an interface.
   *
   * With the filter, a change that adds no menu container costs only one
   * `querySelector` on the added node.
   */
  function touchesMenu(records) {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!n || n.nodeType !== 1) continue;
        if (typeof n.matches === "function" && n.matches(MENU_SEL)) return true;
        if (typeof n.querySelector === "function" && n.querySelector(MENU_SEL)) return true;
      }
    }
    return false;
  }

  /**
   * Execution ceiling. This block had TWO defects, and together they were the Settings
   * freeze. Both are fixed here.
   *
   * 1. `lastInject` was stamped BEFORE `inject()`, not after. The ceiling ended up
   *    measuring the interval between STARTS instead of idle time. When `inject()` took
   *    longer than the ceiling itself - exactly the case on the Settings screen - the
   *    next `schedule()` computed `wait = max(0, 120 - T) = 0`, fell into the
   *    `requestAnimationFrame` branch, and the runs started touching each other, one per
   *    frame. The 120ms ceiling stopped existing precisely in the regime where it was the
   *    only protection. Now the stamp is in the `finally`, AFTER the work.
   *
   * 2. The `wait === 0` branch ran inside `requestAnimationFrame`, that is, INSIDE the
   *    frame and BEFORE the paint. That is why the typed letter never made it to the
   *    screen: its painting waited for our sweep to finish. Now it is always a
   *    `setTimeout` with at least one frame of slack, so our work never competes with the
   *    app interface for the paint.
   *
   * The ceiling also became ADAPTIVE: if a run goes over budget, the next one may only
   * run after an interval proportional to what it cost, with a cap. On a heavy screen the
   * panel backs off on its own instead of fighting for the main thread.
   *
   * `scheduled` now holds ONLY a `setTimeout` id. It used to mix a timeout id with a
   * `requestAnimationFrame` handle; if the rAF never fired (hidden or occluded window),
   * `scheduled` got stuck on a truthy value and `if (scheduled) return;` blocked every
   * future injection - the panel simply never appeared again.
   */
  const INJECT_THROTTLE_MS = 120;
  const INJECT_BUDGET_MS = 24;
  const INJECT_MAX_COOLDOWN_MS = 2000;
  let lastInject = 0;
  let cooldown = INJECT_THROTTLE_MS;

  const schedule = () => {
    if (scheduled) return;
    // A one-frame floor: never runs in the same frame as whoever woke us up.
    const wait = Math.max(16, cooldown - (Date.now() - lastInject));
    const run = () => {
      scheduled = 0;
      const started = Date.now();
      try {
        inject();
      } catch (e) {
        // Deduplicated on purpose. Without dedup, a recurring failure became one
        // SYNCHRONOUS disk write in the main process per run, and a blocked main freezes
        // the whole window. Once says everything that needs saying.
        diag("injection failed", String((e && e.message) || e));
      } finally {
        const took = Date.now() - started;
        lastInject = Date.now();
        cooldown =
          took > INJECT_BUDGET_MS
            ? Math.min(INJECT_MAX_COOLDOWN_MS, Math.max(INJECT_THROTTLE_MS, took * 8))
            : INJECT_THROTTLE_MS;
      }
    };
    scheduled = window.setTimeout(run, wait);
  };


  /**
   * Preloads the quota in the background, with no UI. That way, when the menu opens, the
   * panel is mounted ALREADY WITH the final numbers, in a single DOM mutation.
   *
   * This is what caused the flickering: I injected a placeholder, Radix measured and
   * positioned the menu, and right after I swapped the whole content for 3 rows. The
   * second mutation changed the height and Radix repositioned - which on screen looks
   * like the popover closing and reopening.
   */
  void api.ipc
    .invoke("usage:all", {})
    .then((res) => {
      cachedRows = res.rows;
    })
    .catch(() => {});

  const observer = new MutationObserver((records) => {
    if (touchesMenu(records)) schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  /**
   * The i18n provider writes `documentElement.lang` inside a `useEffect`, that is AFTER
   * the first paint, and `index.html` is born with a hardcoded `lang="en"`. Without
   * observing the attribute, a panel mounted early would stay in English forever on a
   * Portuguese app.
   */
  const langObserver = new MutationObserver(() => {
    const before = dict;
    refreshDict();
    if (dict !== before) {
      api.log.info(`[codex-account-manager] language now: ${document.documentElement.lang || "(empty)"}`);
      schedule();
    }
  });
  langObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["lang", "dir"],
  });

  /**
   * ZERO keyboard hooks. There used to be `document.addEventListener("keydown", schedule,
   * true)` - in CAPTURE, on `document` - and it was the direct trigger of the freeze: it
   * ran ahead of the app's own handler and before the letter was inserted, waking the
   * complete menu sweep ON EVERY KEY. On the Settings screen each sweep cost a
   * `querySelectorAll` over the entire document plus synchronous layout per candidate, and
   * the first letter never got painted at all.
   *
   * And we lose no coverage: the account popover is MOUNTED by Radix, and mounting is a
   * DOM mutation that the observer above already detects through the `touchesMenu` filter.
   * The correct trigger was always the menu mounting; typing was never a signal that the
   * menu opened.
   *
   * `pointerdown` stays: it fires once per click, not once per key, and it front-runs the
   * injection in the common case of opening the menu with the mouse.
   */
  document.addEventListener("pointerdown", schedule, true);
  schedule();

  api.log.info(
    `[codex-account-manager] renderer half ready; lang=${document.documentElement.lang || "(empty)"}`,
  );
  return () => {
    observer.disconnect();
    langObserver.disconnect();
    stopPolling();
    document.removeEventListener("pointerdown", schedule, true);
  };
}

// Two halves, two disposers. There used to be a single `dispose` and the main half simply
// did not have one - that is where the IPC handlers leaked.
let disposeMain = null;
let disposeRenderer = null;

/**
 * The host logs the failure as `failed to start: {}` because it serializes the Error with
 * JSON, and an Error's `message`/`stack` are not enumerable. Without this, the only
 * information available about a start failure is literally "{}".
 */
function shout(api, text) {
  try {
    const fn = (api.log && (api.log.error || api.log.warn || api.log.info)) || null;
    if (fn) fn.call(api.log, `[codex-account-manager] ${text}`);
  } catch {
    // Logger unavailable: there is nothing better to do here.
  }
}

module.exports = {
  start(api) {
    try {
      if (api.process === "main") {
        disposeMain = startMain(api);
        return;
      }
      disposeRenderer = startRenderer(api);
    } catch (e) {
      shout(api, `start(${api && api.process}) failed: ${String((e && e.message) || e)}`);
      if (e && e.stack) {
        shout(api, `stack: ${String(e.stack).split("\n").slice(0, 8).join("  <<  ")}`);
      }
      throw e;
    }
  },
  stop() {
    if (typeof disposeMain === "function") disposeMain();
    disposeMain = null;
    if (typeof disposeRenderer === "function") disposeRenderer();
    disposeRenderer = null;
  },
};
