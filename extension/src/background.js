// Service worker: mantém as sessões de reunião e as salva localmente
// (chrome.storage.local). Só fala com a rede quando o usuário usa a IA.
import { commitSummary } from "./lib/diff.js";
import { mergeSpeakers,
  createSession, applyEvent, normalize, setBlockTags, toggleLastBlockTag, participantNames,
  addAsrSegment, effectiveEntries, toBlocks, speakerName,
} from "./lib/transcript.js";
import { getSettings, DEFAULTS, HQ_MODELS, pushSyncedSettings, pullSyncedSettings } from "./lib/settings.js";
import { getBackupDir, backupPermission, writeSessionFile, removeSessionFile, writeSettingsFile, internalBackupDir, backupFileName, sessionFileText, settingsFileText, SETTINGS_FILE, readBackupFolder } from "./lib/backup.js";
import { accountBase, accountFetch, accountStream, getAccount, setAccount, AccountError } from "./lib/account.js";
import { mergeDocs, sameContent } from "./lib/sync.js";
import { streamClaude, ataRequest, chatRequest, reviewRequest, parseReview, templateFromPdfRequest, templateFromTextRequest, API_ORIGIN } from "./lib/ai.js";
import { captionLanguageIssue } from "./lib/lang.js";
import { compileGlossary, applyGlossary, glossaryForPrompt } from "./lib/glossary.js";
import { deleteAudio, audioInfo, vaultUsage, listAudio, enforceQuota } from "./lib/audiovault.js";
import { computeStats, findMe } from "./lib/stats.js";

const SESSION_GAP_MS = 30 * 60 * 1000;
const SAVE_DELAY_MS = 1000;
const RESUME_MS = 10 * 60 * 1000;
const BACKUP_DELAY_MS = 15_000;

const cache = new Map(); // id -> sessão
const dirty = new Set();
const tabLocks = new Map();
const sessionTab = new Map(); // id -> tabId (reunião em andamento)
const asrInflight = new Set(); // resultados do Whisper ainda sendo aplicados (o encerramento espera por eles)
const endedTab = new Map(); // id -> tabId da reunião encerrada (para "Retomar" pelo painel enquanto a aba existir)
let saveTimer = null;
const backupQueue = new Set(); // ids de reuniões ("settings" para os ajustes) a gravar na pasta
let backupTimer = null;
const autoQueue = new Set(); // backup automático (Downloads ou área interna): grava poucos segundos após cada mudança
let autoTimer = null;
let autoScheduling = false;
const AUTO_BACKUP_DELAY_MS = 3_000; // área interna: barata e invisível, pode ser a cada mudança
const AUTO_BACKUP_DOWNLOADS_DELAY_MS = 45_000; // pasta Downloads: cada gravação passa pela API de downloads, então agrupa

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("src/app/app.html?bemvindo=1") }).catch(() => {});
  await adoptSyncedSettings();
  const { settings } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...DEFAULTS, ...settings } });
  // Primeira vez com sincronização: leva os ajustes deste computador para a conta.
  if (settings?.syncSettings !== false && !(await pullSyncedSettings())) await pushSyncedSettings({ ...DEFAULTS, ...settings }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => adoptSyncedSettings());
// Conta: ao acordar o service worker, atualiza o plano e retoma a sincronização pendente.
setTimeout(() => accountTick().catch(() => {}), 3000);

// ---------------- Ajustes na conta do Chrome ----------------
// Vence a cópia alterada por último (_at). Ao reinstalar, os ajustes voltam da conta.
async function adoptSyncedSettings() {
  try {
    const remote = await pullSyncedSettings();
    if (!remote) return;
    const { settings: local } = await chrome.storage.local.get("settings");
    if (local?.syncSettings === false || remote.syncSettings === false) return;
    if ((remote._at || 0) > (local?._at || 0)) await chrome.storage.local.set({ settings: { ...DEFAULTS, ...local, ...remote } });
  } catch {}
}

// Vocabulário da equipe: as formas erradas são corrigidas em toda fala que chega (legendas e Whisper).
let glossaryRules = [];
async function refreshGlossary() {
  try { glossaryRules = compileGlossary((await getSettings()).glossary); } catch { glossaryRules = []; }
}
refreshGlossary();
const promptGlossary = (settings) => glossaryForPrompt(settings.glossary, settings.teamContext);

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "sync" && Object.keys(changes).some((k) => k.startsWith("settings"))) return adoptSyncedSettings();
  if (area !== "local" || !changes.settings) return;
  refreshGlossary();
  const next = changes.settings.newValue;
  if (!next?._at) return; // só mudanças feitas pelo usuário
  queueBackup(["settings"]);
  queueAutoBackup(["settings"]);
  if (next.syncSettings === false) return;
  const remote = await pullSyncedSettings().catch(() => null);
  if (!remote || next._at > (remote._at || 0)) pushSyncedSettings(next).catch(() => {});
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---------------- Persistência ----------------
async function loadIndex() {
  const { index } = await chrome.storage.local.get("index");
  return index || [];
}

async function getSession(id) {
  if (!id) return null;
  if (cache.has(id)) return cache.get(id);
  const key = `session:${id}`;
  const got = await chrome.storage.local.get(key);
  if (!got[key]) return null;
  const s = normalize(got[key]);
  cache.set(id, s);
  return s;
}

function indexEntry(s) {
  return {
    id: s.id,
    title: s.title,
    platform: s.platform,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    endedAt: s.endedAt,
    count: s.entries.length + s.asr.length,
    participants: participantNames(s),
    highlights: Object.keys(s.highlights).length,
    hasSummary: !!(s.summary && s.summary.text),
    meetingKey: s.meetingKey,
    part: s.part || 1,
  };
}

function scheduleSave(id) {
  dirty.add(id);
  if (!saveTimer) saveTimer = setTimeout(saveDirty, SAVE_DELAY_MS);
}

async function saveDirty() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const ids = [...dirty];
  dirty.clear();
  if (!ids.length) return;
  const index = await loadIndex();
  const patch = {};
  for (const id of ids) {
    const s = cache.get(id);
    if (!s) continue;
    patch[`session:${id}`] = s;
    const i = index.findIndex((e) => e.id === id);
    if (i >= 0) index[i] = indexEntry(s);
    else index.unshift(indexEntry(s));
  }
  index.sort((a, b) => b.startedAt - a.startedAt);
  patch.index = index;
  await chrome.storage.local.set(patch);
  queueBackup(ids);
  queueAutoBackup(ids);
  queueSync(ids);
}

// ---------------- Backup automático (sem escolher pasta) ----------------
// "downloads": cada reunião vira um .json em Downloads\Escribanote\backup pela API de downloads
// (sem diálogo; o registro é apagado do histórico de downloads depois). "opfs": área interna da
// extensão no perfil do Chrome. A pasta escolhida pelo usuário (acima) continua como segunda cópia.
function queueAutoBackup(ids, { now = false } = {}) {
  for (const id of ids) autoQueue.add(id);
  if (now) {
    clearTimeout(autoTimer);
    autoScheduling = false;
    autoTimer = setTimeout(() => flushAutoBackup().catch(() => {}), 0);
    return;
  }
  // Um lote já marcado sai no prazo dele: a reunião ao vivo muda a cada segundo e não pode empurrar o backup para sempre.
  if (autoTimer || autoScheduling) return;
  autoScheduling = true;
  getSettings().then((settings) => {
    if (!autoScheduling) return;
    autoScheduling = false;
    const delay = (settings.backupAuto || "off") === "downloads" ? AUTO_BACKUP_DOWNLOADS_DELAY_MS : AUTO_BACKUP_DELAY_MS;
    autoTimer = setTimeout(() => flushAutoBackup().catch(() => {}), delay);
  });
}

// Esconde a barra/bolha de downloads do navegador enquanto o backup é gravado: sem isso, cada
// gravação aparece como se fosse um download feito pelo usuário. A API é por extensão (não mexe
// no que outras extensões fizeram) e pode não existir em todo navegador.
async function downloadsUi(enabled) {
  try {
    if (chrome.downloads.setUiOptions) await chrome.downloads.setUiOptions({ enabled });
  } catch {}
}
downloadsUi(true); // se o service worker morreu no meio de uma gravação, a barra volta ao normal

