// WORTLEGER – Probe.
//
// Kein Testrahmen, keine Abhaengigkeit – das Skript wirft, wenn etwas nicht
// stimmt, und schreibt sonst mit, was passiert ist. Zweiteilig:
//
//   Teil 1 laeuft ohne Server. Brettmuster, Steinverteilung, Wortliste und vor
//   allem `zug.js` werden durchgerechnet: jede Regel einzeln, jede Punktzahl
//   von Hand nachgerechnet.
//
//   Teil 2 spielt eine Partie mit drei echten Verbindungen. Weil die Steine
//   zufaellig sind, kann die Probe keinen bestimmten Zug ansagen – sie sucht
//   sich mit derselben `zug.js`, die der Server benutzt, einen gueltigen Zug.
//   Genau das ist der Punkt: was die gemeinsame Logik erlaubt, muss der Server
//   annehmen, und was sie verbietet, muss er ablehnen.
//
// Der Server muss laufen:
//   deno task dev            (in einer zweiten Sitzung)
//   deno task probe
//   WS_URL=wss://inf-zeus.de/wortleger/ws deno task probe
//
// Der letzte Abschnitt wartet eine volle Bedenkzeit ab – die Probe dauert
// deshalb gut eine Minute. Ohne ihn waere nie geprueft, dass die Uhr
// tatsaechlich ablaeuft und nicht nur schoen aussieht.

import { bonusAn, GROESSE, leeresBrett, MITTE, MUSTER } from "./brett.js";
import { BINGO, BUCHSTABEN, JOKER, neuerBeutel, regalWert, REGAL, VERTEILUNG, WERT } from "./steine.js";
import { brettAusText, werteZug } from "./zug.js";
import { ladeWoerter } from "./woerter.js";

const PORT = Deno.env.get("PORT") ?? "8070";
const URL_WS = Deno.env.get("WS_URL") ?? `ws://127.0.0.1:${PORT}/ws`;

const woerter = await ladeWoerter(new URL("./woerter.txt", import.meta.url));
const kennt = woerter.kennt;

function client(name) {
  const c = {
    name,
    ws: new WebSocket(URL_WS),
    you: null,
    room: null,
    spiel: null,
    regeln: null,
    final: null,
    hinweise: [],
    fehler: [],
  };
  c.ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === "joined") c.you = m.you;
    if (m.t === "room") c.room = m;
    if (m.t === "spiel") c.spiel = m;
    if (m.t === "regeln") c.regeln = m;
    if (m.t === "final") c.final = m;
    if (m.t === "hinweis") c.hinweise.push(m.msg);
    if (m.t === "error") c.fehler.push(m.msg);
  };
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.offen = new Promise((res) => { c.ws.onopen = res; });
  return c;
}

const warte = (ms) => new Promise((r) => setTimeout(r, ms));

async function bis(bedingung, was, ms = 6000) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (bedingung()) return;
    await warte(20);
  }
  throw new Error("Zeitüberschreitung: " + was);
}

// ═══════════════════════════════════════════════════════════════════════════
// Teil 1 – ohne Server
// ═══════════════════════════════════════════════════════════════════════════

console.log("── Brett ──");

if (MUSTER.length !== GROESSE) throw new Error(`Das Muster hat ${MUSTER.length} Zeilen, nicht ${GROESSE}`);
for (const [i, zeile] of MUSTER.entries()) {
  if (zeile.length !== GROESSE) throw new Error(`Zeile ${i} ist ${zeile.length} Zeichen breit`);
  if (!/^[.dtDT*]+$/.test(zeile)) throw new Error(`Zeile ${i} enthält ein unbekanntes Zeichen`);
}
console.log(`ok  ${GROESSE}x${GROESSE}, nur bekannte Zeichen`);

