// Coletor do Zoom (cliente web): localiza a store Redux pela árvore React e
// observa newLiveTranscription.newLTMessage (legendas/transcrição ao vivo do Zoom).
(function (root) {
  "use strict";

  const ZOOM_HOST = /^([a-zA-Z0-9](?:[-a-zA-Z0-9]{0,61}[a-zA-Z0-9])?\.)?zoom\.us$/;

  function isStore(s) {
    if (!s || typeof s !== "object") return false;
    if (typeof s.getState !== "function" || typeof s.subscribe !== "function") return false;
    try {
      const st = s.getState();
      return !!st && typeof st === "object" && "newLiveTranscription" in st;
    } catch {
      return false;
    }
  }

  function findStore(doc) {
    if (!doc.body) return null;
    const candidates = doc.body.querySelectorAll(":scope > *, :scope > * > *, :scope > * > * > *");
    for (const el of candidates) {
      const key = Object.keys(el).find((k) => k.startsWith("__reactContainer"));
      if (!key) continue;
      const stack = [el[key]];
      let visited = 0;
      while (stack.length && visited < 5000) {
        const fiber = stack.pop();
        visited++;
        if (!fiber) continue;
        const store = fiber.memoizedProps && fiber.memoizedProps.store;
        if (isStore(store)) return store;
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
    }
    return null;
  }

  // Compara dois snapshots de newLTMessage e devolve as mensagens novas/alteradas.
  function changedMessages(prev, next) {
    if (!next || next === prev) return [];
    return Object.values(next).filter((m) => m && (!prev || prev[m.msgId] !== m));
  }

  function toCaption(m) {
    const user = m.user || {};
    if (!m.msgId || !user.zoomID) return null;
    return {
      id: `${m.msgId}/${user.zoomID}`,
      speakerId: String(user.zoomID),
      speakerName: user.displayName || undefined,
      version: Date.now(),
      text: typeof m.text === "string" ? m.text : "",
      lang: m.language != null ? String(m.language) : undefined,
    };
  }

  root.EscribanoteZoom = { changedMessages, toCaption };

  if (typeof location === "undefined" || !ZOOM_HOST.test(location.host)) return;
  if (root.__escribanoteZoomHooked) return;
  root.__escribanoteZoomHooked = true;

  const { emit, safe } = root.EscribanoteCore;
  let store = null;
  let prev = null;
  let topic = null;

  const onState = safe(() => {
    const st = store.getState();
    const lt = st.newLiveTranscription && st.newLiveTranscription.newLTMessage;
    for (const m of changedMessages(prev && prev.lt, lt)) {
      const c = toCaption(m);
      if (c) emit("caption", { platform: "zoom", source: "protocol", ...c });
    }
    const t = st.meeting && st.meeting.meetingTopic;
    if (t && t !== topic) {
      topic = t;
      emit("meeting-title", { platform: "zoom", title: t });
    }
    prev = { lt };
  });

  const timer = setInterval(
    safe(() => {
      if (store) return clearInterval(timer);
      store = findStore(document);
      if (!store) return;
      emit("status", { platform: "zoom", note: "store do Zoom encontrada" });
      prev = null;
      onState();
      store.subscribe(onState);
    }),
    500,
  );
})(globalThis);
