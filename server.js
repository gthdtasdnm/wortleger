// WORTLEGER – Deno-Server: statische Dateien + WebSocket + Zuglogik.
// Keine Abhaengigkeiten, kein Build-Schritt. `deno task dev` oder direkt:
//   deno run --allow-net --allow-read --allow-env --allow-sys server.js
//
// Raum, Host, Bereit, Karenzzeit und Bremse stehen in raum.js und statisch.js
// – Kopien aus /var/www/html/gemeinsam/, die `node werkzeug/verteilen.mjs`
// hierher schreibt. Was hier steht, ist nur dieses Spiel.
//
// Der Unterschied zu allen bisherigen Spielen: hier ist **einer** am Zug und
// alle anderen schauen zu. Daraus folgt fast der ganze Rest dieser Datei –
// die Reihenfolge, die Bedenkzeit, das Ueberspringen von Leuten, deren
// Verbindung gerade weg ist, und die Frage, was mit ihren Steinen passiert.

import { GROESSE, leeresBrett, MITTE, MUSTER } from "./brett.js";
import {
  BINGO,
  BUCHSTABEN,
  JOKER,
  neuerBeutel,
  regalWert,
  REGAL,
  WERT,
} from "./steine.js";
import { brettAlsText, werteZug } from "./zug.js";
import { ladeWoerter } from "./woerter.js";
import { darfRaumOeffnen, raumVermerkt } from "./bremse.js";
import { cleanName, raumverwaltung, shuffle } from "./raum.js";
import { starte } from "./statisch.js";

const PORT = Number(Deno.env.get("PORT") ?? 8070);
const HOST = Deno.env.get("HOST") ?? "0.0.0.0";

const PUBLIC = new URL("./public/", import.meta.url);

// ---------------------------------------------------------------------------
// Spielkonstanten
// ---------------------------------------------------------------------------

// Vier ist die Grenze, nicht aus Bequemlichkeit: bei fuenf Leuten wartet jeder
// vier fremde Zuege lang, und der Beutel reicht fuer keine volle Partie mehr.
const MAX_PLAYERS = 4;
// Zu zweit ist ein Legespiel vollstaendig – mehr braucht es nicht.
const MIN_PLAYERS = 2;

/** Bedenkzeit je Zug in Sekunden. 0 heisst: keine. */
const ZEIT_OPTIONEN = [60, 120, 240, 0];

/**
 * So viele punktlose Zuege in Folge beenden die Partie. Zwei volle Runden, in
 * denen niemand ein Wort zustande bringt – danach kommt keins mehr.
 */
const AUSGESESSEN = 2;

const woerterbuch = await ladeWoerter(new URL("./woerter.txt", import.meta.url));
console.log(`Wortliste: ${woerterbuch.anzahl} Woerter`);

// ---------------------------------------------------------------------------
// Raeume
// ---------------------------------------------------------------------------

