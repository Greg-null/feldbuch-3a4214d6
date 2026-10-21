import {
  distanzM, peilungGrad, relativGrad, zerlegen, himmelsrichtung,
  zuPixel, mittelwert, formatMeter, anweisung
} from "./geo.js";

const $ = id => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const AAD = new TextEncoder().encode("grenzpunkte-v1");
const K = { schluessel: "grenzpunkte-schluessel", status: "grenzpunkte-status", ton: "grenzpunkte-ton" };
const ANKUNFT_M = 2;
const KURZ = { Norden: "N", Nordosten: "NO", Osten: "O", Südosten: "SO", Süden: "S", Südwesten: "SW", Westen: "W", Nordwesten: "NW" };
const lies = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const schreib = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const params = new URLSearchParams(location.search);
const sim = params.get("sim");

let D = null, mpp = 1;
let fixes = [], pos = null, gpsFehler = null;
let blick = null, blickVek = null, kompass = "aus";
let zielIdx = null, ansicht = "start";
let status = lies(K.status, {});
let ton = lies(K.ton, true);
let audio = null, warDa = false, wake = null, geplant = false;
const karte = { s: 1, tx: 0, ty: 0 };

const b64url = s => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
};
const schluesselAus = t => { const s = (t || "").trim(); const i = s.indexOf("#"); return (i >= 0 ? s.slice(i + 1) : s).trim(); };
const ll = p => [p.lat, p.lon];

async function datenLaden(schl) {
  let roh;
  try { roh = new Uint8Array(await (await fetch("daten.bin")).arrayBuffer()); }
  catch { throw new Error("netz"); }
  const key = await crypto.subtle.importKey("raw", b64url(schl), "AES-GCM", false, ["decrypt"]);
  const klar = await crypto.subtle.decrypt({ name: "AES-GCM", iv: roh.slice(0, 12), additionalData: AAD }, key, roh.slice(12));
  return JSON.parse(new TextDecoder().decode(klar));
}

function schluesselFeld(meldung) {
  $("schluessel-feld").hidden = false;
  $("los").hidden = true;
  $("start-meldung").textContent = meldung || "Diese App braucht einmal den vollständigen Link mit Schlüssel.";
}

async function init() {
  if ("serviceWorker" in navigator && !sim) navigator.serviceWorker.register("sw.js").catch(() => {});
  const schl = schluesselAus(location.hash) || lies(K.schluessel, "");
  if (!schl) return schluesselFeld();
  try {
    D = await datenLaden(schl);
  } catch (e) {
    return schluesselFeld(e.message === "netz"
      ? "Die Daten sind noch nicht auf dem iPhone gespeichert. Bitte einmal mit Netz öffnen."
      : "Der Schlüssel passt nicht. Bitte den vollständigen Link einfügen.");
  }
  schreib(K.schluessel, schl);
  vorbereiten();
}

$("schluessel-ok").addEventListener("click", () => {
  const s = schluesselAus($("schluessel").value);
  if (!s) return;
  history.replaceState(null, "", location.pathname + location.search + "#" + s);
  $("schluessel-feld").hidden = true; $("los").hidden = false;
  $("start-meldung").textContent = "";
  init();
});

function vorbereiten() {
  $("titel").textContent = D.titel;
  $("ort").textContent = `${D.ort} · ${D.punkte.length} Grenzpunkte`;
  const b = D.bild;
  mpp = distanzM([b.nord, b.west], [b.nord, b.ost]) / b.w;
  const img = $("luftbild");
  img.width = b.w; img.height = b.h;
  img.src = "data:image/jpeg;base64," + b.jpeg;
  const svg = $("overlay");
  svg.setAttribute("viewBox", `0 0 ${b.w} ${b.h}`);
  svg.setAttribute("width", b.w); svg.setAttribute("height", b.h);
  $("los").disabled = false;
  $("los").textContent = "Los geht's";
  if (sim) losGehts();
}

$("los").addEventListener("click", losGehts);

async function losGehts() {
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}
  try { const AC = window.AudioContext || window.webkitAudioContext; if (AC && !audio) audio = new AC(); audio?.resume?.(); } catch {}
  await kompassStarten();
  gpsStarten();
  wachHalten();
  zeige(params.get("ansicht") === "fuehren" && params.get("ziel") ? "fuehren" : "karte");
  const z = params.get("ziel");
  if (z) { const i = D.punkte.findIndex(p => p.kurz === z); if (i >= 0) waehle(i, params.get("ansicht") === "fuehren"); }
  karteEinpassen();
  setInterval(planen, 1000);
  planen();
}

