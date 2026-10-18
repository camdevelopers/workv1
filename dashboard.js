import { getDB, saveDB } from './db.js';
import { getNextInstance, getLastCompleted, isMissed } from './instances.js';
import { renderTaskCard, getDoer, getLatestStatus, getTransferredTo } from './actions.js';
//import { renderStockBar } from './stock-display.js';
import { renderDuration, renderLeaveBadge } from './polish.js';
import { getStock, renderStockBar } from './stock-display.js';   

// --- Toggle collapse ---
window.toggleSec = function(headerEl) {
  const sec = headerEl.parentElement;
  const body = sec.querySelector('.sec-body');
  const chevron = headerEl.querySelector('.chevron');
  const isOpen = sec.classList.contains('open');

  if (isOpen) {
    sec.classList.remove('open');
    body.style.display = 'none';
    chevron.textContent = '▸';
  } else {
    sec.classList.add('open');
    body.style.display = '';
    chevron.textContent = '▾';
  }
  const prefs = JSON.parse(localStorage.getItem('sec_prefs') || '{}');
  prefs[sec.id] = !isOpen;
  localStorage.setItem('sec_prefs', JSON.stringify(prefs));
};

function restorePrefs() {
  const prefs = JSON.parse(localStorage.getItem('sec_prefs') || '{}');
  for (const [id, shouldOpen] of Object.entries(prefs)) {
    const sec = document.getElementById(id);
    if (!sec) continue;
    const body = sec.querySelector('.sec-body');
    const chevron = sec.querySelector('.chevron');
    if (shouldOpen && !sec.classList.contains('open')) {
      sec.classList.add('open'); body.style.display = ''; chevron.textContent = '▾';
    } else if (!shouldOpen && sec.classList.contains('open')) {
      sec.classList.remove('open'); body.style.display = 'none'; chevron.textContent = '▸';
    }
  }
}

// --- Section 1: Attendance ---
function renderAttendance(currentUser) {
  const container = document.getElementById('attendance-content');
  const db = getDB();
  const today = new Date().toISOString().slice(0, 10);

  const res = db.exec(`SELECT checkin, checkout FROM attendance WHERE date = ? AND user = ?`, [today, currentUser]);
  let checkin = null, checkout = null;
  if (res.length > 0 && res[0].values.length > 0) {
    checkin = res[0].values[0][0];
    checkout = res[0].values[0][1];
  }

  const fmt = (t) => t ? new Date(`2000-01-01T${t}`).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';

  container.innerHTML = `
    <div class="attendance-row">
      <span>Check-in: <strong>${fmt(checkin)}</strong></span>
      <span>Check-out: <strong>${fmt(checkout)}</strong></span>
    </div>
    <div class="attendance-btns">
      ${!checkin ? '<button class="btn-checkin" onclick="doAttendance(\'checkin\')">Check In</button>' : ''}
      ${checkin && !checkout ? '<button class="btn-checkout" onclick="doAttendance(\'checkout\')">Check Out</button>' : ''}
      ${checkin && checkout ? '<span class="muted">Done for today</span>' : ''}
    </div>
  `;
}

window.doAttendance = async function(type) {
  const db = getDB();
  const user = localStorage.getItem('fe_user');
  const now = new Date().toTimeString().slice(0, 8);
  const today = new Date().toISOString().slice(0, 10);

  if (type === 'checkin') {
    db.run(`INSERT OR REPLACE INTO attendance (date, user, checkin, checkout) VALUES (?, ?, ?, NULL)`, [today, user, now]);
  } else {
    db.run(`UPDATE attendance SET checkout = ? WHERE date = ? AND user = ?`, [now, today, user]);
  }
  await saveDB();

  const { logAction } = await import('./app.js');
  await logAction(`att-${today}`, 'attendance', type, '');
  renderDashboard();
};