const {
  rooms, browsing,
  createRoom, clearTimers, anwesende,
  send, raw, broadcast,
  roomList, pushState, pushRoomList,
  makePlayer, attach, dropPlayer,
} = raumverwaltung({
  maxPlayers: MAX_PLAYERS,
  minPlayers: MIN_PLAYERS,
  einstellungen: { zeit: 120 },
  raumfelder: () => ({
    brett: leeresBrett(),
    beutel: [],
    reihe: [],        // Spieler-Ids in Zugreihenfolge
    amZug: null,      // Spieler-Id oder null, wenn gerade niemand da ist
    zugNr: 0,
    ohnePunkte: 0,    // punktlose Zuege in Folge
    zugEndet: null,
    zugTimer: null,
    letzter: null,    // was zuletzt passiert ist, fuer alle sichtbar
    // Steine von Leuten, deren Verbindung weg ist. Solange der Platz in der
    // Karenzzeit steht, gehoeren sie noch ihnen; faellt er weg, wandern sie
    // zurueck in den Beutel. Ohne diese Zwischenablage waeren sie verloren:
    // `beimPlatzfrei` bekommt nur noch die Id, den Spieler hat raum.js da
    // schon aus dem Raum genommen.
    verwaist: new Map(),
  }),
  spielerfelder: () => ({ steine: [] }),
  listeneintrag: (room) => ({ zeit: room.settings.zeit }),

  beimBeitritt: (room, player) => {
    // Brettmuster und Steinwerte gehen einmal je Verbindung mit. Der Client
    // haelt damit keine zweite Fassung der Tabellen aus brett.js und steine.js
    // vor – die waere genau die Art Doppelung, die irgendwann auseinander
    // laeuft, ohne dass es jemandem auffaellt. 430 Byte, einmal.
    send(player, {
      t: "regeln",
      muster: MUSTER,
      werte: WERT,
      buchstaben: BUCHSTABEN,
      joker: JOKER,
      mitte: MITTE,
      groesse: GROESSE,
      regal: REGAL,
      bingo: BINGO,
    });
    if (room.phase !== "playing") return;
    // Kam die Person zurueck, waehrend niemand am Zug war, geht es weiter.
    if (!room.amZug) weiterMitZug(room, ersterAnwesender(room));
    else pushSpiel(room);
  },

  // Wessen Verbindung weg ist, kann nicht legen. Der Platz bleibt aber stehen
  // (Karenzzeit in raum.js) – deshalb werden die Steine nur beiseite gelegt.
  beimVerlassen: (room, player) => {
    if (room.phase === "playing") room.verwaist.set(player.id, player.steine);
  },
  nachVerlassen: (room, player) => {
    if (room.phase !== "playing") return;
    if (room.amZug === player.id) naechsterZug(room, { vermerk: null });
    else pushSpiel(room);
  },

  // Jetzt ist der Platz endgueltig weg. Die Steine gehen zurueck in den
  // Beutel, sonst fehlen sie der Partie bis zum Schluss – und der Beutel wird
  // nie leer, also endet die Partie nie von allein.
  beimPlatzfrei: (room, id) => {
    const zurueck = room.verwaist.get(id);
    room.verwaist.delete(id);
    if (room.phase !== "playing") return;
    if (zurueck?.length) {
      room.beutel.push(...zurueck);
      shuffle(room.beutel);
    }
    const war = room.amZug === id;
    // Nachfolger *vor* dem Ausfaedeln bestimmen – danach weiss niemand mehr,
    // an welcher Stelle der Reihe die Person sass.
    const nachfolger = war ? naechsterSpieler(room, id) : null;
    room.reihe = room.reihe.filter((x) => x !== id);
    if (room.reihe.length < MIN_PLAYERS) return finishGame(room, "zuwenig");
    if (war) weiterMitZug(room, nachfolger);
    else pushSpiel(room);
  },

  zurueckZurLobby: (room) => backToLobby(room),
});

// ---------------------------------------------------------------------------
// Beutel und Regale
// ---------------------------------------------------------------------------

/** Zieht so viele Steine, wie noch da sind, und legt sie aufs Regal. */
function ziehe(room, player) {
  while (player.steine.length < REGAL && room.beutel.length) {
    player.steine.push(room.beutel.pop());
  }
}

// ---------------------------------------------------------------------------
// Zugreihenfolge
// ---------------------------------------------------------------------------

/**
 * Wer kommt nach `vonId`? Ueberspringt, wessen Verbindung gerade weg ist –
 * sonst steht die Partie, bis jemandes Handy wieder Netz hat.
 * Gibt `null` zurueck, wenn niemand da ist.
 */
function naechsterSpieler(room, vonId) {
  if (!room.reihe.length) return null;
  const start = room.reihe.indexOf(vonId);
  for (let k = 1; k <= room.reihe.length; k++) {
    const id = room.reihe[(Math.max(start, 0) + k) % room.reihe.length];
    const p = room.players.get(id);
    if (p && p.connected) return id;
  }
  return null;
}

/** Der erste Anwesende in der Reihe – womit es nach einer Pause weitergeht. */
function ersterAnwesender(room) {
  return room.reihe.find((id) => room.players.get(id)?.connected) ?? null;
}

function stoppeZugUhr(room) {
  if (room.zugTimer) {
    clearTimeout(room.zugTimer);
    room.zugTimer = null;
  }
  room.zugEndet = null;
}

/**
 * Setzt `amZug` und startet die Bedenkzeit. Laeuft sie ab, passt der Server
 * fuer die Person – eine Partie, die auf jemanden wartet, der das Handy
 * weggelegt hat, ist fuer alle anderen vorbei.
 */
function weiterMitZug(room, id) {
  stoppeZugUhr(room);
  room.amZug = id;
  if (!id) return pushSpiel(room);

  const sekunden = room.settings.zeit;
  if (sekunden > 0) {
    room.zugEndet = Date.now() + sekunden * 1000;
    room.zugTimer = setTimeout(() => {
      room.zugTimer = null;
      const p = room.players.get(room.amZug);
      if (!p || room.phase !== "playing") return;
      try {
        room.ohnePunkte++;
        naechsterZug(room, { vermerk: { name: p.name, art: "zeit" } });
      } catch (err) {
        console.error("Fehler beim Ablauf der Bedenkzeit:", err);
      }
    }, sekunden * 1000);
  }
  pushSpiel(room);
}

