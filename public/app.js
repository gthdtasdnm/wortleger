// Client: Verbindung, Warteraum, Brett, Regal, Zug.
//
// Zwei Dinge, die dieser Client anders macht als die anderen:
//
//   Er kennt weder das Brettmuster noch die Steinwerte. Beides kommt beim
//   Verbinden als `regeln` vom Server. Sonst laege dieselbe Tabelle zweimal
//   herum – und wenn ein Ö irgendwann 7 statt 8 zaehlt, faellt die zweite
//   Fassung erst auf, wenn sich jemand ueber seine Punkte wundert.
//
//   Gelegte Steine sind bis zum Abschicken nur hier. Der Server sieht sie
//   erst bei `legen` – und schickt sie zurueck, wenn das kein Wort ergibt.
//   Deshalb wird `state.gelegt` nur geleert, wenn der Zug wirklich durch ist.

const $ = (id) => document.getElementById(id);

// Sitzplatz-Tierchen. Gleiche Liste und gleiche Ableitung wie in den anderen
// Spielen, damit dieselbe Person überall dasselbe Zeichen bekommt.
const AVATARS = ["🦊", "🐙", "🦅", "🐺", "🦁", "🐉"];
const avatarFor = (id) =>
  AVATARS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATARS.length];

const ZEIT_TEXT = { 0: "ohne Uhr", 60: "1 min", 120: "2 min", 240: "4 min" };

const state = {
  you: null,
  code: null,
  room: null,
  spiel: null,
  regeln: null,
  pendingIntent: null,
  visibility: "public",
  zeit: 120,

  // Der eigene, noch nicht abgeschickte Zug.
  gelegt: [],           // {r, c, b, joker, regalIndex}
  gewaehlt: null,       // Index im Regal oder null
  jokerZiel: null,      // {r, c, regalIndex}, solange die Wahl offen ist
  tauschModus: false,
  tauschWahl: new Set(),

  versatz: 0,           // Serveruhr minus eigene Uhr
  uhrTimer: null,
};

// ---------------------------------------------------------------------------
// Verbindung
// ---------------------------------------------------------------------------

let sock = null;
let retryIn = 500;

// Die eigene Kennung. Gleiche Regel wie in `gemeinsam/schale.js`, hier von
// Hand – dieser Client hat die Schale nicht.
//
// Bis zum 17.08.2026 lag sie im `sessionStorage` und starb mit dem Tab. Auf
// dem Handy schließt Safari Tabs von sich aus; wer zurückkam, war für den
// Server ein neuer Spieler, während sein alter Platz mit dem Hostzeichen
// stehenblieb – und niemand mehr starten konnte. Das war Bugreport 4.
//
// Jetzt `localStorage` plus Herzschlag: der Tab, dem die Kennung gehört,
// frischt sie alle vier Sekunden auf und schreibt seine Tabkennung dazu.
//
//   gleiche Tabkennung        → das sind wir selbst (Neuladen)
//   fremd, Herzschlag frisch  → ein anderer Tab spielt gerade, Finger weg
//   fremd, Herzschlag alt     → niemand da, Kennung übernehmen
//
// Ohne den mittleren Fall zögen sich zwei Tabs abwechselnd den Platz weg.
// Nach zwei Stunden verfällt der Eintrag: dann gibt es den Raum längst nicht
// mehr, und niemand will morgen früh in die Runde von gestern geworfen werden.
const SITZ_KEY = "wortleger";
const HERZ_MS = 4000;
const HERZ_TOT = 12_000;
const SITZ_VERFALL = 2 * 60 * 60 * 1000;
const TAB = (() => {
  try {
    const t = sessionStorage.getItem("spiele_tab") ??
      (crypto.randomUUID?.() ?? String(Date.now()) + String(Math.random()).slice(2));
    sessionStorage.setItem("spiele_tab", t);
    return t;
  } catch {
    return "tab";
  }
})();
let herzUhr = null;

