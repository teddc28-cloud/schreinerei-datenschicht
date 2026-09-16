async function loadSettings() {
  const res = await fetch('/api/settings');
  if (res.status === 401) {
    window.location.href = '/login.html';
    return;
  }
  const data = await res.json();
  document.getElementById('kontostand-input').value = data.kontostand;
  renderParameters(data.parameter);
  renderFixedCosts(data.fixed_costs);
}

function renderParameters(rows) {
  const body = document.getElementById('parameter-body');
  body.innerHTML = rows
    .map(
      (p) => `
    <tr data-key="${p.key}">
      <td>${p.key}</td>
      <td><input type="text" class="p-value" value="${p.value}" /></td>
      <td class="footnote">${p.beschreibung ?? ''}</td>
      <td><button class="save-param">Speichern</button></td>
    </tr>`
    )
    .join('');

  body.querySelectorAll('tr').forEach((tr) => {
    const key = tr.dataset.key;
    tr.querySelector('.save-param').addEventListener('click', async () => {
      const value = tr.querySelector('.p-value').value;
      await fetch(`/api/settings/parameter/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      const btn = tr.querySelector('.save-param');
      const original = btn.textContent;
      btn.textContent = 'Gespeichert.';
      setTimeout(() => (btn.textContent = original), 1500);
    });
  });
}

function renderFixedCosts(rows) {
  const body = document.getElementById('fixed-costs-body');
  body.innerHTML = rows
    .map(
      (r) => `
    <tr data-id="${r.id}">
      <td><input type="text" class="f-bezeichnung" value="${r.bezeichnung}" /></td>
      <td><input type="number" step="0.01" class="f-betrag" value="${r.betrag}" /></td>
      <td><input type="number" min="1" max="31" class="f-tag" value="${r.tag_im_monat}" /></td>
      <td><input type="checkbox" class="f-aktiv" ${r.aktiv ? 'checked' : ''} /></td>
      <td>
        <button class="save-row">Speichern</button>
        <button class="delete-row">Löschen</button>
      </td>
    </tr>`
    )
    .join('');

  body.querySelectorAll('tr').forEach((tr) => {
    const id = tr.dataset.id;
    tr.querySelector('.save-row').addEventListener('click', async () => {
      const bezeichnung = tr.querySelector('.f-bezeichnung').value;
      const betrag = tr.querySelector('.f-betrag').value;
      const tag_im_monat = tr.querySelector('.f-tag').value;
      const aktiv = tr.querySelector('.f-aktiv').checked;
      await fetch(`/api/settings/fixed-costs/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bezeichnung, betrag, tag_im_monat, aktiv }),
      });
      loadSettings();
    });
    tr.querySelector('.delete-row').addEventListener('click', async () => {
      if (!confirm('Diese Fixkosten-Zeile wirklich löschen?')) return;
      await fetch(`/api/settings/fixed-costs/${id}`, { method: 'DELETE' });
      loadSettings();
    });
  });
}

document.getElementById('kontostand-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = document.getElementById('kontostand-input').value;
  await fetch('/api/settings/kontostand', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  const hint = document.getElementById('kontostand-saved');
  hint.hidden = false;
  setTimeout(() => (hint.hidden = true), 2000);
});

document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  await fetch('/api/settings/fixed-costs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bezeichnung: form.get('bezeichnung'),
      betrag: form.get('betrag'),
      tag_im_monat: form.get('tag_im_monat'),
    }),
  });
  e.target.reset();
  loadSettings();
});

loadSettings();