const sterne = MUSTER.join("").split("").filter((z) => z === "*").length;
if (sterne !== 1) throw new Error(`Es gibt ${sterne} Sterne, es darf genau einen geben`);
if (bonusAn(MITTE, MITTE) !== "*") throw new Error("Der Stern liegt nicht in der Mitte");
console.log("ok  genau ein Stern, und der liegt in der Mitte");

// Waagerecht zu legen muss genau so viel bringen wie senkrecht – sonst haette
// die eine Richtung einen eingebauten Vorteil, den niemand bemerkt.
for (let r = 0; r < GROESSE; r++) {
  for (let c = 0; c < GROESSE; c++) {
    if (bonusAn(r, c) !== bonusAn(c, r)) {
      throw new Error(`Nicht spiegelsymmetrisch bei ${r},${c}`);
    }
    if (bonusAn(r, c) !== bonusAn(GROESSE - 1 - r, GROESSE - 1 - c)) {
      throw new Error(`Nicht punktsymmetrisch bei ${r},${c}`);
    }
  }
}
console.log("ok  Muster ist spiegel- und punktsymmetrisch");

const zaehlung = {};
for (const z of MUSTER.join("")) zaehlung[z] = (zaehlung[z] ?? 0) + 1;
console.log(`ok  Boni: ${zaehlung.d} doppelte und ${zaehlung.t} dreifache Buchstaben, ` +
  `${zaehlung.D} doppelte und ${zaehlung.T} dreifache Wörter`);

console.log("\n── Steine ──");

const beutel = neuerBeutel();
if (beutel.length !== 86) throw new Error(`Der Beutel hat ${beutel.length} Steine, erwartet 86`);
const joker = beutel.filter((b) => b === JOKER).length;
if (joker !== 2) throw new Error(`${joker} Joker statt 2`);
console.log(`ok  ${beutel.length} Steine, davon ${joker} Joker`);

const gesehen = new Set();
for (const [b, anzahl, wert] of VERTEILUNG) {
  if (gesehen.has(b)) throw new Error(`${b} steht zweimal in der Verteilung`);
  gesehen.add(b);
  if (anzahl < 1) throw new Error(`${b} kommt ${anzahl}-mal vor`);
  if (WERT[b] !== wert) throw new Error(`${b} hat zwei verschiedene Werte`);
}
if (WERT[JOKER] !== 0) throw new Error("Der Joker ist nicht 0 wert");
if (BUCHSTABEN.includes(JOKER)) throw new Error("Der Joker steht in der Buchstabenliste");
for (const b of ["Q", "X", "Y", "ß"]) {
  if (gesehen.has(b)) throw new Error(`${b} soll es als Stein nicht geben`);
}
console.log(`ok  ${BUCHSTABEN.length} Buchstaben, kein Q, X, Y oder ß, Joker zählt 0`);

const summe = VERTEILUNG.reduce((s, [, n, w]) => s + n * w, 0);
console.log(`ok  alle Steine zusammen ${summe} Punkte (${(summe / 84).toFixed(2)} je Buchstabe)`);

console.log("\n── Wortliste ──");

console.log(`ok  ${woerter.anzahl} Wörter geladen`);
for (const w of ["HAUS", "HÄUSER", "STRASSE", "SEE", "IHM", "ÖL"]) {
  if (!kennt(w)) throw new Error(`${w} fehlt in der Liste`);
}
for (const w of ["QQQQ", "ZZZZZ", "A", "", "HAUSX"]) {
  if (kennt(w)) throw new Error(`${w} steht in der Liste, sollte es aber nicht`);
}
console.log("ok  bekannte Wörter drin, erfundene draußen, Einzelbuchstaben abgelehnt");