function session() {
  try {
    const s = JSON.parse(localStorage.getItem(SITZ_KEY) ?? "null");
    if (!s || !s.code || !s.token) return null;
    const alt = Date.now() - (s.herz ?? 0);
    if (alt > SITZ_VERFALL) { localStorage.removeItem(SITZ_KEY); return null; }
    if (s.tab !== TAB && alt < HERZ_TOT) return null;
    return s;
  } catch {
    return null;
  }
}

/** Token für genau diesen Raum – sonst nichts, damit kein fremder mitfährt. */
const tokenFuer = (code) => (session()?.code === code ? session().token : undefined);

function saveSession(data) {
  try {
    clearInterval(herzUhr);
    herzUhr = null;
    if (!data) { localStorage.removeItem(SITZ_KEY); return; }
    const schreibe = () => localStorage.setItem(
      SITZ_KEY,
      JSON.stringify({ ...data, tab: TAB, herz: Date.now() }),
    );
    schreibe();
    herzUhr = setInterval(schreibe, HERZ_MS);
  } catch { /* Privatmodus – dann eben ohne Wiedereinstieg */ }
}

function send(msg) {
  if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
}

function connect() {
  // Muss aus dem Basispfad kommen: das Spiel läuft in Produktion unter
  // /wortleger/, ein festes "/ws" landet auf der Domainwurzel.
  const url = new URL("ws", document.baseURI);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  sock = new WebSocket(url);

  sock.onopen = () => {
    retryIn = 500;
    setStatus("");
    const s = session();
    if (state.pendingIntent) {
      send(state.pendingIntent);
      state.pendingIntent = null;
    } else if (s && s.code && s.token) {
      send({ t: "join", code: s.code, token: s.token, name: s.name });
    } else {
      send({ t: "browse" });
    }
  };

  sock.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    onMessage(msg);
  };

  sock.onclose = () => {
    setStatus("Verbindung weg – neuer Versuch …");
    setTimeout(connect, retryIn);
    retryIn = Math.min(retryIn * 1.8, 8000);
  };
}

// Lebenszeichen alle 25 s. Der Server schließt jede Verbindung, die 65 s lang
// schweigt (die Geisterwache in `server.js`) – wer eine Weile nur zusieht und
// nichts drückt, flog dadurch mitten im Spiel aus dem Raum. Gleicher Takt wie
// in `gemeinsam/schale.js`; dieser Client hat die Schale nicht und schickt den
// Ping selbst.
setInterval(() => send({ t: "ping", c: Date.now() }), 25000);

// ---------------------------------------------------------------------------
// Bildschirme
// ---------------------------------------------------------------------------

function show(name) {
  for (const s of document.querySelectorAll(".screen")) {
    s.classList.toggle("active", s.id === `screen-${name}`);
  }
  if (name === "home") send({ t: "browse" });
}

function setStatus(text) {
  $("status").textContent = text;
  $("status").classList.toggle("show", !!text);
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast._id);
  toast._id = setTimeout(() => t.classList.remove("show"), 2600);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// ---------------------------------------------------------------------------
// Nachrichten vom Server
// ---------------------------------------------------------------------------

function onMessage(msg) {
  switch (msg.t) {
    case "rooms":
      renderRooms(msg.rooms);
      break;

    case "regeln":
      state.regeln = msg;
      baueBrett();
      break;

    case "joined":
      state.you = msg.you;
      state.code = msg.code;
      saveSession({ code: msg.code, token: msg.token, name: $("name").value.trim() });
      location.hash = msg.code;
      break;

    case "room":
      state.room = msg;
      if (msg.phase !== "playing") {
        state.spiel = null;
        zugZuruecksetzen();
        stoppeUhr();
      }
      renderRoom();
      break;

    case "spiel": {
      // Ein neuer Zug oder ein Wechsel, wer dran ist: der eigene halbfertige
      // Zug ist damit erledigt. Bleibt beides gleich, war es ein abgelehnter
      // Versuch – dann bleiben die Steine liegen, wo sie sind.
      const vorher = state.spiel;
      if (!vorher || vorher.zugNr !== msg.zugNr || vorher.amZug !== msg.amZug) {
        zugZuruecksetzen();
      }
      state.versatz = msg.jetzt - Date.now();
      state.spiel = msg;
      renderSpiel();
      break;
    }

    case "hinweis":
      toast(msg.msg);
      break;

    case "final":
      stoppeUhr();
      renderFinal(msg);
      break;

    case "error":
      toast(msg.msg);
      show("home");
      break;
  }
}

