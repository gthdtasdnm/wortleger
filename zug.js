// Einen Zug pruefen und werten.
//
// Diese Datei kennt keine Raeume, keine Spieler und keine Verbindungen – sie
// bekommt ein Brett, eine Handvoll gelegter Steine und die Wortliste und sagt,
// was das wert ist. Genau deshalb steht sie allein: `probe.js` kann jede Regel
// einzeln durchrechnen, ohne einen Server zu starten.
//
// Wer welche Steine besitzt, prueft der Server – hier waere es nicht zu
// pruefen, weil das Regal gar nicht hereingereicht wird.

import {
  aufDemBrett,
  bonusAn,
  buchstabenFaktor,
  GROESSE,
  MITTE,
  wortFaktor,
} from "./brett.js";
import { BINGO, JOKER, REGAL, WERT } from "./steine.js";

/** Erlaubte Buchstaben auf dem Brett. Der Joker wird beim Legen zu einem davon. */
const BUCHSTABE = /^[A-ZÄÖÜ]$/;

/**
 * @typedef {{b: string, joker: boolean}} Stein
 * @typedef {{r: number, c: number, b: string, joker: boolean}} Gelegt
 * @typedef {{wort: string, punkte: number, felder: [number, number][]}} Wort
 */

/**
 * Prueft und wertet einen Zug.
 *
 * @param {object} o
 * @param {(Stein|null)[][]} o.brett      Stand *vor* dem Zug
 * @param {Gelegt[]} o.gelegt             neu gelegte Steine
 * @param {boolean} o.ersterZug           ist das Brett noch leer?
 * @param {(w: string) => boolean} o.kennt
 * @returns {{ok: false, fehler: string} |
 *           {ok: true, woerter: Wort[], punkte: number, bingo: boolean}}
 */