// Jedes Wort der Liste muss aus vorhandenen Steinen legbar sein. Fiele hier ein
// X auf, waere die Liste an steine.js vorbeigelaufen.
{
  const text = await Deno.readTextFile(new URL("./woerter.txt", import.meta.url));
  const erlaubt = new Set([...BUCHSTABEN, "\n"]);
  let laengstes = 0;
  for (const z of text) {
    if (!erlaubt.has(z)) throw new Error(`Die Wortliste enthält „${z}“, dafür gibt es keinen Stein`);
  }
  for (const w of text.split("\n")) laengstes = Math.max(laengstes, w.length);
  if (laengstes > GROESSE) throw new Error(`Ein Wort ist ${laengstes} Zeichen lang, das Brett nur ${GROESSE}`);
  console.log(`ok  jedes Wort ist legbar, das längste hat ${laengstes} Buchstaben`);
}

console.log("\n── Zugregeln ──");

/** Kurzschreibweise: legt Buchstaben ab (r,c) in eine Richtung. */
function reihe(wort, r, c, dr, dc, joker = -1) {
  return [...wort].map((b, i) => ({
    r: r + dr * i,
    c: c + dc * i,
    b,
    joker: i === joker,
  }));
}

const leer = leeresBrett();

// Der Eroeffnungszug muss durch den Stern.
{
  const daneben = werteZug({ brett: leer, gelegt: reihe("HAUS", 0, 0, 0, 1), ersterZug: true, kennt });
  if (daneben.ok || !daneben.fehler.includes("Stern")) {
    throw new Error("Ein erstes Wort abseits der Mitte wurde angenommen");
  }
  const einer = werteZug({ brett: leer, gelegt: reihe("A", MITTE, MITTE, 0, 1), ersterZug: true, kennt });
  if (einer.ok) throw new Error("Ein einzelner Buchstabe wurde als erstes Wort angenommen");
  console.log("ok  das erste Wort muss durch den Stern und mindestens zwei Steine haben");
}

// HAUS waagerecht durch die Mitte: H auf doppeltem Buchstaben (4), A auf dem
// Stern (1), U auf doppeltem Buchstaben (4), S frei (1) – zusammen 10, und der
// Stern verdoppelt das Wort: 20.
const eroeffnung = reihe("HAUS", MITTE, MITTE - 1, 0, 1);
{
  const w = werteZug({ brett: leer, gelegt: eroeffnung, ersterZug: true, kennt });
  if (!w.ok) throw new Error("HAUS durch die Mitte wurde abgelehnt: " + w.fehler);
  if (w.punkte !== 20) throw new Error(`HAUS bringt ${w.punkte} statt 20`);
  if (w.woerter.length !== 1) throw new Error("HAUS soll genau ein Wort sein");
  console.log("ok  HAUS durch die Mitte: 20 Punkte (2×[H]+1+2×[U]+1, Wort doppelt)");

  const senkrecht = werteZug({
    brett: leer,
    gelegt: reihe("HAUS", MITTE - 1, MITTE, 1, 0),
    ersterZug: true,
    kennt,
  });
  if (senkrecht.punkte !== w.punkte) {
    throw new Error(`Senkrecht bringt ${senkrecht.punkte}, waagerecht ${w.punkte}`);
  }
  console.log("ok  senkrecht bringt dasselbe wie waagerecht");
}

// Ab hier liegt HAUS auf dem Brett.
const mitHaus = leeresBrett();
for (const s of eroeffnung) mitHaus[s.r][s.c] = { b: s.b, joker: false };

// Ecken, Lücken, Anschluss
{
  const eck = werteZug({
    brett: mitHaus,
    gelegt: [{ r: 5, c: 5, b: "E", joker: false }, { r: 4, c: 4, b: "I", joker: false }],
    ersterZug: false,
    kennt,
  });
  if (eck.ok || !eck.fehler.includes("Eck")) throw new Error("Ein Zug übers Eck wurde angenommen");

  const luecke = werteZug({
    brett: mitHaus,
    gelegt: [{ r: 4, c: 5, b: "E", joker: false }, { r: 4, c: 8, b: "I", joker: false }],
    ersterZug: false,
    kennt,
  });
  if (luecke.ok || !luecke.fehler.includes("Lücke")) throw new Error("Ein Zug mit Lücke wurde angenommen");

  const weitweg = werteZug({ brett: mitHaus, gelegt: reihe("EI", 0, 0, 0, 1), ersterZug: false, kennt });
  if (weitweg.ok || !weitweg.fehler.includes("anschließen")) {
    throw new Error("Ein Wort ohne Anschluss wurde angenommen");
  }

  const besetzt = werteZug({
    brett: mitHaus,
    gelegt: [{ r: MITTE, c: MITTE, b: "E", joker: false }],
    ersterZug: false,
    kennt,
  });
  if (besetzt.ok) throw new Error("Ein besetztes Feld wurde noch einmal belegt");
  console.log("ok  ums Eck, mit Lücke, ohne Anschluss und auf besetztem Feld: alles abgelehnt");
}