async function downloadText(name, text) {
  let url;
  if (text.length < 1_500_000) url = "data:application/json;charset=utf-8," + encodeURIComponent(text);
  else {
    await ensureOffscreen();
    url = (await toOffscreen({ type: "object-url", text, mime: "application/json" })).url;
  }
  await downloadsUi(false);
  try {
    const id = await chrome.downloads.download({ url, filename: `Escribanote/backup/${name}`, conflictAction: "overwrite", saveAs: false });
    await new Promise((ok, fail) => {
      const onChange = (d) => {
        if (d.id !== id || !d.state) return;
        if (d.state.current === "complete") { chrome.downloads.onChanged.removeListener(onChange); ok(); }
        if (d.state.current === "interrupted") { chrome.downloads.onChanged.removeListener(onChange); fail(new Error(d.error?.current || "download interrompido")); }
      };
      chrome.downloads.onChanged.addListener(onChange);
      chrome.downloads.search({ id }).then(([d]) => { if (d?.state === "complete") { chrome.downloads.onChanged.removeListener(onChange); ok(); } });
    });
    await chrome.downloads.erase({ id }).catch(() => {}); // sai do histórico de downloads (o arquivo fica)
  } finally {
    await downloadsUi(true);
    if (url.startsWith("blob:")) toOffscreen({ type: "revoke-url", url }).catch(() => {});
  }
}

async function flushAutoBackup() {
  clearTimeout(autoTimer);
  autoTimer = null;
  autoScheduling = false;
  const settings = await getSettings();
  const mode = settings.backupAuto || "off";
  const { autoBackup = {} } = await chrome.storage.local.get("autoBackup");
  const ids = [...new Set([...(autoBackup.pending || []), ...autoQueue])];
  autoQueue.clear();
  const next = { ...autoBackup, mode };
  if (mode === "off" || !ids.length) {
    if (mode === "off") Object.assign(next, { pending: [] });
    await chrome.storage.local.set({ autoBackup: next });
    return next;
  }
  try {
    const dir = mode === "opfs" ? await internalBackupDir() : null;
    for (const id of ids) {
      if (id === "settings") {
        if (dir) await writeSettingsFile(dir, settings);
        else await downloadText(SETTINGS_FILE, settingsFileText(settings));
        continue;
      }
      const s = await getSession(id);
      if (!s) { if (dir) await removeSessionFile(dir, id); continue; }
      if (dir) await writeSessionFile(dir, s);
      else await downloadText(backupFileName(s), sessionFileText(s));
    }
    const count = (await loadIndex()).length;
    Object.assign(next, { pending: [], error: null, at: Date.now(), count });
  } catch (err) {
    Object.assign(next, { pending: ids, error: err.message || String(err) });
  }
  await chrome.storage.local.set({ autoBackup: next });
  chrome.runtime.sendMessage({ type: "backup-updated" }).catch(() => {});
  return next;
}

// ---------------- Backup na pasta do computador ----------------
// Grava em lotes (a reunião ao vivo muda a cada segundo). Sem permissão para a pasta (o Chrome
// pede de novo depois de reiniciar, a menos que o usuário escolha "permitir sempre"), os ids ficam
// pendentes em chrome.storage.local "backup" e a página do Escribanote oferece retomar.
function queueBackup(ids, { now = false } = {}) {
  for (const id of ids) backupQueue.add(id);
  clearTimeout(backupTimer);
  backupTimer = setTimeout(flushBackup, now ? 0 : BACKUP_DELAY_MS);
}

async function flushBackup() {
  clearTimeout(backupTimer);
  backupTimer = null;
  const { backup = {} } = await chrome.storage.local.get("backup");
  const ids = [...new Set([...(backup.pending || []), ...backupQueue])];
  backupQueue.clear();
  const dir = await getBackupDir();
  if (!dir || !ids.length) return backup;
  const next = { ...backup, folder: dir.name };
  try {
    if ((await backupPermission(dir)) !== "granted") {
      Object.assign(next, { pending: ids, paused: true });
    } else {
      for (const id of ids) {
        if (id === "settings") {
          await writeSettingsFile(dir, await getSettings());
          continue;
        }
        const s = await getSession(id);
        if (s) await writeSessionFile(dir, s);
        else await removeSessionFile(dir, id);
      }
      Object.assign(next, { pending: [], paused: false, error: null, at: Date.now() });
    }
  } catch (err) {
    Object.assign(next, { pending: ids, error: err.message || String(err) });
  }
  await chrome.storage.local.set({ backup: next });
  chrome.runtime.sendMessage({ type: "backup-updated" }).catch(() => {});
  return next;
}

// Cota e retenção do cofre de áudio: apaga o que passou do prazo e, se ainda não couber, as mais
// antigas (as marcadas "manter" e as reuniões em andamento ficam). Roda ao encerrar uma reunião e na
// partida do service worker.
async function enforceAudioQuota() {
  const st = await getSettings();
  const protect = new Set(sessionTab.keys());
  const ids = await enforceQuota({ limitBytes: Number(st.audioQuotaMb || 0) * 1024 * 1024, retentionMs: Number(st.audioRetentionDays || 0) * 86_400_000, protect });
  for (const id of ids) {
    const s = await getSession(id);
    if (s && s.audio) { s.audio = null; noteEvent(s, "audio-evicted"); await changed(s); }
  }
  return ids;
}
setTimeout(() => enforceAudioQuota().catch(() => {}), 15_000);

// Relatório de sessão: eventos datados para diagnóstico (dispositivos, modelo, pausas, encerramento).
// Sem conteúdo da reunião. Guardado na própria reunião; a aba "Diagnóstico" do painel mostra.
const REPORT_MAX = 400;
function noteEvent(s, kind, detail) {
  if (!s) return;
  s.report ||= { events: [] };
  const ev = { at: Date.now(), kind };
  if (detail && Object.keys(detail).length) ev.detail = detail;
  s.report.events.push(ev);
  if (s.report.events.length > REPORT_MAX) s.report.events.splice(0, s.report.events.length - REPORT_MAX);
  scheduleSave(s.id);
}

// Salva e avisa as páginas abertas (app e widget da reunião).
async function changed(s, { now = false } = {}) {
  scheduleSave(s.id);
  if (now) await saveDirty();
  chrome.runtime.sendMessage({ type: "session-updated", id: s.id, tabId: sessionTab.get(s.id) }).catch(() => {});
  const tabId = sessionTab.get(s.id);
  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "session-updated", id: s.id, paused: s.paused }).catch(() => {});
}

// ---------------- Sessão por aba ----------------
async function activeFor(tabId) {
  const key = `active:${tabId}`;
  const { [key]: active } = await chrome.storage.session.get(key);
  if (active) sessionTab.set(active.id, tabId);
  return active || null;
}

async function sessionForTab(tabId, meeting) {
  const active = await activeFor(tabId);
  if (active && (!meeting || active.meetingKey === meeting.key)) {
    const s = await getSession(active.id);
    if (s && !s.endedAt && Date.now() - s.updatedAt < SESSION_GAP_MS) return s;
  }
  if (!meeting) return null;
  const now = Date.now();
  // Retoma a sessão da mesma reunião se ela terminou há pouco (ex.: recarregou a página ou reconectou).
  const recent = (await loadIndex()).find(
    (m) => m.meetingKey === meeting.key && now - (m.endedAt || m.updatedAt) < RESUME_MS,
  );
  if (recent) {
    const prev = await getSession(recent.id);
    if (prev) {
      prev.endedAt = null;
      sessionTab.set(prev.id, tabId);
      await chrome.storage.session.set({ [`active:${tabId}`]: { id: prev.id, meetingKey: meeting.key } });
      return prev;
    }
  }
  const s = createSession({
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    platform: meeting.platform,
    url: meeting.url,
    title: meeting.title,
    startedAt: now,
  });
  s.meetingKey = meeting.key;
  // Mesmo link de novo no mesmo dia (saiu e voltou depois de um tempo, reunião em dois blocos):
  // nova parte, numerada, em vez de misturar tudo ou perder o vínculo.
  const sameDay = (await loadIndex()).filter((m) => m.meetingKey === meeting.key && new Date(m.startedAt).toDateString() === new Date(now).toDateString());
  if (sameDay.length) s.part = Math.max(...sameDay.map((m) => m.part || 1)) + 1;
  cache.set(s.id, s);
  sessionTab.set(s.id, tabId);
  await chrome.storage.session.set({ [`active:${tabId}`]: { id: s.id, meetingKey: meeting.key } });
  return s;
}

async function onEvents(msg, tabId) {
  const s = await sessionForTab(tabId, msg.meeting);
  if (s.paused) return;
  if (msg.meeting.title && (!s.title || s.title === "Reunião sem título")) s.title = msg.meeting.title;
  let didChange = msg.events.some((ev) => ev.kind === "meeting-start" && !s.entries.length); // huddle detectado: a sessão já existe
  if (!s.report?.events?.length) noteEvent(s, "start", { platform: s.platform, version: chrome.runtime.getManifest().version });
  const had = s.entries.length;
  for (const ev of msg.events) {
    if ((ev.kind === "caption" || ev.kind === "chat") && ev.text) ev.text = applyGlossary(ev.text, glossaryRules);
    didChange = applyEvent(s, ev) || didChange;
  }
  if (!had && s.entries.length) noteEvent(s, "first-caption", { source: s.entries[0].source, afterMs: Date.now() - s.startedAt });
  if (!didChange) return;
  setBadge(tabId, s);
  await changed(s);
  scheduleReview(s);
}