// ---------------------------------------------------------------------------
// Offene Räume
// ---------------------------------------------------------------------------

function renderRooms(list) {
  const box = $("roomList");
  $("roomsCount").textContent = list.length ? `(${list.length})` : "";
  if (!list.length) {
    box.innerHTML = `<p class="rooms-empty">Gerade ist kein Raum offen.
      Eröffne einen – er erscheint dann bei den anderen in der Liste.</p>`;
    return;
  }
  box.innerHTML = list.map((r) => `
    <button class="roomrow" data-code="${escapeHtml(r.code)}">
      <span class="roomrow-name">${escapeHtml(r.host)}</span>
      <span class="roomrow-meta">${escapeHtml(ZEIT_TEXT[r.zeit] ?? "")}</span>
      <span class="roomrow-count">${r.count}/${r.max}</span>
    </button>`).join("");

  for (const b of box.querySelectorAll(".roomrow")) {
    b.addEventListener("click", () => joinCode(b.dataset.code));
  }
}

// Gemeinsam mit den anderen Spielen: wer bei einem seinen Namen eintippt,
// findet ihn beim nächsten schon vor.
const NAME_KEY = "spiele_name";

function meinName() {
  return $("name").value.trim();
}

function joinCode(code) {
  try {
    localStorage.setItem(NAME_KEY, meinName());
  } catch { /* egal */ }
  state.pendingIntent = { t: "join", code, token: tokenFuer(code), name: meinName() };
  if (sock?.readyState === WebSocket.OPEN) {
    send(state.pendingIntent);
    state.pendingIntent = null;
  }
}

function verlassen() {
  send({ t: "leave" });
  saveSession(null);
  state.room = null;
  state.spiel = null;
  state.you = null;
  zugZuruecksetzen();
  stoppeUhr();
  location.hash = "";
  show("home");
}

// ---------------------------------------------------------------------------
// Startseite
// ---------------------------------------------------------------------------

function setZeit(z) {
  state.zeit = z;
  for (const b of document.querySelectorAll("[data-zeit]")) {
    b.classList.toggle("sel", Number(b.dataset.zeit) === z);
  }
}

for (const b of document.querySelectorAll("[data-zeit]")) {
  b.addEventListener("click", () => setZeit(Number(b.dataset.zeit)));
}

for (const b of document.querySelectorAll("[data-vis]")) {
  b.addEventListener("click", () => {
    state.visibility = b.dataset.vis;
    for (const x of document.querySelectorAll("[data-vis]")) {
      x.classList.toggle("sel", x === b);
    }
  });
}

$("createBtn").addEventListener("click", () => {
  try {
    localStorage.setItem(NAME_KEY, meinName());
  } catch { /* egal */ }
  state.pendingIntent = {
    t: "create",
    name: meinName(),
    isPublic: state.visibility === "public",
    zeit: state.zeit,
  };
  if (sock?.readyState === WebSocket.OPEN) {
    send(state.pendingIntent);
    state.pendingIntent = null;
  }
});

$("joinBtn").addEventListener("click", () => {
  const code = $("codeInput").value.toUpperCase().trim();
  if (code.length < 3) return toast("Bitte den vierstelligen Code eingeben");
  joinCode(code);
});

$("codeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("joinBtn").click();
});

$("helpBtn").addEventListener("click", () => { $("help").hidden = false; });
$("helpClose").addEventListener("click", () => { $("help").hidden = true; });

