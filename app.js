/* Zeiterfassung – PWA für Windows und Android.
 *
 * Datenhaltung: lokal im Browser (localStorage). Jedes Gerät schreibt seinen kompletten Stand in eine
 * eigene Datei <geraet-id>.json im Sync-Ordner der Nextcloud und liest die Dateien der anderen Geräte.
 * Zusammengeführt wird je Datensatz (id) nach dem jüngsten Änderungszeitpunkt (updated); gelöschte
 * Datensätze bleiben als Markierung (deleted) erhalten, damit das Löschen auf alle Geräte übertragen wird.
 *
 * Abrechnung: offene Zeiten eines Kunden werden zu Rechnungspositionen zusammengefasst und per API als
 * Rechnungs-Entwurf in der Buchhaltung angelegt (POST /api/rechnungen).
 */
'use strict';
const APP_VERSION = '7';   // zusammen mit VERSION in sw.js erhöhen
const APP_STAND = '22.11.2026';

// ------------------------------------------------------------------ Hilfen
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoLocal = d => `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const heute = () => isoDate(new Date());
const dDE = s => s ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : '';
const dDEkurz = s => s ? `${s.slice(8, 10)}.${s.slice(5, 7)}.` : '';
const zeit = s => s ? s.slice(11, 16) : '';
const eur = n => (Number(n) || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const stdFmt = min => `${Math.floor(min / 60)}:${pad(Math.round(min % 60))} h`;
const dezFmt = n => (Number(n) || 0).toLocaleString('de-DE', { maximumFractionDigits: 3 });
const WOCHENTAG = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const FARBEN = ['#0f766e', '#2563eb', '#c2410c', '#7c3aed', '#be185d', '#15803d', '#a16207', '#0369a1', '#4d7c0f', '#9f1239'];
const STEUER = { '': 'Kundenstandard', U19: '19 % USt', U7: '7 % USt', U0: '0 % steuerfrei (§ 4 UStG)', RC: '0 % Reverse Charge', KU: 'Kleinunternehmer (§ 19)' };
const RSTATUS = { entwurf: 'Entwurf', offen: 'Gestellt', bezahlt: 'Bezahlt', storniert: 'Storniert', geloescht: 'In Buchhaltung gelöscht' };

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch { toast('Speichern im Browser fehlgeschlagen!'); return false; }
}
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ------------------------------------------------------------------ Zustand
const cfg = Object.assign({
  geraet_id: uid(), geraet_name: /Android/i.test(navigator.userAgent) ? 'Handy' : 'PC',
  sync: { modus: 'auto', url: '', user: '', pass: '', ordner: 'Zeiterfassung-Daten' },
  bh: { url: 'http://127.0.0.1:5000', token: '' },
  takt: 6, rundung: 'exakt', gruppe: 'tag', etags: {}, letzteSync: null,
}, lsGet('ze_cfg', {}));
if (![5, 6, 10, 15, 30].includes(Number(cfg.takt))) cfg.takt = 6;
const S = Object.assign({ projekte: [], eintraege: [], kunden: [] }, lsGet('ze_state', {}));
const saveCfg = () => lsSet('ze_cfg', cfg);
saveCfg();

const lebend = arr => arr.filter(x => !x.deleted);
const projekte = () => lebend(S.projekte).sort((a, b) => (b.aktiv - a.aktiv) || a.name.localeCompare(b.name, 'de'));
const projekt = id => S.projekte.find(p => p.id === id);
const eintraege = () => lebend(S.eintraege);
const laufend = () => eintraege().find(e => !e.ende);
const farbe = p => p?.farbe || FARBEN[0];
const kundeName = p => p?.kunde || 'Ohne Kunde';
const kundeKey = p => p?.kunde_id ? 'id:' + p.kunde_id : 'n:' + (p?.kunde || '').trim().toLowerCase();

const KURZ_SEK = 60;   // gestoppte Zeiten unter einer Minute werden direkt verworfen (versehentliches Start/Stopp)

function laufendePauseMin(e, jetzt = new Date()) {
  return e.pause_seit ? Math.max(0, (jetzt - new Date(e.pause_seit)) / 60000) : 0;
}
function dauerMin(e, jetzt = new Date()) {
  const ende = e.ende ? new Date(e.ende) : jetzt;
  return Math.max(0, (ende - new Date(e.start)) / 60000 - (Number(e.pause) || 0) - laufendePauseMin(e, ende));
}

function speichern(sofortSync = false) {
  lsSet('ze_state', S);
  render();
  planeSync(sofortSync ? 200 : 2500);
}
function upsert(liste, obj) {
  obj.updated = Date.now();
  const i = S[liste].findIndex(x => x.id === obj.id);
  if (i >= 0) S[liste][i] = obj; else S[liste].push(obj);
}
function loeschen(liste, id) {
  const o = S[liste].find(x => x.id === id);
  if (o) { upsert(liste, { id: o.id, deleted: true }); }
}

// ------------------------------------------------------------------ Zusammenführen
function merge(daten) {
  let geaendert = false;
  for (const liste of ['projekte', 'eintraege', 'kunden']) {
    const map = new Map(S[liste].map(x => [x.id, x]));
    for (const fremd of daten?.[liste] || []) {
      if (!fremd?.id) continue;
      const eigen = map.get(fremd.id);
      if (!eigen || (fremd.updated || 0) > (eigen.updated || 0)) { map.set(fremd.id, fremd); geaendert = true; }
    }
    S[liste] = [...map.values()];
  }
  return geaendert;
}

// ------------------------------------------------------------------ Sync-Adapter
const LOKAL = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);

const lokalAdapter = {
  name: 'Lokaler Nextcloud-Ordner',
  async list() {
    const r = await fetch('sync/', { cache: 'no-store' });
    if (!r.ok) throw new Error('Lokaler Sync nicht erreichbar (' + r.status + ')');
    const j = await r.json();
    return j.dateien.map(d => ({ name: d.name, etag: String(d.mtime) }));
  },
  async get(name) {
    const r = await fetch('sync/' + encodeURIComponent(name), { cache: 'no-store' });
    if (!r.ok) throw new Error('Lesen fehlgeschlagen: ' + name);
    return r.json();
  },
  async put(name, daten) {
    const r = await fetch('sync/' + encodeURIComponent(name), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(daten) });
    if (!r.ok) throw new Error('Schreiben fehlgeschlagen (' + r.status + ')');
  },
};

/* Nextcloud-Adresse vereinheitlichen: ohne https:// würde der Browser sie an die App-Adresse anhängen
 * (GitHub antwortet dann 405), http:// blockiert der Browser auf HTTPS-Seiten. Kopierte Adressen wie
 * …/index.php/apps/files oder …/login werden auf die Server-Adresse gekürzt. */
function ncUrl(eingabe) {
  let s = String(eingabe || '').trim().replace(/\s+/g, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.replace(/^http:\/\//i, 'https://');
  try {
    const u = new URL(s);
    const pfad = u.pathname.split(/\/(?:index\.php|remote\.php|apps|login|settings|s\/)(?:\/|$)/)[0].replace(/\/+$/, '');
    return u.origin + pfad;
  } catch { return s.replace(/\/+$/, ''); }
}

function webdavAdapter(c) {
  const base = ncUrl(c.url) + '/remote.php/dav/files/' + encodeURIComponent(c.user) + '/' +
    (c.ordner || 'Zeiterfassung-Daten').split('/').filter(Boolean).map(encodeURIComponent).join('/') + '/';
  const auth = 'Basic ' + btoa(unescape(encodeURIComponent(c.user + ':' + c.pass)));
  // Fehlermeldungen nennen Schritt, Adresse und Grund – damit sich Probleme aus der Ferne eingrenzen lassen
  const wo = (method, url) => `${method} ${url.replace(/^https?:\/\//, '')}`;
  const req = async (method, url, opt = {}) => {
    let r;
    try { r = await fetch(url, { method, cache: 'no-store', ...opt, headers: { Authorization: auth, ...(opt.headers || {}) } }); }
    catch (e) {
      throw new Error(`Nextcloud nicht erreichbar (${wo(method, url)}: ${e.message}). ` +
        (navigator.onLine ? 'Ist die Adresse richtig und der Browser-Zugriff (CORS) für diese App erlaubt?' : 'Das Gerät ist offline.'));
    }
    if (r.status === 401) throw new Error(`Nextcloud: Benutzername oder App-Passwort falsch (${wo(method, url)}).`);
    if (!r.ok && !(method === 'PROPFIND' && r.status === 404)) {
      const hinweis = { 404: 'Benutzername stimmt nicht? Es muss der Anmeldename sein, nicht die E-Mail-Adresse.',
        405: 'Adresse falsch oder Ordnername ist eine Datei?', 409: 'Übergeordneter Ordner fehlt – Benutzername prüfen.',
        423: 'Datei ist in der Nextcloud gesperrt.', 507: 'Nextcloud-Speicher voll.' }[r.status] || '';
      throw new Error(`Nextcloud-Fehler ${r.status} bei ${wo(method, url)}. ${hinweis}`);
    }
    return r;
  };
  return {
    name: 'Nextcloud (WebDAV)',
    async list() {
      const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>';
      let r = await req('PROPFIND', base, { headers: { Depth: '1', 'Content-Type': 'application/xml' }, body });
      if (r.status === 404) {
        const m = await req('MKCOL', base);
        if (!m.ok) throw new Error('Ordner konnte nicht angelegt werden (' + m.status + ')');
        return [];
      }
      if (!r.ok) throw new Error('Nextcloud-Fehler ' + r.status);
      const xml = new DOMParser().parseFromString(await r.text(), 'application/xml');
      return [...xml.getElementsByTagNameNS('DAV:', 'response')].map(resp => {
        const href = resp.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent || '';
        const etag = resp.getElementsByTagNameNS('DAV:', 'getetag')[0]?.textContent || '';
        return { name: decodeURIComponent(href.replace(/\/$/, '').split('/').pop()), etag };
      }).filter(f => f.name.endsWith('.json'));
    },
    async get(name) {
      const r = await req('GET', base + encodeURIComponent(name));
      if (!r.ok) throw new Error('Lesen fehlgeschlagen: ' + name);
      return r.json();
    },
    async put(name, daten) {
      const r = await req('PUT', base + encodeURIComponent(name), { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(daten) });
      if (!r.ok) throw new Error('Schreiben fehlgeschlagen (' + r.status + ')');
    },
  };
}

let lokalVerfuegbar = null;
async function adapter() {
  const m = cfg.sync.modus;
  if (m === 'aus') return null;
  if (m === 'lokal' || (m === 'auto' && LOKAL)) {
    if (lokalVerfuegbar === null) {
      try { lokalVerfuegbar = (await fetch('sync/', { cache: 'no-store' })).ok; } catch { lokalVerfuegbar = false; }
    }
    if (lokalVerfuegbar) return lokalAdapter;
    if (m === 'lokal') throw new Error('Lokaler Sync nur über den PC-Starter (zeiterfassung.pyw) verfügbar.');
  }
  if ((m === 'webdav' || m === 'auto') && cfg.sync.url && cfg.sync.user && cfg.sync.pass) return webdavAdapter(cfg.sync);
  return null;
}

let syncLaeuft = false, syncTimer = null, nochmal = false;
function planeSync(ms = 2500) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
function syncAnzeige(zustand, text) {
  const b = $('#syncBtn'); b.className = 'syncstate ' + zustand; $('#syncText').textContent = text;
}

async function sync() {
  if (syncLaeuft) { nochmal = true; return; }
  let a;
  try { a = await adapter(); } catch (e) { syncAnzeige('err', 'Sync-Fehler'); $('#syncBtn').title = e.message; return; }
  if (!a) { syncAnzeige('', 'Nur lokal'); $('#syncBtn').title = 'Keine Synchronisation eingerichtet (Einstellungen)'; return; }
  if (!navigator.onLine && a !== lokalAdapter) { syncAnzeige('err', 'Offline'); return; }
  syncLaeuft = true; syncAnzeige('busy', 'Sync …');
  try {
    const eigene = cfg.geraet_id + '.json';
    const dateien = await a.list();
    let geaendert = false;
    for (const f of dateien) {
      if (f.name === eigene || !/^[\w.-]+\.json$/.test(f.name)) continue;
      if (f.etag && cfg.etags[f.name] === f.etag) continue;    // unverändert seit letztem Abgleich
      const daten = await a.get(f.name);
      if (merge(daten)) geaendert = true;
      cfg.etags[f.name] = f.etag;
    }
    if (geaendert) lsSet('ze_state', S);
    await a.put(eigene, { format: 1, geraet: cfg.geraet_id, name: cfg.geraet_name, gespeichert: new Date().toISOString(),
                          projekte: S.projekte, eintraege: S.eintraege, kunden: S.kunden });
    cfg.letzteSync = Date.now(); saveCfg();
    syncAnzeige('ok', 'Synchron');
    $('#syncBtn').title = `${a.name} · zuletzt ${new Date().toLocaleTimeString('de-DE')} · ${dateien.length} Gerätedatei(en)`;
    if (geaendert) render();
  } catch (e) {
    syncAnzeige('err', 'Sync-Fehler'); $('#syncBtn').title = e.message;
  } finally {
    syncLaeuft = false;
    if (nochmal) { nochmal = false; planeSync(500); }
  }
}

// ------------------------------------------------------------------ Buchhaltung
async function bh(path, opt = {}) {
  if (!cfg.bh.token) throw new Error('Kein API-Schlüssel für die Buchhaltung eingetragen (Einstellungen).');
  let r;
  try {
    r = await fetch(cfg.bh.url.replace(/\/+$/, '') + path, {
      ...opt, headers: { Authorization: 'Bearer ' + cfg.bh.token, 'Content-Type': 'application/json' } });
  } catch { throw new Error('Buchhaltung nicht erreichbar. Läuft sie an diesem PC?'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.fehler || 'Buchhaltung: Fehler ' + r.status);
  return j;
}

async function kundenLaden() {
  const j = await bh('/api/kunden');
  let neu = 0;
  for (const k of j.kunden) {
    const id = 'bh-' + k.id, alt = S.kunden.find(x => x.id === id);
    const obj = { id, bh_id: k.id, firma: k.firma, kundennr: k.kundennr, ort: k.ort };
    if (!alt || alt.deleted || alt.firma !== k.firma || alt.kundennr !== k.kundennr || alt.ort !== k.ort) { upsert('kunden', obj); neu++; }
  }
  // Projekte mit gleichem Kundennamen, aber ohne Verknüpfung, automatisch verknüpfen
  for (const p of lebend(S.projekte)) {
    if (p.kunde_id || !p.kunde) continue;
    const k = j.kunden.find(k => k.firma.trim().toLowerCase() === p.kunde.trim().toLowerCase());
    if (k) upsert('projekte', { ...p, kunde_id: k.id, kunde: k.firma });
  }
  speichern();
  return { anzahl: j.kunden.length, neu, firma: (await bh('/api/status')).firma };
}

// ------------------------------------------------------------------ Navigation
let aktiverTab = 'erfassen';
function zeigeTab(name) {
  aktiverTab = name;
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  try { sessionStorage.setItem('ze_tab', name); } catch { /* egal */ }
  render();
  if (name === 'abrechnen') rechnungsStatus(true);
  window.scrollTo(0, 0);
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) zeigeTab(b.dataset.tab); });