function setBadge(tabId, s) {
  chrome.action.setBadgeText({ tabId, text: s.paused ? "II" : "REC" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: s.paused ? "#6b7280" : "#d93025" }).catch(() => {});
}

async function endSession(tabId, reason = "unknown") {
  const active = await activeFor(tabId);
  if (!active) return;
  const s = await getSession(active.id);
  if (s && !s.endedAt) {
    noteEvent(s, "end", { reason, entries: s.entries.length, asr: s.asr.length });
    // Primeiro o Whisper termina o que tinha na fila (os resultados chegam por mensagem e precisam
    // encontrar a sessão ainda aberta); só depois a sessão fecha. Antes, esses últimos trechos se perdiam.
    await Promise.race([stopHq(tabId), new Promise((r) => setTimeout(r, 25_000))]);
    await Promise.allSettled([...asrInflight]);
  }
  await chrome.storage.session.remove(`active:${tabId}`);
  sessionTab.delete(active.id);
  endedTab.set(active.id, tabId);
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {}); // o selo REC some junto com a sessão
  if (!s || s.endedAt) return;
  s.endedAt = s.updatedAt;
  await changed(s, { now: true });
  queueBackup([s.id], { now: true }); // reunião terminou: backup já, sem esperar o lote
  queueAutoBackup([s.id], { now: true });
  const settings = await getSettings();
  enforceAudioQuota().catch(() => {});
  // a tela pós-reunião abre já; revisão e ata continuam em segundo plano e aparecem nela
  openAfterCall(s, settings).catch((err) => console.warn("abrir após a chamada:", err));
  if (settings.autoReview) await reviewPending(s).catch(() => {});
  maybeAutoAta(s);
}

// Slack (Pro): com "publicar sozinho" ligado na conta, a ata automática vai para o canal padrão.
// A reunião precisa estar na conta antes (a API lê a ata de lá); o servidor ignora o pedido se "auto"
// estiver desligado ou se a ata já tiver sido publicada.
async function postAtaToSlack(s) {
  if (!(await isPro()) || !(await syncActive())) return;
  queueSync([s.id], { now: true });
  await flushSync();
  if (!(await getSyncMeta()).versions[s.id]) return;
  await accountFetch(`/meetings/${encodeURIComponent(s.id)}/slack`, { method: "POST", body: { ifAuto: true } });
}

// Ajuste "Ao sair da reunião": abre a tela pós-reunião assim que a chamada termina.
// "app" abre a reunião no Escribanote; "web" (Pro) envia a reunião para a conta e abre o app web
// nela (transcrição, ata e chat); se o envio não der, abre no Escribanote mesmo.
async function openAfterCall(s, settings) {
  const mode = settings.afterCall || "off";
  const diag = { at: Date.now(), id: s.id, mode, entries: s.entries.length + s.asr.length, recorder: !!s.recorder };
  const note = (patch) => chrome.storage.local.set({ afterCallDiag: Object.assign(diag, patch) }).catch(() => {});
  if (mode === "off" || s.recorder || diag.entries === 0) return note({ skipped: true });
  let url = chrome.runtime.getURL(`src/app/app.html?id=${encodeURIComponent(s.id)}&fim=1`);
  if (mode === "web" && (await isPro())) {
    try {
      if (await syncActive()) {
        queueSync([s.id], { now: true });
        await flushSync();
      }
      if ((await getSyncMeta()).versions[s.id]) url = `${await accountBase()}/app/#/r/${encodeURIComponent(s.id)}`;
    } catch (err) {
      note({ syncError: err.message });
    }
  }
  try {
    const tab = await chrome.tabs.create({ url, active: true });
    note({ url, tabId: tab.id });
  } catch (err) {
    note({ url, error: err.message });
    throw err;
  }
}

async function maybeAutoAta(s) {
  const settings = await getSettings();
  if (!settings.autoAta || s.summary || s.entries.length + s.asr.length < 8) return;
  const ai = await aiProvider();
  if (!ai) return;
  try {
    s.summary = await runAta(ai, s, settings);
    await commitAta(s, settings);
    await changed(s, { now: true });
    postAtaToSlack(s).catch(() => {});
  } catch {
    // Sem rede ou chave inválida: o usuário pode gerar a ata manualmente depois.
  }
}

// ---------------- Revisão por IA ----------------
const reviewTimers = new Map();
const reviewing = new Set();

async function aiReady() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) return null;
  if (!(await chrome.permissions.contains({ origins: [API_ORIGIN] }))) return null;
  return apiKey;
}

// A IA usa a chave própria quando há uma; senão, os créditos da conta Escribanote Pro.
async function aiProvider() {
  const apiKey = await aiReady();
  if (apiKey) return { kind: "key", apiKey };
  const acct = await getAccount();
  if (acct && acct.plan === "pro" && !acct.invalid) return { kind: "account" };
  return null;
}
const NO_AI = "Para usar a IA, cadastre sua chave de API em Ajustes ou conecte a sua conta Escribanote Pro.";

// Documento enviado à IA da conta (sem capturas de tela).
const forAccount = (s) => ({ ...s, shots: [] });

async function accountCall(fn) {
  try {
    const r = await fn();
    if (r && typeof r.balance === "number") setAccount({ balance: r.balance }).then(notifyAccount);
    return r;
  } catch (err) {
    if (err instanceof AccountError && typeof err.body?.balance === "number") setAccount({ balance: err.body.balance }).then(notifyAccount);
    if (err instanceof AccountError && err.status === 401) await setAccount({ invalid: true }).then(notifyAccount);
    throw err;
  }
}

// ---------------- Modelos de ata (do usuário) ----------------
// Ficam em chrome.storage.local (podem ser grandes demais para o sync): [{id, name, text, createdAt, updatedAt}].
const MAX_TEMPLATE_CHARS = 24000;
async function loadTemplates() {
  const { ataTemplates } = await chrome.storage.local.get("ataTemplates");
  return Array.isArray(ataTemplates) ? ataTemplates : [];
}
async function saveTemplate({ id, name, text }) {
  const list = await loadTemplates();
  const clean = { name: String(name || "Modelo").trim().slice(0, 80), text: String(text || "").trim().slice(0, MAX_TEMPLATE_CHARS) };
  if (!clean.text) throw new Error("O modelo está vazio.");
  const now = Date.now();
  const i = list.findIndex((t) => t.id === id);
  if (i >= 0) list[i] = { ...list[i], ...clean, updatedAt: now };
  else list.push({ id: id || now.toString(36) + Math.random().toString(36).slice(2, 6), ...clean, createdAt: now, updatedAt: now });
  await chrome.storage.local.set({ ataTemplates: list });
  return list;
}
async function deleteTemplate(id) {
  const list = (await loadTemplates()).filter((t) => t.id !== id);
  await chrome.storage.local.set({ ataTemplates: list });
  const settings = await getSettings();
  if (settings.ataTemplate === id) await chrome.storage.local.set({ settings: { ...settings, ataTemplate: "" } });
  return list;
}
// Modelo que vale para esta reunião: o escolhido nela, senão o padrão dos Ajustes.
async function templateFor(s, settings) {
  const id = s.ataTemplateId !== undefined && s.ataTemplateId !== null ? s.ataTemplateId : settings.ataTemplate;
  if (!id) return "";
  const t = (await loadTemplates()).find((x) => x.id === id);
  return t ? t.text : "";
}
// Extrai um modelo a partir de um PDF (base64) ou de um texto colado, pela IA.
async function importTemplate(ai, { pdfBase64, text }) {
  const req = pdfBase64 ? templateFromPdfRequest(pdfBase64) : templateFromTextRequest(text || "");
  if (ai.kind === "key") {
    const settings = await getSettings();
    const r = await streamClaude({ apiKey: ai.apiKey, model: settings.aiModel, ...req, maxTokens: 8000 });
    return r.text.trim();
  }
  const r = await accountCall(() => accountFetch("/ai/template", { method: "POST", body: pdfBase64 ? { pdfBase64 } : { text } }));
  return (r.text || "").trim();
}

// Cada ata gerada vira uma versão no histórico, com o nome do modelo usado no rótulo.
async function commitAta(s, settings) {
  if (!s.summary?.text) return;
  const id = s.ataTemplateId !== undefined && s.ataTemplateId !== null ? s.ataTemplateId : settings.ataTemplate;
  const tpl = id && id !== "none" ? (await loadTemplates()).find((x) => x.id === id) : null;
  s.summary.templateId = tpl ? tpl.id : null;
  const withInstr = ataInstructions(s, settings) ? " · com instruções extras" : "";
  commitSummary(s, s.summary, { source: "ai", label: (tpl ? `Gerada pela IA · modelo ${tpl.name}` : "Gerada pela IA") + withInstr });
}

