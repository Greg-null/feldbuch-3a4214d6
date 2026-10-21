const A = 6378137.0;
const E2 = 6.69437999014e-3;
const RAD = Math.PI / 180;
const RICHTUNGEN = ["Norden", "Nordosten", "Osten", "Südosten", "Süden", "Südwesten", "Westen", "Nordwesten"];
const zahl = (v, stellen) => v.toLocaleString("de-DE", { minimumFractionDigits: stellen, maximumFractionDigits: stellen });

export function versatzM([lat1, lon1], [lat2, lon2]) {
  const phi = ((lat1 + lat2) / 2) * RAD;
  const s = 1 - E2 * Math.sin(phi) ** 2;
  const m = (A * (1 - E2)) / s ** 1.5;
  const n = A / Math.sqrt(s);
  return { nord: (lat2 - lat1) * RAD * m, ost: (lon2 - lon1) * RAD * n * Math.cos(phi) };
}

export function distanzM(a, b) {
  const v = versatzM(a, b);
  return Math.hypot(v.nord, v.ost);
}

export function peilungGrad(a, b) {
  const v = versatzM(a, b);
  return (Math.atan2(v.ost, v.nord) / RAD + 360) % 360;
}

export function relativGrad(peilung, blick) {
  let r = (peilung - blick) % 360;
  if (r <= -180) r += 360;
  if (r > 180) r -= 360;
  return r;
}

export function zerlegen(distanz, rel) {
  return { vor: distanz * Math.cos(rel * RAD), rechts: distanz * Math.sin(rel * RAD) };
}

const kurzMeter = v => (v < 3 ? `${zahl(v, 1)} m` : `${zahl(Math.round(v), 0)} m`);

export function anweisung({ vor, rechts }) {
  const teile = [];
  if (Math.abs(vor) >= 0.5) teile.push(`${kurzMeter(Math.abs(vor))} ${vor > 0 ? "geradeaus" : "zurück"}`);
  if (Math.abs(rechts) >= 0.5) teile.push(`${kurzMeter(Math.abs(rechts))} ${rechts > 0 ? "rechts" : "links"}`);
  return teile.length ? teile.join(" · ") : "hier";
}

export function himmelsrichtung(grad) {
  const g = ((grad % 360) + 360) % 360;
  return RICHTUNGEN[Math.round(g / 45) % 8];
}

const mercY = lat => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));

export function zuPixel([lat, lon], bild) {
  return {
    x: ((lon - bild.west) / (bild.ost - bild.west)) * bild.w,
    y: ((mercY(bild.nord) - mercY(lat)) / (mercY(bild.nord) - mercY(bild.sued))) * bild.h,
  };
}

export function vonPixel(x, y, bild) {
  const my = mercY(bild.nord) - (y / bild.h) * (mercY(bild.nord) - mercY(bild.sued));
  return [(2 * Math.atan(Math.exp(my)) - Math.PI / 2) / RAD, bild.west + (x / bild.w) * (bild.ost - bild.west)];
}

export function mittelwert(fixes, jetzt, fensterMs) {
  const frisch = fixes.filter(f => jetzt - f.t <= fensterMs);
  if (!frisch.length) return null;
  let sw = 0, slat = 0, slon = 0;
  for (const f of frisch) {
    const w = 1 / Math.max(f.acc, 1) ** 2;
    sw += w; slat += f.lat * w; slon += f.lon * w;
  }
  return { lat: slat / sw, lon: slon / sw, acc: 1 / Math.sqrt(sw), anzahl: frisch.length };
}

export function formatMeter(v) {
  return v < 10 ? `${zahl(v, 1)} m` : `${zahl(Math.round(v), 0)} m`;
}