// ---------------------------------------------------------------------------
// Warteraum
// ---------------------------------------------------------------------------

function renderRoom() {
  const r = state.room;
  if (!r) return;

  if (r.phase === "final") return;   // das Endbild steht schon
  if (r.phase === "playing") {
    renderPunktleiste();
    return;                          // den Spielbildschirm zeichnet renderSpiel()
  }

  show("lobby");
  stoppeUhr();

  $("roomCode").textContent = r.code;
  const da = r.players.filter((p) => p.connected).length;
  $("lobbyCount").textContent = `${da}/${r.maxPlayers}`;
  $("roomVis").textContent =
    (r.isPublic ? "Öffentlich – steht in der Liste" : "Privat – nur mit Code") +
    " · " + (r.settings.zeit ? `${ZEIT_TEXT[r.settings.zeit]} Bedenkzeit` : "ohne Uhr");

  const list = $("playerList");
  list.textContent = "";
  const plaetze = Math.max(r.players.length + 1, 2);
  for (let i = 0; i < Math.min(plaetze, r.maxPlayers); i++) {
    const p = r.players[i];
    const card = document.createElement("div");
    card.className = "seat" + (p ? "" : " empty") +
      (p?.ready ? " ready" : "") + (p && !p.connected ? " off" : "");
    if (!p) {
      card.innerHTML =
        `<div class="av">🪑</div><div class="nm">frei</div><div class="st">wartet</div>`;
    } else {
      card.innerHTML = `
        <div class="av">${avatarFor(p.id)}</div>
        <div class="nm">${escapeHtml(p.name)}${p.id === state.you ? " (du)" : ""}</div>
        <div class="st">${
        !p.connected ? "weg" : p.host ? "startet" : p.ready ? "✓ bereit" : "wartet"
      }</div>
        ${p.host ? '<div class="host">HOST</div>' : ""}`;
    }
    list.append(card);
  }

  const isHost = r.hostId === state.you;
  const me = r.players.find((p) => p.id === state.you);
  $("hostControls").hidden = !isHost;
  $("guestControls").hidden = isHost;

  for (const b of document.querySelectorAll("[data-lobbyzeit]")) {
    b.classList.toggle("sel", Number(b.dataset.lobbyzeit) === r.settings.zeit);
  }
  for (const b of document.querySelectorAll("[data-lobbyvis]")) {
    b.classList.toggle("sel", (b.dataset.lobbyvis === "public") === r.isPublic);
  }

  // Wer gerade weg ist, zählt nicht mit – sonst blockiert er den Start.
  const here = r.players.filter((p) => p.connected);
  const others = here.filter((p) => p.id !== r.hostId);
  const allReady = others.every((p) => p.ready);
  $("startBtn").disabled = here.length < r.minPlayers || !allReady;
  $("startHint").textContent = here.length < r.minPlayers
    ? "Zu zweit geht es los."
    : allReady
    ? "Alle bereit!"
    : "Warten auf die anderen …";

  $("readyBtn").textContent = me?.ready ? "Doch nicht bereit" : "Bereit!";
  $("readyBtn").classList.toggle("on", !!me?.ready);
}

$("readyBtn").addEventListener("click", () => {
  const me = state.room?.players.find((p) => p.id === state.you);
  send({ t: "ready", value: !me?.ready });
});

$("startBtn").addEventListener("click", () => send({ t: "start" }));
$("leaveBtn").addEventListener("click", verlassen);
// Derselbe Weg hinaus von ueberall: Lobby, Spielbildschirm, Endstand.
for (const b of document.querySelectorAll("[data-raus]")) {
  b.addEventListener("click", verlassen);
}


for (const b of document.querySelectorAll("[data-lobbyzeit]")) {
  b.addEventListener("click", () => send({ t: "settings", zeit: Number(b.dataset.lobbyzeit) }));
}
for (const b of document.querySelectorAll("[data-lobbyvis]")) {
  b.addEventListener("click", () =>
    send({ t: "settings", isPublic: b.dataset.lobbyvis === "public" })
  );
}

