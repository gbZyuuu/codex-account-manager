"use strict";
/**
 * Who owns this app's entry point, and may we take it over?
 *
 * There is exactly one point of contention: the `main` field of the `package.json`
 * inside the archive. If two tools rewrite it, the last writer wins and the other
 * stops loading; in the worst case both load and register the SAME IPC channel,
 * which throws "Attempted to register a second handler".
 *
 * Detection is GENERIC on purpose: we do not look for the name of any specific
 * tool. The rule is structural and holds for any of them:
 *
 *   - `main` points at `.vite/build/...`      -> original, untouched
 *   - `main` points at OUR loader            -> ours, safe to reapply
 *   - `main` points at anything else         -> taken by a third party
 *
 * In the third case we refuse. We neither read nor reuse the metadata of whoever
 * took it: if it is not ours and not the original, we leave it alone.
 *
 * The owner values below are internal codes, not display text. `ownerLabel` in
 * i18n.js turns them into the user's language.
 */
const { readFileFromAsar } = require("./asar");
const { t } = require("./i18n");

/** Our loader's file name, used to recognise our own installation. */
const OUR_LOADER = "codex-account-manager-loader.cjs";
const OUR_META_KEY = "__codexAccountManager";

/** An Electron app's factory entry point always lives in the app's own bundle. */
const ORIGINAL_MAIN_RE = /^\.vite[\\/]/;

function inspectAsar(asarPath) {
  const { buf, entry } = readFileFromAsar(asarPath, "package.json");
  const text = buf.toString("utf8");
  const meta = JSON.parse(text);
  const main = String(meta.main || "");

  let owner;
  if (main.includes(OUR_LOADER) || meta[OUR_META_KEY]) owner = "nosso";
  else if (!main || ORIGINAL_MAIN_RE.test(main)) owner = "original";
  else owner = "terceiro";

  return {
    owner,
    main,
    capacity: entry.size,
    currentBytes: Buffer.byteLength(text.trimEnd(), "utf8"),
    originalMain: (meta[OUR_META_KEY] && meta[OUR_META_KEY].originalMain) || null,
    meta,
  };
}

/**
 * May we patch? Returns `{ ok, info, reason }`.
 *
 * Reapplying over OUR OWN patch is allowed: that is the normal path after an app
 * update, when the copy is rebuilt.
 */
function canPatch(asarPath) {
  const info = inspectAsar(asarPath);
  if (info.owner === "terceiro") {
    return { ok: false, info, reason: t("err.third.party", info.main) };
  }
  return { ok: true, info, reason: null };
}

module.exports = { inspectAsar, canPatch, OUR_LOADER, OUR_META_KEY, ORIGINAL_MAIN_RE };