// Anbau an das S von HAUS: S-E-E senkrecht. E auf doppeltem Buchstaben (2),
// E frei (1), S zaehlt mit (1) – aber ohne seinen Bonus, der ist verbraucht.
{
  const w = werteZug({
    brett: mitHaus,
    gelegt: reihe("EE", MITTE + 1, MITTE + 2, 1, 0),
    ersterZug: false,
    kennt,
  });
  if (!w.ok) throw new Error("SEE wurde abgelehnt: " + w.fehler);
  if (w.woerter[0].wort !== "SEE") throw new Error("Erkanntes Wort ist " + w.woerter[0].wort);
  if (w.punkte !== 4) throw new Error(`SEE bringt ${w.punkte} statt 4`);
  console.log("ok  SEE hängt sich an das liegende S: 4 Punkte");
}

// IHM senkrecht durch das liegende H. Das H steht auf einem doppelten
// Buchstaben – der wurde beim Legen von HAUS verbraucht und zaehlt jetzt nicht
// mehr. Also 1 + 2 + 3 = 6, kein Faktor.
{
  const w = werteZug({
    brett: mitHaus,
    gelegt: [
      { r: MITTE - 1, c: MITTE - 1, b: "I", joker: false },
      { r: MITTE + 1, c: MITTE - 1, b: "M", joker: false },
    ],
    ersterZug: false,
    kennt,
  });
  if (!w.ok) throw new Error("IHM wurde abgelehnt: " + w.fehler);
  if (w.punkte !== 6) throw new Error(`IHM bringt ${w.punkte} statt 6 – zählt ein Bonus doppelt?`);
  console.log("ok  IHM über das liegende H: 6 Punkte – der verbrauchte Bonus zählt nicht noch einmal");
}

// Ein Zug, der quer ein Unwort erzeugt, muss auffliegen: das zweite Wort ist
// so wichtig wie das erste.
{
  const w = werteZug({
    brett: mitHaus,
    gelegt: reihe("EI", MITTE - 1, MITTE - 1, 0, 1),
    ersterZug: false,
    kennt,
  });
  if (w.ok) throw new Error("Ein Zug mit ungültigem Querwort wurde angenommen");
  console.log(`ok  Querwörter werden mitgeprüft (${w.fehler})`);
}

// Joker: traegt seinen Buchstaben, zaehlt aber nichts.
{
  const ohne = werteZug({ brett: leer, gelegt: reihe("HAUS", MITTE, MITTE - 1, 0, 1), ersterZug: true, kennt });
  const mit = werteZug({ brett: leer, gelegt: reihe("HAUS", MITTE, MITTE - 1, 0, 1, 0), ersterZug: true, kennt });
  if (!mit.ok) throw new Error("HAUS mit Joker wurde abgelehnt");
  // Das H stand auf einem doppelten Buchstaben und war 2 wert – mit Joker 0.
  if (ohne.punkte - mit.punkte !== 8) {
    throw new Error(`Der Joker kostet ${ohne.punkte - mit.punkte} Punkte, erwartet 8`);
  }
  console.log("ok  ein Joker zählt null, auch auf einem Bonusfeld");
}