$("copyBtn").addEventListener("click", async () => {
  const link = location.origin + location.pathname + "#" + (state.code ?? "");
  try {
    await navigator.clipboard.writeText(link);
    toast("Link kopiert");
  } catch {
    // Ohne Zwischenablage (http, altes Handy) bleibt nur Vorlesen.
    toast(link);
  }
});

// ---------------------------------------------------------------------------
// Das Brett
// ---------------------------------------------------------------------------

/** Beschriftung eines Bonusfeldes. Farbe trennt Buchstabe von Wort, die Zahl sagt wie viel. */
const BONUS_TEXT = { d: "2", t: "3", D: "2W", T: "3W", "*": "★" };
const BONUS_KLASSE = { d: "dl", t: "tl", D: "dw", T: "tw", "*": "stern" };

/** Legt die 169 Felder einmal an. Danach wird nur noch beschriftet. */
function baueBrett() {
  const g = state.regeln?.groesse;
  if (!g) return;
  const brett = $("brett");
  if (brett.childElementCount === g * g) return;

  brett.textContent = "";
  brett.style.gridTemplateColumns = `repeat(${g}, 1fr)`;
  for (let r = 0; r < g; r++) {
    for (let c = 0; c < g; c++) {
      const feld = document.createElement("div");
      feld.dataset.r = String(r);
      feld.dataset.c = String(c);
      brett.append(feld);
    }
  }
  brett.addEventListener("click", (e) => {
    const feld = e.target.closest("[data-r]");
    if (feld) tippeFeld(Number(feld.dataset.r), Number(feld.dataset.c));
  });
}

/** Der eigene, noch nicht abgeschickte Stein auf (r,c) – oder undefined. */
const meinerAuf = (r, c) => state.gelegt.find((s) => s.r === r && s.c === c);

function renderBrett() {
  const sp = state.spiel;
  const reg = state.regeln;
  if (!sp || !reg) return;
  const g = reg.groesse;
  const brett = $("brett");
  const felder = brett.children;
  const frisch = new Set((sp.letzter?.felder ?? []).map(([r, c]) => r * g + c));
  const binDran = sp.amZug === state.you;

  brett.classList.toggle("leer", !!sp.leer);
  brett.classList.toggle("dran", binDran && !state.tauschModus);

  for (let r = 0; r < g; r++) {
    for (let c = 0; c < g; c++) {
      const i = r * g + c;
      const feld = felder[i];
      const zeichen = reg.muster[r][c];
      const vomServer = sp.brett[i];
      const meiner = meinerAuf(r, c);

      let klasse = "feld";
      let inhalt = "";

      if (vomServer !== "." || meiner) {
        const b = meiner ? meiner.b : vomServer.toUpperCase();
        const joker = meiner ? meiner.joker : vomServer !== vomServer.toUpperCase();
        klasse += " stein" + (joker ? " joker" : "") + (meiner ? " neu" : "");
        if (!meiner && frisch.has(i)) klasse += " frisch";
        const wert = joker ? 0 : (reg.werte[b] ?? 0);
        inhalt = escapeHtml(b) + (wert ? `<span class="wert">${wert}</span>` : "");
      } else if (zeichen !== ".") {
        klasse += ` ${BONUS_KLASSE[zeichen]}` + (zeichen === "*" ? "" : " bonus");
        inhalt = BONUS_TEXT[zeichen];
      }

      if (feld.className !== klasse) feld.className = klasse;
      if (feld.innerHTML !== inhalt) feld.innerHTML = inhalt;
    }
  }
}

