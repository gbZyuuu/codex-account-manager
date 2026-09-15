/**
 * The program's messages in English and Portuguese.
 *
 * ENGLISH IS THE DEFAULT, always, regardless of the Windows display language.
 * Whoever wants Portuguese sets `CAM_LANG=pt`. This is deliberate: the project is
 * public, and someone who does not speak Portuguese has no way to guess what
 * "espelhando (origem protegida pelo SO)" means, while a Portuguese speaker can
 * read technical English or set the variable.
 *
 * Detecting the system language was rejected on purpose: on a machine running
 * Windows in Portuguese the default would become Portuguese, and "the default is
 * English" would stop being true on exactly the machine where it was checked.
 *
 * Format: `t("key", value1, value2, ...)`. The `{0}`, `{1}` placeholders in the
 * string are replaced by the arguments in order. A missing key returns the key
 * itself, so a missing message shows up as a key instead of vanishing.
 */

const EN = {
  // --------------------------------------------------------------- install
  "install.source": "source: {0} version {1}",
  "install.mirroring": "mirroring (source is protected by the OS) to {0}",
  "install.mirror.stats": "  mirror: {0} files, {1} MB",
  "install.inplace": "writable source: patched in place, no copy needed",
  "install.entry.current": "current entry point: {0} (owner: {1})",
  "install.backup.made": "backup of the original package.json: {0} ({1} bytes)",
  "install.backup.kept":
    "already our patch: previous backup kept (not overwriting it with patched bytes)",
  "install.runtime.copied": "runtime copied to {0}",
  "install.loader.installed": "loader installed at {0}",
  "install.patch.size": "package.json patched: {0} of {1} bytes available",
  "install.patch.written": "written in place ({0}/{1} bytes, remainder padded with spaces)",
  "install.validated": "validated: main={0}, originalMain={1}",
  "install.validation.failed": "VALIDATION FAILED ({0}), reverting",
  "install.shortcut.made": "shortcut created: {0}",
  "install.shortcut.startmenu.failed": "could not create the Start Menu shortcut: {0}",
  "install.shortcut.desktop.failed": "could not create the Desktop shortcut: {0}",
  "install.launcher.made": "launcher created: {0}",
  "install.launcher.failed": "could not create the .cmd launcher: {0}",
  "install.shell.notified": "shell notified to re-index the shortcuts",
  "install.shell.notify.failed":
    "could not notify the shell; the shortcuts exist and work anyway",
  "install.done": "installed. open Codex through any of these:",
  "install.icon.missing": "icon not found at {0}; the shortcut will use the app icon",
  "install.icon.failed": "could not copy the icon: {0}",
  "install.removed": "removed: {0}",
  "err.app.open":
    "this Codex installation is OPEN ({0}).\nClose it before reinstalling, otherwise robocopy may leave the copy half written:\n  Get-Process ChatGPT | Stop-Process -Force\nIf you know what you are doing, repeat with --force.",
  "err.third.party":
    "this app's entry point has already been changed by another program (main = {0}).\nTwo tools on the same entry point fight over the same IPC channel and one of them\nstops working. Remove the other one, or restore the app, before continuing.",

  // ------------------------------------------------------------- uninstall
  "uninstall.restoring": "restoring the original package.json ({0} bytes, version {1})",
  "uninstall.entry.now": "entry point now: {0} (owner: {1})",
  "uninstall.loader.removed": "loader removed",
  "uninstall.watch.failed": "could not remove the update watcher triggers: {0}",
  "uninstall.watch.hint": "run `node bin/cam.js watch remove` to finish removing them",
  "uninstall.done": "uninstalled. the copy stays on disk; delete it by hand to reclaim the space:",

  // ---------------------------------------------------------------- doctor
  "doctor.source.now": "source detected now  : {0} {1}",
  "doctor.version.state": "version in state     : {0}",
  "doctor.stale": "copy out of date     : {0}",
  "doctor.stale.yes": "YES - Codex updated",
  "doctor.stale.no": "no",
  "doctor.asar": "archive              : {0}",
  "doctor.entry": "entry point          : {0} (owner: {1})",
  "doctor.pkg.space": "package.json space   : {0}/{1} bytes",
  "doctor.no.state": "(no state)",

  // --------------------------------------------------------------- watcher
  "watch.nothing": "nothing to do",
  "watch.reapplied": "copy and patch brought up to date",
  "watch.update.detected": "update detected: {0} -> {1}",
  "watch.need.apply": "run with --apply to re-copy and re-patch",
  "watch.deferred": "Codex is open; deferring the reapply to the next pass",
  "watch.uninstalled": "installation disabled by `uninstall`; not reapplying anything",
  "watch.uninstalled.hint": "to use the panel again: node bin/cam.js install",
  "watch.script": "watcher script: {0}",
  "watch.logon.trigger": "logon trigger: {0}",
  "watch.logon.failed": "could not create the logon trigger: {0}",
  "watch.task.removed": "previous task removed: {0}",
  "watch.task.periodic.failed": "periodic task not created (logon only from here): {0}",
  "watch.active": "watcher active. Coverage: {0}.",
  "watch.coverage.logon": "logon",
  "watch.coverage.periodic": "every 6h",
  "watch.coverage.and": " and ",
  "watch.removed": "removed: {0}",
  "watch.absent": "did not exist: {0}",
  "watch.logon.absent": "logon trigger: did not exist",
  "watch.status.registered": "{0}: registered",
  "watch.status.missing": "{0}: missing",
  "watch.status.logon": "logon trigger (Startup folder): {0}",
  "watch.status.present": "present",
  "watch.status.notpresent": "absent",
  "watch.last.install": "last install: {0} version {1}",

  // ---------------------------------------------------------------- erros
  "err.no.state": "no installation state; nothing to undo",
  "err.backup.missing": "backup missing: {0}",
  "err.backup.hash": "the package.json backup does not match the recorded hash; refusing to restore",
  "err.no.asar": "could not find the archive at {0}",
  "err.validate.reverted": "patch reverted after validation failure: {0}",
  "err.no.trigger":
    "no trigger could be installed; run `check --apply` by hand after a Codex update",
  "err.windows.only": "this version is Windows-only on purpose. macOS/Linux not yet.",
  "err.prefix": "ERROR: {0}",
  "err.unknown.command": "unknown command: {0}",

  // ------------------------------------------------------------------ ajuda
  "help.usage": "usage: node bin/cam.js <preflight|install|uninstall|doctor|check|watch> [options]",
  "help.preflight1": "  preflight             read-only: where the app is, whether the change fits,",
  "help.preflight2": "                        and who owns the entry point. Writes nothing",
  "help.install1": "  install [--force]     copies the app if needed and patches the entry point",
  "help.install2": "                        refuses if that Codex installation is open",
  "help.uninstall": "  uninstall             restores the original entry point and removes shortcuts",
  "help.doctor": "  doctor                shows state, versions and who owns the entry point",
  "help.check": "  check [--apply]       detects a Codex update; --apply re-copies and re-patches",
  "help.watch.install":
    "  watch install         installs the triggers: logon (Startup folder) + 6h (scheduled task)",
  "help.watch.remove": "  watch remove          removes the triggers",
  "help.watch.status": "  watch status          shows which triggers exist",
  "help.lang": "Language: English by default. Set CAM_LANG=pt for Portuguese.",

  // ----------------------------------------------------------------- donos
  "owner.original": "original",
  "owner.ours": "ours",
  "owner.third": "third-party",

  // ------------------------------------------------------------- preflight
  // (the PT table below mirrors these keys; both are kept in the same order)
  "pf.detected": "=== source detected ===",
  "pf.msix": "MSIX: {0}",
  "pf.msix.at": "{0} at {1}",
  "pf.notfound": "(not found)",
  "pf.msix.readable": "MSIX readable? {0}",
  "pf.local": "local: {0} {1} {2}",
  "pf.fit": "=== fit test, per archive found ===",
  "pf.label.msix": "MSIX original",
  "pf.label.local": "local installation {0}",
  "pf.label.mirror": "our copy {0}",
  "pf.header.ok": "    header ok: jsonLen={0} baseOffset={1}",
  "pf.pkg": "    package.json: capacity={0} used={1}",
  "pf.main": "    current main = {0}   owner = {1}",
  "pf.need": "    patched would need {0} bytes -> {1} ({2} to spare)",
  "pf.fits": "FITS",
  "pf.nofit": "DOES NOT FIT",
  "pf.error": "    ERROR: {0}",
  "pf.readonly": "Nothing was written to the app. This probe is read-only.",
  "pf.report": "Report also saved to: {0}",
};

