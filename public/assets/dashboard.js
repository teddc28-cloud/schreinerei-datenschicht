const eur = (n) => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const pct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(1)} %`;
const MONATE = ['', 'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function renderStatus(status) {
  const el = document.getElementById('sync-status');
  if (!status.last_success) {
    el.textContent = 'Noch kein erfolgreicher Sync';
    el.classList.add('red');
    return;
  }
  const d = new Date(status.last_success);
  el.textContent = `Letzter Sync: ${d.toLocaleString('de-DE')}`;
  el.classList.toggle('red', status.red);
}

function umsatzTile(u) {
  const richtung = u.differenz_eur >= 0 ? 'up' : 'down';
  const vergleich = u.differenz_prozent === null
    ? 'kein Vorjahreswert'
    : `${pct(u.differenz_prozent)} (${eur(u.differenz_eur)}) ggü. Vorjahresmonat`;

  return `
    <div class="tile">
      <h2>Umsatz laufender Monat (netto)</h2>
      <p class="value">${eur(u.umsatz_netto_eur)}</p>
      <p class="compare ${richtung}">${vergleich}</p>
      <p class="footnote">Basis: Rechnungsdatum, Ausgangsrechnungen netto</p>
    </div>
  `;
}

function forderungenTile(f) {
  const b = f.buckets;
  const row = (label, key) => `
    <div class="bucket-row">
      <span>${label}</span>
      <span>${b[key].anzahl} / ${eur(b[key].betrag)}</span>
    </div>`;

  return `
    <div class="tile">
      <h2>Offene Forderungen</h2>
      <p class="value">${eur(f.gesamt_eur)}</p>
      <p class="compare ${f.ueberfaellig_eur > 0 ? 'down' : ''}">
        davon überfällig: ${eur(f.ueberfaellig_eur)} (${f.ueberfaellig_anzahl} Rechnungen)
      </p>
      <div class="bucket-list">
        ${row('Nicht fällig', 'nicht_faellig')}
        ${row('Bis 14 Tage', 'bis_14')}
        ${row('15–30 Tage', '15_30')}
        ${row('31–60 Tage', '31_60')}
        ${row('Über 60 Tage', 'ueber_60')}
      </div>
      <p class="footnote">${f.gesamt_anzahl} offene Rechnungen gesamt, Basis: Fälligkeitsdatum</p>
    </div>
  `;
}

function ustTile(u) {
  const warnung = u.wenige_eingangsrechnungen
    ? `<p class="compare down">⚠ Nur ${u.anzahl_eingangsrechnungen} Eingangsrechnung(en) diesen Monat erfasst — Zahllast steht vermutlich zu hoch.</p>`
    : '';
  const istErstattung = u.zahllast_eur < 0;
  const label = istErstattung ? 'Vorsteuerüberhang (Erstattung)' : 'USt-Zahllast';
  const betrag = istErstattung ? Math.abs(u.zahllast_eur) : u.zahllast_eur;

  return `
    <div class="tile">
      <h2>${label} — fällig ${MONATE[u.faellig_monat]} ${u.faellig_jahr}</h2>
      <p class="value">${eur(betrag)}</p>
      <p class="compare">USt ${eur(u.ust_eur)} − Vorsteuer ${eur(u.vorsteuer_eur)}</p>
      ${warnung}
      <p class="footnote">Soll-Versteuerung, Basis: Rechnungs-/Belegdatum ${MONATE[u.monat]} ${u.jahr}. Einkommensteuer nicht enthalten.</p>
    </div>
  `;
}

function rohgewinnTile(r) {
  const richtung = r.differenz_eur >= 0 ? 'up' : 'down';
  const vergleich = r.differenz_prozent === null
    ? 'kein Vorjahreswert'
    : `${pct(r.differenz_prozent)} (${eur(r.differenz_eur)}) ggü. Vorjahresmonat`;

  return `
    <div class="tile">
      <h2>Rohgewinn laufender Monat</h2>
      <p class="value">${eur(r.rohgewinn_eur)}</p>
      <p class="compare ${richtung}">${vergleich}</p>
      <div class="bucket-list">
        <div class="bucket-row"><span>Umsatz netto</span><span>${eur(r.umsatz_eur)}</span></div>
        <div class="bucket-row"><span>− Material/Fremdleistungen</span><span>${eur(r.material_fremdleistungen_eur)}</span></div>
        <div class="bucket-row"><span>− Fertigungslöhne (${r.ist_stunden.toFixed(1)} h × ${eur(r.stundensatz_selbstkosten)})</span><span>${eur(r.fertigungsloehne_eur)}</span></div>
      </div>
      <p class="footnote">Nicht der steuerliche Gewinn — Miete, Leasing, Versicherungen, Verwaltung sind nicht enthalten.</p>
    </div>
  `;
}

function projektampelnTile(a) {
  if (a.anzahl_laufend === 0) {
    return `
      <div class="tile tile-wide">
        <h2>Projektampeln (Stunden)</h2>
        <p class="footnote">Keine Projekte im Status "In Umsetzung".</p>
      </div>
    `;
  }

  const projectRow = (p) => `
    <div class="bucket-row">
      <span>${p.display_id ? `#${p.display_id} ` : ''}${p.name ?? 'Unbenannt'}</span>
      <span class="${p.rot ? 'ampel-rot' : 'ampel-gruen'}">${p.prozent.toFixed(0)} % (${p.ist_stunden.toFixed(1)} / ${p.soll_stunden.toFixed(1)} h)</span>
    </div>`;

  return `
    <div class="tile tile-wide">
      <h2>Projektampeln (Stunden) — ${a.anzahl_laufend} laufend, rot ab ${a.schwelle_rot_prozent} %</h2>
      <div class="ampel-columns">
        <div>
          <p class="ampel-label">Top 5</p>
          ${a.top.map(projectRow).join('') || '<p class="footnote">Keine Daten</p>'}
        </div>
        <div>
          <p class="ampel-label">Flop 5</p>
          ${a.flop.map(projectRow).join('') || '<p class="footnote">Keine Daten</p>'}
        </div>
      </div>
      <p class="footnote">Nur Stunden-Ampel — Material-Ampel entfällt mangels projektbezogener Ist-Materialkosten in Hero. Ist-Stunden über gesamte Projektlaufzeit.</p>
    </div>
  `;
}

function liquiditaetTile(l) {
  const rows = l.wochen
    .map((w) => {
      const von = new Date(w.von).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
      const bis = new Date(w.bis).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
      const negativ = w.saldo_eur < 0;
      return `
        <div class="bucket-row">
          <span>KW ${w.kw} (${von}–${bis})</span>
          <span class="${negativ ? 'ampel-rot' : ''}">${eur(w.saldo_eur)}</span>
        </div>`;
    })
    .join('');

  return `
    <div class="tile tile-wide">
      <h2>Liquiditätsvorschau ${l.horizont_wochen} Wochen</h2>
      <p class="compare">Startwert Kontostand: ${eur(l.kontostand_eur)}</p>
      <div class="bucket-list">${rows}</div>
      <p class="footnote">+ offene Forderungen − offene Verbindlichkeiten − Fixkosten, jeweils auf Fälligkeit/Stichtag. Ohne Abschreibungen, Zinsanteile, Rückstellungen. Kontostand und Fixkosten unter Einstellungen pflegen.</p>
    </div>
  `;
}

async function load() {
  const res = await fetch('/api/dashboard');
  if (res.status === 401) {
    window.location.href = '/login.html';
    return;
  }
  const data = await res.json();
  renderStatus(data.status);
  document.getElementById('tiles').innerHTML =
    umsatzTile(data.umsatz) +
    forderungenTile(data.forderungen) +
    ustTile(data.ust) +
    rohgewinnTile(data.rohgewinn) +
    projektampelnTile(data.projektampeln) +
    liquiditaetTile(data.liquiditaet);
}

load();
setInterval(load, 5 * 60 * 1000);