/** Zug ist vorbei: Vermerk setzen, Ende pruefen, naechste Person dran. */
function naechsterZug(room, { vermerk } = {}) {
  if (vermerk !== null) room.letzter = vermerk;
  if (room.ohnePunkte >= AUSGESESSEN * Math.max(room.reihe.length, 1)) {
    return finishGame(room, "ausgesessen");
  }
  weiterMitZug(room, naechsterSpieler(room, room.amZug));
}

// ---------------------------------------------------------------------------
// Spielablauf
// ---------------------------------------------------------------------------

function startGame(room) {
  clearTimers(room);
  stoppeZugUhr(room);
  room.phase = "playing";
  room.brett = leeresBrett();
  room.beutel = shuffle(neuerBeutel());
  room.zugNr = 0;
  room.ohnePunkte = 0;
  room.letzter = null;
  room.verwaist.clear();

  const dabei = anwesende(room);
  room.reihe = shuffle(dabei.map((p) => p.id));
  for (const p of room.players.values()) {
    p.punkte = 0;
    p.ready = false;
    p.steine = [];
    if (room.reihe.includes(p.id)) ziehe(room, p);
  }

  pushState(room);
  weiterMitZug(room, room.reihe[0] ?? null);
  pushRoomList();
}

/** Der Spielstand geht an jeden einzeln – das Regal ist Privatsache. */
function pushSpiel(room) {
  const brett = brettAlsText(room.brett);
  const jetzt = Date.now();
  const stand = room.reihe
    .map((id) => room.players.get(id))
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      name: p.name,
      punkte: p.punkte,
      steine: p.steine.length,
      da: p.connected,
    }));

  for (const p of room.players.values()) {
    send(p, {
      t: "spiel",
      brett,
      amZug: room.amZug,
      zugNr: room.zugNr,
      beutel: room.beutel.length,
      steine: p.steine,
      mitspieler: stand,
      letzter: room.letzter,
      endet: room.zugEndet,
      jetzt,
      // Solange nichts liegt, muss das erste Wort durch die Mitte – der Client
      // markiert den Stern dafuer.
      leer: room.zugNr === 0,
    });
  }
}

function finishGame(room, grund) {
  clearTimers(room);
  stoppeZugUhr(room);
  room.phase = "final";
  room.amZug = null;

  // Abrechnung. Wer sein Regal leer bekommen hat, bekommt auf, was die anderen
  // noch halten; alle anderen ziehen ihre eigenen Steine ab. Das ist der
  // Grund, warum man am Ende nicht auf dem letzten teuren Stein sitzen bleibt.
  const dabei = room.reihe.map((id) => room.players.get(id)).filter(Boolean);
  const fertig = dabei.find((p) => p.steine.length === 0 && grund === "fertig");
  let rest = 0;
  for (const p of dabei) {
    if (p === fertig) continue;
    const abzug = regalWert(p.steine);
    p.punkte -= abzug;
    rest += abzug;
  }
  if (fertig) fertig.punkte += rest;

  const tabelle = dabei
    .map((p) => ({
      id: p.id,
      name: p.name,
      punkte: p.punkte,
      rest: p === fertig ? 0 : regalWert(p.steine),
      bonus: p === fertig ? rest : 0,
    }))
    .sort((a, b) => b.punkte - a.punkte || a.name.localeCompare(b.name, "de"));

  for (const p of room.players.values()) p.ready = false;
  broadcast(room, { t: "final", tabelle, grund, zuege: room.zugNr });
  pushState(room);
  pushRoomList();
}

function backToLobby(room) {
  clearTimers(room);
  stoppeZugUhr(room);
  room.phase = "lobby";
  room.brett = leeresBrett();
  room.beutel = [];
  room.reihe = [];
  room.amZug = null;
  room.zugNr = 0;
  room.ohnePunkte = 0;
  room.letzter = null;
  room.verwaist.clear();
  for (const p of room.players.values()) {
    p.ready = false;
    p.punkte = 0;
    p.steine = [];
  }
  pushState(room);
}

// ---------------------------------------------------------------------------
// Die drei Zuege: legen, tauschen, passen
// ---------------------------------------------------------------------------

/** Kurzer Hinweis nur an eine Person. Kein `error` – das wirft den Client raus. */
function hinweis(player, text) {
  send(player, { t: "hinweis", msg: text });
}

