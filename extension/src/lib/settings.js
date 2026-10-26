// Configurações compartilhadas entre o service worker e as páginas da extensão.

export const DEFAULT_TAGS = [
  { id: "importante", label: "Importante", emoji: "⭐", color: "#f59e0b" },
  { id: "decisao", label: "Decisão", emoji: "✅", color: "#16a34a" },
  { id: "acao", label: "Ação", emoji: "📌", color: "#2563eb" },
  { id: "pergunta", label: "Pergunta", emoji: "❓", color: "#9333ea" },
  { id: "risco", label: "Risco", emoji: "⚠️", color: "#dc2626" },
];

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (melhor qualidade)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (equilíbrio)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (mais rápido e barato)" },
];

// Modelos Whisper (ONNX) para o modo de alta precisão. dtype por dispositivo:
// webgpu usa a placa de vídeo; wasm roda no processador. Tamanhos aproximados do download.
export const HQ_MODELS = {
  base: {
    id: "onnx-community/whisper-base",
    label: "Rápido (whisper-base)",
    wasm: { dtype: { encoder_model: "q8", decoder_model_merged: "q8" }, mb: 77 },
    webgpu: { dtype: { encoder_model: "fp32", decoder_model_merged: "q4" }, mb: 206 },
  },
  small: {
    id: "onnx-community/whisper-small",
    label: "Equilibrado (whisper-small) — recomendado",
    wasm: { dtype: { encoder_model: "q8", decoder_model_merged: "q8" }, mb: 249 },
    webgpu: { dtype: { encoder_model: "fp32", decoder_model_merged: "q4" }, mb: 586 },
  },
  turbo: {
    id: "onnx-community/whisper-large-v3-turbo",
    label: "Máximo (whisper-large-v3-turbo, só com placa de vídeo)",
    webgpu: { dtype: { encoder_model: "q4", decoder_model_merged: "q4" }, mb: 759 },
  },
};

export const WHISPER_LANG = { pt: "portuguese", en: "english", es: "spanish", fr: "french", de: "german", it: "italian" };

export const DEFAULTS = {
  mode: "always", // "always" | "ask" | "off"
  widget: true,
  hideCaptions: true,
  autoCaptions: true,
  domFallback: true,
  autoAta: false,
  aiModel: "claude-opus-5-5",
  talkTarget: 30, // % de fala desejada para "você"
  captionLang: "pt-BR",
  glossary: "", // vocabulário: um termo por linha; "Termo = forma errada, outra" corrige na hora (lib/glossary.js)
  teamContext: "", // sobre as reuniões (área, assuntos), para a revisão, a ata e o chat
  ataTemplate: "", // id do modelo de ata padrão ("" = formato do Escribanote)
  ataInstructions: "", // instruções extras padrão para todas as atas (a reunião pode ter as suas)
  autoReview: false,
  hq: "off", // "off" | "base" | "small" | "turbo" — motor Whisper local
  hqMic: false,
  echoFilter: true,
  audioKeep: false, // guardar o áudio (faixas separadas) no cofre da extensão quando houver captura de áudio
  audioQuotaMb: 2048, // espaço máximo do cofre; as reuniões mais antigas saem primeiro
  audioRetentionDays: 30, // 0 = sem prazo // descarta do microfone o que é a voz dos outros saindo da caixa de som (energia e texto)
  diarize: false, // identificar falantes pela voz (Pro): pyannote + WeSpeaker locais
  afterCall: "off", // ao sair da chamada: "off" | "app" (abre a reunião no Escribanote) | "web" (app web da conta Pro)
  myName: "",
  // Gravador do computador (Slack e outros apps): últimas escolhas
  recorderModel: "",
  recorderPlatform: "slack",
  recorderMic: true,
  syncSettings: true, // ajustes na conta do Chrome (chrome.storage.sync)
  backupAuto: "downloads", // backup automático sem escolher pasta: "downloads" (Downloads\Escribanote\backup) | "opfs" (área interna do Chrome) | "off"
  tags: DEFAULT_TAGS,
  notifyMessage:
    "Olá! Estou transcrevendo esta reunião com o Escribanote para gerar a ata. A transcrição fica salva só no meu computador.",
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

// _at marca a última mudança feita pelo usuário: decide qual cópia vence ao sincronizar.
export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch, _at: Date.now() };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// ---------------- Ajustes na conta do Chrome ----------------
// chrome.storage.sync aceita no máximo 8 KB por item: o JSON vai em pedaços ("settings:0", ...).
// A chave de API não fica nos ajustes (está em chrome.storage.local "apiKey") e não é sincronizada.
const SYNC_CHUNK = 6000;

export async function pushSyncedSettings(settings) {
  const json = JSON.stringify(settings);
  const parts = {};
  for (let i = 0; i * SYNC_CHUNK < json.length; i++) parts[`settings:${i}`] = json.slice(i * SYNC_CHUNK, (i + 1) * SYNC_CHUNK);
  const n = Object.keys(parts).length;
  const { settingsParts: old = 0 } = await chrome.storage.sync.get("settingsParts");
  await chrome.storage.sync.set({ ...parts, settingsParts: n });
  const stale = [];
  for (let i = n; i < old; i++) stale.push(`settings:${i}`);
  if (stale.length) await chrome.storage.sync.remove(stale);
}

export async function pullSyncedSettings() {
  const { settingsParts: n = 0 } = await chrome.storage.sync.get("settingsParts");
  if (!n) return null;
  const keys = Array.from({ length: n }, (_, i) => `settings:${i}`);
  const got = await chrome.storage.sync.get(keys);
  try {
    return JSON.parse(keys.map((k) => got[k] ?? "").join(""));
  } catch {
    return null; // pedaços de versões diferentes no meio de uma sincronização
  }
}