/** Ein Feld wurde angetippt: Stein hinlegen oder wieder aufnehmen. */
function tippeFeld(r, c) {
  const sp = state.spiel;
  if (!sp || sp.amZug !== state.you || state.tauschModus) return;

  const meiner = meinerAuf(r, c);
  if (meiner) {
    state.gelegt = state.gelegt.filter((s) => s !== meiner);
    state.gewaehlt = meiner.regalIndex;
    return renderSpiel();
  }

  if (sp.brett[r * state.regeln.groesse + c] !== ".") return;
  if (state.gewaehlt === null) return toast("Erst einen Stein im Regal antippen");

  const b = sp.steine[state.gewaehlt];
  if (b === state.regeln.joker) {
    state.jokerZiel = { r, c, regalIndex: state.gewaehlt };
    zeigeJokerwahl();
    return;
  }
  state.gelegt.push({ r, c, b, joker: false, regalIndex: state.gewaehlt });
  state.gewaehlt = null;
  renderSpiel();
}

// ---------------------------------------------------------------------------
// Das Regal
// ---------------------------------------------------------------------------

function renderRegal() {
  const sp = state.spiel;
  const reg = state.regeln;
  const regal = $("regal");
  regal.textContent = "";
  if (!sp || !reg) return;

  regal.classList.toggle("leer", sp.steine.length === 0);
  const benutzt = new Set(state.gelegt.map((s) => s.regalIndex));
  const binDran = sp.amZug === state.you;

  sp.steine.forEach((b, i) => {
    // Was schon auf dem Brett liegt, bleibt als Lücke stehen – sonst rutschen
    // die Steine bei jedem Ablegen weiter und man greift daneben.
    if (benutzt.has(i)) {
      const luecke = document.createElement("span");
      luecke.className = "rstein";
      luecke.style.visibility = "hidden";
      regal.append(luecke);
      return;
    }
    const joker = b === reg.joker;
    const knopf = document.createElement("button");
    knopf.type = "button";
    knopf.className = "rstein" + (joker ? " joker" : "") +
      (state.gewaehlt === i ? " gewaehlt" : "") +
      (state.tauschWahl.has(i) ? " markiert" : "");
    knopf.disabled = !binDran;
    const wert = reg.werte[b] ?? 0;
    knopf.innerHTML = escapeHtml(joker ? "★" : b) +
      (wert ? `<span class="wert">${wert}</span>` : "");
    knopf.addEventListener("click", () => tippeRegal(i));
    regal.append(knopf);
  });
}

function tippeRegal(i) {
  if (state.tauschModus) {
    if (state.tauschWahl.has(i)) state.tauschWahl.delete(i);
    else state.tauschWahl.add(i);
    return renderSpiel();
  }
  state.gewaehlt = state.gewaehlt === i ? null : i;
  renderSpiel();
}

// ---------------------------------------------------------------------------
// Jokerwahl
// ---------------------------------------------------------------------------

function zeigeJokerwahl() {
  const raster = $("jokerRaster");
  raster.textContent = "";
  for (const b of state.regeln.buchstaben) {
    const knopf = document.createElement("button");
    knopf.type = "button";
    knopf.textContent = b;
    knopf.addEventListener("click", () => {
      const ziel = state.jokerZiel;
      $("jokerwahl").hidden = true;
      state.jokerZiel = null;
      if (!ziel) return;
      state.gelegt.push({ r: ziel.r, c: ziel.c, b, joker: true, regalIndex: ziel.regalIndex });
      state.gewaehlt = null;
      renderSpiel();
    });
    raster.append(knopf);
  }
  $("jokerwahl").hidden = false;
}

$("jokerAbbruch").addEventListener("click", () => {
  $("jokerwahl").hidden = true;
  state.jokerZiel = null;
});

// ---------------------------------------------------------------------------
// Spielbildschirm
// ---------------------------------------------------------------------------

function zugZuruecksetzen() {
  state.gelegt = [];
  state.gewaehlt = null;
  state.jokerZiel = null;
  state.tauschModus = false;
  state.tauschWahl.clear();
  $("jokerwahl").hidden = true;
}

function knopf(label, cls, fn) {
  const b = document.createElement("button");
  b.className = "btn " + cls;
  b.textContent = label;
  b.addEventListener("click", fn);
  return b;
}