async function kompassStarten() {
  if (sim) {
    const h = Number(sim.split(",")[2]);
    if (!Number.isNaN(h)) { kompass = "an"; setzeBlick(h); }
    return;
  }
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== "granted") { kompass = "verweigert"; return; }
    }
  } catch { kompass = "verweigert"; return; }
  kompass = "wartet";
  const onO = e => {
    let h = null;
    if (typeof e.webkitCompassHeading === "number" && !Number.isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === "number") h = 360 - e.alpha;
    if (h !== null) { kompass = "an"; setzeBlick(h); }
  };
  window.addEventListener("deviceorientation", onO, true);
  window.addEventListener("deviceorientationabsolute", onO, true);
  setTimeout(() => { if (kompass === "wartet") { kompass = "fehlt"; planen(); } }, 4000);
}

function setzeBlick(h) {
  const r = h * Math.PI / 180, x = Math.sin(r), y = Math.cos(r);
  if (!blickVek) blickVek = { x, y };
  else { blickVek.x += 0.25 * (x - blickVek.x); blickVek.y += 0.25 * (y - blickVek.y); }
  blick = (Math.atan2(blickVek.x, blickVek.y) * 180 / Math.PI + 360) % 360;
  planen();
}

function gpsStarten() {
  if (sim) {
    const [lat, lon, , acc] = sim.split(",").map(Number);
    const fix = () => neuerFix({ lat, lon, acc: acc || 3, t: Date.now() });
    fix(); setInterval(fix, 1000);
    return;
  }
  if (!navigator.geolocation) { gpsFehler = "Dieses Gerät liefert keinen Standort."; return; }
  navigator.geolocation.watchPosition(
    p => neuerFix({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() }),
    e => {
      gpsFehler = e.code === 1
        ? "Standort nicht erlaubt. Einstellungen › Datenschutz › Ortungsdienste: für Safari „Beim Verwenden“ und „Genauer Standort“ einschalten."
        : "Noch kein GPS-Signal. Unter freiem Himmel kurz warten.";
      planen();
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

function neuerFix(f) {
  const jetzt = Date.now();
  fixes.push(f);
  fixes = fixes.filter(x => jetzt - x.t < 30000);
  const m20 = mittelwert(fixes, jetzt, 20000);
  const juengst = fixes.filter(x => jetzt - x.t <= 20000);
  const ruhig = m20 && juengst.length >= 4 && juengst.every(x => distanzM(ll(x), ll(m20)) < Math.max(3, m20.acc));
  const aktuell = mittelwert(fixes, jetzt, 4000) || { lat: f.lat, lon: f.lon, acc: f.acc, anzahl: 1 };
  pos = ruhig ? { ...m20, ruhig: true, t: f.t } : { ...aktuell, ruhig: false, t: f.t };
  gpsFehler = null;
  planen();
}

async function wachHalten() {
  try { if ("wakeLock" in navigator && document.visibilityState === "visible") wake = await navigator.wakeLock.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && ansicht !== "start") { wachHalten(); audio?.resume?.(); } });
document.addEventListener("pointerdown", () => { audio?.resume?.(); }, { passive: true });

function zeige(a) {
  ansicht = a;
  $("start").hidden = a !== "start";
  $("haupt").hidden = a !== "karte";
  $("fuehren").hidden = a !== "fuehren";
  if (a === "karte" && karte.s === 1 && karte.tx === 0) requestAnimationFrame(karteEinpassen);
  planen();
}

function waehle(i, fuehren) {
  zielIdx = i; warDa = false;
  if (fuehren) zeige("fuehren");
  planen();
}

function planen() {
  if (geplant) return;
  geplant = true;
  requestAnimationFrame(() => { geplant = false; zeichnen(); });
}

function zeichnen() {
  if (!D) return;
  zeichneChips();
  if (ansicht === "karte") { zeichneKarte(); zeichneZielPanel(); }
  if (ansicht === "fuehren") zeichneFuehren();
  if (!$("liste").hidden) listeAktualisieren();
}

function zeichneChips() {
  const g = $("gps-chip"), k = $("kompass-chip");
  if (gpsFehler && !pos) { g.textContent = "GPS fehlt"; g.className = "chip warn"; }
  else if (!pos) { g.textContent = "GPS sucht …"; g.className = "chip"; }
  else if (veraltetS() > 10) { g.textContent = `GPS weg (${veraltetS()} s)`; g.className = "chip warn"; }
  else { g.textContent = `GPS ±${Math.round(pos.acc)} m`; g.className = pos.acc <= 8 ? "chip gut" : "chip warn"; }
  const kt = { an: ["Kompass an", "chip gut"], wartet: ["Kompass …", "chip"], fehlt: ["ohne Kompass", "chip warn"], verweigert: ["Kompass aus", "chip warn"], aus: ["Kompass aus", "chip"] }[kompass];
  k.textContent = kt[0]; k.className = kt[1];
}

const pz = p => zuPixel(ll(p), D.bild);
const veraltetS = () => (pos ? Math.round((Date.now() - pos.t) / 1000) : 0);

function zeichneKarte() {
  const s = karte.s, svg = $("overlay");
  const pts = D.punkte.map(pz);
  const mitte = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
  let h = `<polygon points="${pts.map(p => `${p.x},${p.y}`).join(" ")}" fill="rgba(255,212,0,.13)" stroke="#111" stroke-width="${7 / s}" stroke-linejoin="round"/>`;
  h += `<polygon points="${pts.map(p => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="#ffd400" stroke-width="${3.5 / s}" stroke-linejoin="round"/>`;
  if (pos && zielIdx !== null) {
    const a = pz(pos), b = pts[zielIdx];
    h += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#fff" stroke-width="${3 / s}" stroke-dasharray="${8 / s} ${6 / s}"/>`;
  }
  D.punkte.forEach((p, i) => {
    const { x, y } = pts[i];
    const erl = status[p.kurz];
    const r = (p.art === "stein" ? 10 : 7) / s;
    if (i === zielIdx) h += `<circle cx="${x}" cy="${y}" r="${22 / s}" fill="none" stroke="#0a5cff" stroke-width="${5 / s}"/>`;
    const fill = erl ? "#13803a" : p.art === "stein" ? "#ffd400" : "#ffffff";
    h += `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="#111" stroke-width="${2.5 / s}"/>`;
    if (p.art === "knick" && s < 1 && i !== zielIdx) return;
    const fs = (p.art === "stein" ? 15 : 12) / s;
    const vx = x - mitte.x, vy = y - mitte.y, vl = Math.hypot(vx, vy) || 1;
    const lx = x + (vx / vl) * 20 / s, ly = y + (vy / vl) * 16 / s + 5 / s;
    h += `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="${fs}" font-weight="800" fill="${p.art === "stein" ? "#ffd400" : "#fff"}" stroke="#111" stroke-width="${4 / s}" paint-order="stroke" font-family="-apple-system,sans-serif">${p.kurz}${erl ? " ✓" : ""}</text>`;
  });
  if (pos) {
    const u = pz(pos);
    h += `<circle cx="${u.x}" cy="${u.y}" r="${Math.max(pos.acc / mpp, 6 / s)}" fill="rgba(10,92,255,.15)" stroke="rgba(10,92,255,.6)" stroke-width="${1.5 / s}"/>`;
    if (blick !== null) {
      const L = 46 / s, a1 = (blick - 28) * Math.PI / 180, a2 = (blick + 28) * Math.PI / 180;
      h += `<path d="M${u.x} ${u.y} L${u.x + L * Math.sin(a1)} ${u.y - L * Math.cos(a1)} A${L} ${L} 0 0 1 ${u.x + L * Math.sin(a2)} ${u.y - L * Math.cos(a2)} Z" fill="rgba(10,92,255,.35)"/>`;
    }
    h += `<circle cx="${u.x}" cy="${u.y}" r="${8 / s}" fill="#0a5cff" stroke="#fff" stroke-width="${3 / s}"/>`;
  }
  svg.innerHTML = h;
}

function zielInfo(i) {
  const z = D.punkte[i];
  if (!pos) return { z, d: null };
  const d = distanzM(ll(pos), ll(z)), peil = peilungGrad(ll(pos), ll(z));
  return { z, d, peil };
}

const artText = z => z.art === "stein" ? "Grenzstein, im Gelände suchen" : "Knickpunkt ohne Stein, hier Stock setzen";

function zeichneZielPanel() {
  const t = $("ziel-text"), btn = $("hinfuehren");
  if (zielIdx === null) { t.textContent = "Tippe auf einen Punkt auf der Karte."; btn.hidden = true; return; }
  const { z, d, peil } = zielInfo(zielIdx);
  const wo = d === null ? "warte auf GPS" : `${formatMeter(d)} nach ${himmelsrichtung(peil)}`;
  t.innerHTML = `<strong>${z.name}</strong>${status[z.kurz] ? " ✓" : ""}<br><span class="leise">${artText(z)} · ${wo}</span>`;
  btn.hidden = false;
}

function zeichneFuehren() {
  const box = $("fuehren");
  if (zielIdx === null) zielIdx = 0;
  const { z, d, peil } = zielInfo(zielIdx);
  $("f-name").textContent = z.name;
  $("f-art").textContent = artText(z);
  $("f-ziel").textContent = `${z.lat.toFixed(6)}, ${z.lon.toFixed(6)}`;
  $("ton").textContent = ton ? "Ton an" : "Ton aus";
  $("ton").setAttribute("aria-pressed", String(ton));
  const erl = status[z.kurz];
  const mb = $("markieren");
  mb.textContent = erl ? (z.art === "stein" ? "Stein gefunden ✓" : "Stock gesetzt ✓") : (z.art === "stein" ? "Stein gefunden" : "Stock gesetzt");
  mb.className = erl ? "taste gross erledigt" : "taste gross";
  const warn = $("f-warnung");
  if (gpsFehler && !pos) { warn.hidden = false; warn.textContent = gpsFehler; }
  else if (veraltetS() > 10) { warn.hidden = false; warn.textContent = `Seit ${veraltetS()} s kein GPS-Signal. Pfeil und Meter zeigen die letzte bekannte Position. Kurz stehen bleiben, möglichst freie Sicht zum Himmel.`; }
  else if (pos && pos.acc > 8) { warn.hidden = false; warn.textContent = `GPS noch ungenau (±${Math.round(pos.acc)} m). Kurz stehen bleiben, möglichst freie Sicht zum Himmel.`; }
  else if (kompass === "verweigert" || kompass === "fehlt") { warn.hidden = false; warn.textContent = "Ohne Kompass: Der Pfeil zeigt mit Norden nach oben. Erst ein paar Schritte gehen, dann die Richtung vergleichen."; }
  else warn.hidden = true;
  if (d === null) {
    $("f-distanz").textContent = "–"; $("f-anweisung").textContent = "Warte auf GPS …"; $("f-richtung").textContent = "";
    $("f-gps").textContent = "–"; $("f-ich").textContent = "–"; $("radar").innerHTML = "";
    box.classList.remove("da");
    return;
  }
  const mitKompass = blick !== null && kompass === "an";
  const rel = mitKompass ? relativGrad(peil, blick) : peil;
  $("pfeil-dreh").setAttribute("transform", `rotate(${rel.toFixed(1)})`);
  const nWinkel = mitKompass ? -blick : 0;
  const n = $("pfeil-n");
  n.setAttribute("x", (88 * Math.sin(nWinkel * Math.PI / 180)).toFixed(1));
  n.setAttribute("y", (-88 * Math.cos(nWinkel * Math.PI / 180) + 5).toFixed(1));
  const da = d <= ANKUNFT_M;
  box.classList.toggle("da", da);
  $("f-distanz").textContent = da ? "Angekommen" : formatMeter(d);
  $("f-anweisung").textContent = da
    ? (z.art === "stein" ? `Noch ${formatMeter(d)}. Im Umkreis von 2 bis 3 m nach dem Stein suchen.` : `Noch ${formatMeter(d)}. Hier den Stock setzen.`)
    : mitKompass ? anweisung(zerlegen(d, rel)) : `nach ${himmelsrichtung(peil)}`;
  $("f-richtung").textContent = `${himmelsrichtung(peil)} · ${Math.round(peil)}° vom Norden`;
  $("f-gps").textContent = `±${Math.round(pos.acc)} m${pos.ruhig ? ` · gemittelt aus ${pos.anzahl} Messungen` : ""}`;
  $("f-ich").textContent = `${pos.lat.toFixed(6)}, ${pos.lon.toFixed(6)}`;
  if (da && !warDa) piep();
  warDa = da;
  zeichneRadar(d, mitKompass ? rel : peil, mitKompass);
}

function zeichneRadar(d, winkel, mitKompass) {
  const R = d < 4 ? 5 : d < 12 ? 15 : d < 40 ? 50 : d < 120 ? 150 : 500;
  const k = 100 / R;
  const x = Math.sin(winkel * Math.PI / 180) * Math.min(d, R) * k, y = -Math.cos(winkel * Math.PI / 180) * Math.min(d, R) * k;
  let h = `<circle r="100" fill="#fff" stroke="#111" stroke-width="2.5"/><circle r="50" fill="none" stroke="#cfd3c8" stroke-width="2"/>`;
  h += `<circle r="${(ANKUNFT_M * k).toFixed(1)}" fill="rgba(19,128,58,.18)" stroke="#13803a" stroke-width="2"/>`;
  h += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="#ffd400" stroke="#111" stroke-width="3"/>`;
  h += `<path d="M0 -10 L7 7 L0 3 L-7 7 Z" fill="#0a5cff" stroke="#fff" stroke-width="1.5"/>`;
  $("radar").innerHTML = h;
  $("f-radar").textContent = `Radar: Rand ${R} m, ${mitKompass ? "Blickrichtung oben" : "Norden oben"}`;
}

function piep() {
  if (!ton || !audio) return;
  try {
    audio.resume?.();
    const t = audio.currentTime;
    [0, 0.22].forEach(off => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(0.0001, t + off); g.gain.exponentialRampToValueAtTime(0.4, t + off + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.18);
      o.start(t + off); o.stop(t + off + 0.2);
    });
  } catch {}
}

function zeichneListe() {
  const ol = $("punkte-liste");
  const fertig = D.punkte.filter(p => status[p.kurz]).length;
  $("fortschritt").textContent = `${fertig} von ${D.punkte.length} erledigt`;
  ol.innerHTML = "";
  D.punkte.forEach((p, i) => {
    const li = document.createElement("li");
    const erl = status[p.kurz];
    li.innerHTML = `<button type="button"><span class="marke ${p.art === "knick" ? "knick" : ""} ${erl ? "erledigt" : ""}">${p.kurz}</span>`
      + `<span><strong>${p.name}</strong><span class="sub">${p.art === "stein" ? "Grenzstein" : "Knickpunkt, Stock setzen"}${erl ? " · erledigt" : ""}</span></span>`
      + `<span class="weit"></span></button>`;
    li.firstChild.addEventListener("click", () => { $("liste").hidden = true; waehle(i, true); });
    ol.appendChild(li);
  });
  listeAktualisieren();
}

function listeAktualisieren() {
  const felder = $("punkte-liste").querySelectorAll(".weit");
  D.punkte.forEach((p, i) => {
    const { d, peil } = zielInfo(i);
    const text = d === null ? "" : `${formatMeter(d)} ${KURZ[himmelsrichtung(peil)]}`;
    if (felder[i] && felder[i].textContent !== text) felder[i].textContent = text;
  });
}

$("hinfuehren").addEventListener("click", () => zeige("fuehren"));
$("zur-karte").addEventListener("click", () => zeige("karte"));
$("liste-auf").addEventListener("click", () => { $("liste").hidden = false; zeichneListe(); });
$("liste-zu").addEventListener("click", () => { $("liste").hidden = true; planen(); });
$("naechster").addEventListener("click", () => waehle((zielIdx + 1) % D.punkte.length, true));
$("vorheriger").addEventListener("click", () => waehle((zielIdx - 1 + D.punkte.length) % D.punkte.length, true));
$("ton").addEventListener("click", () => { ton = !ton; schreib(K.ton, ton); planen(); });
$("markieren").addEventListener("click", () => {
  const z = D.punkte[zielIdx];
  if (status[z.kurz]) delete status[z.kurz];
  else status[z.kurz] = { art: z.art === "stein" ? "gefunden" : "gesteckt", t: new Date().toISOString(), lat: pos?.lat ?? null, lon: pos?.lon ?? null, acc: pos?.acc ?? null };
  schreib(K.status, status);
  planen();
});

function karteAnwenden() {
  $("ebene").style.transform = `translate(${karte.tx}px, ${karte.ty}px) scale(${karte.s})`;
  planen();
}

function karteEinpassen() {
  if (!D) return;
  const r = $("karte").getBoundingClientRect();
  if (!r.width) return;
  const pts = D.punkte.map(pz);
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = 48;
  karte.s = Math.min((r.width - 2 * pad) / (x1 - x0), (r.height - 2 * pad) / (y1 - y0));
  karte.tx = r.width / 2 - karte.s * (x0 + x1) / 2;
  karte.ty = r.height / 2 - karte.s * (y0 + y1) / 2;
  karteAnwenden();
}

function michZeigen() {
  if (!pos) return;
  const r = $("karte").getBoundingClientRect();
  const u = pz(pos);
  karte.s = Math.max(karte.s, 1.2);
  karte.tx = r.width / 2 - karte.s * u.x;
  karte.ty = r.height / 2 - karte.s * u.y;
  karteAnwenden();
}

$("ganz").addEventListener("click", karteEinpassen);
$("mich").addEventListener("click", michZeigen);
window.addEventListener("resize", () => { if (ansicht === "karte") karteEinpassen(); });

const zeiger = new Map();
let geste = null;
const kartenEl = $("karte");
const lokal = e => { const r = kartenEl.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

function zoomUm(px, py, faktor) {
  const neu = Math.min(12, Math.max(0.15, karte.s * faktor));
  const f = neu / karte.s;
  karte.tx = px - (px - karte.tx) * f;
  karte.ty = py - (py - karte.ty) * f;
  karte.s = neu;
  karteAnwenden();
}

kartenEl.addEventListener("pointerdown", e => {
  if (e.target.closest(".karten-tasten")) return;
  kartenEl.setPointerCapture(e.pointerId);
  zeiger.set(e.pointerId, lokal(e));
  if (zeiger.size === 1) geste = { art: "tippen", start: lokal(e), t: Date.now(), tx: karte.tx, ty: karte.ty };
  if (zeiger.size === 2) {
    const [a, b] = [...zeiger.values()];
    geste = { art: "pinch", d: Math.hypot(a.x - b.x, a.y - b.y), m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }
});
kartenEl.addEventListener("pointermove", e => {
  if (!zeiger.has(e.pointerId)) return;
  zeiger.set(e.pointerId, lokal(e));
  if (geste?.art === "pinch" && zeiger.size === 2) {
    const [a, b] = [...zeiger.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    karte.tx += m.x - geste.m.x; karte.ty += m.y - geste.m.y;
    zoomUm(m.x, m.y, d / geste.d);
    geste.d = d; geste.m = m;
  } else if (geste && zeiger.size === 1) {
    const p = lokal(e);
    if (geste.art === "tippen" && Math.hypot(p.x - geste.start.x, p.y - geste.start.y) > 8) geste.art = "schieben";
    if (geste.art === "schieben") { karte.tx = geste.tx + p.x - geste.start.x; karte.ty = geste.ty + p.y - geste.start.y; karteAnwenden(); }
  }
});
const ende = e => {
  if (!zeiger.has(e.pointerId)) return;
  const p = lokal(e);
  zeiger.delete(e.pointerId);
  if (geste?.art === "tippen" && zeiger.size === 0 && Date.now() - geste.t < 500) antippen(p);
  if (zeiger.size === 0) geste = null;
  else if (zeiger.size === 1) { const [q] = [...zeiger.values()]; geste = { art: "schieben", start: q, t: Date.now(), tx: karte.tx, ty: karte.ty }; }
};
kartenEl.addEventListener("pointerup", ende);
kartenEl.addEventListener("pointercancel", ende);
kartenEl.addEventListener("wheel", e => { e.preventDefault(); const p = lokal(e); zoomUm(p.x, p.y, Math.exp(-e.deltaY * 0.002)); }, { passive: false });

function antippen(p) {
  let best = -1, bd = Infinity;
  D.punkte.forEach((q, i) => {
    const v = pz(q), sx = v.x * karte.s + karte.tx, sy = v.y * karte.s + karte.ty;
    const d = Math.hypot(sx - p.x, sy - p.y);
    if (d < bd) { bd = d; best = i; }
  });
  if (bd <= 34) waehle(best, false);
}

init();
