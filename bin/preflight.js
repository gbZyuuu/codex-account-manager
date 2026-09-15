"use strict";
/**
 * READ-ONLY check of the installer's central premise: does the patched
 * `package.json` fit in the original bytes inside the archive?
 *
 * If it does not fit, `writeFileInPlace` refuses and the whole design has to
 * change to repacking. Better to find that out now than during install.
 *
 * WRITES NOTHING to the app. It only reads and simulates.
 */
const fs = require("node:fs");
const path = require("node:path");

const { readFileFromAsar, readHeader } = require("../src/asar");
const { inspectAsar, OUR_META_KEY } = require("../src/conflict");
const { t, ownerLabel } = require("../src/i18n");
const { findMsix, findLocalInstalls, asarOf, paths } = require("../src/paths");

/**
 * Report in TWO places: a file and the screen.
 *
 * The file exists because this machine's console truncates long output, and a
 * report cut in half is no basis for a decision.
 *
 * The screen was added after a test taken from the point of view of a brand new
 * user: `cam.js preflight` finished with exit code 0 and ZERO console output,
 * because everything went to the file only. A command that looks like it does
 * nothing is a command nobody uses - and this is precisely the one that should be
 * run BEFORE installing.
 */
const REPORT = path.join(__dirname, "..", "preflight-report.txt");
const out = fs.openSync(REPORT, "w");
const say = (l) => {
  fs.writeSync(out, `${l}\n`);
  fs.fsyncSync(out);
  try {
    process.stdout.write(`${l}\n`);
  } catch {
    // No console (running under wscript, for instance): the file has everything.
  }
};

const LOADER_REL = "../app.asar.unpacked/codex-account-manager-loader.cjs";

say(t("pf.detected"));
const msix = findMsix();
say(t("pf.msix", msix ? t("pf.msix.at", msix.version, msix.appDir) : t("pf.notfound")));
say(t("pf.msix.readable", msix ? fs.existsSync(asarOf(msix.appDir)) : "n/a"));
for (const l of findLocalInstalls()) say(t("pf.local", l.kind, l.version, l.appDir));

const candidates = [];
if (msix && fs.existsSync(asarOf(msix.appDir))) candidates.push([t("pf.label.msix"), asarOf(msix.appDir)]);
for (const l of findLocalInstalls()) {
  if (fs.existsSync(asarOf(l.appDir))) candidates.push([t("pf.label.local", l.kind), asarOf(l.appDir)]);
}
// Our own copy, when already installed: confirms that reapplying still fits.
try {
  for (const d of fs.readdirSync(paths.mirrors)) {
    const a = path.join(paths.mirrors, d, "app", "resources", "app.asar");
    if (fs.existsSync(a)) candidates.push([t("pf.label.mirror", d), a]);
  }
} catch {
  /* nothing installed yet */
}

say("");
say(t("pf.fit"));
for (const [label, asar] of candidates) {
  say(`--- ${label}`);
  say(`    ${asar}`);
  try {
    const h = readHeader(asar);
    say(t("pf.header.ok", h.jsonLen, h.baseOffset));
    const { buf, entry } = readFileFromAsar(asar, "package.json");
    const info = inspectAsar(asar);
    say(t("pf.pkg", entry.size, Buffer.byteLength(buf.toString("utf8").trimEnd(), "utf8")));
    say(t("pf.main", info.main, ownerLabel(info.owner)));
    const originalMain = info.owner === "original" ? info.main : info.originalMain || info.main;
    const patched = { ...info.meta, main: LOADER_REL };

    // The same constant the installer uses. With the key written by hand (the old
    // `__codexlive`, 10 bytes shorter) this prediction underestimated the space
    // needed, meaning the probe could say "FITS" for a patch that would not.
    patched[OUR_META_KEY] = {
      originalMain,
      root: "C:\\Users\\<user>\\AppData\\Local\\codex-account-manager",
      patchedAt: new Date().toISOString(),
    };
    const text = JSON.stringify(patched);
    const need = Buffer.byteLength(text, "utf8");
    say(
      t("pf.need", need, need <= entry.size ? t("pf.fits") : t("pf.nofit"), entry.size - need),
    );
  } catch (e) {
    say(t("pf.error", String(e && e.message)));
  }
}

say("");
say(t("pf.readonly"));
say(t("pf.report", REPORT));