// Instruções extras em vigor para a ata: as da reunião, senão as padrão dos Ajustes.
const ataInstructions = (s, settings) => (s.ataPrompt || "").trim() || (settings.ataInstructions || "").trim();

async function runAta(ai, s, settings, { onDelta, signal } = {}) {
  const template = await templateFor(s, settings);
  const instructions = ataInstructions(s, settings);
  if (ai.kind === "key") {
    return streamClaude({ apiKey: ai.apiKey, model: settings.aiModel, ...ataRequest(s, settings.tags, promptGlossary(settings), template, instructions), onDelta, signal });
  }
  const done = await accountCall(() =>
    accountStream("/ai/summary", { meeting: forAccount(s), tags: settings.tags, glossary: promptGlossary(settings), template, instructions }, { onDelta, signal }),
  );
  return { text: done.text, model: done.model, stopReason: "end_turn", createdAt: Date.now(), via: "account" };
}

async function runChat(ai, s, messages, settings, { previous, onDelta, signal } = {}) {
  if (ai.kind === "key") {
    const reqBody = chatRequest(s, messages, { tags: settings.tags, previous, glossary: promptGlossary(settings) });
    return streamClaude({ apiKey: ai.apiKey, model: settings.aiModel, ...reqBody, maxTokens: 8000, onDelta, signal });
  }
  const done = await accountCall(() =>
    accountStream("/ai/ask", { meeting: forAccount(s), history: messages.map((m) => ({ role: m.role, text: m.text })), tags: settings.tags, glossary: promptGlossary(settings) }, { onDelta, signal }),
  );
  return { text: done.text, model: done.model };
}

async function runReview(ai, s, items, context, settings) {
  if (ai.kind === "key") {
    const res = await streamClaude({ apiKey: ai.apiKey, model: settings.aiModel, ...reviewRequest(items, { glossary: promptGlossary(settings), context }), maxTokens: 8000 });
    return parseReview(res.text, items);
  }
  const r = await accountCall(() => accountFetch("/ai/review", { method: "POST", body: { meetingId: s.id, items, context, glossary: promptGlossary(settings) } }));
  return r.fixes || {};
}

// Revisão automática durante a reunião: a cada ~20 s, em lote, só falas já estabilizadas.
async function scheduleReview(s) {
  const settings = await getSettings();
  if (!settings.autoReview || reviewTimers.has(s.id)) return;
  reviewTimers.set(s.id, setTimeout(async () => {
    reviewTimers.delete(s.id);
    await reviewPending(s).catch(() => {});
  }, 20_000));
}

// Revisa as falas ainda não revisadas. force: inclui falas recentes (ex.: botão "Revisar").
async function reviewPending(s, { force = false, onProgress } = {}) {
  if (reviewing.has(s.id)) return { skipped: true };
  const ai = await aiProvider();
  if (!ai) throw new Error(NO_AI);
  const settings = await getSettings();
  reviewing.add(s.id);
  try {
    const now = Date.now();
    const all = effectiveEntries(s).filter((e) => e.kind === "caption");
    const todo = all.filter((e) => !s.reviewed[e.id] && (force || s.endedAt || now - e.updatedAt > 8000));
    let changedCount = 0;
    for (let i = 0; i < todo.length; i += 40) {
      const batch = todo.slice(i, i + 40);
      const items = batch.map((e) => ({ id: e.id, speaker: speakerName(s, e.speakerId), text: e.original }));
      const firstIdx = all.indexOf(batch[0]);
      const context = all.slice(Math.max(0, firstIdx - 8), firstIdx).map((e) => ({ id: e.id, speaker: speakerName(s, e.speakerId), text: e.text }));
      const fixes = await runReview(ai, s, items, context, settings);
      for (const it of items) {
        s.reviewed[it.id] = true;
        if (fixes[it.id]) {
          s.fixes[it.id] = fixes[it.id];
          changedCount++;
        }
      }
      await changed(s, { now: true });
      onProgress?.({ done: Math.min(i + 40, todo.length), total: todo.length, changed: changedCount });
    }
    return { total: todo.length, changed: changedCount };
  } finally {
    reviewing.delete(s.id);
  }
}

// ---------------- Alta precisão (Whisper local) ----------------
const hqStatus = new Map(); // tabId -> status
const OFFSCREEN_URL = "src/offscreen/offscreen.html";

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Transcrever localmente o áudio da reunião com o Whisper.",
  });
}

function toOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: "offscreen", ...msg });
}

function broadcastHq(tabId, status) {
  hqStatus.set(tabId, status);
  chrome.runtime.sendMessage({ type: "hq-updated", tabId, status }).catch(() => {});
  chrome.tabs.sendMessage(tabId, { type: "hq-updated", status }).catch(() => {});
}

async function startHq(tabId) {
  const settings = await getSettings();
  // Sem modelo escolhido (ex.: huddle do Slack, que só tem o áudio), usa o do gravador ou o rápido.
  const modelKey = settings.hq !== "off" ? settings.hq : settings.recorderModel || "base";
  if (!HQ_MODELS[modelKey]) throw new Error("Modelo de reconhecimento inválido.");
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    throw new Error("O Chrome só libera o áudio depois que você clica no ícone do Escribanote na aba da reunião. Clique no ícone e tente de novo.");
  }
  await ensureOffscreen();
  broadcastHq(tabId, { state: "starting" });
  const hs = await activeFor(tabId);
  if (hs) noteEvent(await getSession(hs.id), "hq-start", { model: modelKey, mic: !!settings.hqMic, diarize: !!settings.diarize, audio: !!settings.audioKeep });
  const keep = settings.audioKeep && hs ? { sessionId: hs.id } : null;
  const r = await toOffscreen({ type: "start", tabId, streamId, modelKey, lang: settings.captionLang, mic: settings.hqMic, echo: settings.echoFilter !== false, diarize: settings.diarize && (await isPro()), keep });
  if (r && r.error) {
    broadcastHq(tabId, { state: "error", message: r.error });
    throw new Error(r.error);
  }
  return true;
}

async function stopHq(tabId) {
  if (!hqStatus.has(tabId) || hqStatus.get(tabId).state === "idle") return;
  const hs = await activeFor(tabId);
  if (hs) noteEvent(await getSession(hs.id), "hq-stop");
  await toOffscreen({ type: "stop" }).catch(() => {});
  broadcastHq(tabId, { state: "idle" });
}

// Identificação de falantes pela voz é do plano Pro (roda no computador, mas é um diferencial do plano).
async function isPro() {
  const a = await getAccount();
  return !!(a && a.plan === "pro" && !a.invalid);
}

function meIdFor(s, myName) {
  const n = (myName || "").trim().toLowerCase();
  if (!n) return "me";
  const hit = Object.entries(s.speakers).find(([, name]) => name.toLowerCase() === n || name.toLowerCase().startsWith(n + " "));
  return hit ? hit[0] : "me";
}

async function onAsrResult(msg) {
  let s;
  if (msg.sessionId) {
    // retranscrição ou arquivo importado: a reunião já terminou, não há aba
    s = await getSession(msg.sessionId);
    if (!s) return;
  } else {
    const active = await activeFor(msg.tabId);
    if (!active) return;
    s = await getSession(active.id);
    if (!s || s.paused || s.endedAt) return;
  }
  const settings = await getSettings();
  s.myName = settings.myName || "";
  if (msg.seg && msg.seg.text) msg.seg.text = applyGlossary(msg.seg.text, glossaryRules);
  if (addAsrSegment(s, msg.seg, meIdFor(s, settings.myName))) {
    await changed(s);
    scheduleReview(s);
  }
}

// Visão pronta para o widget (mesma lógica de blocos do app).
async function widgetView(s) {
  if (!s) return null;
  const settings = await getSettings();
  const blocks = toBlocks(s).slice(-30).map(({ texts, originals, ...b }) => b);
  const st = computeStats(s);
  const me = findMe(st, settings.myName);
  const top = st.speakers[0];
  const tabId = sessionTab.get(s.id);
  return {
    id: s.id,
    startedAt: s.startedAt,
    paused: s.paused,
    count: s.entries.length + s.asr.length,
    blocks,
    names: Object.fromEntries(
      [...new Set([...Object.keys(s.speakers), ...s.entries.map((e) => e.speakerId), ...s.asr.map((a) => a.speakerId)])]
        .filter((id) => id && !s.merged[id])
        .map((id) => [id, speakerName(s, id)]),
    ),
    share: st.speakers.length && st.totalWords >= 20 ? (me ? { me: true, name: me.name, pct: Math.round(me.share * 100) } : { me: false, name: top.name, pct: Math.round(top.share * 100) }) : null,
    langIssue: captionLanguageIssue(s, settings.captionLang),
    hq: tabId != null ? hqStatus.get(tabId) || { state: "idle" } : { state: "idle" },
  };
}