// --- Section 2: Office Presence ---
function renderPresence() {
  const container = document.getElementById('presence-content');
  const db = getDB();
  const today = new Date().toISOString().slice(0, 10);

  const attRes = db.exec(`SELECT user, checkin, checkout FROM attendance WHERE date = ?`, [today]);
  const leaveRes = db.exec(`SELECT user, type FROM leave WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)`, [today, today]);

  const fmt = (t) => t ? new Date(`2000-01-01T${t}`).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';

  const users = new Set();
  if (attRes.length > 0) attRes[0].values.forEach(v => users.add(v[0]));
  if (leaveRes.length > 0) leaveRes[0].values.forEach(v => users.add(v[0]));

  const attMap = {};
  if (attRes.length > 0) attRes[0].values.forEach(v => { attMap[v[0]] = { checkin: v[1], checkout: v[2] }; });
  const leaveMap = {};
  if (leaveRes.length > 0) leaveRes[0].values.forEach(v => { leaveMap[v[0]] = v[1]; });

  let rows = '';
  for (const user of [...users].sort()) {
    if (leaveMap[user]) {
      rows += `<div class="presence-row"><span class="p-name">${user}</span> <span class="badge badge-leave">On Leave (${leaveMap[user]})</span></div>`;
    } else if (attMap[user]?.checkin && attMap[user]?.checkout) {
      rows += `<div class="presence-row"><span class="p-name">${user}</span> <span class="badge badge-out">Out</span> <span class="muted">${fmt(attMap[user].checkin)} – ${fmt(attMap[user].checkout)}</span></div>`;
    } else if (attMap[user]?.checkin) {
      rows += `<div class="presence-row"><span class="p-name">${user}</span> <span class="badge badge-in">In</span> <span class="muted">since ${fmt(attMap[user].checkin)}</span></div>`;
    } else {
      rows += `<div class="presence-row"><span class="p-name">${user}</span> <span class="badge badge-absent">Absent</span></div>`;
    }
  }
  container.innerHTML = rows || '<p class="muted">No one logged yet today.</p>';
}

// --- Section 3: Missed ---
function renderMissed(tasks) {
  const container = document.getElementById('missed-content');
  let count = 0;

  for (const task of tasks) {
    const inst = getNextInstance(task);
    if (inst && isMissed(inst, task)) {
      const card = renderTaskCard(inst, task);
      card.classList.add('card-missed');
      container.appendChild(card);
      count++;
    }
  }
  if (count === 0) container.innerHTML = '<p class="muted">Nothing missed. 🎉</p>';
}

// --- Section 4: Current Tasks (one card per task) ---
function renderCurrentTasks(tasks) {
  const container = document.getElementById('current-content');
  let count = 0;

  for (const task of tasks) {
    // Stock tasks: always show card
    if (task.type === 'stock') {
      const card = document.createElement('div');
      card.className = 'task-card';

      const stock = getStock(task.task_id);
      const threshold = parseInt((task.recurrence || '').replace('threshold:', '')) || 0;
      if (stock > threshold) card.classList.add('card-inactive');

      const header = document.createElement('div');
      header.className = 'task-card-header';
      header.innerHTML = `<strong>${task.name}</strong> <span class="muted">(${task.assigned_user || 'unassigned'})</span>`;
      card.appendChild(header);
      card.appendChild(renderStockBar(task));
      container.appendChild(card);
      count++;
      continue;
    }

    // All other types: show next pending instance
    const inst = getNextInstance(task);
    if (!inst) continue;
    if (isMissed(inst, task)) continue; // shown in Missed section

    const card = renderTaskCard(inst, task);
    decorateCard(card, inst, task);
    container.appendChild(card);
    count++;
  }

  if (count === 0) container.innerHTML = '<p class="muted">Nothing to do right now.</p>';
}   
// --- Section 5: Completed (one card per task, last done) ---
function renderCompleted(tasks) {
  const container = document.getElementById('completed-content');
  let count = 0;

  for (const task of tasks) {
    const inst = getLastCompleted(task);
    if (!inst) continue;

    const card = renderTaskCard(inst, task);
    card.classList.add('card-completed');
    decorateCard(card, inst, task);
    container.appendChild(card);
    count++;
  }
  if (count === 0) container.innerHTML = '<p class="muted">Nothing completed yet.</p>';
}

