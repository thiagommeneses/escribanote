// Coletor do Google Meet: escuta os RTCDataChannels de legendas que o próprio Meet
// abre quando as legendas estão ligadas. Esquemas protobuf observados no tráfego do
// próprio Meet. Somente escuta — nunca envia nada na conexão.
(function (root) {
  "use strict";
  const P = root.ReuniloProto;

  // captions_v2: Packet{1: Utterance{1 id, 2 version, 3: Caption{3 text, 4 lang, 6 deviceId}}}
  function decodeCaptionsV2(bytes) {
    const pkt = P.tryDecode(bytes);
    const utt = P.msg(pkt, 1);
    const cap = P.msg(utt, 3);
    const speakerId = P.str(cap, 6);
    const uttId = P.num(utt, 1);
    if (!speakerId || !uttId) return null;
    return {
      id: `${uttId}/${speakerId}`,
      speakerId,
      version: P.num(utt, 2) || 0,
      text: P.str(cap, 3) || "",
      lang: P.str(cap, 4) || undefined,
    };
  }

  // captions (legado): Wrapper{1: Message{1 deviceId, 2 messageId, 3 version, 6 text, 8 langId}}
  function decodeLegacyCaption(bytes) {
    const outer = P.tryDecode(bytes);
    for (const m of [P.msg(outer, 1), outer]) {
      const speakerId = P.str(m, 1);
      const msgId = P.num(m, 2);
      if (speakerId && msgId && P.field(m, 6)) {
        return {
          id: `${msgId}/${speakerId}`,
          speakerId,
          version: P.num(m, 3) || 0,
          text: P.str(m, 6) || "",
        };
      }
    }
    return null;
  }

  function plausibleName(s) {
    return typeof s === "string" && s.length > 0 && s.length <= 80 && !/[\n\r\u0000]/.test(s);
  }

  // collections: Device 1→2→13→1→2 → {1 deviceId, 2 nome}. Como o esquema muda,
  // também varre a árvore atrás de pares (id "…devices/…", nome).
  function decodeDevices(bytes) {
    const root = P.tryDecode(bytes);
    if (!root) return [];
    const found = new Map();
    const exact = P.path(root, [1, 2, 13, 1, 2]);
    if (exact && P.str(exact, 1) && plausibleName(P.str(exact, 2))) {
      found.set(P.str(exact, 1), P.str(exact, 2));
    }
    P.walk(root, (m) => {
      const id = P.str(m, 1);
      const name = P.str(m, 2);
      if (id && /devices\//.test(id) && plausibleName(name) && !found.has(id)) found.set(id, name);
    });
    return [...found].map(([speakerId, name]) => ({ speakerId, name }));
  }

  // meet_messages (chat): procura {2 deviceId, 3 timestamp, 5: {1 texto}} em qualquer nível.
  function decodeChat(bytes) {
    const root = P.tryDecode(bytes);
    if (!root) return null;
    let hit = null;
    P.walk(root, (m) => {
      if (hit) return;
      const speakerId = P.str(m, 2);
      const ts = P.num(m, 3);
      const text = P.str(P.msg(m, 5), 1);
      if (speakerId && ts && text) hit = { id: `chat/${ts}/${speakerId}`, speakerId, text, ts };
    });
    return hit;
  }

  root.ReuniloMeet = { decodeCaptionsV2, decodeLegacyCaption, decodeDevices, decodeChat };

  if (typeof location === "undefined" || location.host !== "meet.google.com") return;
  if (!root.RTCPeerConnection || root.__reuniloMeetHooked) return;
  root.__reuniloMeetHooked = true;

  const { emit, toBytes, safe } = root.ReuniloCore;
  const attached = new WeakSet();
  let lastProtocolCaption = 0;

  const handlers = {
    captions_v2: (b) => decodeCaptionsV2(b),
    captions: (b) => decodeLegacyCaption(b),
  };

  function attach(channel) {
    if (!channel || attached.has(channel)) return;
    const label = channel.label;
    const capDecoder = handlers[label];
    if (!capDecoder && label !== "collections" && label !== "meet_messages") return;
    attached.add(channel);
    emit("status", { platform: "meet", note: `canal ${label} detectado` });

    channel.addEventListener(
      "message",
      safe(async (ev) => {
        const bytes = await toBytes(ev.data);
        if (!bytes) return;
        if (capDecoder) {
          const c = capDecoder(bytes);
          if (c) {
            lastProtocolCaption = Date.now();
            emit("caption", { platform: "meet", source: "protocol", ...c });
          }
        } else if (label === "collections") {
          for (const d of decodeDevices(bytes)) emit("speaker", { platform: "meet", ...d });
        } else if (label === "meet_messages") {
          const chat = decodeChat(bytes);
          if (chat) emit("chat", { platform: "meet", ...chat });
        }
      }),
    );
  }

  const NativePC = root.RTCPeerConnection;
  const nativeCreate = NativePC.prototype.createDataChannel;
  NativePC.prototype.createDataChannel = function () {
    const ch = nativeCreate.apply(this, arguments);
    safe(attach)(ch);
    return ch;
  };

  function PatchedPC(config, constraints) {
    const pc = new NativePC(config, constraints);
    pc.addEventListener("datachannel", safe((ev) => attach(ev.channel)));
    return pc;
  }
  PatchedPC.prototype = NativePC.prototype;
  Object.setPrototypeOf(PatchedPC, NativePC);
  root.RTCPeerConnection = PatchedPC;

  // Permite ao fallback por DOM saber se o protocolo está funcionando.
  document.addEventListener("reunilo:ping", () =>
    emit("protocol-health", { platform: "meet", lastProtocolCaption }),
  );
})(globalThis);
