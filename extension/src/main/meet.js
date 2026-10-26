// Coletor do Google Meet: escuta os RTCDataChannels de legendas que o próprio Meet
// abre quando as legendas estão ligadas. Esquemas protobuf observados no tráfego do
// próprio Meet. Somente escuta — nunca envia nada na conexão.
(function (root) {
  "use strict";
  const P = root.EscribanoteProto;

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

  root.EscribanoteMeet = { decodeCaptionsV2, decodeLegacyCaption, decodeDevices, decodeChat };

  if (typeof location === "undefined" || location.host !== "meet.google.com") return;
  if (!root.RTCPeerConnection || root.__escribanoteMeetHooked) return;
  root.__escribanoteMeetHooked = true;

  const { emit, toBytes, safe } = root.EscribanoteCore;
  const attached = new WeakSet();
  let lastProtocolCaption = 0;

  // Conexões WebRTC vivas. Sair da chamada fecha todas (o Meet chama close(), que não dispara
  // evento), então "já houve conexão e agora não há nenhuma" é o sinal mais confiável de saída,
  // em qualquer idioma da interface. Numa reconexão, uma nova abre em poucos segundos.
  const livePcs = new Set();
  let pcSeen = false;
  let lastPcAt = 0;
  function trackPc(pc) {
    livePcs.add(pc);
    pcSeen = true;
    lastPcAt = Date.now();
    const check = () => {
      if (["closed", "failed"].includes(pc.connectionState) || pc.signalingState === "closed") forget(pc);
      else lastPcAt = Date.now();
    };
    pc.addEventListener("connectionstatechange", safe(check));
    pc.addEventListener("signalingstatechange", safe(check));
  }
  function forget(pc) {
    if (!livePcs.delete(pc)) return;
    if (!livePcs.size) emit("connections-closed", { platform: "meet" });
  }
  function connectionsHealth() {
    for (const pc of [...livePcs]) if (pc.connectionState === "closed" || pc.signalingState === "closed") forget(pc);
    return { connections: livePcs.size, connectionsSeen: pcSeen, lastConnectionAt: lastPcAt };
  }

  const handlers = {
    captions_v2: (b) => decodeCaptionsV2(b),
    captions: (b) => decodeLegacyCaption(b),
  };

  // Diagnóstico: todos os canais de dados vistos (rótulo → mensagens, bytes), mesmo os que não usamos.
  // Se o Meet trocar o nome do canal de legendas, é aqui que isso aparece.
  const channelStats = {};
  function noteChannel(channel) {
    const st = (channelStats[channel.label] ||= { msgs: 0, bytes: 0, decoded: 0, lastAt: 0 });
    channel.addEventListener("message", safe((ev) => {
      st.msgs++;
      st.bytes += ev.data?.byteLength ?? ev.data?.size ?? (typeof ev.data === "string" ? ev.data.length : 0);
      st.lastAt = Date.now();
    }));
  }

  function attach(channel) {
    if (!channel || attached.has(channel)) return;
    const label = channel.label;
    const capDecoder = handlers[label];
    if (!attached.has(channel)) safe(noteChannel)(channel);
    if (!capDecoder && label !== "collections" && label !== "meet_messages") return;
    attached.add(channel);
    emit("status", { platform: "meet", note: `canal ${label} detectado` });
    // Saúde do canal: se o Meet fecha o canal de legendas (reconexão, legendas desligadas),
    // o content script pode religá-las em vez de esperar 30 s sem texto.
    if (capDecoder) {
      channel.addEventListener("close", safe(() => emit("channel-closed", { platform: "meet", label })));
      if (channel.readyState === "open") emit("channel-open", { platform: "meet", label });
      else channel.addEventListener("open", safe(() => emit("channel-open", { platform: "meet", label })));
    }

    channel.addEventListener(
      "message",
      safe(async (ev) => {
        const bytes = await toBytes(ev.data);
        if (!bytes) return;
        if (capDecoder) {
          const c = capDecoder(bytes);
          if (c) {
            channelStats[label].decoded++;
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

  const nativeClose = NativePC.prototype.close;
  NativePC.prototype.close = function () {
    safe(forget)(this);
    return nativeClose.apply(this, arguments);
  };

  function PatchedPC(config, constraints) {
    const pc = new NativePC(config, constraints);
    pc.addEventListener("datachannel", safe((ev) => attach(ev.channel)));
    safe(trackPc)(pc);
    return pc;
  }
  PatchedPC.prototype = NativePC.prototype;
  Object.setPrototypeOf(PatchedPC, NativePC);
  root.RTCPeerConnection = PatchedPC;

  // Permite ao fallback por DOM saber se o protocolo está funcionando.
  document.addEventListener("escribanote:ping", () =>
    emit("protocol-health", { platform: "meet", lastProtocolCaption, channels: channelStats, ...connectionsHealth() }),
  );
})(globalThis);