function render() {
  ({ erfassen: renderErfassen, eintraege: renderEintraege, abrechnen: renderAbrechnen,
     projekte: renderProjekte, einstellungen: renderEinstellungen })[aktiverTab]();
}

// ------------------------------------------------------------------ Erfassen
function projektOptionen(sel, mitLeer = false, nurAktiv = true) {
  const ps = projekte().filter(p => !nurAktiv || p.aktiv || p.id === sel);
  return (mitLeer ? '<option value="">– kein Projekt –</option>' : '') +
    ps.map(p => `<option value="${esc(p.id)}"${p.id === sel ? ' selected' : ''}>${esc(p.name)}${p.kunde ? ' · ' + esc(p.kunde) : ''}</option>`).join('');
}

function renderErfassen() {
  const l = laufend(), card = $('#timerCard');
  const tippt = card.contains(document.activeElement) && document.activeElement.matches('input, select');
  if (tippt && !!l === card.classList.contains('running')) {
    // Timer-Karte nicht neu aufbauen, während darin getippt wird (z. B. bei Sync im Hintergrund)
  } else if (l) {
    const p = projekt(l.projekt_id);
    const pausiert = !!l.pause_seit;
    card.className = 'card timer running' + (pausiert ? ' paused' : '');
    card.innerHTML = `
      <div class="sub">${pausiert ? `⏸ Pause seit ${zeit(l.pause_seit)} Uhr` : `läuft seit ${zeit(l.start)} Uhr${l.start.slice(0, 10) !== heute() ? ' (' + dDE(l.start) + ')' : ''}`}${(Number(l.pause) || 0) >= 1 ? ` · bisher ${Math.round(l.pause)} min Pause` : ''}</div>
      <div class="clock" id="clock">0:00:00</div>
      <div class="sub"><span class="badge" style="color:${farbe(p)}">●</span> ${esc(p?.name || 'Ohne Projekt')}${p?.kunde ? ' · ' + esc(p.kunde) : ''}</div>
      <div class="fields"><input id="tText" placeholder="Was machst du gerade?" value="${esc(l.text || '')}"></div>
      <div class="timerbtns">
        <button class="btn big" id="pauseBtn" type="button">${pausiert ? '▶ Fortsetzen' : '⏸ Pause'}</button>
        <button class="btn primary big" id="stopBtn" type="button">■ Stoppen</button>
      </div>`;
    $('#pauseBtn').addEventListener('click', () => {
      const e = { ...laufend(), text: $('#tText').value.trim() };
      if (e.pause_seit) {          // fortsetzen: laufende Pause zur Pausensumme addieren
        e.pause = Math.round(((Number(e.pause) || 0) + laufendePauseMin(e)) * 100) / 100;
        e.pause_seit = null;
      } else {
        e.pause_seit = isoLocal(new Date());
      }
      upsert('eintraege', e); speichern(true);
    });
    // ohne Neuaufbau speichern – sonst ginge ein direkt folgender Klick auf „Stoppen“ verloren
    $('#tText').addEventListener('change', e => { upsert('eintraege', { ...laufend(), text: e.target.value.trim() }); lsSet('ze_state', S); planeSync(); });
    $('#stopBtn').addEventListener('click', () => {
      const jetzt = new Date(), e = { ...laufend(), text: $('#tText').value.trim(), ende: isoLocal(jetzt) };
      if (e.pause_seit) { e.pause = Math.round(((Number(e.pause) || 0) + laufendePauseMin(e, jetzt)) * 100) / 100; e.pause_seit = null; }
      if (dauerMin(e) * 60 < KURZ_SEK) {
        loeschen('eintraege', e.id); speichern(true); toast('Unter 1 Minute – Eintrag wurde verworfen.');
        return;
      }
      upsert('eintraege', e); speichern(true); toast('Zeit gespeichert.');
    });
    tick();
  } else {
    const ps = projekte().filter(p => p.aktiv);
    const letztes = lsGet('ze_letztes_projekt', '');
    card.className = 'card timer';
    const zuletzt = [...new Set(eintraege().sort((a, b) => b.start.localeCompare(a.start)).map(e => e.projekt_id))]
      .map(projekt).filter(p => p && !p.deleted && p.aktiv).slice(0, 4);
    card.innerHTML = ps.length ? `
      <div class="clock">0:00:00</div>
      <div class="fields">
        <select id="tProjekt">${projektOptionen(letztes)}</select>
        <input id="tText" placeholder="Tätigkeit (optional)">
      </div>
      <button class="btn primary big" id="startBtn" type="button">▶ Starten</button>
      ${zuletzt.length > 1 ? `<div class="recent">${zuletzt.map(p => `<button class="chip" type="button" data-start="${esc(p.id)}">▶ ${esc(p.name)}</button>`).join('')}</div>` : ''}`
      : `<div class="empty">Lege zuerst ein Projekt an (mit Kunde und Stundensatz).<br><br>
         <button class="btn primary" type="button" id="ersteProjekt">+ Projekt anlegen</button></div>`;
    const start = (pid, text = '') => {
      lsSet('ze_letztes_projekt', pid);
      upsert('eintraege', { id: uid(), projekt_id: pid, start: isoLocal(new Date()), ende: null, pause: 0, text, rechnung: null });
      speichern(true);
    };
    $('#startBtn')?.addEventListener('click', () => start($('#tProjekt').value, $('#tText').value.trim()));
    $$('[data-start]', card).forEach(b => b.addEventListener('click', () => start(b.dataset.start)));
    $('#ersteProjekt')?.addEventListener('click', () => projektDialog());
  }

  const h = heute();
  const liste = eintraege().filter(e => e.start.slice(0, 10) === h && e.ende).sort((a, b) => b.start.localeCompare(a.start));
  $('#heuteListe').innerHTML = liste.length ? liste.map(eintragItem).join('') : '<div class="empty">Heute noch keine abgeschlossenen Zeiten.</div>';
  const sumHeute = eintraege().filter(e => e.start.slice(0, 10) === h).reduce((s, e) => s + dauerMin(e), 0);
  $('#heuteSumme').textContent = sumHeute ? '· ' + stdFmt(sumHeute) : '';

  const jetzt = new Date(), wo = new Date(jetzt); wo.setDate(jetzt.getDate() - ((jetzt.getDay() + 6) % 7));
  const woStart = isoDate(wo), moStart = h.slice(0, 8) + '01';
  const summe = (von) => eintraege().filter(e => e.start.slice(0, 10) >= von).reduce((s, e) => s + dauerMin(e), 0);
  const offenWert = eintraege().filter(e => e.ende && !e.rechnung).reduce((s, e) => s + dauerMin(e) / 60 * (Number(projekt(e.projekt_id)?.satz) || 0), 0);
  $('#stats').innerHTML = `
    <div class="stat"><div class="k">Diese Woche</div><div class="v">${stdFmt(summe(woStart))}</div></div>
    <div class="stat"><div class="k">Dieser Monat</div><div class="v">${stdFmt(summe(moStart))}</div></div>
    <div class="stat"><div class="k">Nicht abgerechnet</div><div class="v">${eur(offenWert)}</div></div>`;
  bindEintragItems($('#heuteListe'));
}

