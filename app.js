import { initDB, getDB, saveDB, getUserIndex, setUserIndex, getLastSHA, setLastSHA, getPending, setPending, applyEventRow } from './db.js';
//import { getLatestSHA, listChanges, fetchFileContent, pushFile } from './git.js';
import { setSyncStatus, setPendingCount } from './ui.js';
//import { getUpcomingInstances, isMissed } from './instances.js';
import { getNextInstance, getLastCompleted, isMissed } from './instances.js';   
import { getLatestSHA, listChanges, fetchFileContent, pushFile, listDir } from './git.js';   
//import { getDB } from './db.js';

//import { renderTaskCard, getUpcomingInstances } from './instances.js';
import { renderTaskCard as renderCard } from './actions.js';
import { renderDashboard } from './dashboard.js';

import { initTaskCreatePage } from './task-create.js';
import { showLeaveModal } from './leave.js';
import { initExpensesPage } from './expenses.js';

 
window.getDB = getDB;
window.renderDashboard = renderDashboard;
window.saveDB = saveDB;





let currentUser = null;
let pollTimer = null;

// --- Router ---
//const pages = ['dashboard', 'task-create', 'task-detail', 'maintenance'];
const pages = ['dashboard', 'task-create', 'task-detail', 'maintenance', 'expenses'];   

export function showPage(name) {
  pages.forEach(p => {
    document.getElementById(`page-${p}`).style.display = p === name ? '' : 'none';
  });
  history.pushState(name, '');
  if (name === 'expenses') initExpensesPage();
}

// --- Login ---
function initLogin() {
  const btn = document.getElementById('login-btn');
  btn.addEventListener('click', async () => {
    const user = document.getElementById('login-user').value.trim();
    const token = document.getElementById('login-token').value.trim();
    if (!user || !token) return;

    // Validate token by hitting GitHub API
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'office-pwa' }
      });
      if (!res.ok) throw new Error('Invalid PAT');
    } catch (e) {
      document.getElementById('login-error').textContent = 'Invalid token. Check and retry.';
      return;
    }

    localStorage.setItem('fe_token', token);
    localStorage.setItem('fe_user', user);
    currentUser = user;
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = '';
    document.getElementById('user-label').textContent = user;

    await startApp();
  });
}

// --- App startup ---
async function startApp() {
  await initDB();
  await doPull();
  await doPushPending();
  startPolling();
  initNav();
 document.getElementById('signout-btn').addEventListener('click', () => {
  localStorage.removeItem('fe_token');
  localStorage.removeItem('fe_user');
  location.reload();
});   
  initTaskCreatePage();
 // restorePrefs();   TODO
  renderDashboard();

}