// ---------------- Ações sobre a sessão ----------------
async function screenshot(s, tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new Error("Deixe a aba da reunião visível para capturar a tela.");
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 75 });
  const id = Date.now().toString(36);
  await chrome.storage.local.set({ [`shot:${s.id}:${id}`]: dataUrl });
  s.shots.push({ id, at: Date.now() });
  await changed(s, { now: true });
  return id;
}

async function getShots(s) {
  const keys = s.shots.map((x) => `shot:${s.id}:${x.id}`);
  const got = keys.length ? await chrome.storage.local.get(keys) : {};
  return Object.fromEntries(s.shots.map((x) => [x.id, got[`shot:${s.id}:${x.id}`]]).filter(([, v]) => v));
}

async function deleteSession(id) {
  const s = await getSession(id);
  deleteAudio(id).catch(() => {});
  cache.delete(id);
  dirty.delete(id);
  const index = (await loadIndex()).filter((e) => e.id !== id);
  const keys = [`session:${id}`, ...(s ? s.shots.map((x) => `shot:${id}:${x.id}`) : [])];
  await chrome.storage.local.remove(keys);
  await chrome.storage.local.set({ index });
  queueBackup([id]); // apaga também o arquivo da pasta de backup
  queueAutoBackup([id]);
  chrome.runtime.sendMessage({ type: "index-updated" }).catch(() => {});
}

async function allSessions() {
  const index = await loadIndex();
  const out = [];
  for (const m of index) {
    const s = await getSession(m.id);
    if (s) out.push(s);
  }
  return out;
}

async function search(q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const results = [];
  for (const s of await allSessions()) {
    const hit = s.entries.find((e) => e.text.toLowerCase().includes(needle));
    const inTitle = s.title.toLowerCase().includes(needle);
    const inNotes = s.notes.text.toLowerCase().includes(needle);
    if (!hit && !inTitle && !inNotes) continue;
    let snippet = "";
    if (hit) {
      const i = hit.text.toLowerCase().indexOf(needle);
      snippet = (i > 40 ? "…" : "") + hit.text.slice(Math.max(0, i - 40), i + needle.length + 60);
    }
    results.push({ id: s.id, snippet });
  }
  return results;
}

async function importSessions(list) {
  let added = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || !raw.id || !Array.isArray(raw.entries) || (await getSession(raw.id))) continue;
    const s = normalize({ ...raw, shots: [] });
    delete s.blocks;
    cache.set(s.id, s);
    scheduleSave(s.id);
    added++;
  }
  await saveDirty();
  chrome.runtime.sendMessage({ type: "index-updated" }).catch(() => {});
  return added;
}