function renderSpiel() {
  const sp = state.spiel;
  if (!sp) return;
  show("game");

  $("rundeNo").textContent = String(sp.zugNr + 1);
  $("beutelZahl").textContent = String(sp.beutel);
  $("endeBtn").hidden = state.room?.hostId !== state.you;

  const binDran = sp.amZug === state.you;
  const dran = sp.mitspieler.find((p) => p.id === sp.amZug);
  $("dran").classList.toggle("ich", binDran);
  $("dran").textContent = !sp.amZug
    ? "Niemand ist gerade da – es geht weiter, sobald jemand zurückkommt."
    : binDran
    ? "Du bist am Zug"
    : `${dran?.name ?? "…"} ist am Zug`;

  $("letzter").innerHTML = letzterText(sp.letzter);

  renderBrett();
  renderRegal();
  renderAktionen();
  renderPunktleiste();

  if (binDran && sp.endet) starteUhr();
  else stoppeUhr();
}

/** Was zuletzt passiert ist, in einem Satz. */
function letzterText(l) {
  if (!l) return "";
  if (l.art === "gepasst") return `${escapeHtml(l.name)} hat gepasst.`;
  if (l.art === "zeit") return `${escapeHtml(l.name)}: Bedenkzeit abgelaufen.`;
  if (l.art === "getauscht") {
    return `${escapeHtml(l.name)} hat ${l.anzahl} ${l.anzahl === 1 ? "Stein" : "Steine"} getauscht.`;
  }
  // Bei einem einzigen Wort stünde die Punktzahl sonst zweimal da – einmal in
  // der Klammer und einmal hinter dem Pfeil.
  const woerter = l.woerter.length === 1
    ? escapeHtml(l.woerter[0].wort)
    : l.woerter.map((w) => `${escapeHtml(w.wort)} (${w.punkte})`).join(" + ");
  return `${escapeHtml(l.name)}: ${woerter} → <b>${l.punkte}</b>${l.bingo ? " · alle sieben!" : ""}`;
}

function renderAktionen() {
  const sp = state.spiel;
  const box = $("aktionen");
  box.textContent = "";
  if (sp.amZug !== state.you) return;

  if (state.tauschModus) {
    const n = state.tauschWahl.size;
    const ok = knopf(n ? `${n} tauschen` : "Steine wählen", "primary", () => {
      if (!state.tauschWahl.size) return toast("Tippe die Steine an, die weg sollen");
      send({ t: "tauschen", indizes: [...state.tauschWahl] });
    });
    ok.disabled = n === 0;
    box.append(ok);
    box.append(knopf("Abbrechen", "ghost", () => {
      state.tauschModus = false;
      state.tauschWahl.clear();
      renderSpiel();
    }));
    return;
  }

  const legen = knopf("Legen", "primary", () => {
    if (!state.gelegt.length) return toast("Leg erst ein paar Steine hin");
    send({
      t: "legen",
      steine: state.gelegt.map(({ r, c, b, joker }) => ({ r, c, b, joker })),
    });
  });
  legen.disabled = state.gelegt.length === 0;
  box.append(legen);

  if (state.gelegt.length) {
    box.append(knopf("Zurück", "ghost", () => {
      state.gelegt = [];
      state.gewaehlt = null;
      renderSpiel();
    }));
  } else {
    box.append(knopf("Mischen", "ghost", () => {
      // Nur die Anzeige mischen. Der Server behält seine Reihenfolge – ein
      // gemischtes Regal ist eine Denkhilfe, kein Zug.
      for (let i = state.spiel.steine.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const s = state.spiel.steine;
        [s[i], s[j]] = [s[j], s[i]];
      }
      renderSpiel();
    }));
    box.append(knopf("Tauschen", "ghost", () => {
      if (!sp.beutel) return toast("Der Beutel ist leer");
      state.tauschModus = true;
      state.gewaehlt = null;
      renderSpiel();
    }));
    box.append(knopf("Passen", "ghost", () => send({ t: "passen" })));
  }
}