/**
 * Nimmt die Steine eines Zuges vom Regal. Gibt die neue Regalliste zurueck
 * oder `null`, wenn dort etwas liegt, das die Person gar nicht hat.
 *
 * Das ist der Riegel gegen einen umgebauten Client: die Oberflaeche bietet nur
 * eigene Steine an, aber geprueft wird es hier.
 */
function vomRegal(player, gelegt) {
  const regal = player.steine.slice();
  for (const s of gelegt) {
    const gesucht = s.joker ? JOKER : s.b;
    const i = regal.indexOf(gesucht);
    if (i === -1) return null;
    regal.splice(i, 1);
  }
  return regal;
}

/** Macht aus dem, was der Client schickt, eine saubere Liste. */
function lesenGelegt(roh) {
  if (!Array.isArray(roh)) return null;
  const gelegt = [];
  for (const s of roh.slice(0, REGAL + 1)) {
    if (!s || typeof s !== "object") return null;
    gelegt.push({
      r: Number(s.r),
      c: Number(s.c),
      b: String(s.b ?? "").toUpperCase(),
      joker: !!s.joker,
    });
  }
  return gelegt;
}

function legen(room, player, roh) {
  const gelegt = lesenGelegt(roh);
  if (!gelegt) return hinweis(player, "Der Zug kam kaputt an.");

  const regal = vomRegal(player, gelegt);
  if (!regal) return hinweis(player, "So einen Stein hast du nicht.");

  const ergebnis = werteZug({
    brett: room.brett,
    gelegt,
    ersterZug: room.zugNr === 0,
    kennt: woerterbuch.kennt,
  });
  if (!ergebnis.ok) return hinweis(player, ergebnis.fehler);

  for (const s of gelegt) room.brett[s.r][s.c] = { b: s.b, joker: s.joker };
  player.steine = regal;
  player.punkte += ergebnis.punkte;
  room.zugNr++;
  room.ohnePunkte = 0;
  ziehe(room, player);

  room.letzter = {
    name: player.name,
    art: "gelegt",
    punkte: ergebnis.punkte,
    bingo: ergebnis.bingo,
    woerter: ergebnis.woerter.map((w) => ({ wort: w.wort, punkte: w.punkte })),
    felder: ergebnis.woerter[0]?.felder ?? [],
  };

  // Regal leer und Beutel leer: die Partie ist zu Ende, und zwar sofort – nicht
  // erst, wenn die Reihe wieder herum ist.
  if (player.steine.length === 0 && room.beutel.length === 0) {
    pushState(room);
    return finishGame(room, "fertig");
  }
  pushState(room);
  naechsterZug(room, { vermerk: room.letzter });
}

function tauschen(room, player, roh) {
  if (!Array.isArray(roh) || roh.length === 0) {
    return hinweis(player, "Wähle erst die Steine aus, die weg sollen.");
  }
  if (room.beutel.length === 0) {
    return hinweis(player, "Der Beutel ist leer – tauschen geht nicht mehr.");
  }
  // Doppelte Indizes wuerden denselben Stein zweimal abgeben.
  const indizes = [...new Set(roh.map(Number))]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < player.steine.length);
  if (!indizes.length) return hinweis(player, "Diese Steine gibt es nicht.");
  if (indizes.length > room.beutel.length) {
    return hinweis(player, `Im Beutel liegen nur noch ${room.beutel.length} Steine.`);
  }

  const weg = indizes.map((i) => player.steine[i]);
  player.steine = player.steine.filter((_, i) => !indizes.includes(i));
  ziehe(room, player);
  // Erst nachziehen, dann zurueckwerfen – sonst zieht man seine eigenen
  // Steine mit einer gewissen Wahrscheinlichkeit gleich wieder.
  room.beutel.push(...weg);
  shuffle(room.beutel);

  room.ohnePunkte++;
  pushState(room);
  naechsterZug(room, {
    vermerk: { name: player.name, art: "getauscht", anzahl: weg.length },
  });
}

function passen(room, player) {
  room.ohnePunkte++;
  naechsterZug(room, { vermerk: { name: player.name, art: "gepasst" } });
}

// ---------------------------------------------------------------------------
// Nachrichten
// ---------------------------------------------------------------------------