// ---------------- Mensagens ----------------
async function handle(msg, sender) {
  const senderTab = sender.tab && sender.tab.id;
  // Mensagens do widget/bridge se referem à sessão da própria aba.
  const s = msg.id ? await getSession(msg.id) : senderTab != null ? await sessionForTab(senderTab) : null;

  switch (msg.type) {
    case "events": {
      // Serializa por aba para não criar duas sessões para a mesma reunião.
      const run = (tabLocks.get(senderTab) || Promise.resolve()).then(() => onEvents(msg, senderTab));
      tabLocks.set(senderTab, run.catch(() => {}));
      return run;
    }
    case "meeting-left":
      return endSession(senderTab, msg.reason || "meeting-left");
    case "audio-meta": {
      // quem grava (offscreen, gravador) informa início, faixas, bytes e fim
      const as = await getSession(msg.sessionId);
      if (!as || !msg.meta) return false;
      as.audio = { ...(as.audio || {}), ...msg.meta };
      await changed(as);
      return true;
    }
    case "audio-info":
      return audioInfo(msg.id);
    case "audio-delete": {
      if (!s) return null;
      await deleteAudio(s.id);
      s.audio = null;
      noteEvent(s, "audio-deleted");
      await changed(s, { now: true });
      return s;
    }
    case "audio-keep-toggle": {
      // "manter": fora da retenção e da cota
      if (!s || !s.audio) return s;
      s.audio.keep = !s.audio.keep;
      const { writeMeta, readMeta } = await import("./lib/audiovault.js");
      const meta = (await readMeta(s.id)) || {};
      await writeMeta(s.id, { ...meta, keep: s.audio.keep }).catch(() => {});
      await changed(s, { now: true });
      return s;
    }
    case "audio-usage": {
      const u = await vaultUsage();
      const st = await getSettings();
      return { ...u, limitBytes: Number(st.audioQuotaMb || 0) * 1024 * 1024, retentionDays: Number(st.audioRetentionDays || 0) };
    }
    case "audio-wipe": {
      for (const a of await listAudio()) {
        await deleteAudio(a.id);
        const ws = await getSession(a.id);
        if (ws && ws.audio) { ws.audio = null; await changed(ws); }
      }
      return true;
    }
    case "retranscribe": {
      // Transcreve de novo a partir do áudio guardado (ou pela primeira vez, num arquivo importado).
      if (!s) throw new Error("Reunião não encontrada.");
      if (!s.audio || !s.audio.tracks || !s.audio.tracks.length) throw new Error("Esta reunião não tem áudio guardado.");
      if (sessionTab.has(s.id)) throw new Error("A reunião ainda está em andamento.");
      const st = await getSettings();
      const modelKey = HQ_MODELS[msg.modelKey] ? msg.modelKey : st.hq !== "off" ? st.hq : "base";
      const diarize = (msg.diarize ?? st.diarize) && (await isPro());
      noteEvent(s, "retranscribe-start", { model: modelKey, diarize: !!diarize, tracks: s.audio.tracks });
      s.asr = [];
      s.voices = {};
      s.fixes = {};
      s.reviewed = {};
      await changed(s, { now: true });
      await ensureOffscreen();
      const r = await toOffscreen({ type: "retranscribe", sessionId: s.id, modelKey, lang: msg.lang || st.captionLang, diarize, startedAt: s.audio.startedAt, tracks: s.audio.tracks });
      if (r && r.error) { noteEvent(s, "retranscribe-error", { message: r.error }); await changed(s, { now: true }); throw new Error(r.error); }
      const done = await getSession(s.id);
      done.audio = { ...(done.audio || {}), model: modelKey, durationMs: done.audio?.durationMs || r.durationMs };
      if (!done.audio.durationMs && r.durationMs) done.audio.durationMs = r.durationMs;
      noteEvent(done, "retranscribe-done", { segments: r.segments, model: modelKey });
      await changed(done, { now: true });
      if (st.autoReview) reviewPending(done, { force: true }).catch(() => {});
      return done;
    }
    case "import-create": {
      // Arquivo de áudio/vídeo importado pelo painel: nasce uma reunião já encerrada, sem aba; o painel
      // grava o arquivo no cofre e pede a transcrição com "retranscribe".
      const startedAt = Number(msg.startedAt) || Date.now();
      const rec = createSession({ id: `imp-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 7)}`, platform: "import", url: "", title: String(msg.title || "Arquivo importado").slice(0, 200), startedAt });
      rec.origin = "import";
      rec.endedAt = startedAt;
      rec.speakers.outros = "Gravação";
      noteEvent(rec, "import", { name: String(msg.name || "").slice(0, 120), bytes: Number(msg.bytes) || 0 });
      cache.set(rec.id, rec);
      await changed(rec, { now: true });
      return rec;
    }
    case "session-report": {
      // eventos do offscreen (com tabId ou sessionId), do gravador e da página da reunião (aba remetente)
      if (msg.sessionId) {
        const rs2 = await getSession(msg.sessionId);
        if (rs2) noteEvent(rs2, String(msg.kind || "event").slice(0, 40), msg.detail && typeof msg.detail === "object" ? msg.detail : {});
        return !!rs2;
      }
      const tabId = msg.tabId ?? senderTab;
      if (tabId == null) return false;
      const a = await activeFor(tabId);
      const rs = a ? await getSession(a.id) : null;
      if (!rs) return false;
      noteEvent(rs, String(msg.kind || "event").slice(0, 40), msg.detail && typeof msg.detail === "object" ? msg.detail : {});
      return true;
    }
    case "consent-get": {
      const { consent = {} } = await chrome.storage.session.get("consent");
      return consent[msg.key] ?? null;
    }
    case "consent-set": {
      const { consent = {} } = await chrome.storage.session.get("consent");
      consent[msg.key] = msg.value;
      await chrome.storage.session.set({ consent });
      return true;
    }
    case "my-session":
      return s;
    case "my-view":
      return widgetView(s);
    case "asr-result": {
      // vem do offscreen (com tabId) ou do gravador do computador (a própria aba)
      const p = onAsrResult({ ...msg, tabId: msg.tabId ?? senderTab });
      asrInflight.add(p);
      p.finally(() => asrInflight.delete(p));
      return p;
    }
    case "recorder-start": {
      // Gravador do computador (Slack e outros apps): a aba do gravador faz o papel da reunião,
      // então fechar a aba encerra a sessão como sair de uma reunião.
      if (senderTab == null) throw new Error("Abra o gravador numa aba.");
      await endSession(senderTab);
      const now = Date.now();
      const rec = await sessionForTab(senderTab, { platform: msg.platform || "desktop", key: `rec:${senderTab}:${now}`, title: msg.title, url: "" });
      rec.recorder = true;
      rec.speakers.outros ||= "Participantes";
      setBadge(senderTab, rec);
      await changed(rec, { now: true });
      return rec.id;
    }
    case "open-recorder":
      await chrome.tabs.create({ url: chrome.runtime.getURL("src/app/gravar.html") });
      return true;
    case "recorder-stop":
      await endSession(senderTab, "recorder-stop");
      return true;
    case "hq-status":
      // vindo do documento offscreen
      if (msg.tabId != null) broadcastHq(msg.tabId, msg.status);
      return true;
    case "hq-start": {
      const tabId = msg.tabId ?? (s && sessionTab.get(s.id)) ?? senderTab;
      if (tabId == null) throw new Error("Abra o Escribanote na aba da reunião.");
      return startHq(tabId);
    }
    case "hq-stop":
      await stopHq(msg.tabId ?? (s && sessionTab.get(s.id)) ?? senderTab);
      return true;
    case "hq-get": {
      const tabId = msg.tabId ?? (s && sessionTab.get(s.id));
      return hqStatus.get(tabId) || { state: "idle" };
    }
    case "asr-diag": {
      // diagnóstico do motor Whisper vindo do offscreen (que não tem chrome.storage)
      const { asrDiag = {} } = await chrome.storage.local.get("asrDiag");
      await chrome.storage.local.set({ asrDiag: { ...asrDiag, ...msg.patch, at: Date.now() } });
      return true;
    }
    case "is-pro":
      return isPro();
    case "ata-save": {
      // Edição manual da ata: vira a versão atual e entra no histórico.
      if (!s) return null;
      const text = String(msg.text || "").trim().slice(0, 200000);
      if (!text) throw new Error("A ata está vazia.");
      s.summary = { ...(s.summary || {}), text, createdAt: Date.now(), model: "manual", templateId: s.summary?.templateId ?? null };
      commitSummary(s, s.summary, { source: "edit", label: msg.label ? `Editada à mão · ${String(msg.label).slice(0, 80)}` : "Editada à mão" });
      await changed(s, { now: true });
      return s;
    }
    case "ata-restore": {
      if (!s) return null;
      const v = (s.summaryHistory || []).find((x) => x.id === msg.versionId);
      if (!v) throw new Error("Versão não encontrada.");
      s.summary = { text: v.text, createdAt: Date.now(), model: v.model, templateId: v.templateId ?? null };
      commitSummary(s, s.summary, { source: "restore", label: `Restaurada da v${v.n}`, parentId: v.id });
      await changed(s, { now: true });
      return s;
    }
    case "ata-templates":
      return loadTemplates();
    case "ata-template-save":
      return saveTemplate(msg);
    case "ata-template-delete":
      return deleteTemplate(msg.id);
    case "ata-template-import": {
      const ai = await aiProvider();
      if (!ai) throw new Error(NO_AI);
      return { text: await importTemplate(ai, msg) };
    }
    case "speakers-test": {
      // diagnóstico: turnos e vozes das amostras enviadas (identificação de falantes)
      await ensureOffscreen();
      return toOffscreen({ type: "analyze-speakers", clips: msg.clips });
    }
    case "hq-test": {
      // diagnóstico: transcreve amostras enviadas pela página de ajustes/testes
      await ensureOffscreen();
      return toOffscreen({ type: "transcribe-samples", samples: msg.samples, modelKey: msg.modelKey || "base", lang: msg.lang || "pt-BR" });
    }
    case "lang-issue": {
      const settings = await getSettings();
      return s ? captionLanguageIssue(s, settings.captionLang) : null;
    }
    case "list":
      return loadIndex();
    case "get":
      return s;
    case "active-for-tab": {
      const active = await activeFor(msg.tabId);
      return active ? active.id : null;
    }
    case "update": {
      if (!s) return null;
      if (typeof msg.title === "string" && msg.title.trim()) s.title = msg.title.trim().slice(0, 200);
      if (msg.summary !== undefined) s.summary = msg.summary;
      if (msg.speakers) Object.assign(s.speakers, msg.speakers);
      if (typeof msg.notesText === "string") s.notes.text = msg.notesText;
      if ("ataTemplateId" in msg) s.ataTemplateId = msg.ataTemplateId || null;
      if (typeof msg.ataPrompt === "string") s.ataPrompt = msg.ataPrompt.trim().slice(0, 4000);
      await changed(s, { now: true });
      return s;
    }
    case "merge-speakers": {
      if (!s) return null;
      const moved = mergeSpeakers(s, msg.from, msg.to);
      await changed(s, { now: true });
      return { ...s, moved };
    }
    case "end-live": {
      // "Parar" pelo painel: a aba da reunião fecha a sessão (e para de captar); sem aba, fecha aqui mesmo.
      if (!s || s.endedAt) return s;
      const tabId = sessionTab.get(s.id);
      if (tabId != null) {
        const viaTab = await chrome.tabs.sendMessage(tabId, { type: "end-session" }).then(() => true, () => false);
        if (viaTab) await waitUntil(async () => !!(await getSession(s.id))?.endedAt, 4000);
        if (!(await getSession(s.id))?.endedAt) await endSession(tabId, "stop-panel");
      } else {
        noteEvent(s, "end", { reason: "stop-panel", entries: s.entries.length, asr: s.asr.length });
        s.endedAt = s.updatedAt;
        await changed(s, { now: true });
      }
      return getSession(s.id);
    }
    case "resume-live": {
      // "Retomar" pelo painel: só enquanto a aba da reunião existir; a sessão reabre e volta a receber.
      if (!s) return { error: "Reunião não encontrada." };
      if (!s.endedAt) return s;
      const tabId = endedTab.get(s.id);
      const ok = tabId != null && (await chrome.tabs.sendMessage(tabId, { type: "resume-session" }).then(() => true, () => false));
      if (!ok) return { error: "A aba da reunião já foi fechada; não dá para retomar." };
      s.endedAt = null;
      noteEvent(s, "resume-after-end", { via: "panel" });
      sessionTab.set(s.id, tabId);
      await chrome.storage.session.set({ [`active:${tabId}`]: { id: s.id, meetingKey: s.meetingKey } });
      setBadge(tabId, s);
      await changed(s, { now: true });
      return s;
    }
    case "pause": {
      if (!s) return null;
      s.paused = typeof msg.paused === "boolean" ? msg.paused : !s.paused;
      noteEvent(s, s.paused ? "pause" : "resume");
      const tabId = sessionTab.get(s.id);
      if (tabId != null) setBadge(tabId, s);
      await changed(s, { now: true });
      return s;
    }
    case "tag-block": {
      if (!s) return null;
      setBlockTags(s, msg.ids, msg.tags);
      await changed(s, { now: true });
      return s;
    }
    case "highlight-last": {
      if (!s) return null;
      const r = toggleLastBlockTag(s, msg.tagId || "importante");
      if (r) await changed(s, { now: true });
      return r;
    }
    case "add-note": {
      if (!s || !msg.text || !msg.text.trim()) return null;
      s.notes.items.push({ id: Date.now().toString(36), at: msg.at || Date.now(), text: msg.text.trim().slice(0, 2000) });
      await changed(s, { now: true });
      return s;
    }
    case "delete-note": {
      if (!s) return null;
      s.notes.items = s.notes.items.filter((n) => n.id !== msg.noteId);
      await changed(s, { now: true });
      return s;
    }
    case "screenshot": {
      if (!s) throw new Error("Nenhuma reunião ativa nesta aba.");
      const tabId = senderTab ?? sessionTab.get(s.id);
      if (tabId == null) throw new Error("A reunião não está mais aberta.");
      return screenshot(s, tabId);
    }
    case "delete-shot": {
      if (!s) return null;
      s.shots = s.shots.filter((x) => x.id !== msg.shotId);
      await chrome.storage.local.remove(`shot:${s.id}:${msg.shotId}`);
      await changed(s, { now: true });
      return s;
    }
    case "get-shots":
      return s ? getShots(s) : {};
    case "delete":
      await deleteSession(msg.id);
      return true;
    case "search":
      return search(msg.q || "");
    case "export-all":
      return (await allSessions()).map(({ aliases, ...rest }) => rest);
    case "import":
      return importSessions(msg.sessions);
    case "account-state":
      return { account: await publicAccount(), sync: await getSyncMeta(), pending: await pendingCount() };
    case "account-refresh":
      await refreshAccount().catch(() => {});
      return { account: await publicAccount() };
    case "sync-now":
      await pullSync().catch(() => {});
      queueSync((await loadIndex()).map((m) => m.id), { now: true });
      return { ok: true };
    case "sync-consent": {
      const meta = await getSyncMeta();
      meta.consent = msg.mode === "new" ? "new" : "all";
      if (msg.mode === "new") for (const m of await loadIndex()) meta.localOnly[m.id] = true;
      await saveSyncMeta(meta);
      if (meta.consent === "all") queueSync((await loadIndex()).map((m) => m.id), { now: true });
      notifyAccount();
      return { ok: true };
    }
    case "account-disconnect": {
      const acct = await getAccount();
      if (acct?.deviceId) await accountFetch(`/devices/${acct.deviceId}`, { method: "DELETE" }).catch(() => {});
      await setAccount(null);
      await chrome.storage.local.remove("sync");
      notifyAccount();
      return { ok: true };
    }
    case "auto-backup-flush": {
      if (msg.all) queueAutoBackup(["settings", ...(await loadIndex()).map((m) => m.id)]);
      return flushAutoBackup();
    }
    case "auto-backup-restore": {
      // Traz de volta o que está na área interna (reuniões que já existem aqui são mantidas).
      const { sessions } = await readBackupFolder(await internalBackupDir());
      return { n: sessions.length ? await importSessions(sessions) : 0, total: sessions.length };
    }
    case "auto-backup-open":
      chrome.downloads.showDefaultFolder();
      return true;
    case "backup-flush": {
      // all: depois de escolher a pasta ou em "Fazer backup agora"
      if (msg.all) queueBackup(["settings", ...(await loadIndex()).map((m) => m.id)]);
      return flushBackup();
    }
    case "open-app": {
      const url = chrome.runtime.getURL(`src/app/app.html?id=${encodeURIComponent(s ? s.id : "")}`);
      await chrome.tabs.create({ url });
      return true;
    }
    default:
      return undefined;
  }
}