// Alle sieben Steine: Zuschlag.
{
  const w = werteZug({
    brett: leer,
    gelegt: reihe("MEISTER", MITTE, MITTE - 3, 0, 1),
    ersterZug: true,
    kennt,
  });
  if (!w.ok) throw new Error("MEISTER wurde abgelehnt: " + w.fehler);
  if (!w.bingo) throw new Error("Sieben Steine wurden nicht als Bingo erkannt");
  const ohneBingo = w.woerter.reduce((s, x) => s + x.punkte, 0);
  if (w.punkte !== ohneBingo + BINGO) throw new Error("Der Zuschlag fehlt");
  console.log(`ok  MEISTER mit sieben Steinen: ${ohneBingo} + ${BINGO} Zuschlag = ${w.punkte}`);
}

// Reststeine am Ende.
if (regalWert(["J", "Ö", "E"]) !== 8 + 8 + 1) throw new Error("regalWert rechnet falsch");
console.log("ok  regalWert zählt die Reststeine zusammen");

// ═══════════════════════════════════════════════════════════════════════════
// Teil 2 – mit Server
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n── Partie gegen ${URL_WS} ──`);

const A = client("Anna");
const B = client("Ben");
const C = client("Cem");
const alleC = [A, B, C];
await Promise.all(alleC.map((c) => c.offen));

A.send({ t: "create", name: "Anna", isPublic: true, zeit: 240 });
await bis(() => A.room && A.regeln, "Raum angelegt");
const code = A.room.code;
console.log(`ok  Raum ${code} steht, Regeln kamen mit (${A.regeln.muster.length} Zeilen Muster)`);

if (A.regeln.werte.E !== WERT.E || A.regeln.mitte !== MITTE) {
  throw new Error("Die Regeln des Servers weichen von brett.js/steine.js ab");
}
console.log("ok  der Client bekommt genau die Tabellen aus brett.js und steine.js");

for (const c of [B, C]) c.send({ t: "join", code, name: c.name });
await bis(() => A.room.players.length === 3, "drei Spieler im Raum");

A.send({ t: "start" });
await warte(200);
if (A.room.phase !== "lobby") throw new Error("Die Partie startete, ohne dass alle bereit waren");
console.log("ok  ohne Bereitmeldung startet nichts");

for (const c of [B, C]) c.send({ t: "ready", value: true });
await bis(() => A.room.players.filter((p) => p.ready).length >= 2, "beide bereit");
A.send({ t: "start" });
await bis(() => alleC.every((c) => c.spiel), "alle sehen den Spielstand");
console.log("ok  Partie gestartet");

// Geheimhaltung: jeder sieht nur sein eigenes Regal.
{
  for (const c of alleC) {
    if (c.spiel.steine.length !== REGAL) {
      throw new Error(`${c.name} hat ${c.spiel.steine.length} Steine statt ${REGAL}`);
    }
    for (const m of c.spiel.mitspieler) {
      if (m.id !== c.you && "steine" in m && typeof m.steine !== "number") {
        throw new Error(`${c.name} sieht fremde Steine`);
      }
    }
  }
  const roh = JSON.stringify(A.spiel);
  if (roh.includes(JSON.stringify(B.spiel.steine))) {
    throw new Error("Annas Nachricht enthält Bens Regal");
  }
  const summeRegale = alleC.reduce((s, c) => s + c.spiel.steine.length, 0);
  if (A.spiel.beutel !== 86 - summeRegale) {
    throw new Error(`Beutel ${A.spiel.beutel}, aber ${summeRegale} Steine ausgeteilt`);
  }
  console.log(`ok  jeder sieht nur sein Regal, im Beutel liegen noch ${A.spiel.beutel} Steine`);
}

const vonId = (id) => alleC.find((c) => c.you === id);
const dran = () => vonId(A.spiel.amZug);
const nichtDran = () => alleC.find((c) => c.you !== A.spiel.amZug);

/**
 * Sucht mit derselben Logik, die der Server benutzt, einen gültigen Zug für
 * das Regal von `c`. Beim ersten Zug werden Wörter aus zwei und drei Steinen
 * durch den Stern probiert, danach genügt ein einzelner Stein am Rand des
 * schon Liegenden – das findet immer etwas, wenn es etwas zu finden gibt.
 */
function sucheZug(c) {
  const sp = c.spiel;
  const brett = brettAusText(sp.brett);
  const regal = sp.steine.filter((b) => b !== JOKER);

  if (sp.leer) {
    for (const laenge of [3, 2]) {
      for (const folge of folgen(regal, laenge)) {
        const wort = folge.join("");
        if (!kennt(wort)) continue;
        for (let versatz = 0; versatz < laenge; versatz++) {
          const gelegt = reihe(wort, MITTE, MITTE - versatz, 0, 1);
          if (werteZug({ brett, gelegt, ersterZug: true, kennt }).ok) return gelegt;
        }
      }
    }
    return null;
  }

  for (let r = 0; r < GROESSE; r++) {
    for (let c2 = 0; c2 < GROESSE; c2++) {
      if (brett[r][c2]) continue;
      for (const b of new Set(regal)) {
        const gelegt = [{ r, c: c2, b, joker: false }];
        if (werteZug({ brett, gelegt, ersterZug: false, kennt }).ok) return gelegt;
      }
    }
  }
  return null;
}

/** Alle geordneten Folgen der Länge n aus der Liste, ohne einen Stein doppelt. */
function folgen(liste, n) {
  if (n === 0) return [[]];
  const raus = [];
  for (let i = 0; i < liste.length; i++) {
    const rest = liste.slice(0, i).concat(liste.slice(i + 1));
    for (const f of folgen(rest, n - 1)) raus.push([liste[i], ...f]);
  }
  return raus;
}

// Rechte: wer nicht dran ist, legt nicht.
{
  const falsch = nichtDran();
  const vorher = falsch.spiel.zugNr;
  falsch.hinweise.length = 0;
  falsch.send({ t: "legen", steine: reihe("HAUS", MITTE, MITTE - 1, 0, 1) });
  falsch.send({ t: "passen" });
  await warte(250);
  if (falsch.spiel.zugNr !== vorher) throw new Error("Jemand konnte legen, ohne am Zug zu sein");
  if (!falsch.hinweise.some((h) => h.includes("nicht am Zug"))) {
    throw new Error("Der Server hat den Fremdzug stillschweigend geschluckt");
  }
  console.log("ok  wer nicht am Zug ist, kann weder legen noch passen");
}

// Schummeln: ein Stein, den man gar nicht hat.
{
  const d = dran();
  const fremd = BUCHSTABEN.find((b) => !d.spiel.steine.includes(b));
  d.hinweise.length = 0;
  d.send({ t: "legen", steine: reihe(fremd + fremd, MITTE, MITTE, 0, 1) });
  await warte(250);
  if (!d.hinweise.some((h) => h.includes("hast du nicht"))) {
    throw new Error("Ein Stein vom fremden Regal wurde angenommen: " + d.hinweise.join(" / "));
  }
  console.log(`ok  ein Stein, den man nicht hat (${fremd}), wird abgelehnt`);
}

// Unsinn: ein Wort aus eigenen Steinen, das es nicht gibt. Die Steine müssen
// wirklich auf dem Regal liegen, sonst greift der Riegel von oben und die
// Wortliste kommt gar nicht erst dran.
{
  const d = dran();
  const eigene = d.spiel.steine.filter((b) => b !== JOKER);
  let unwort = null;
  for (let i = 0; i < eigene.length && !unwort; i++) {
    for (let j = 0; j < eigene.length; j++) {
      if (i === j) continue;
      if (!kennt(eigene[i] + eigene[j])) { unwort = eigene[i] + eigene[j]; break; }
    }
  }
  if (!unwort) throw new Error("Aus diesem Regal ergibt jedes Paar ein Wort – unwahrscheinlich");
  d.hinweise.length = 0;
  d.send({ t: "legen", steine: reihe(unwort, MITTE, MITTE, 0, 1) });
  await warte(250);
  if (!d.hinweise.some((h) => h.includes("Wortliste"))) {
    throw new Error(`„${unwort}“ wurde nicht wegen der Wortliste abgelehnt: ` + d.hinweise.join(" / "));
  }
  console.log(`ok  Unsinn aus eigenen Steinen wird abgelehnt: „${d.hinweise[0]}“`);
}

// Der erste echte Zug. Findet die Suche nichts, wird getauscht – auch das ist
// ein Zug, den es zu pruefen gilt.
let gelegteWoerter = 0;
for (let versuch = 0; versuch < 12 && gelegteWoerter < 3; versuch++) {
  const d = dran();
  if (!d) throw new Error("Niemand ist am Zug");
  const vorherZug = d.spiel.zugNr;
  const zug = sucheZug(d);

  if (zug) {
    const vorherPunkte = d.spiel.mitspieler.find((p) => p.id === d.you).punkte;
    const beutelVorher = d.spiel.beutel;
    d.send({ t: "legen", steine: zug });
    await bis(() => d.spiel.zugNr === vorherZug + 1, "der Zug kommt durch");
    const nachher = d.spiel.mitspieler.find((p) => p.id === d.you);
    const wort = d.spiel.letzter.woerter.map((w) => w.wort).join("+");
    if (nachher.punkte <= vorherPunkte) throw new Error("Ein gelegtes Wort brachte keine Punkte");
    if (beutelVorher > 0 && d.spiel.steine.length !== REGAL) {
      throw new Error(`Nach dem Zug nur ${d.spiel.steine.length} Steine – es wurde nicht nachgezogen`);
    }
    for (const c of alleC) {
      if (c.spiel.brett !== d.spiel.brett) throw new Error("Nicht alle sehen dasselbe Brett");
    }
    gelegteWoerter++;
    console.log(`ok  ${d.name} legt ${wort} für ${d.spiel.letzter.punkte} – alle sehen dasselbe Brett`);
  } else {
    const alt = d.spiel.steine.join("");
    d.send({ t: "tauschen", indizes: [0, 1] });
    await bis(() => d.spiel.amZug !== d.you, "nach dem Tausch ist der Nächste dran");
    if (d.spiel.steine.join("") === alt) throw new Error("Beim Tauschen änderte sich nichts");
    console.log(`ok  ${d.name} findet nichts und tauscht (${alt} → ${d.spiel.steine.join("")})`);
  }
}
if (gelegteWoerter === 0) throw new Error("In zwölf Zügen kam kein einziges Wort zustande");
console.log(`ok  ${gelegteWoerter} Wörter liegen auf dem Brett`);

// Passen bringt den Nächsten dran.
{
  const d = dran();
  const naechster = d.spiel.amZug;
  d.send({ t: "passen" });
  await bis(() => A.spiel.amZug !== naechster, "nach dem Passen ist der Nächste dran");
  if (A.spiel.letzter.art !== "gepasst") throw new Error("Das Passen steht nicht im Verlauf");
  console.log("ok  Passen gibt weiter und steht für alle im Verlauf");
}

// Wer die Verbindung verliert, wird uebersprungen. Anna bleibt verschont: sie
// ist der Host, und ohne sie sähe die Probe den Rest der Partie nicht mehr.
{
  for (let i = 0; i < 4 && A.spiel.amZug === A.you; i++) {
    A.send({ t: "passen" });
    await bis(() => A.spiel.amZug !== A.you, "Anna gibt weiter");
  }
  const weg = dran();
  if (!weg || weg === A) throw new Error("Kein Gast am Zug, den man ausfallen lassen könnte");
  const rest = alleC.filter((c) => c !== weg);
  weg.ws.close();
  await bis(() => rest.every((c) => c.spiel.amZug !== weg.you), "der Abwesende wird übersprungen", 9000);
  const eintrag = rest[0].spiel.mitspieler.find((p) => p.id === weg.you);
  if (eintrag.da) throw new Error("Der Abwesende gilt noch als anwesend");
  console.log(`ok  ${weg.name} fällt aus und wird übersprungen, der Platz bleibt stehen`);
  alleC.splice(alleC.indexOf(weg), 1);
}

// Bedenkzeit. Bis hierher hat immer jemand etwas gedrückt – geprüft ist damit
// nie, ob die Uhr wirklich abläuft.
{
  console.log("… Bedenkzeit auf 1 min – der nächste Abschnitt wartet sie ab");
  A.send({ t: "settings", zeit: 60 });
  await bis(() => A.room.settings.zeit === 60, "der Host stellt die Uhr mitten in der Partie um");

  // Die neue Zeit greift erst beim nächsten Zug – wer schon überlegt, behält
  // seine. Also einmal weitergeben und dann nachsehen.
  const vorher = A.spiel.amZug;
  const alteFrist = A.spiel.endet - A.spiel.jetzt;
  if (Math.abs(alteFrist - 240_000) > 1500) {
    throw new Error(`Der laufende Zug hat plötzlich ${alteFrist} ms statt der alten 240 s`);
  }
  vonId(vorher).send({ t: "passen" });
  await bis(() => A.spiel.amZug !== vorher, "weiter zum nächsten Zug");

  const geplant = A.spiel.endet - A.spiel.jetzt;
  if (Math.abs(geplant - 60_000) > 1500) {
    throw new Error(`Die Bedenkzeit ist nicht 60 s, sondern ${geplant} ms`);
  }
  console.log(`ok  die Uhr steht auf ${Math.round(geplant / 1000)} s`);

  const wer = A.spiel.amZug;
  await bis(() => A.spiel.amZug !== wer || A.final, "die Bedenkzeit läuft von allein ab", 70_000);
  if (!A.final && A.spiel.letzter?.art !== "zeit") {
    throw new Error("Die Zeit lief ab, aber der Verlauf sagt: " + A.spiel.letzter?.art);
  }
  console.log("ok  abgelaufene Bedenkzeit passt von allein weiter");
}

// Aussitzen beendet die Partie.
if (!A.final) {
  console.log("… jetzt passen alle, bis die Partie von selbst endet");
  for (let i = 0; i < 12 && !A.final; i++) {
    const d = vonId(A.spiel.amZug);
    if (!d) break;
    d.send({ t: "passen" });
    await warte(150);
  }
  await bis(() => A.final, "die Partie endet nach lauter punktlosen Zügen", 8000);
  if (A.final.grund !== "ausgesessen") throw new Error("Grund ist " + A.final.grund);
}
console.log(`ok  Partie zu Ende (${A.final.grund}), ${A.final.tabelle.length} Spieler in der Tabelle`);

// Abrechnung: die Reststeine sind abgezogen.
{
  const mitRest = A.final.tabelle.filter((p) => p.rest > 0);
  if (A.final.grund === "ausgesessen" && !mitRest.length) {
    throw new Error("Niemand hat Reststeine abgezogen bekommen");
  }
  for (const p of A.final.tabelle) console.log(`     ${p.name}: ${p.punkte} (−${p.rest} Rest)`);
  const sortiert = A.final.tabelle.every((p, i, l) => i === 0 || l[i - 1].punkte >= p.punkte);
  if (!sortiert) throw new Error("Die Tabelle ist nicht sortiert");
  console.log("ok  Reststeine abgezogen, Tabelle sortiert");
}

if (alleC.some((c) => c.fehler.length)) {
  throw new Error("Fehlermeldungen: " + JSON.stringify(alleC.map((c) => c.fehler)));
}
console.log("\nALLES GRÜN");
Deno.exit(0);
