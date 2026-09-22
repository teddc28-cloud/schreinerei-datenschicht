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

function reichtsTile(r) {
  const breite = r.quote_prozent === null ? 0 : Math.min(100, r.quote_prozent);
  return `
    <div class="tile ampel-tile ampel-tile-${r.ampel}">
      <h2>Reicht's diesen Monat?</h2>
      <p class="value"><span class="ampel-dot ${r.ampel}"></span>${eur(r.fakturiert_eur)}</p>
      <p class="compare">von ${eur(r.break_even_eur)} Break-Even${r.quote_prozent === null ? '' : ` (${r.quote_prozent.toFixed(0)} %)`}</p>
      <div class="progress-bar"><div class="progress-bar-fill ${r.ampel}" style="width:${breite}%"></div></div>
      <p class="footnote">Schnitt letzte 3 volle Monate: ${eur(r.schnitt_letzte_3_monate_eur)}</p>
    </div>
  `;
}

function werkstattTile(w) {
  const rows = w.ueberschreitungen
    .map(
      (p) => `
    <div class="bucket-row">
      <span>${p.display_id ? `#${p.display_id} ` : ''}${p.name ?? 'Unbenannt'}</span>
      <span class="ampel-rot">+${p.abweichung_stunden.toFixed(1)} h (${p.ist_stunden.toFixed(1)} / ${p.soll_stunden.toFixed(1)})</span>
    </div>`
    )
    .join('');

  return `
    <div class="tile ampel-tile ampel-tile-${w.ampel}">
      <h2>Läuft die Werkstatt wirtschaftlich?</h2>
      <div class="stat-line">
        <div class="stat">
          <span class="stat-label">Soll-Ist-Quote (${w.anzahl_laufend} aktiv)</span>
          <span class="stat-value"><span class="ampel-dot ${w.ampel_soll_ist}"></span>${w.soll_ist_quote_prozent === null ? '–' : w.soll_ist_quote_prozent.toFixed(0) + ' %'}</span>
          <span class="footnote">Ziel unter ${w.ziel_soll_ist_prozent.toFixed(0)} %</span>
        </div>
        <div class="stat">
          <span class="stat-label">Stunden letzte Woche</span>
          <span class="stat-value"><span class="ampel-dot ${w.ampel_stunden}"></span>${w.stunden_letzte_woche.toFixed(0)} h</span>
          <span class="footnote">Ziel ${w.ziel_stunden_woche} h</span>
        </div>
      </div>
      ${rows ? `<div class="bucket-list">${rows}</div>` : ''}
    </div>
  `;
}

function geldTile(g) {
  const faelligkeit = g.naechste_faelligkeit
    ? `${new Date(g.naechste_faelligkeit.datum).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} · ${g.naechste_faelligkeit.bezeichnung} (${eur(g.naechste_faelligkeit.betrag_eur)})`
    : '<a href="/settings.html" class="empty-state-link">→ Fixkosten eintragen</a>';

  return `
    <div class="tile tile-wide">
      <h2>Reicht das Geld?</h2>
      <div class="stat-line">
        <div class="stat">
          <span class="stat-label">Kontostand</span>
          <span class="stat-value ${g.kontostand_eur < 0 ? 'small' : ''}" id="kontostand-anzeige">
            ${eur(g.kontostand_eur)} <button type="button" class="edit-inline-btn" id="kontostand-edit-btn" title="Kontostand ändern">✎</button>
          </span>
          <form id="kontostand-inline-form" class="inline-form" hidden>
            <input type="number" step="0.01" id="kontostand-inline-input" value="${g.kontostand_eur}" />
            <button type="submit">Speichern</button>
          </form>
        </div>
        <div class="stat">
          <span class="stat-label">Freier Rahmen Linie</span>
          <span class="stat-value small">${eur(g.freier_rahmen_eur)} / ${eur(g.kk_linie_eur)}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Forderungen fällig</span>
          <span class="stat-value small">${eur(g.forderungen_faellig_eur)}</span>
          <span class="footnote">davon ${eur(g.forderungen_ueberfaellig_eur)} überfällig</span>
        </div>
        <div class="stat">
          <span class="stat-label">Verbindlichkeiten fällig</span>
          <span class="stat-value small">${eur(g.verbindlichkeiten_faellig_eur)}</span>
          <span class="footnote">davon ${eur(g.verbindlichkeiten_ueberfaellig_eur)} überfällig</span>
        </div>
        <div class="stat">
          <span class="stat-label">Nächste Fälligkeit</span>
          <span class="stat-value small">${faelligkeit}</span>
        </div>
      </div>
    </div>
  `;
}

function pipelineTile(p) {
  const ampel = p.rot ? 'rot' : 'gruen';
  const chip = (label, prozent) => {
    if (prozent === null) return `<span class="delta-chip">${label}: k.A.</span>`;
    const richtung = prozent >= 0 ? 'up' : 'down';
    const pfeil = prozent >= 0 ? '↑' : '↓';
    return `<span class="delta-chip ${richtung}">${label}: ${pfeil} ${Math.abs(prozent).toFixed(0)} %</span>`;
  };

  return `
    <div class="tile tile-wide ampel-tile ampel-tile-${ampel}">
      <h2>Kommt noch was rein? — rollierend 3 Monate</h2>
      <div class="stat-line">
        <div class="stat">
          <span class="stat-label">Angebote raus</span>
          <span class="stat-value">${p.angebote.anzahl}</span>
          <span class="footnote">${eur(p.angebote.volumen_eur)}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Auftragseingang</span>
          <span class="stat-value"><span class="ampel-dot ${ampel}"></span>${p.auftragseingang.anzahl}</span>
          <span class="footnote">${eur(p.auftragseingang.volumen_eur)} / Schwelle ${eur(p.ampel_schwelle_eur)}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Wandlungsquote</span>
          <span class="stat-value">${p.wandlungsquote_prozent === null ? '–' : p.wandlungsquote_prozent.toFixed(0) + ' %'}</span>
        </div>
      </div>
      <div class="mini-compare">
        <span class="footnote">Auftragseingang-Volumen ggü.</span>
        ${chip('3 Monate davor', p.vergleich_vorher_prozent)}
        ${chip('Vorjahr', p.vergleich_vorjahr_prozent)}
      </div>
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

  document.getElementById('tiles-ueberblick').innerHTML =
    reichtsTile(data.reichts) + werkstattTile(data.werkstatt) + geldTile(data.geld) + pipelineTile(data.pipeline);
  wireKontostandEdit();

  document.getElementById('tiles').innerHTML =
    forderungenTile(data.forderungen) +
    ustTile(data.ust) +
    rohgewinnTile(data.rohgewinn) +
    projektampelnTile(data.projektampeln) +
    liquiditaetTile(data.liquiditaet);
}

function wireKontostandEdit() {
  const anzeige = document.getElementById('kontostand-anzeige');
  const editBtn = document.getElementById('kontostand-edit-btn');
  const form = document.getElementById('kontostand-inline-form');
  const input = document.getElementById('kontostand-inline-input');
  if (!editBtn || !form) return;

  editBtn.addEventListener('click', () => {
    anzeige.hidden = true;
    form.hidden = false;
    input.focus();
    input.select();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await fetch('/api/settings/kontostand', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: input.value }),
    });
    load();
  });
}

load();
setInterval(load, 5 * 60 * 1000);