// ---------------- Conta Escribanote Pro: sincronização ----------------
// A extensão continua sendo a fonte durante a reunião; a conta recebe cópias com controle de versão.
const SYNC_LIVE_MS = 120_000;
const SYNC_IDLE_MS = 5_000;
const PULL_EVERY_MS = 10 * 60_000;
const syncQueue = new Set();
const syncSkip = new Set(); // gravadas por causa da própria sincronização: não voltam para a fila
let syncTimer = null;
let syncing = false;

async function getSyncMeta() {
  const { sync } = await chrome.storage.local.get("sync");
  return { consent: null, versions: {}, remoteDeleted: {}, localOnly: {}, pending: [], lastPull: null, lastSyncAt: null, error: null, ...(sync || {}) };
}
const saveSyncMeta = (meta) => chrome.storage.local.set({ sync: meta });

async function publicAccount() {
  const a = await getAccount();
  if (!a) return null;
  const { token, ...rest } = a;
  return { ...rest, web: `${await accountBase()}/app/` };
}

async function pendingCount() {
  const meta = await getSyncMeta();
  return (await loadIndex()).filter((m) => !(m.id in meta.versions) && !meta.localOnly[m.id] && !meta.remoteDeleted[m.id]).length;
}

function notifyAccount() {
  chrome.runtime.sendMessage({ type: "account-updated" }).catch(() => {});
}

async function syncActive() {
  const a = await getAccount();
  if (!a || a.invalid || a.plan !== "pro") return false;
  return !!(await getSyncMeta()).consent;
}

function queueSync(ids, { now = false } = {}) {
  ids = ids.filter((id) => !(syncSkip.has(id) && syncSkip.delete(id)));
  if (!ids.length && !now) return;
  for (const id of ids) syncQueue.add(id);
  const live = ids.some((id) => sessionTab.has(id));
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => flushSync().catch(() => {}), now ? 0 : live ? SYNC_LIVE_MS : SYNC_IDLE_MS);
}

async function refreshAccount() {
  if (!(await getAccount())) return null;
  try {
    const me = await accountFetch("/me");
    const a = await setAccount({ email: me.email, plan: me.plan, balance: me.credits?.balance ?? 0, renewsAt: me.credits?.renewsAt || null, invalid: false, checkedAt: Date.now() });
    notifyAccount();
    return a;
  } catch (err) {
    if (err.status === 401) {
      await setAccount({ invalid: true });
      notifyAccount();
    }
    throw err;
  }
}

async function accountTick() {
  const a = await getAccount();
  if (!a) return;
  if (!a.checkedAt || Date.now() - a.checkedAt > 30 * 60_000) await refreshAccount().catch(() => {});
  if (!(await syncActive())) return;
  const meta = await getSyncMeta();
  if (!meta.lastPull || Date.now() - new Date(meta.lastPull).getTime() > PULL_EVERY_MS) await pullSync().catch(() => {});
  if (meta.pending.length) queueSync(meta.pending, { now: true });
}
setInterval(() => accountTick().catch(() => {}), PULL_EVERY_MS);

// Envia uma reunião; em conflito, mescla com a versão da conta e tenta de novo.
async function pushOne(id, meta) {
  const s = await getSession(id);
  if (!s) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await accountFetch(`/meetings/${encodeURIComponent(id)}`, { method: "PUT", body: { doc: { ...s, shots: [] }, baseVersion: meta.versions[id] ?? null } });
      meta.versions[id] = r.version;
      return;
    } catch (err) {
      if (err.status === 409) {
        const remote = await accountFetch(`/meetings/${encodeURIComponent(id)}`);
        const merged = mergeDocs(s, remote.doc);
        Object.assign(s, merged);
        cache.set(id, s);
        dirty.add(id);
        meta.versions[id] = remote.version;
        continue;
      }
      if (err.status === 410) {
        meta.remoteDeleted[id] = true; // apagada na conta: fica só no computador
        return;
      }
      throw err;
    }
  }
}

async function flushSync() {
  clearTimeout(syncTimer);
  syncTimer = null;
  if (syncing) return;
  const meta = await getSyncMeta();
  const ids = [...new Set([...meta.pending, ...syncQueue])];
  syncQueue.clear();
  if (!ids.length || !(await getAccount())) return;
  if (!(await syncActive())) {
    meta.pending = ids.filter((id) => !meta.localOnly[id]);
    return saveSyncMeta(meta);
  }
  syncing = true;
  const left = [];
  try {
    for (const id of ids) {
      if (meta.localOnly[id] || meta.remoteDeleted[id]) continue;
      try {
        await pushOne(id, meta);
      } catch (err) {
        left.push(id);
        meta.error = err.message;
        if (err.status === 401 || err.status === 402) {
          if (err.status === 401) await setAccount({ invalid: true });
          else await setAccount({ plan: "free" });
          left.push(...ids.slice(ids.indexOf(id) + 1));
          break;
        }
      }
    }
    if (dirty.size) {
      for (const id of dirty) syncSkip.add(id); // a versão mesclada já foi enviada
      await saveDirty();
    }
    meta.pending = [...new Set(left)];
    if (!left.length) meta.error = null;
    meta.lastSyncAt = Date.now();
  } finally {
    syncing = false;
    await saveSyncMeta(meta);
    notifyAccount();
  }
}

// Baixa o que mudou em outros computadores ou no app web.
async function pullSync() {
  if (!(await syncActive())) return;
  const meta = await getSyncMeta();
  const since = meta.lastPull || new Date(0).toISOString();
  const r = await accountFetch(`/meetings?changedSince=${encodeURIComponent(since)}`);
  let index = await loadIndex();
  for (const item of r.items) {
    if (item.deleted) {
      meta.remoteDeleted[item.id] = true;
      continue;
    }
    delete meta.remoteDeleted[item.id];
    if (meta.versions[item.id] === item.version) continue;
    const remote = await accountFetch(`/meetings/${encodeURIComponent(item.id)}`);
    const local = await getSession(item.id);
    const merged = local ? mergeDocs(local, remote.doc) : normalize({ ...remote.doc, shots: [] });
    delete merged.blocks;
    cache.set(item.id, local ? Object.assign(local, merged) : merged);
    dirty.add(item.id);
    meta.versions[item.id] = remote.version;
    if (local && !sameContent(merged, remote.doc)) syncQueue.add(item.id); // havia novidades aqui também
  }
  meta.lastPull = r.serverTime;
  await saveSyncMeta(meta);
  if (dirty.size) {
    // grava sem reenviar o que acabou de chegar da conta (o que tinha novidade local já está em syncQueue)
    for (const id of dirty) if (!syncQueue.has(id)) syncSkip.add(id);
    await saveDirty();
    chrome.runtime.sendMessage({ type: "index-updated" }).catch(() => {});
  }
  if (syncQueue.size) queueSync([], { now: true });
}

