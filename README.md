# Wortleger

Buchstabensteine mit Werten auf ein 13×13-Brett mit Bonusfeldern. Reihum legt
einer ein Wort, alle anderen schauen zu und überlegen mit.

Läuft unter <https://inf-zeus.de/wortleger/>, 2 bis 4 Leute, jeder mit eigenem
Gerät. Kein Download, kein Account: Raum aufmachen, Code weitergeben.

Der Name ist eigen, das Brettmuster ist eigen, die Buchstabenverteilung ist
eigen. Regeln eines Legespiels sind frei; Name, Feldmuster und Zahlentabelle
eines bestimmten Spiels sind es nicht.

## Regeln

- Jeder hat **sieben Steine**, die nur er sieht. Nachgezogen wird nach jedem
  Zug, solange der Beutel etwas hergibt.
- Das **erste Wort** muss durch den Stern in der Mitte. Danach muss jedes neue
  Wort an etwas anschließen, das schon liegt.
- Ein Zug legt Steine **in einer Reihe oder einer Spalte**, ohne Lücke. Alles,
  was dabei entsteht – auch quer –, muss ein Wort sein.
- **Bonusfelder zählen nur in dem Zug, in dem sie belegt werden.** Ein Stein
  auf einem doppelten Wortfeld verdoppelt sowohl das Wort in der Reihe als auch
  das in der Spalte.
- Alle sieben Steine in einem Zug: **40 Punkte Zuschlag**.
- Statt zu legen kann man **tauschen** oder **passen**. Zwei volle Runden ohne
  ein einziges Wort beenden die Partie.
- Wer sein Regal leer bekommt, wenn der Beutel leer ist, bekommt obendrauf, was
  die anderen noch halten; alle anderen ziehen ihre Reststeine ab.

Bedenkzeit je Zug: 1, 2 oder 4 Minuten – oder keine. Läuft sie ab, passt der
Server für die Person. Der Host darf sie **mitten in der Partie** ändern; genau
dann merkt man ja, dass sie zu lang ist. Sie greift erst beim nächsten Zug.

## Die Wortliste

`woerter.txt`, **488 344 Wörter**, 5,4 MB. Herkunft: [`enz/german-wordlist`],
gepflegt für das freie Wortspiel Tanglet, nach Legespiel-Regeln geführt (keine
Eigennamen, keine Abkürzungen) und unter **CC0 1.0** veröffentlicht, also
gemeinfrei.

[`enz/german-wordlist`]: https://github.com/enz/german-wordlist

Die Lizenz war das Auswahlkriterium, nicht die Größe. Bei den naheliegenden
Alternativen steht entweder Copyleft drauf (igerman98 ist GPL – deshalb darf
Firefox es nicht mitliefern) oder eine MIT-Angabe über Material, das aus
Wiktionary stammt und CC-BY-SA ist.

Aufbereitet wurde sie einmalig aus 685 789 Rohzeilen:

| Schritt | weg |
|---|---|
| ß → SS, alles groß | – |
| länger als 13 Zeichen | 163 384 – so breit ist das Brett |
| enthält Q, X oder Y | 24 866 – dafür gibt es keinen Stein |
| Doppelte nach der Umwandlung | 9 195 |

Damit gilt: **jedes Wort in der Datei ist auch wirklich legbar.** `probe.js`
liest die ganze Liste durch und prüft das nach – sie und `steine.js` dürfen
nicht auseinanderlaufen.

### Warum kein `Set`

Gemessen auf diesem Server, gleiche Datei, gleicher Deno:

| Verfahren | Start | RSS |
|---|---|---|
| `new Set(text.split("\n"))` | 291 ms | 128 MB |
| Bytepuffer + binäre Suche | **19 ms** | **62 MB** |

Der laufende Dienst braucht damit **25 MB** gegenüber 17 MB bei den Spielen
ohne Wortliste (`systemctl show wortleger -p MemoryCurrent`). Auf einer Kiste,
die neben elf Spielen auch Nextcloud und zwei Bots trägt, ist der Unterschied
zum `Set` je Neustart deutlich – und `Restart=always` startet öfter, als man
denkt. `woerter.js` behält deshalb die rohe UTF-8-Datei als `Uint8Array` und
legt nur eine `Uint32Array` mit den Zeilenanfängen daneben. Eine Abfrage kostet
gemessene 1,1 Mikrosekunden.

## Die Steine

84 Buchstaben und 2 Joker, zusammen 165 Punkte – 1,96 je Stein. Drei
Entscheidungen, die nicht auf der Hand liegen:

- **Kein ß.** In Großbuchstaben schreibt man STRASSE. Ein ß-Stein wäre ein
  Stein, mit dem sich kein einziges Wort der Liste legen lässt.