function renderPunktleiste() {
  const sp = state.spiel;
  const box = $("punktleiste");
  box.textContent = "";
  if (!sp) return;
  for (const p of sp.mitspieler) {
    const el = document.createElement("div");
    el.className = "pkt" + (p.id === sp.amZug ? " dran" : "") + (p.da ? "" : " weg");
    el.innerHTML = `<span>${avatarFor(p.id)}</span>
      <span>${escapeHtml(p.name)}${p.id === state.you ? " (du)" : ""}</span>
      <b>${p.punkte}</b><span class="rest">${p.steine}&nbsp;St.</span>`;
    box.append(el);
  }
}

$("endeBtn").addEventListener("click", () => {
  if (confirm("Partie für alle beenden und abrechnen?")) send({ t: "ende" });
});

// ---------------------------------------------------------------------------
// Die Uhr
//
// Nur die Bedenkzeit läuft hier mit, und nur bei dem, der dran ist. Gerechnet
// wird gegen `endet` vom Server plus dem Versatz aus der letzten Nachricht –
// eine eigene Zählung liefe sonst gegen eine falsch gestellte Handyuhr.
// ---------------------------------------------------------------------------

function stoppeUhr() {
  if (state.uhrTimer) {
    clearInterval(state.uhrTimer);
    state.uhrTimer = null;
  }
  $("uhr").textContent = "";
  $("uhr").classList.remove("knapp");
}

function starteUhr() {
  if (state.uhrTimer) clearInterval(state.uhrTimer);
  zeigeUhr();
  state.uhrTimer = setInterval(zeigeUhr, 250);
}

function zeigeUhr() {
  const sp = state.spiel;
  if (!sp?.endet) return stoppeUhr();
  const rest = Math.max(0, sp.endet - (Date.now() + state.versatz));
  const s = Math.ceil(rest / 1000);
  $("uhr").textContent = s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s} s`;
  $("uhr").classList.toggle("knapp", s <= 15);
}

// ---------------------------------------------------------------------------
// Endstand
// ---------------------------------------------------------------------------

const GRUND_TEXT = {
  fertig: "Ein Regal war leer und der Beutel auch.",
  ausgesessen: "Zwei Runden lang kam kein Wort mehr zustande.",
  abgebrochen: "Der Host hat die Partie beendet.",
  zuwenig: "Es waren zu wenige übrig, um weiterzuspielen.",
};

function renderFinal(msg) {
  show("final");
  zugZuruecksetzen();
  $("finalSub").textContent =
    `${GRUND_TEXT[msg.grund] ?? ""} ${msg.zuege} ${msg.zuege === 1 ? "Wort" : "Wörter"} lagen am Ende.`;

  const ol = $("podium");
  ol.textContent = "";
  msg.tabelle.forEach((p, i) => {
    const li = document.createElement("li");
    const zusatz = p.bonus
      ? `<span class="abzug">+${p.bonus} aus fremden Regalen</span>`
      : p.rest
      ? `<span class="abzug">−${p.rest} Reststeine</span>`
      : "";
    li.innerHTML = `<span class="platz">${i + 1}.</span>
      <span class="nm">${escapeHtml(p.name)}${p.id === state.you ? " (du)" : ""}</span>
      ${zusatz}
      <span class="pts">${p.punkte}</span>`;
    ol.append(li);
  });

  const isHost = state.room?.hostId === state.you;
  $("againBtn").hidden = !isHost;
  $("againHint").hidden = isHost;
}

$("againBtn").addEventListener("click", () => send({ t: "again" }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

try {
  const gemerkt = localStorage.getItem(NAME_KEY);
  if (gemerkt) $("name").value = gemerkt;
} catch { /* egal */ }

const hash = location.hash.replace("#", "").toUpperCase().trim();
if (hash.length >= 3 && hash.length <= 5) {
  $("codeInput").value = hash;
  if (!session()?.token && $("name").value.trim()) {
    state.pendingIntent = { t: "join", code: hash, token: tokenFuer(hash), name: meinName() };
  }
}

connect();