export function werteZug({ brett, gelegt, ersterZug, kennt }) {
  if (!Array.isArray(gelegt) || gelegt.length === 0) {
    return { ok: false, fehler: "Du hast noch keinen Stein gelegt." };
  }
  if (gelegt.length > REGAL) {
    return { ok: false, fehler: `Mehr als ${REGAL} Steine hat niemand.` };
  }

  // -- 1. Jeder einzelne Stein muss legbar sein ------------------------------
  const belegt = new Set();
  for (const s of gelegt) {
    if (!aufDemBrett(s.r, s.c)) {
      return { ok: false, fehler: "Ein Stein liegt neben dem Brett." };
    }
    if (typeof s.b !== "string" || !BUCHSTABE.test(s.b)) {
      return { ok: false, fehler: "Ein Stein trägt keinen gültigen Buchstaben." };
    }
    const schluessel = s.r * GROESSE + s.c;
    if (belegt.has(schluessel)) {
      return { ok: false, fehler: "Zwei Steine auf demselben Feld." };
    }
    belegt.add(schluessel);
    if (brett[s.r][s.c]) {
      return { ok: false, fehler: "Da liegt schon ein Stein." };
    }
  }

  // -- 2. Alles in einer Reihe oder einer Spalte -----------------------------
  const eineZeile = gelegt.every((s) => s.r === gelegt[0].r);
  const eineSpalte = gelegt.every((s) => s.c === gelegt[0].c);
  if (!eineZeile && !eineSpalte) {
    return { ok: false, fehler: "Ein Wort läuft in einer Reihe, nicht ums Eck." };
  }

  // Arbeitsbrett: der Stand, wie er nach dem Zug aussaehe.
  const nachher = brett.map((zeile) => zeile.slice());
  for (const s of gelegt) nachher[s.r][s.c] = { b: s.b, joker: !!s.joker };

  // -- 3. Keine Luecke zwischen den gelegten Steinen -------------------------
  // Zwischenraeume duerfen mit Steinen gefuellt sein, die schon lagen – aber
  // leer bleiben duerfen sie nicht.
  if (eineZeile) {
    const r = gelegt[0].r;
    const von = Math.min(...gelegt.map((s) => s.c));
    const bis = Math.max(...gelegt.map((s) => s.c));
    for (let c = von; c <= bis; c++) {
      if (!nachher[r][c]) return { ok: false, fehler: "Zwischen den Steinen bleibt eine Lücke." };
    }
  }
  if (eineSpalte) {
    const c = gelegt[0].c;
    const von = Math.min(...gelegt.map((s) => s.r));
    const bis = Math.max(...gelegt.map((s) => s.r));
    for (let r = von; r <= bis; r++) {
      if (!nachher[r][c]) return { ok: false, fehler: "Zwischen den Steinen bleibt eine Lücke." };
    }
  }

  // -- 4. Anschluss ----------------------------------------------------------
  if (ersterZug) {
    if (!gelegt.some((s) => s.r === MITTE && s.c === MITTE)) {
      return { ok: false, fehler: "Das erste Wort muss durch den Stern in der Mitte." };
    }
    if (gelegt.length < 2) {
      return { ok: false, fehler: "Ein einzelner Buchstabe ist noch kein Wort." };
    }
  } else {
    const beruehrt = gelegt.some(({ r, c }) =>
      [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]
        .some(([nr, nc]) => aufDemBrett(nr, nc) && brett[nr][nc])
    );
    if (!beruehrt) {
      return { ok: false, fehler: "Dein Wort muss an einen liegenden Stein anschließen." };
    }
  }

  // -- 5. Welche Woerter entstehen? -----------------------------------------
  // Fuer jeden gelegten Stein die laengste ununterbrochene Kette waagerecht und
  // senkrecht. Ketten aus einem einzigen Buchstaben zaehlen nicht. Ueber den
  // Anfang der Kette werden Doppelte aussortiert – bei einem waagerechten Zug
  // liefern alle Steine dieselbe waagerechte Kette.
  const neu = new Set(belegt);
  const woerter = [];
  const gesehen = new Set();

  for (const s of gelegt) {
    for (const [dr, dc] of [[0, 1], [1, 0]]) {
      let r = s.r;
      let c = s.c;
      while (aufDemBrett(r - dr, c - dc) && nachher[r - dr][c - dc]) {
        r -= dr;
        c -= dc;
      }
      const marke = `${r},${c},${dr}`;
      if (gesehen.has(marke)) continue;
      gesehen.add(marke);

      const felder = [];
      let wort = "";
      while (aufDemBrett(r, c) && nachher[r][c]) {
        felder.push([r, c]);
        wort += nachher[r][c].b;
        r += dr;
        c += dc;
      }
      if (wort.length < 2) continue;
      woerter.push({ wort, felder });
    }
  }

  if (woerter.length === 0) {
    return { ok: false, fehler: "Daraus wird kein Wort." };
  }

  // -- 6. Steht jedes davon in der Liste? ------------------------------------
  for (const w of woerter) {
    if (!kennt(w.wort)) {
      return { ok: false, fehler: `„${w.wort}“ steht nicht in der Wortliste.` };
    }
  }

  // -- 7. Punkte -------------------------------------------------------------
  // Boni zaehlen nur unter *neu* gelegten Steinen, und dort fuer jedes Wort,
  // das ueber das Feld laeuft. Ein Stein auf einem doppelten Wortfeld
  // verdoppelt also sowohl das Wort in der Reihe als auch das in der Spalte.
  let punkte = 0;
  const fertig = [];
  for (const { wort, felder } of woerter) {
    let summe = 0;
    let faktor = 1;
    for (const [r, c] of felder) {
      const stein = nachher[r][c];
      const wertDesSteins = stein.joker ? 0 : (WERT[stein.b] ?? 0);
      const zeichen = bonusAn(r, c);
      if (neu.has(r * GROESSE + c)) {
        summe += wertDesSteins * buchstabenFaktor(zeichen);
        faktor *= wortFaktor(zeichen);
      } else {
        summe += wertDesSteins;
      }
    }
    const wertung = summe * faktor;
    punkte += wertung;
    fertig.push({ wort, punkte: wertung, felder });
  }

  const bingo = gelegt.length === REGAL;
  if (bingo) punkte += BINGO;

  return { ok: true, woerter: fertig, punkte, bingo };
}

/**
 * Ein Brett als Zeichenkette: ein Zeichen je Feld, zeilenweise.
 * `.` leer, Grossbuchstabe = Stein, Kleinbuchstabe = Joker in dieser Rolle.
 *
 * 169 Zeichen statt 169 Objekte – das ist der Unterschied zwischen 400 Byte und
 * ein paar Kilobyte je Zug, und der Client liest daraus direkt sein Raster.
 */
export function brettAlsText(brett) {
  let s = "";
  for (let r = 0; r < GROESSE; r++) {
    for (let c = 0; c < GROESSE; c++) {
      const stein = brett[r][c];
      s += !stein ? "." : stein.joker ? stein.b.toLowerCase() : stein.b;
    }
  }
  return s;
}

/** Gegenstueck zu `brettAlsText` – nur die Probe braucht es. */
export function brettAusText(text) {
  const brett = [];
  for (let r = 0; r < GROESSE; r++) {
    const zeile = [];
    for (let c = 0; c < GROESSE; c++) {
      const z = text[r * GROESSE + c];
      if (z === "." || z === undefined) zeile.push(null);
      else {
        const gross = z.toUpperCase();
        zeile.push({ b: gross, joker: z !== gross });
      }
    }
    brett.push(zeile);
  }
  return brett;
}

export { JOKER };