const PT = {
  "install.source": "origem: {0} versao {1}",
  "install.mirroring": "espelhando (a origem e protegida pelo SO) para {0}",
  "install.mirror.stats": "  espelho: {0} arquivos, {1} MB",
  "install.inplace": "origem gravavel: alterado no lugar, sem copia",
  "install.entry.current": "entry point atual: {0} (dono: {1})",
  "install.backup.made": "backup do package.json original: {0} ({1} bytes)",
  "install.backup.kept":
    "ja era o nosso patch: backup anterior preservado (nao sobrescrevo com bytes alterados)",
  "install.runtime.copied": "runtime copiado para {0}",
  "install.loader.installed": "carregador instalado em {0}",
  "install.patch.size": "package.json alterado: {0} de {1} bytes disponiveis",
  "install.patch.written": "escrito no lugar ({0}/{1} bytes, resto preenchido com espaco)",
  "install.validated": "validado: main={0}, originalMain={1}",
  "install.validation.failed": "VALIDACAO FALHOU ({0}), revertendo",
  "install.shortcut.made": "atalho criado: {0}",
  "install.shortcut.startmenu.failed": "nao consegui criar o atalho do Menu Iniciar: {0}",
  "install.shortcut.desktop.failed": "nao consegui criar o atalho da Area de Trabalho: {0}",
  "install.launcher.made": "launcher criado: {0}",
  "install.launcher.failed": "nao consegui criar o launcher .cmd: {0}",
  "install.shell.notified": "shell avisado para reindexar os atalhos",
  "install.shell.notify.failed":
    "nao consegui avisar o shell; os atalhos existem e funcionam mesmo assim",
  "install.done": "instalado. abra o Codex por qualquer um destes:",
  "install.icon.missing": "icone nao encontrado em {0}; o atalho usara o icone do app",
  "install.icon.failed": "nao consegui copiar o icone: {0}",
  "install.removed": "removido: {0}",
  "err.app.open":
    "o Codex desta instalacao esta ABERTO ({0}).\nFeche-o antes de reinstalar, senao o robocopy pode deixar a copia pela metade:\n  Get-Process ChatGPT | Stop-Process -Force\nSe souber o que esta fazendo, repita com --force.",
  "err.third.party":
    "o entry point deste app ja foi alterado por outro programa (main = {0}).\nDuas ferramentas no mesmo entry point brigam pelo mesmo canal de IPC e uma delas\npara de funcionar. Remova a outra, ou restaure o app, antes de continuar.",

  "uninstall.restoring": "restaurando o package.json original ({0} bytes, versao {1})",
  "uninstall.entry.now": "entry point agora: {0} (dono: {1})",
  "uninstall.loader.removed": "carregador removido",
  "uninstall.watch.failed": "nao consegui remover os gatilhos do vigia: {0}",
  "uninstall.watch.hint": "rode `node bin/cam.js watch remove` para terminar de tira-los",
  "uninstall.done":
    "desinstalado. A copia continua no disco; apague a mao se quiser recuperar o espaco:",

  "doctor.source.now": "origem detectada agora : {0} {1}",
  "doctor.version.state": "versao no estado       : {0}",
  "doctor.stale": "copia desatualizada    : {0}",
  "doctor.stale.yes": "SIM - o Codex atualizou",
  "doctor.stale.no": "nao",
  "doctor.asar": "arquivo                : {0}",
  "doctor.entry": "entry point            : {0} (dono: {1})",
  "doctor.pkg.space": "espaco no package.json : {0}/{1} bytes",
  "doctor.no.state": "(sem estado)",

  "watch.nothing": "nada a fazer",
  "watch.reapplied": "copia e patch atualizados",
  "watch.update.detected": "atualizacao detectada: {0} -> {1}",
  "watch.need.apply": "rode com --apply para recopiar e reaplicar",
  "watch.deferred": "Codex aberto; adiando a reaplicacao para a proxima passada",
  "watch.uninstalled": "instalacao desativada por `uninstall`; nao vou reaplicar nada",
  "watch.uninstalled.hint": "para voltar a usar o painel: node bin/cam.js install",
  "watch.script": "script do vigia: {0}",
  "watch.logon.trigger": "gatilho de logon: {0}",
  "watch.logon.failed": "nao consegui criar o gatilho de logon: {0}",
  "watch.task.removed": "tarefa anterior removida: {0}",
  "watch.task.periodic.failed": "tarefa periodica nao criada (segue so o logon): {0}",
  "watch.active": "vigia ativo. Cobertura: {0}.",
  "watch.coverage.logon": "logon",
  "watch.coverage.periodic": "a cada 6h",
  "watch.coverage.and": " e ",
  "watch.removed": "removida: {0}",
  "watch.absent": "nao existia: {0}",
  "watch.logon.absent": "gatilho de logon: nao existia",
  "watch.status.registered": "{0}: registrada",
  "watch.status.missing": "{0}: ausente",
  "watch.status.logon": "gatilho de logon (pasta Inicializar): {0}",
  "watch.status.present": "presente",
  "watch.status.notpresent": "ausente",
  "watch.last.install": "ultima instalacao: {0} versao {1}",

  "err.no.state": "sem estado de instalacao; nada para desfazer",
  "err.backup.missing": "backup ausente: {0}",
  "err.backup.hash":
    "o backup do package.json nao casa com o hash gravado; nao vou restaurar",
  "err.no.asar": "nao achei o arquivo em {0}",
  "err.validate.reverted": "patch revertido apos falha de validacao: {0}",
  "err.no.trigger":
    "nenhum gatilho pudo ser instalado; rode `check --apply` a mao depois de uma atualizacao do Codex",
  "err.windows.only": "esta versao e Windows-only de proposito. macOS/Linux ainda nao.",
  "err.prefix": "ERRO: {0}",
  "err.unknown.command": "comando desconhecido: {0}",

  "help.usage":
    "uso: node bin/cam.js <preflight|install|uninstall|doctor|check|watch> [opcoes]",
  "help.preflight1": "  preflight             somente leitura: onde esta o app, se a alteracao cabe,",
  "help.preflight2": "                        e quem e o dono do entry point. Nao escreve nada",
  "help.install1": "  install [--force]     copia o app se preciso e altera o entry point",
  "help.install2": "                        recusa se aquela instalacao do Codex estiver aberta",
  "help.uninstall": "  uninstall             restaura o entry point original e remove atalhos",
  "help.doctor": "  doctor                mostra estado, versoes e quem e o dono do entry point",
  "help.check": "  check [--apply]       detecta atualizacao do Codex; --apply recopia e reaplica",
  "help.watch.install":
    "  watch install         instala os gatilhos: logon (pasta Inicializar) + 6h (tarefa agendada)",
  "help.watch.remove": "  watch remove          remove os gatilhos",
  "help.watch.status": "  watch status          mostra quais gatilhos existem",
  "help.lang": "Idioma: ingles por padrao. Defina CAM_LANG=en para voltar ao ingles.",

  "owner.original": "original",
  "owner.ours": "nosso",
  "owner.third": "terceiro",

  "pf.detected": "=== origem detectada ===",
  "pf.msix": "MSIX: {0}",
  "pf.msix.at": "{0} em {1}",
  "pf.notfound": "(nao achado)",
  "pf.msix.readable": "MSIX legivel? {0}",
  "pf.local": "local: {0} {1} {2}",
  "pf.fit": "=== teste de caber, por arquivo encontrado ===",
  "pf.label.msix": "MSIX original",
  "pf.label.local": "instalacao local {0}",
  "pf.label.mirror": "nossa copia {0}",
  "pf.header.ok": "    cabecalho ok: jsonLen={0} baseOffset={1}",
  "pf.pkg": "    package.json: capacidade={0} usado={1}",
  "pf.main": "    main atual = {0}   dono = {1}",
  "pf.need": "    alterado precisaria de {0} bytes -> {1} (sobra {2})",
  "pf.fits": "CABE",
  "pf.nofit": "NAO CABE",
  "pf.error": "    ERRO: {0}",
  "pf.readonly": "Nada foi escrito no app. Este probe e somente leitura.",
  "pf.report": "Relatorio tambem salvo em: {0}",
};

/** `pt`, `pt-BR`, `PT_br` -> Portuguese. Anything else, including empty, -> English. */
function pickLang() {
  const raw = String(process.env.CAM_LANG || "").trim().toLowerCase();
  return raw.startsWith("pt") ? "pt" : "en";
}

const LANG = pickLang();
const TABLE = LANG === "pt" ? PT : EN;

function t(key, ...args) {
  const raw = TABLE[key] || EN[key] || key;
  return raw.replace(/\{(\d+)\}/g, (m, i) => {
    const v = args[Number(i)];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** Translates the entry point owner, which arrives as a fixed internal code. */
function ownerLabel(owner) {
  if (owner === "nosso") return t("owner.ours");
  if (owner === "terceiro") return t("owner.third");
  return t("owner.original");
}

module.exports = { t, ownerLabel, LANG };