- **Kein Q, X, Y.** Zusammen keine 0,1 % im Deutschen. Auf 13×13 mit sieben
  Steinen blockiert so ein Stein ein Regal die halbe Partie, statt Punkte zu
  bringen. Wer sie vermisst, nimmt den Joker.
- **Der Wert richtet sich danach, wie leicht ein Buchstabe unterzubringen ist**,
  nicht allein danach, wie oft er vorkommt. H zählt nur 2, obwohl es viermal im
  Beutel liegt: es passt fast überall hinein.

## Das Brett

Vier dreifache Wörter, und zwar **in der Mitte jeder Kante, nicht in den
Ecken** – wer sie will, muss sich vom Zentrum bis an den Rand vorarbeiten. Die
Ecken sind doppelte Wörter, die Diagonale dazwischen ist bewusst leer, damit
kein Wort zwei davon auf einmal trifft. Um den Stern liegt ein Kranz aus vier
doppelten Buchstaben; die dreifachen liegen drei Felder weiter außen.

Das Muster ist punkt- **und** spiegelsymmetrisch zur Diagonale: waagerecht zu
legen bringt genau so viel wie senkrecht. `probe.js` rechnet das nach, Feld für
Feld, statt es zu glauben.

## Aufbau

```
server.js          Zugreihenfolge, Bedenkzeit, handle()   (~430 Zeilen)
brett.js           Muster und Bonusfelder – 13 Zeichenketten
steine.js          Verteilung, Werte, Beutel
woerter.js         Wortliste laden und nachschlagen
woerter.txt        die Liste selbst (CC0)
zug.js             Zug prüfen und werten – kennt weder Raum noch Spieler
probe.js           Regeln offline + eine Partie mit drei Verbindungen
public/            index.html, style.css, app.js
bremse.js  raum.js  statisch.js   ← Kopien aus /var/www/html/gemeinsam/,
                                    nicht hier ändern
```

**`zug.js` steht bewusst allein.** Es bekommt ein Brett, eine Handvoll Steine
und die Wortliste und sagt, was das wert ist – ohne Räume, Spieler oder
Verbindungen. Dadurch kann `probe.js` jede Regel einzeln durchrechnen, ohne
einen Server zu starten, und das Screenshot-Rezept in `werkzeug/aufnehmen.mjs`
kann damit einen gültigen Zug suchen, statt die Regeln ein zweites Mal
nachzubauen.

Wer welche Steine besitzt, prüft dagegen `server.js` – dort und nur dort. Die
Oberfläche bietet nur eigene Steine an, aber ein umgebauter Client könnte
alles schicken. `probe.js` greift genau das an.

**Der Client kennt weder das Brettmuster noch die Steinwerte.** Beides kommt
beim Verbinden als `regeln`-Nachricht vom Server, 430 Byte, einmal. Sonst läge
dieselbe Tabelle zweimal herum, und wenn ein Ö irgendwann 7 statt 8 zählt,
fiele die zweite Fassung erst auf, wenn sich jemand über seine Punkte wundert.

Das Brett geht als **eine Zeichenkette von 169 Zeichen** über die Leitung:
`.` leer, Großbuchstabe = Stein, Kleinbuchstabe = Joker in dieser Rolle.

## Entwickeln

```bash
DENO_DIR=/tmp/deno-check deno task check
DENO_DIR=/tmp/deno-check PORT=8171 HOST=127.0.0.1 deno task dev

# in einer zweiten Sitzung
WS_URL=ws://127.0.0.1:8171/ws deno task probe
# oder gegen die Live-Fassung
WS_URL=wss://inf-zeus.de/wortleger/ws deno task probe
```

Die Probe braucht gut eine Minute. Der lange Teil am Ende ist Absicht: sie
wartet eine volle Bedenkzeit ab, um nachzuweisen, dass die Uhr tatsächlich
abläuft und nicht nur schön aussieht.

Weil die Steine zufällig sind, kann die Probe keinen bestimmten Zug ansagen –
sie sucht sich mit derselben `zug.js`, die der Server benutzt, einen gültigen.
Genau das ist der Punkt: was die gemeinsame Logik erlaubt, muss der Server
annehmen, und was sie verbietet, muss er ablehnen.

Dazu der Browserlauf. Er prüft, was die serverseitige Probe nicht sehen kann –
und zwar **auf Handygröße**, denn 13 Spalten nebeneinander sind die
Belastungsprobe dieses Spiels:

```bash
cd /root/werkzeug-screenshots && node pruefe-wortleger.mjs
```

Auf 390 px bleiben je Feld 26 px, der Buchstabe misst 16,7 px, die Bonuszahl
9,8 px und ein Regalstein 44,8 px. Die Werte stehen als Untergrenzen im Skript.

Betrieb: `systemctl status wortleger`, Port 8070, Apache-Regel in
`/etc/apache2/conf-available/wortleger.conf`.