// O app web (logado) entrega o token do dispositivo por mensagem externa.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  handleExternal(msg, sender).then(sendResponse, (err) => sendResponse({ ok: false, reason: err.message }));
  return true;
});

async function handleExternal(msg, sender) {
  const allowed = new URL(await accountBase()).origin;
  if (!sender.origin || sender.origin !== allowed) return { ok: false, reason: "origem não autorizada" };
  if (msg?.type === "escribanote-ping") return { ok: true, version: chrome.runtime.getManifest().version };
  if (["escribanote-list", "escribanote-unsynced", "escribanote-get", "escribanote-save"].includes(msg?.type)) return externalLibrary(msg);
  if (msg?.type !== "escribanote-connect") return { ok: false, reason: "mensagem desconhecida" };
  if (typeof msg.token !== "string" || msg.token.length < 20) return { ok: false, reason: "token inválido" };
  await setAccount({ token: msg.token, email: String(msg.email || ""), deviceId: String(msg.deviceId || ""), connectedAt: Date.now(), invalid: false });
  const meta = await getSyncMeta();
  meta.versions = {};
  meta.remoteDeleted = {};
  meta.lastPull = null;
  meta.error = null;
  await saveSyncMeta(meta);
  await refreshAccount().catch(() => {});
  notifyAccount();
  return { ok: true, pending: meta.consent ? 0 : (await loadIndex()).length };
}

// O app web (Pro, logado, com a extensão conectada) enxerga as reuniões deste navegador e pode
// pedir o envio das que ainda não estão na conta. Só metadados sem consentimento de sincronização;
// o texto só sai daqui quando a pessoa já aceitou sincronizar ou pede o envio explicitamente.
async function externalLibrary(msg) {
  const acct = await getAccount();
  if (!acct || acct.invalid) return { ok: false, reason: "extensão não conectada à conta" };
  const meta = await getSyncMeta();
  const index = await loadIndex();
  const status = (m) => (meta.versions[m.id] ? "synced" : meta.remoteDeleted[m.id] ? "deleted" : meta.localOnly[m.id] ? "local" : "pending");
  if (msg.type === "escribanote-list") {
    return {
      ok: true,
      meetings: index.map((m) => ({ id: m.id, title: m.title, platform: m.platform, startedAt: m.startedAt, endedAt: m.endedAt, count: m.count, participants: m.participants, part: m.part || 1, status: status(m) })),
      sync: { consent: meta.consent, pending: meta.pending.length, error: meta.error, lastSyncAt: meta.lastSyncAt, plan: acct.plan },
    };
  }
  if (msg.type === "escribanote-unsynced") {
    const ids = index.filter((m) => status(m) !== "synced" && status(m) !== "deleted").map((m) => m.id);
    return { ok: true, ids, count: ids.length };
  }
  if (msg.type === "escribanote-get") {
    if (!meta.consent) return { ok: false, reason: "sincronização ainda não autorizada na extensão" };
    const s = await getSession(String(msg.id || ""));
    if (!s) return { ok: false, reason: "reunião não encontrada neste navegador" };
    const { shots, aliases, ...doc } = s;
    return { ok: true, doc };
  }
  // escribanote-save: envia agora as reuniões pedidas (ou todas as pendentes)
  if (acct.plan !== "pro") return { ok: false, reason: "o envio para a conta é do Escribanote Pro" };
  const wanted = Array.isArray(msg.ids) && msg.ids.length ? msg.ids.map(String) : index.filter((m) => status(m) === "pending" || status(m) === "local").map((m) => m.id);
  const ids = wanted.filter((id) => index.some((m) => m.id === id) && !meta.remoteDeleted[id]);
  if (!ids.length) return { ok: true, synced: [], failed: [] };
  if (!meta.consent) meta.consent = "new"; // a pessoa pediu o envio pelo app: as próximas reuniões passam a ir sozinhas
  for (const id of ids) delete meta.localOnly[id];
  await saveSyncMeta(meta);
  notifyAccount();
  queueSync(ids, { now: true });
  await flushSync();
  const after = await getSyncMeta();
  const synced = ids.filter((id) => after.versions[id]);
  return { ok: true, synced, failed: ids.filter((id) => !after.versions[id]), error: after.error };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(
    (r) => sendResponse(r === undefined ? null : r),
    (err) => sendResponse({ error: err.message || String(err) }),
  );
  return true;
});

// ---------------- IA por streaming (porta "ai") ----------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ai") return;
  const abort = new AbortController();
  port.onDisconnect.addListener(() => abort.abort());
  port.onMessage.addListener(async (req) => {
    const post = (m) => {
      try {
        port.postMessage(m);
      } catch {}
    };
    try {
      const s = await getSession(req.id);
      if (!s) throw new Error("Reunião não encontrada.");
      const settings = await getSettings();
      const ai = await aiProvider();
      if (!ai) throw new Error(NO_AI);
      const onDelta = (text) => post({ type: "delta", text });

      if (req.action === "review") {
        const r = await reviewPending(s, { force: true, onProgress: (p) => post({ type: "progress", ...p }) });
        post({ type: "done", ...r });
        return;
      }

      if (req.action === "ata") {
        // A ata atual entra no histórico antes de ser substituída (se ainda não estiver lá).
        if (s.summary?.text) commitSummary(s, s.summary, { source: s.summary.model === "manual" ? "edit" : "ai" });
        s.summary = await runAta(ai, s, settings, { onDelta, signal: abort.signal });
        await commitAta(s, settings);
        await changed(s, { now: true });
        post({ type: "done", text: s.summary.text });
        return;
      }

      // Chat: cria ou continua uma conversa salva na reunião.
      let chat = s.chats.find((c) => c.id === req.chatId);
      if (!chat) {
        chat = { id: Date.now().toString(36), createdAt: Date.now(), messages: [] };
        s.chats.push(chat);
      }
      chat.messages.push({ role: "user", text: req.question, at: Date.now() });
      post({ type: "chat", chatId: chat.id });
      const previous = req.previousId ? await getSession(req.previousId) : null;
      const result = await runChat(ai, s, chat.messages, settings, { previous, onDelta, signal: abort.signal });
      chat.messages.push({ role: "assistant", text: result.text, at: Date.now() });
      await changed(s, { now: true });
      post({ type: "done", text: result.text, chatId: chat.id });
    } catch (err) {
      // Não deixa uma pergunta sem resposta no histórico (a API exige alternância).
      const s = await getSession(req.id);
      const chat = s && s.chats.find((c) => c.messages.at(-1)?.role === "user" && c.messages.at(-1)?.text === req.question);
      if (chat) {
        chat.messages.pop();
        if (!chat.messages.length) s.chats = s.chats.filter((c) => c !== chat);
        await changed(s, { now: true });
      }
      post({ type: "error", message: err.name === "AbortError" ? "Cancelado." : err.message });
    }
  });
});

// ---------------- Atalhos de teclado ----------------
async function waitUntil(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "open-recorder") {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/app/gravar.html") });
    return;
  }
  if (!tab) return;
  if (command === "end-session") {
    // Parar (ou retomar) a transcrição da aba atual pelo teclado; o widget mostra o estado.
    const active = await activeFor(tab.id);
    chrome.tabs.sendMessage(tab.id, { type: active ? "end-session" : "resume-session" }).catch(() => {});
    return;
  }
  const s = await sessionForTab(tab.id);
  if (!s) return;
  try {
    if (command === "highlight-last") {
      const r = toggleLastBlockTag(s, "importante");
      if (r) await changed(s, { now: true });
    } else if (command === "screenshot") {
      await screenshot(s, tab.id);
    } else if (command === "toggle-pause") {
      s.paused = !s.paused;
      setBadge(tab.id, s);
      await changed(s, { now: true });
    }
    chrome.tabs.sendMessage(tab.id, { type: "toast", command }).catch(() => {});
  } catch (err) {
    chrome.tabs.sendMessage(tab.id, { type: "toast", error: err.message }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabLocks.delete(tabId);
  endSession(tabId, "tab-removed");
});
