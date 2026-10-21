// Coletor do Microsoft Teams (web): legendas chegam como JSON no RTCDataChannel
// "main-channel" (campo recognitionResults); nomes vêm das mensagens de roster
// trafegadas por WebSocket ("3:::{…/rosterUpdate/…}", corpo em base64 compactado).
(function (root) {
  "use strict";

  const TEAMS_HOST =
    /^(gov\.)?teams\.(microsoft|live)(\.com(\.cas\.ms|\.mcas\.ms|\.mcas-gov\.us)?|\.us)$|^teams\.cloud\.microsoft(\.mcas\.ms|\.cas\.ms)?$/;

  function parseJsonTail(text) {
    const starts = [text.indexOf("["), text.indexOf("{")].filter((i) => i >= 0);
    if (!starts.length) return null;
    try {
      return JSON.parse(text.slice(Math.min(...starts)));
    } catch {
      return null;
    }
  }

  // Converte um item de recognitionResults em legenda normalizada.
  function toCaption(r) {
    if (!r || !("timestampAudioSent" in r) || !r.userId) return null;
    const version = Number.parseInt(String(r.id || "").split("/")[1], 10) || 0;
    return {
      id: `${r.timestampAudioSent}/${r.userId}`,
      speakerId: r.userId,
      version,
      text: r.text || r.rawText || "",
      lang: r.language || r.languageCode || undefined,
    };
  }

  function captionsFromPayload(text) {
    const json = parseJsonTail(text);
    if (!json || !Array.isArray(json.recognitionResults)) return [];
    return json.recognitionResults.map(toCaption).filter(Boolean);
  }

  root.EscribanoteTeams = { captionsFromPayload, parseJsonTail, TEAMS_HOST };

  if (typeof location === "undefined" || !TEAMS_HOST.test(location.host)) return;
  if (!root.RTCPeerConnection || root.__escribanoteTeamsHooked) return;
  root.__escribanoteTeamsHooked = true;

  const { emit, toBytes, inflate, safe } = root.EscribanoteCore;
  const decoder = new TextDecoder();
  const attached = new WeakSet();

  const NativePC = root.RTCPeerConnection;
  const nativeCreate = NativePC.prototype.createDataChannel;
  NativePC.prototype.createDataChannel = function () {
    const ch = nativeCreate.apply(this, arguments);
    if (ch && ch.label === "main-channel" && !attached.has(ch)) {
      attached.add(ch);
      emit("status", { platform: "teams", note: "canal main-channel detectado" });
      ch.addEventListener(
        "message",
        safe(async (ev) => {
          const bytes = await toBytes(ev.data);
          if (!bytes) return;
          for (const c of captionsFromPayload(decoder.decode(bytes))) {
            emit("caption", { platform: "teams", source: "protocol", ...c });
          }
        }),
      );
    }
    return ch;
  };

  async function decodeRosterBody(b64) {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    for (const fmt of ["gzip", "deflate", "deflate-raw"]) {
      try {
        return decoder.decode(await inflate(raw, fmt));
      } catch {}
    }
    return decoder.decode(raw);
  }

  const NativeWS = root.WebSocket;
  function PatchedWS(url, protocols) {
    const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    ws.addEventListener(
      "message",
      safe(async (ev) => {
        if (typeof ev.data !== "string" || !ev.data.startsWith("3:::")) return;
        const env = JSON.parse(ev.data.slice(4));
        if (!env || typeof env.url !== "string" || !env.url.includes("/rosterUpdate/")) return;
        const roster = JSON.parse(await decodeRosterBody(env.body));
        for (const p of Object.values(roster.participants || {})) {
          const d = p && p.details;
          if (d && d.id && d.displayName) {
            emit("speaker", { platform: "teams", speakerId: d.id, name: d.displayName });
          }
        }
      }),
    );
    return ws;
  }
  PatchedWS.prototype = NativeWS.prototype;
  Object.setPrototypeOf(PatchedWS, NativeWS);
  root.WebSocket = PatchedWS;
})(globalThis);