function tick() {
  const c = $('#clock'), l = laufend();
  if (!c || !l) return;
  const s = Math.floor(dauerMin(l) * 60);
  c.textContent = `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
setInterval(tick, 1000);

function eintragItem(e) {
  const p = projekt(e.projekt_id);
  const status = e.rechnung ? `<span class="badge ok">${esc(e.rechnung.nummer || 'Rechnung #' + e.rechnung.id)}</span>` : (e.ende ? '' : '<span class="badge accent">läuft</span>');
  return `<button class="item" type="button" data-eintrag="${esc(e.id)}">
    <span class="swatch" style="background:${farbe(p)}"></span>
    <span class="main"><span class="title">${esc(e.text || p?.name || 'Ohne Projekt')}</span>
      <span class="meta">${esc(p?.name || 'Ohne Projekt')}${p?.kunde ? ' · ' + esc(p.kunde) : ''} · ${zeit(e.start)}–${e.ende ? zeit(e.ende) : '…'}${e.pause ? ` · ${e.pause} min Pause` : ''} ${status}</span></span>
    <span class="right"><b>${stdFmt(dauerMin(e))}</b><span class="meta">${p?.satz ? eur(dauerMin(e) / 60 * p.satz) : ''}</span></span>
  </button>`;
}
function bindEintragItems(el) {
  $$('[data-eintrag]', el).forEach(b => b.addEventListener('click', () => eintragDialog(S.eintraege.find(e => e.id === b.dataset.eintrag))));
}

// ------------------------------------------------------------------ Dialoge
function dialog(html, onSubmit, onReady) {
  const dlg = $('#dlg'), form = $('#dlgForm');
  form.innerHTML = html;
  form.onsubmit = ev => {
    const btn = ev.submitter?.value;
    if (btn === 'abbrechen') return;
    if (onSubmit(btn, new FormData(form)) === false) ev.preventDefault();
  };
  // Enter = Speichern (sonst wäre der erste Knopf im Formular, z. B. „Löschen“, der Standard)
  form.onkeydown = ev => {
    if (ev.key !== 'Enter' || ev.target.matches('textarea, button')) return;
    ev.preventDefault();
    const ok = form.querySelector('button[value="ok"]');
    if (ok) form.requestSubmit(ok);
  };
  onReady?.(form);
  dlg.showModal();
}

function eintragDialog(e) {
  const neu = !e;
  if (neu) {
    const jetzt = new Date(), vor = new Date(jetzt - 3600e3);
    e = { id: uid(), projekt_id: lsGet('ze_letztes_projekt', projekte()[0]?.id || ''), start: isoLocal(vor), ende: isoLocal(jetzt), pause: 0, text: '', rechnung: null };
  }
  const gesperrt = !!e.rechnung;
  dialog(`
    <h3>${neu ? 'Zeit nachtragen' : 'Eintrag bearbeiten'}</h3>
    ${gesperrt ? `<div class="notice warn">Abgerechnet in ${esc(e.rechnung.nummer || 'Rechnung #' + e.rechnung.id)}. Der Eintrag ist gesperrt.</div>` : ''}
    <fieldset ${gesperrt ? 'disabled' : ''} style="border:0;padding:0;margin:0">
      <label>Projekt<select name="projekt_id">${projektOptionen(e.projekt_id, true, false)}</select></label>
      <label>Tätigkeit<textarea name="text" rows="2">${esc(e.text || '')}</textarea></label>
      <div class="grid2">
        <label>Datum<input type="date" name="datum" value="${e.start.slice(0, 10)}" required></label>
        <label>Pause (Min.)<input type="number" name="pause" min="0" step="1" value="${Math.round(Number(e.pause) || 0)}"></label>
        <label>Von<input type="time" name="von" value="${zeit(e.start)}" required></label>
        <label>Bis<input type="time" name="bis" value="${e.ende ? zeit(e.ende) : ''}" ${e.ende ? 'required' : ''} placeholder="läuft"></label>
      </div>
      <p class="hint" id="dauerHint"></p>
    </fieldset>
    <div class="actions">
      ${!neu && !gesperrt ? '<button class="btn danger" value="loeschen" formnovalidate>Löschen</button>' : ''}
      ${!neu && gesperrt ? '<button class="btn" value="entsperren" formnovalidate>Sperre aufheben</button>' : ''}
      <span class="spacer"></span>
      <button class="btn" value="abbrechen" formnovalidate>Abbrechen</button>
      ${gesperrt ? '' : '<button class="btn primary" value="ok">Speichern</button>'}
    </div>`,
  (btn, fd) => {
    if (btn === 'loeschen') {
      if (!confirm('Eintrag wirklich löschen?')) return false;
      loeschen('eintraege', e.id); speichern(true); toast('Eintrag gelöscht.'); return;
    }
    if (btn === 'entsperren') {
      if (!confirm('Die Zuordnung zur Rechnung wird entfernt. Der Eintrag kann dann erneut abgerechnet werden. Nur verwenden, wenn die Rechnung in der Buchhaltung gelöscht oder storniert ist. Fortfahren?')) return false;
      upsert('eintraege', { ...e, rechnung: null }); speichern(true); return;
    }
    const datum = fd.get('datum'), von = fd.get('von'), bis = fd.get('bis');
    const start = `${datum}T${von}:00`;
    let ende = null;
    if (bis) {
      const d = new Date(`${datum}T${bis}:00`);
      if (bis < von) d.setDate(d.getDate() + 1);   // über Mitternacht
      ende = isoLocal(d);
    } else if (e.ende || neu) { alert('Bitte eine Endzeit angeben.'); return false; }
    if (!ende && laufend() && laufend().id !== e.id) { alert('Es läuft bereits eine andere Zeit.'); return false; }
    lsSet('ze_letztes_projekt', fd.get('projekt_id'));
    upsert('eintraege', { ...e, projekt_id: fd.get('projekt_id'), text: fd.get('text').trim(), start, ende, pause: Math.max(0, parseInt(fd.get('pause')) || 0) });
    speichern(true);
  },
  form => {
    const upd = () => {
      const v = form.von.value, b = form.bis.value;
      if (!v || !b) { $('#dauerHint').textContent = ''; return; }
      let m = (new Date(`2000-01-01T${b}`) - new Date(`2000-01-01T${v}`)) / 60000;
      if (m < 0) m += 1440;
      m -= parseInt(form.pause.value) || 0;
      $('#dauerHint').textContent = 'Dauer: ' + stdFmt(Math.max(0, m)) + (b < v ? ' (endet am Folgetag)' : '');
    };
    form.addEventListener('input', upd); upd();
  });
}
$('#nachtragenBtn').addEventListener('click', () => projekte().length ? eintragDialog(null) : projektDialog());

function projektDialog(p) {
  const neu = !p;
  p = p || { id: uid(), name: '', kunde: '', kunde_id: null, satz: '', steuer: '', aktiv: true, farbe: FARBEN[lebend(S.projekte).length % FARBEN.length] };
  const kunden = lebend(S.kunden).sort((a, b) => a.firma.localeCompare(b.firma, 'de'));
  dialog(`
    <h3>${neu ? 'Neues Projekt' : 'Projekt bearbeiten'}</h3>
    <label>Projektname<input name="name" value="${esc(p.name)}" required placeholder="z. B. Baumkontrolle Stadtpark"></label>
    <label>Kunde<input name="kunde" list="kundenListe" value="${esc(p.kunde || '')}" placeholder="${kunden.length ? 'Aus Buchhaltung wählen oder neu eingeben' : 'Name wie in der Buchhaltung'}"></label>
    <datalist id="kundenListe">${kunden.map(k => `<option value="${esc(k.firma)}">${esc(k.kundennr || '')} ${esc(k.ort || '')}</option>`).join('')}</datalist>
    <p class="hint" id="kundeHint"></p>
    <div class="grid2">
      <label>Stundensatz netto (€)<input name="satz" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(p.satz)}"></label>
      <label>Steuer<select name="steuer">${Object.entries(STEUER).map(([k, v]) => `<option value="${k}"${k === (p.steuer || '') ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
    </div>
    <label>Farbe<select name="farbe">${FARBEN.map((f, i) => `<option value="${f}"${f === p.farbe ? ' selected' : ''} style="color:${f}">● Farbe ${i + 1}</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" name="aktiv" ${p.aktiv ? 'checked' : ''}> aktiv (zur Auswahl beim Erfassen)</label>
    <div class="actions">
      ${neu ? '' : '<button class="btn danger" value="loeschen" formnovalidate>Löschen</button>'}
      <span class="spacer"></span>
      <button class="btn" value="abbrechen" formnovalidate>Abbrechen</button>
      <button class="btn primary" value="ok">Speichern</button>
    </div>`,
  (btn, fd) => {
    if (btn === 'loeschen') {
      const n = eintraege().filter(e => e.projekt_id === p.id).length;
      if (n) { alert(`Das Projekt hat ${n} Einträge. Bitte stattdessen auf „inaktiv“ setzen.`); return false; }
      loeschen('projekte', p.id); speichern(true); return;
    }
    const kname = fd.get('kunde').trim();
    const k = kunden.find(k => k.firma.trim().toLowerCase() === kname.toLowerCase());
    upsert('projekte', { ...p, name: fd.get('name').trim(), kunde: k ? k.firma : kname, kunde_id: k ? k.bh_id : null,
      satz: fd.get('satz') === '' ? '' : Number(fd.get('satz')), steuer: fd.get('steuer'), farbe: fd.get('farbe'), aktiv: !!fd.get('aktiv') });
    speichern(true);
  },
  form => {
    const upd = () => {
      const v = form.kunde.value.trim().toLowerCase();
      const k = kunden.find(k => k.firma.trim().toLowerCase() === v);
      $('#kundeHint').textContent = !v ? '' : k ? `✓ Verknüpft mit Kunde ${k.kundennr || ''} in der Buchhaltung` :
        'Noch nicht in der Buchhaltung. Wird bei der ersten Rechnung angelegt bzw. per Namen zugeordnet.';
    };
    form.kunde.addEventListener('input', upd); upd();
  });
}
$('#projektNeuBtn').addEventListener('click', () => projektDialog());

// ------------------------------------------------------------------ Einträge
function initFilter() {
  const h = heute();
  $('#fVon').value = h.slice(0, 8) + '01';
  $('#fBis').value = h;
  ['#fVon', '#fBis', '#fProjekt', '#fStatus'].forEach(s => $(s).addEventListener('change', renderEintraege));
}
function gefilterteEintraege() {
  const von = $('#fVon').value, bis = $('#fBis').value, pid = $('#fProjekt').value, st = $('#fStatus').value;
  return eintraege().filter(e => {
    const d = e.start.slice(0, 10);
    return (!von || d >= von) && (!bis || d <= bis) && (!pid || e.projekt_id === pid) &&
      (!st || (st === 'offen' ? !e.rechnung : !!e.rechnung));
  }).sort((a, b) => b.start.localeCompare(a.start));
}
function renderEintraege() {
  const sel = $('#fProjekt').value;
  $('#fProjekt').innerHTML = '<option value="">Alle Projekte</option>' + projektOptionen(sel, false, false);
  const liste = gefilterteEintraege();
  let html = '', tag = '';
  for (const e of liste) {
    const d = e.start.slice(0, 10);
    if (d !== tag) {
      tag = d;
      const summe = liste.filter(x => x.start.slice(0, 10) === d).reduce((s, x) => s + dauerMin(x), 0);
      html += `<div class="daygroup"><span>${WOCHENTAG[new Date(d + 'T12:00').getDay()]}, ${dDE(d)}</span><span>${stdFmt(summe)}</span></div>`;
    }
    html += eintragItem(e);
  }
  $('#eintraegeListe').innerHTML = html || '<div class="empty">Keine Einträge im gewählten Zeitraum.</div>';
  const min = liste.reduce((s, e) => s + dauerMin(e), 0);
  const wert = liste.reduce((s, e) => s + dauerMin(e) / 60 * (Number(projekt(e.projekt_id)?.satz) || 0), 0);
  $('#eintraegeSumme').textContent = liste.length ? `· ${stdFmt(min)} · ${eur(wert)}` : '';
  bindEintragItems($('#eintraegeListe'));
}
$('#csvBtn').addEventListener('click', () => {
  const zeilen = [['Datum', 'Von', 'Bis', 'Pause (Min.)', 'Dauer (h)', 'Projekt', 'Kunde', 'Tätigkeit', 'Stundensatz', 'Betrag netto', 'Rechnung']];
  for (const e of gefilterteEintraege().reverse()) {
    const p = projekt(e.projekt_id), h = dauerMin(e) / 60;
    zeilen.push([dDE(e.start.slice(0, 10)), zeit(e.start), zeit(e.ende), e.pause || 0, h.toFixed(2).replace('.', ','), p?.name || '', p?.kunde || '',
      e.text || '', p?.satz ? String(p.satz).replace('.', ',') : '', p?.satz ? (h * p.satz).toFixed(2).replace('.', ',') : '', e.rechnung ? (e.rechnung.nummer || '#' + e.rechnung.id) : '']);
  }
  const csv = '﻿' + zeilen.map(z => z.map(v => /[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(';')).join('\r\n');
  download(`Zeiten_${$('#fVon').value}_${$('#fBis').value}.csv`, csv, 'text/csv');
});
function download(name, text, typ) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: typ + ';charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ Abrechnen
const abwahl = new Set();     // abgewählte Einträge in der aktuellen Abrechnung
let letztesErgebnis = '';

function offeneNachKunde() {
  const map = new Map();
  for (const e of eintraege()) {
    if (!e.ende || e.rechnung) continue;
    const p = projekt(e.projekt_id);
    if (!p || p.deleted) continue;
    const key = kundeKey(p);
    if (!map.has(key)) map.set(key, { key, name: kundeName(p), kunde_id: p.kunde_id, eintraege: [] });
    map.get(key).eintraege.push(e);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

const RUNDUNG = { exakt: 'minutengenau', kaufm: 'kaufmännisch gerundet', ab: 'abgerundet', auf: 'aufgerundet' };
function runden(min, modus, takt) {
  const m = Math.round(min * 60) / 60;          // auf ganze Sekunden, damit 60,0000001 min nicht springt
  if (modus === 'exakt') return Math.round(m);  // ganze Minuten
  const t = m / takt;
  return (modus === 'auf' ? Math.ceil(t - 1e-9) : modus === 'ab' ? Math.floor(t + 1e-9) : Math.round(t)) * takt;
}

function positionen(liste, gruppe, takt, modus = cfg.rundung) {
  const runde = min => runden(min, modus, takt);
  const gruppen = new Map();
  for (const e of [...liste].sort((a, b) => a.start.localeCompare(b.start))) {
    const p = projekt(e.projekt_id), d = e.start.slice(0, 10);
    const key = gruppe === 'einzeln' ? e.id : gruppe === 'tag' ? d + '|' + p.id : p.id;
    if (!gruppen.has(key)) gruppen.set(key, { p, tage: [], texte: [], min: 0, ids: [] });
    const g = gruppen.get(key);
    g.min += dauerMin(e); g.ids.push(e.id); g.tage.push(d);
    if (e.text && !g.texte.includes(e.text)) g.texte.push(e.text);
  }
  return [...gruppen.values()].map(g => {
    const von = g.tage[0], bis = g.tage[g.tage.length - 1];
    const zr = gruppe === 'projekt' ? (von === bis ? dDE(von) : `${dDEkurz(von)}–${dDE(bis)}`) : dDE(von);
    const taet = g.texte.join('; ');
    const bez = gruppe === 'projekt' ? `${g.p.name} (${zr})${taet ? ': ' + taet : ''}` : `${zr} ${g.p.name}${taet ? ': ' + taet : ''}`;
    // minutengenau: 3 Nachkommastellen (0,833 Std. statt 0,83), damit der Betrag praktisch centgenau stimmt
    const stellen = modus === 'exakt' ? 1000 : 100;
    const menge = Math.round(runde(g.min) / 60 * stellen) / stellen;
    const preis = Number(g.p.satz) || 0;
    return { bezeichnung: bez.slice(0, 500), menge, einheit: 'Std.', preis, steuer: g.p.steuer || '', netto: Math.round(menge * preis * 100) / 100, ids: g.ids, minIst: g.min };
  }).filter(p => p.menge > 0);   // durch Abrunden auf 0 gefallene Positionen nicht berechnen
}

function renderAbrechnen() {
  const hinweis = $('#bhHinweis');
  hinweis.innerHTML = !cfg.bh.token ? `<div class="notice warn">Noch keine Verbindung zur Buchhaltung. Trage unter <a href="#" data-goto="einstellungen">Einstellungen</a> den API-Schlüssel ein.${LOKAL ? '' : ' Die Buchhaltung ist nur am PC erreichbar. Rechne dort ab, die Zeiten vom Handy kommen per Sync.'}</div>` : '';
  $$('[data-goto]', hinweis).forEach(a => a.addEventListener('click', ev => { ev.preventDefault(); zeigeTab(a.dataset.goto); }));

  const kunden = offeneNachKunde(), sel = $('#aKunde').value;
  $('#aKunde').innerHTML = kunden.length ? kunden.map(k => {
    const min = k.eintraege.reduce((s, e) => s + dauerMin(e), 0);
    return `<option value="${esc(k.key)}"${k.key === sel ? ' selected' : ''}>${esc(k.name)} · ${stdFmt(min)}${k.kunde_id ? '' : ' (nicht verknüpft)'}</option>`;
  }).join('') : '<option value="">Keine offenen Zeiten</option>';
  const k = kunden.find(k => k.key === $('#aKunde').value);
  $('#aGruppe').value = cfg.gruppe; $('#aTakt').value = String(cfg.takt); $('#aRundung').value = cfg.rundung;
  $('#aTakt').disabled = cfg.rundung === 'exakt';
  $('#aRundHinweis').innerHTML = cfg.rundung === 'auf' ? (cfg.takt >= 15
    ? `<div class="notice err"><b>Achtung:</b> Das Aufrunden auf ${cfg.takt} Minuten ist als AGB-Klausel laut BGH (IX ZR 140/19) gegenüber Verbrauchern und laut OLG Düsseldorf (24 U 65/22) auch gegenüber Unternehmen unwirksam. Verwende es nur bei ausdrücklicher Einzelvereinbarung mit dem Kunden.</div>`
    : `<div class="notice warn">Aufrunden auf ${cfg.takt} Minuten ist nicht höchstrichterlich geklärt. Verwende es nur, wenn es mit dem Kunden vereinbart ist.</div>`)
    : cfg.rundung === 'kaufm' && cfg.takt >= 15 ? `<div class="notice warn">Kaufmännisches Runden auf ${cfg.takt} Minuten kann zu Ungunsten des Kunden aufrunden. Minutengenau ist rechtlich am sichersten.</div>` : '';
  const von = $('#aVon').value, bis = $('#aBis').value;
  const im = (k?.eintraege || []).filter(e => { const d = e.start.slice(0, 10); return (!von || d >= von) && (!bis || d <= bis); })
    .sort((a, b) => a.start.localeCompare(b.start));

  $('#aEintraege').innerHTML = im.length ? `<div class="tablewrap"><table>
    <thead><tr><th><input type="checkbox" id="aAlle" ${im.every(e => !abwahl.has(e.id)) ? 'checked' : ''} aria-label="Alle"></th><th>Datum</th><th>Projekt / Tätigkeit</th><th class="r">Dauer</th></tr></thead>
    <tbody>${im.map(e => { const p = projekt(e.projekt_id); return `<tr>
      <td><input type="checkbox" data-wahl="${esc(e.id)}" ${abwahl.has(e.id) ? '' : 'checked'}></td>
      <td class="num">${dDE(e.start.slice(0, 10))}<div class="hint">${zeit(e.start)}–${zeit(e.ende)}</div></td>
      <td>${esc(p.name)}<div class="hint">${esc(e.text || '')}</div></td>
      <td class="r">${stdFmt(dauerMin(e))}</td></tr>`; }).join('')}</tbody></table></div>`
    : '<div class="empty">Keine offenen Zeiten für diese Auswahl.</div>';
  $$('[data-wahl]').forEach(c => c.addEventListener('change', () => { c.checked ? abwahl.delete(c.dataset.wahl) : abwahl.add(c.dataset.wahl); renderAbrechnen(); }));
  $('#aAlle')?.addEventListener('change', ev => { im.forEach(e => ev.target.checked ? abwahl.delete(e.id) : abwahl.add(e.id)); renderAbrechnen(); });

  const gewaehlt = im.filter(e => !abwahl.has(e.id));
  const pos = positionen(gewaehlt, cfg.gruppe, cfg.takt);
  const ohneSatz = pos.some(p => !p.preis);
  const summe = pos.reduce((s, p) => s + p.netto, 0);
  $('#aVorschau').innerHTML = pos.length ? `<div class="tablewrap"><table>
    <thead><tr><th>Bezeichnung</th><th class="r">Menge</th><th class="r">Preis</th><th class="r">Netto</th></tr></thead>
    <tbody>${pos.map(p => `<tr><td>${esc(p.bezeichnung)}<div class="hint">${STEUER[p.steuer]}${Math.abs(p.menge * 60 - p.minIst) > 0.5 ? ` · erfasst ${stdFmt(p.minIst)}` : ''}</div></td>
      <td class="r">${dezFmt(p.menge)} Std.</td><td class="r">${eur(p.preis)}</td><td class="r">${eur(p.netto)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="3">Summe netto</td><td class="r">${eur(summe)}</td></tr></tfoot></table></div>
    ${ohneSatz ? '<div class="notice warn">Mindestens ein Projekt hat keinen Stundensatz. Die Position wird mit 0 € übertragen.</div>' : ''}
    ${k && !k.kunde_id ? `<div class="notice">Der Kunde „${esc(k.name)}“ ist nicht mit der Buchhaltung verknüpft. Die Buchhaltung sucht ihn per Namen und legt ihn neu an, wenn sie ihn nicht findet.</div>` : ''}`
    : '<div class="empty">Keine Positionen.</div>';
  $('#aSenden').disabled = !pos.length || !cfg.bh.token || !k || k.name === 'Ohne Kunde';
  $('#aErgebnis').innerHTML = letztesErgebnis;
  renderRechnungen();
}
['#aKunde', '#aVon', '#aBis'].forEach(s => $(s).addEventListener('change', () => { abwahl.clear(); letztesErgebnis = ''; renderAbrechnen(); }));
$('#aGruppe').addEventListener('change', e => { cfg.gruppe = e.target.value; saveCfg(); renderAbrechnen(); });
$('#aTakt').addEventListener('change', e => { cfg.takt = Number(e.target.value); saveCfg(); renderAbrechnen(); });
$('#aRundung').addEventListener('change', e => { cfg.rundung = e.target.value; saveCfg(); renderAbrechnen(); });

$('#aSenden').addEventListener('click', async () => {
  const k = offeneNachKunde().find(k => k.key === $('#aKunde').value);
  if (!k) return;
  const von = $('#aVon').value, bis = $('#aBis').value;
  const gewaehlt = k.eintraege.filter(e => { const d = e.start.slice(0, 10); return (!von || d >= von) && (!bis || d <= bis) && !abwahl.has(e.id); });
  const pos = positionen(gewaehlt, cfg.gruppe, cfg.takt);
  if (!pos.length) return;
  const tage = gewaehlt.map(e => e.start.slice(0, 10)).sort();
  const zr = tage[0] === tage[tage.length - 1] ? dDE(tage[0]) : `${dDE(tage[0])} – ${dDE(tage[tage.length - 1])}`;
  const summe = pos.reduce((s, p) => s + p.netto, 0);
  if (!confirm(`Rechnungsentwurf für ${k.name} anlegen?\n\n${pos.length} Position(en), ${eur(summe)} netto\nLeistungszeitraum: ${zr}\n\nDer Entwurf erhält erst beim Stellen in der Buchhaltung eine Nummer.`)) return;
  const btn = $('#aSenden'); btn.disabled = true; btn.textContent = 'Wird übertragen …';
  try {
    const body = {
      ...(k.kunde_id ? { kunde_id: k.kunde_id } : { kunde: { firma: k.name } }),
      leistungsdatum: tage[tage.length - 1],
      bemerkung: `Leistungszeitraum: ${zr}\nAbrechnung nach Zeitaufwand, ${cfg.rundung === 'exakt' ? 'minutengenau' : `je Position im ${cfg.takt}-Minuten-Takt ${RUNDUNG[cfg.rundung]}`}.`,
      positionen: pos.map(p => ({ bezeichnung: p.bezeichnung, menge: p.menge, einheit: p.einheit, preis: p.preis, ...(p.steuer ? { steuer: p.steuer } : {}) })),
    };
    const j = await bh('/api/rechnungen', { method: 'POST', body: JSON.stringify(body) });
    const r = { id: j.rechnung_id, status: 'entwurf', nummer: null, datum: heute(), netto: j.netto_cents / 100, url: j.url };
    for (const e of gewaehlt) upsert('eintraege', { ...e, rechnung: r });
    if (j.kunde_neu || !k.kunde_id) {   // Kunde nun in der Buchhaltung -> Projekte verknüpfen
      for (const p of lebend(S.projekte)) if (kundeKey(p) === k.key) upsert('projekte', { ...p, kunde_id: j.kunde_id });
    }
    abwahl.clear();
    letztesErgebnis = `<div class="notice ok">✓ Rechnungsentwurf #${j.rechnung_id} für ${esc(k.name)} angelegt (${eur(j.netto_cents / 100)} netto, ${eur(j.brutto_cents / 100)} brutto)${j.kunde_neu ? ', Kunde wurde neu angelegt' : ''}.
      <div class="actions"><a class="btn primary" href="${esc(j.url)}" target="_blank" rel="noopener">In der Buchhaltung öffnen</a></div></div>`;
    speichern(true);
  } catch (e) {
    letztesErgebnis = `<div class="notice err">${esc(e.message)}</div>`; renderAbrechnen();
  } finally {
    btn.textContent = 'Rechnungsentwurf in Buchhaltung anlegen';
  }
});

function rechnungenListe() {
  const map = new Map();
  for (const e of eintraege()) {
    if (!e.rechnung) continue;
    const r = map.get(e.rechnung.id) || { ...e.rechnung, ids: [], min: 0, kunde: kundeName(projekt(e.projekt_id)) };
    if ((e.updated || 0) > (r._u || 0)) Object.assign(r, e.rechnung, { _u: e.updated });
    r.ids.push(e.id); r.min += dauerMin(e); map.set(e.rechnung.id, r);
  }
  return [...map.values()].sort((a, b) => (b.datum || '').localeCompare(a.datum || '') || b.id - a.id);
}
function renderRechnungen() {
  const rs = rechnungenListe().slice(0, 30);
  $('#aRechnungen').innerHTML = rs.length ? rs.map(r => {
    const cls = { entwurf: 'warn', offen: 'accent', bezahlt: 'ok', geloescht: '', storniert: '' }[r.status] || '';
    return `<div class="item" style="cursor:default">
      <span class="main"><span class="title">${esc(r.nummer || 'Entwurf #' + r.id)} · ${esc(r.kunde)}</span>
      <span class="meta">${dDE(r.datum)} · ${r.ids.length} Einträge · ${stdFmt(r.min)} <span class="badge ${cls}">${RSTATUS[r.status] || r.status}</span></span></span>
      <span class="right">${r.netto != null ? `<b>${eur(r.netto)}</b>` : ''}
      ${['geloescht', 'storniert'].includes(r.status) ? `<button class="btn ghost" type="button" data-freigeben="${r.id}">Zeiten freigeben</button>` : ''}</span></div>`;
  }).join('') : '<div class="empty">Noch keine Rechnungen aus der Zeiterfassung.</div>';
  $$('[data-freigeben]').forEach(b => b.addEventListener('click', () => {
    if (!confirm('Die Zeiten dieser Rechnung werden wieder als „nicht abgerechnet“ markiert. Fortfahren?')) return;
    for (const e of eintraege()) if (e.rechnung && String(e.rechnung.id) === b.dataset.freigeben) upsert('eintraege', { ...e, rechnung: null });
    speichern(true);
  }));
}

let statusZuletzt = 0;
async function rechnungsStatus(still = false) {
  if (!cfg.bh.token || (still && Date.now() - statusZuletzt < 60e3)) return;
  const offen = rechnungenListe().filter(r => !['bezahlt', 'geloescht', 'storniert'].includes(r.status));
  if (!offen.length) return;
  statusZuletzt = Date.now();
  try {
    const j = await bh('/api/rechnungen/status', { method: 'POST', body: JSON.stringify({ ids: offen.map(r => r.id) }) });
    let n = 0;
    for (const r of offen) {
      const neu = j.rechnungen[String(r.id)];
      const upd = neu ? { status: neu.status, nummer: neu.nummer, netto: neu.netto_cents / 100 } : { status: 'geloescht' };
      if (upd.status === r.status && (upd.nummer || null) === (r.nummer || null)) continue;
      n++;
      for (const e of eintraege()) if (e.rechnung && e.rechnung.id === r.id) upsert('eintraege', { ...e, rechnung: { ...e.rechnung, ...upd } });
    }
    if (n) speichern(); else if (!still) toast('Status ist aktuell.');
  } catch (e) { if (!still) toast(e.message); }
}
$('#aStatusBtn').addEventListener('click', () => rechnungsStatus(false));

// ------------------------------------------------------------------ Projekte
function renderProjekte() {
  const ps = projekte();
  $('#projektListe').innerHTML = ps.length ? ps.map(p => {
    const offen = eintraege().filter(e => e.projekt_id === p.id && e.ende && !e.rechnung).reduce((s, e) => s + dauerMin(e), 0);
    return `<button class="item${p.aktiv ? '' : ' inactive'}" type="button" data-projekt="${esc(p.id)}">
      <span class="swatch" style="background:${farbe(p)}"></span>
      <span class="main"><span class="title">${esc(p.name)}</span>
      <span class="meta">${esc(p.kunde || 'Ohne Kunde')} ${p.kunde_id ? '<span class="badge ok">verknüpft</span>' : p.kunde ? '<span class="badge warn">nicht verknüpft</span>' : ''} ${p.aktiv ? '' : '<span class="badge">inaktiv</span>'}</span></span>
      <span class="right"><b>${p.satz ? eur(p.satz) + '/h' : '–'}</b><span class="meta">${offen ? stdFmt(offen) + ' offen' : ''}</span></span></button>`;
  }).join('') : '<div class="empty">Noch keine Projekte.</div>';
  $$('[data-projekt]').forEach(b => b.addEventListener('click', () => projektDialog(projekt(b.dataset.projekt))));
}

// ------------------------------------------------------------------ Einstellungen
function fuelle(form, obj) { for (const el of form.elements) if (el.name && el.name in obj) el.value = obj[el.name] ?? ''; }
function renderEinstellungen() {
  if (document.activeElement?.closest('#tab-einstellungen form')) return;   // nicht beim Tippen überschreiben
  fuelle($('#formAllg'), cfg);
  fuelle($('#formSync'), cfg.sync);
  fuelle($('#formBh'), cfg.bh);
  $('#formSync .webdav').style.display = cfg.sync.modus === 'webdav' || (cfg.sync.modus === 'auto' && !LOKAL) ? '' : 'none';
  $('#syncInfo').textContent = (cfg.sync.modus === 'auto'
    ? (LOKAL ? 'Automatisch: Am PC wird über den lokalen Nextcloud-Ordner synchronisiert. ' : 'Automatisch: Nextcloud direkt, sobald die Zugangsdaten eingetragen sind. ')
    : '') + (cfg.letzteSync ? 'Letzter Abgleich: ' + new Date(cfg.letzteSync).toLocaleString('de-DE') + '.' : 'Noch nicht synchronisiert.');
  const n = { p: lebend(S.projekte).length, e: eintraege().length, k: lebend(S.kunden).length };
  $('#datenInfo').textContent = `${n.e} Einträge, ${n.p} Projekte, ${n.k} Kunden aus der Buchhaltung`;
  renderInfo();
}

async function renderInfo() {
  let offline = 'nicht aktiv';
  try {
    const keys = 'caches' in window ? await caches.keys() : [];
    const c = keys.find(k => k.startsWith('zeiterfassung-v'));
    if (navigator.serviceWorker?.controller && c) offline = 'aktiv (Cache ' + c.replace('zeiterfassung-', '') + ')';
  } catch { /* egal */ }
  const zeilen = [
    ['App-Version', `${APP_VERSION} (Stand ${APP_STAND})`],
    ['Offline-Betrieb', offline],
    ['Installiert als App', matchMedia('(display-mode: standalone)').matches ? 'ja' : 'nein (im Browser geöffnet)'],
    ['Adresse', location.origin + location.pathname],
    ['Gerät', `${cfg.geraet_name} · ID ${cfg.geraet_id.slice(0, 8)}`],
    ['Letzter Abgleich', cfg.letzteSync ? new Date(cfg.letzteSync).toLocaleString('de-DE') : '–'],
  ];
  $('#infoListe').innerHTML = zeilen.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

$('#updateBtn').addEventListener('click', async () => {
  const info = $('#updateInfo');
  info.textContent = 'Suche …';
  try {
    const t = await (await fetch('app.js?' + Date.now(), { cache: 'no-store' })).text();
    const online = (t.match(/APP_VERSION = '([^']+)'/) || [])[1];
    if (!online) throw new Error('Version online nicht lesbar.');
    if (online === APP_VERSION) { info.textContent = `✓ Aktuell – Version ${APP_VERSION} ist die neueste.`; return; }
    info.textContent = `Version ${online} verfügbar – wird geladen …`;
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.update();          // neuer Service Worker übernimmt und lädt die Seite neu
    setTimeout(() => location.reload(), 4000);
  } catch (e) { info.textContent = '✗ ' + (navigator.onLine ? e.message : 'Offline – Update-Suche nicht möglich.'); }
});
$('#formAllg').addEventListener('change', e => { cfg.geraet_name = e.currentTarget.geraet_name.value.trim() || cfg.geraet_name; saveCfg(); planeSync(); });
$('#formSync').addEventListener('change', e => {
  const f = e.currentTarget;
  f.url.value = ncUrl(f.url.value);   // korrigierte Adresse gleich anzeigen
  Object.assign(cfg.sync, { modus: f.modus.value, url: f.url.value, user: f.user.value.trim(), pass: f.pass.value, ordner: f.ordner.value.trim() || 'Zeiterfassung-Daten' });
  cfg.etags = {}; lokalVerfuegbar = null; saveCfg();
  $('#formSync .webdav').style.display = cfg.sync.modus === 'webdav' || (cfg.sync.modus === 'auto' && !LOKAL) ? '' : 'none';
  planeSync(300);
});
$('#formBh').addEventListener('change', e => {
  const f = e.currentTarget;
  cfg.bh = { url: f.url.value.trim() || 'http://127.0.0.1:5000', token: f.token.value.trim() }; saveCfg();
});
$$('form.card').forEach(f => f.addEventListener('submit', e => e.preventDefault()));
$('#syncTestBtn').addEventListener('click', async () => {
  $('#syncInfo').textContent = 'Teste …';
  try {
    const a = await adapter();
    if (!a) throw new Error('Keine Synchronisation eingerichtet.');
    const l = await a.list();
    $('#syncInfo').textContent = `✓ ${a.name} erreichbar, ${l.length} Gerätedatei(en) im Ordner.`;
    sync();
  } catch (e) { $('#syncInfo').textContent = '✗ ' + e.message; }
});
$('#bhTestBtn').addEventListener('click', async () => {
  $('#bhInfo').textContent = 'Verbinde …';
  try {
    const r = await kundenLaden();
    $('#bhInfo').textContent = `✓ Verbunden mit „${r.firma}“: ${r.anzahl} Kunden geladen (${r.neu} neu/geändert).`;
  } catch (e) { $('#bhInfo').textContent = '✗ ' + e.message; }
});
$('#backupBtn').addEventListener('click', () => download(`Zeiterfassung_Sicherung_${heute()}.json`,
  JSON.stringify({ format: 1, gespeichert: new Date().toISOString(), projekte: S.projekte, eintraege: S.eintraege, kunden: S.kunden }, null, 1), 'application/json'));
$('#importFile').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.eintraege)) throw new Error('Keine Zeiterfassungs-Sicherung.');
    merge(d); speichern(true); toast('Sicherung eingelesen und zusammengeführt.');
  } catch (err) { alert('Einlesen fehlgeschlagen: ' + err.message); }
  e.target.value = '';
});

// ------------------------------------------------------------------ Start
$('#syncBtn').addEventListener('click', () => sync());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { sync(); render(); } });
window.addEventListener('online', () => sync());
window.addEventListener('storage', ev => {        // zweites Fenster/Tab im selben Browser
  if (ev.key === 'ze_state') { Object.assign(S, lsGet('ze_state', {})); render(); }
});
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 60e3);

initFilter();
zeigeTab((() => {
  const h = location.hash.slice(1);
  if ($('#tab-' + h)) { history.replaceState(null, '', location.pathname); return h; }   // z. B. App-Verknüpfung „Abrechnen“
  try { return sessionStorage.getItem('ze_tab') || 'erfassen'; } catch { return 'erfassen'; }
})());
sync();
if (LOKAL && cfg.bh.token) kundenLaden().catch(() => {});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || LOKAL)) {
  // Übernimmt ein neuer Service Worker (Update), Seite einmal neu laden – dann läuft sofort die neue Version
  const hatteController = !!navigator.serviceWorker.controller;
  let neuGeladen = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hatteController && !neuGeladen && !$('#dlg').open) { neuGeladen = true; location.reload(); }
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}