// --- Pull: check for new commits, fetch new CSVs, apply ---
async function doPull() {
  setSyncStatus('⏳ Checking…');
  try {
    const remoteSHA = await getLatestSHA();
    const localSHA = await getLastSHA();

    if (remoteSHA === localSHA) {
      setSyncStatus('✅ Synced');
      return;
    }

    const db = getDB();
    let applied = 0;

    // --- Pull changes/ (event CSVs) ---
    const files = await listChanges();
    const index = await getUserIndex();

    for (const filename of files) {
      const match = filename.match(/^(.+)_(\d+)\.csv$/);
      if (!match) continue;
      const [, fileUser, seqStr] = match;
      const seq = parseInt(seqStr, 10);
      const lastSeen = index[fileUser] || 0;

      if (seq <= lastSeen) continue;

      const content = await fetchFileContent(`changes/${filename}`);
      const lines = content.trim().split('\n');

      for (let i = 1; i < lines.length; i++) {
        const fields = lines[i].split('|');
        if (fields.length >= 6) {
          applyEventRow(fields);
          applied++;
        }
      }

      index[fileUser] = seq;
    }

    await setUserIndex(index);

    // --- Pull tasks/ (task definitions) ---
    const taskFiles = await listDir('tasks');
    for (const filename of taskFiles) {
      if (!filename.endsWith('.csv')) continue;
      const taskId = filename.replace('.csv', '');
      const exists = db.exec(`SELECT 1 FROM tasks WHERE task_id = ?`, [taskId]);
      if (exists.length > 0) continue;

      const content = await fetchFileContent(`tasks/${filename}`);
      const lines = content.trim().split('\n');
      const header = lines[0].split('|');
      const values = lines[1].split('|');
      const obj = Object.fromEntries(header.map((h, i) => [h, values[i]]));

      db.run(
        `INSERT OR IGNORE INTO tasks (task_id, name, type, recurrence, assigned_user, exempt_days, grace_min, show_all_instances, track_time, retired, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [obj.task_id, obj.name, obj.type, obj.recurrence, obj.assigned_user || '', obj.exempt_days || '', parseInt(obj.grace_min) || 0, parseInt(obj.show_all_instances) || 1, parseInt(obj.track_time) || 0, 0, new Date().toISOString()]
      );
      applied++;
    }

    // --- Save & update ---
    await setLastSHA(remoteSHA);
    if (applied > 0) await saveDB();

    setSyncStatus(`✅ Synced (${applied} new)`);
    renderDashboard();
  } catch (e) {
    setSyncStatus(`❌ ${e.message}`, 'error');
    console.error('Pull failed:', e);
  }
}   

// --- Push: send pending local changes ---
async function doPushPending() {
  const pending = await getPending();
  if (pending.length === 0) return;

  const user = currentUser;
  let success = 0;

  for (const item of pending) {
    const seq = item.seq;
    const filename = `${user}_${String(seq).padStart(4, '0')}.csv`;
    const content = `ts|instance_id|task_id|action|user|note\n${item.line}`;

    try {
      await pushFile(`changes/${filename}`, content, `${user}: ${item.line.split('|')[3]} ${item.line.split('|')[1]}`);
      success++;
    } catch (e) {
      console.error(`Push ${filename} failed:`, e);
      break; // stop on first failure, retry later
    }
  }

  if (success > 0) {
    const remaining = pending.slice(success);
    await setPending(remaining);
    // Update local counter
    const newIndex = parseInt(pending[success - 1].seq, 10);
    const index = await getUserIndex();
    index[user] = newIndex;
    await setUserIndex(index);
  }

  const count = await getPending();
  setPendingCount(count.length);
  if (count.length === 0) setSyncStatus('✅ Synced');
}

// --- Log a local action (queues for push) ---
export async function logAction(instance_id, task_id, action, note = '') {
  const ts = new Date().toISOString().replace(/\.\d+Z$/, '');
  const index = await getUserIndex();
  const seq = (index[currentUser] || 0) + 1;
  const line = `${ts}|${instance_id}|${task_id}|${action}|${currentUser}|${note}`;

  const pending = await getPending();
  pending.push({ seq: String(seq).padStart(4, '0'), line });
  await setPending(pending);

  // Also apply locally so UI reflects immediately
  applyEventRow(line.split('|'));
  await saveDB();

  // Try to push immediately
  await doPushPending();
    renderDashboard();
}

// --- Polling ---
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(doPull, 15 * 60 * 1000);
}

// --- Nav ---
function initNav() {
  document.querySelectorAll('nav button[data-page]').forEach(btn => {
    btn.addEventListener('click', () => showPage(btn.dataset.page));
  });
  document.getElementById('refresh-btn').addEventListener('click', doPull);
  window.onpopstate = (e) => showPage(e.state || 'dashboard');
}

// --- Boot ---
(async function boot() {
  const savedUser = localStorage.getItem('fe_user');
  const savedToken = localStorage.getItem('fe_token');

  if (savedUser && savedToken) {
    currentUser = savedUser;
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = '';
    document.getElementById('user-label').textContent = savedUser;
    await startApp();
  } else {
    initLogin();
  }
})();


function renderUpcoming() {
  const db = getDB();
  const tasks = db.exec(`SELECT * FROM tasks WHERE retired = 0`);
  const cols = tasks[0].columns;
  const taskObjs = tasks[0].values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]])));

  for (const task of taskObjs) {
    const instances = getUpcomingInstances(task, 7);
    const missed = instances.filter(i => isMissed(i, task));
    // render missed + upcoming sections
  }
}


/*function renderDashboard() {
  const db = getDB();
  const tasksRes = db.exec(`SELECT * FROM tasks WHERE retired = 0`);
  if (tasksRes.length === 0) return;

  const cols = tasksRes[0].columns;
  const tasks = tasksRes[0].values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]])));

  // Upcoming section (today + 7d)
  const upcomingSection = document.getElementById('section-upcoming');
  upcomingSection.innerHTML = '';

  for (const task of tasks) {
    const instances = getUpcomingInstances(task, 7);
    for (const inst of instances) {
      upcomingSection.appendChild(renderCard(inst, task));
    }
  }
}*/  
/*export function showPage_DUPLICATE(name) {
  pages.forEach(p => {
    document.getElementById(`page-${p}`).style.display = p === name ? '' : 'none';
  });
  history.pushState(name, '');
} */  



//window.getDB = getDB;   