// --- Section 6: Recurring (beyond 7d) ---
function renderRecurring(tasks) {
  const container = document.getElementById('recurring-content');
  let count = 0;
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + 7);

  for (const task of tasks) {
    if (task.type !== 'calendar') continue;
    const inst = getNextInstance(task);
    if (!inst) continue;
    if (new Date(inst.due_date) <= horizon) continue;

    const card = renderTaskCard(inst, task);
    decorateCard(card, inst, task);
    container.appendChild(card);
    count++;
  }
  if (count === 0) container.innerHTML = '<p class="muted">No recurring tasks beyond this week.</p>';
}

// --- Section 7: Notes ---
function renderNotes() {
  const container = document.getElementById('notes-content');
  const db = getDB();
  const res = db.exec(`SELECT note_id, author, ts, content FROM notes ORDER BY ts DESC LIMIT 10`);

  if (res.length === 0 || res[0].values.length === 0) {
    container.innerHTML = '<p class="muted">No notes yet.</p>';
    return;
  }
  container.innerHTML = res[0].values.map(v => {
    const [, author, ts, content] = v;
    const time = new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<div class="note-row"><span class="note-author">${author}</span> <span class="note-time">${time}</span><p>${content}</p></div>`;
  }).join('');
}

window.publishNote = async function() {
  const input = document.getElementById('note-input');
  const content = input.value.trim();
  if (!content) return;

  const db = getDB();
  const user = localStorage.getItem('fe_user');
  const ts = new Date().toISOString();
  const noteId = `n-${Date.now()}`;

  db.run(`INSERT INTO notes (note_id, author, ts, content) VALUES (?,?,?,?)`, [noteId, user, ts, content]);
  await saveDB();

  const { logAction } = await import('./app.js');
  await logAction(noteId, 'notes', 'note', content);

  input.value = '';
  renderNotes();
};

// --- Section 8: Paused / Retired ---
function renderPaused() {
  const container = document.getElementById('paused-content');
  const db = getDB();
  const res = db.exec(`SELECT task_id, name, retired FROM tasks WHERE retired = 1`);

  if (res.length === 0 || res[0].values.length === 0) {
    container.innerHTML = '<p class="muted">Nothing paused or retired.</p>';
    return;
  }
  container.innerHTML = res[0].values.map(v => {
    const [, name] = v;
    return `<div class="paused-row"><span>${name}</span> <span class="badge badge-retired">Retired</span></div>`;
  }).join('');
}

// --- Decorate a card with stock bar, duration, badges ---
function decorateCard(card, inst, task) {
  const header = card.querySelector('.task-card-header');

  const leaveBadge = renderLeaveBadge(task);
  if (leaveBadge && header) header.appendChild(leaveBadge);

  const transferTarget = getTransferredTo(inst.instance_id);
  if (transferTarget && header) {
    const el = document.createElement('span');
    el.className = 'transfer-label';
    el.textContent = `→ ${transferTarget}`;
    header.appendChild(el);
  }

  const duration = renderDuration(inst.instance_id, task);
  if (duration) card.appendChild(duration);

  if (task.type === 'stock') {
    card.appendChild(renderStockBar(task));
  }
}

// --- Master render ---
export function renderDashboard() {
  const db = getDB();
  const currentUser = localStorage.getItem('fe_user');

  const tasksRes = db.exec(`SELECT * FROM tasks WHERE retired = 0`);
  let tasks = [];
  if (tasksRes.length > 0) {
    const cols = tasksRes[0].columns;
    tasks = tasksRes[0].values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
  }

  ['attendance-content', 'presence-content', 'missed-content', 'current-content', 'completed-content', 'recurring-content', 'notes-content', 'paused-content']
    .forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });

  renderAttendance(currentUser);
  renderPresence();
  renderMissed(tasks);
  renderCurrentTasks(tasks);
  renderCompleted(tasks);
  renderRecurring(tasks);
  renderNotes();
  renderPaused();
}

export { restorePrefs };   