function handle(ws, msg) {
  const room = ws._room;
  const player = ws._player;

  if (msg.t === "ping") {
    raw(ws, { t: "pong", c: msg.c, s: Date.now() });
    return;
  }

  if (msg.t === "browse") {
    if (!ws._room) {
      browsing.add(ws);
      raw(ws, { t: "rooms", rooms: roomList() });
    }
    return;
  }

  if (msg.t === "create") {
    if (room) return;
    if (!darfRaumOeffnen(ws._ip)) {
      return raw(ws, { t: "error", msg: "Zu viele Räume in kurzer Zeit. Warte kurz." });
    }
    raumVermerkt(ws._ip);
    const r = createRoom(msg.isPublic);
    if (ZEIT_OPTIONEN.includes(msg.zeit)) r.settings.zeit = msg.zeit;
    const p = makePlayer(msg.name, true);
    r.hostId = p.id;
    r.players.set(p.id, p);
    attach(ws, r, p);
    pushState(r);
    pushRoomList();
    return;
  }

  if (msg.t === "join") {
    if (room) return;
    const r = rooms.get(String(msg.code ?? "").toUpperCase().trim());
    if (!r) return raw(ws, { t: "error", msg: "Diesen Raum gibt es nicht" });

    if (msg.token) {
      const back = [...r.players.values()].find((p) => p.token === msg.token);
      if (back) {
        if (back.ws && back.ws !== ws && back.ws.readyState === WebSocket.OPEN) {
          try { back.ws.close(4001, "woanders geöffnet"); } catch { /* egal */ }
        }
        attach(ws, r, back);
        pushState(r);
        return;
      }
    }

    if (r.players.size >= MAX_PLAYERS) {
      return raw(ws, { t: "error", msg: `Der Raum ist voll (${MAX_PLAYERS} Spieler)` });
    }
    if (r.phase !== "lobby") {
      return raw(ws, { t: "error", msg: "Die Partie läuft schon" });
    }
    const p = makePlayer(msg.name, false);
    r.players.set(p.id, p);
    attach(ws, r, p);
    pushState(r);
    return;
  }

  if (!room || !player) return;
  room.lastActivity = Date.now();

  switch (msg.t) {
    case "name":
      player.name = cleanName(msg.name);
      pushState(room);
      if (room.phase === "playing") pushSpiel(room);
      break;

    case "ready":
      player.ready = !!msg.value;
      pushState(room);
      break;

    case "settings": {
      if (player.id !== room.hostId) break;
      // Die Bedenkzeit darf der Host auch mitten in der Partie ändern – genau
      // dann merkt man ja, dass sie zu lang ist. Sie greift erst beim nächsten
      // Zug: wer schon überlegt, bekommt nicht plötzlich weniger Zeit.
      if (ZEIT_OPTIONEN.includes(msg.zeit)) room.settings.zeit = msg.zeit;
      if (typeof msg.isPublic === "boolean" && room.phase === "lobby") {
        room.isPublic = msg.isPublic;
      }
      pushState(room);
      pushRoomList();
      break;
    }

    case "start": {
      if (player.id !== room.hostId || room.phase !== "lobby") break;
      const da = anwesende(room);
      if (da.length < MIN_PLAYERS) break;
      if (!da.every((p) => p.ready || p.id === room.hostId)) break;
      startGame(room);
      break;
    }

    // Die drei Zuege. Alle drei haben denselben Riegel davor: nur die Person,
    // die dran ist, und nur waehrend die Partie laeuft.
    case "legen":
    case "tauschen":
    case "passen": {
      if (room.phase !== "playing") break;
      if (room.amZug !== player.id) {
        hinweis(player, "Du bist nicht am Zug.");
        break;
      }
      if (msg.t === "legen") legen(room, player, msg.steine);
      else if (msg.t === "tauschen") tauschen(room, player, msg.indizes);
      else passen(room, player);
      break;
    }

    case "ende":
      if (player.id !== room.hostId || room.phase !== "playing") break;
      finishGame(room, "abgebrochen");
      break;

    case "again":
      if (player.id !== room.hostId || room.phase !== "final") break;
      backToLobby(room);
      break;

    case "leave":
      // Beim Knopf „Raum verlassen“ gibt es keine Karenzzeit: raum.js raeumt
      // den Platz sofort. Die Steine muessen also jetzt beiseite, sonst sind
      // sie weg, bevor `beimPlatzfrei` danach greifen kann.
      if (room.phase === "playing") room.verwaist.set(player.id, player.steine);
      dropPlayer(ws, { immediate: true });
      break;
  }
}

starte({
  port: PORT,
  host: HOST,
  publicDir: PUBLIC,
  titel: "WORTLEGER",
  handle,
  dropPlayer,
});
