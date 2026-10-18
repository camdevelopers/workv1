import { getDB, saveDB } from './db.js';
import { pushFile } from './git.js';

// --- Get all users (for assigned-to and transfer selects) ---
function getAllUsers() {
  const db = getDB();
  const res = db.exec(`SELECT DISTINCT user FROM attendance UNION SELECT DISTINCT user FROM leave UNION SELECT DISTINCT assigned_user FROM tasks WHERE assigned_user != ''`);
  const users = new Set();
  if (res.length > 0) res[0].values.forEach(v => users.add(v[0]));
  const currentUser = localStorage.getItem('fe_user');
  if (currentUser) users.add(currentUser);
  return [...users].sort();
}

// --- Render task list ---
function renderTaskList() {
  const container = document.getElementById('task-list');
  const db = getDB();
  const res = db.exec(`SELECT * FROM tasks ORDER BY name`);

  if (res.length === 0 || res[0].values.length === 0) {
    container.innerHTML = '<p class="muted">No tasks yet. Create one below.</p>';
    return;
  }

  const cols = res[0].columns;
  const tasks = res[0].values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]])));

  container.innerHTML = tasks.map(t => `
    <div class="task-list-row ${t.retired ? 'retired' : ''}">
      <div class="task-list-info">
        <strong>${t.name}</strong>
        <span class="badge badge-type-${t.type}">${t.type}</span>
        <span class="muted small">→ ${t.assigned_user || 'unassigned'}</span>
        ${t.retired ? '<span class="badge badge-retired">Retired</span>' : ''}
      </div>
      <div class="task-list-actions">
        ${t.retired
          ? `<button onclick="unretireTask('${t.task_id}')">Resume</button>`
          : `<button onclick="retireTask('${t.task_id}')">Retire</button>`}
      </div>
    </div>
  `).join('');
}

window.retireTask = async function(taskId) {
  const db = getDB();
  db.run(`UPDATE tasks SET retired = 1 WHERE task_id = ?`, [taskId]);
  await saveDB();
  const { logAction } = await import('./app.js');
  await logAction(taskId, taskId, 'retired', '');
  renderTaskList();
  const { renderDashboard } = await import('./dashboard.js');
  renderDashboard();
};

window.unretireTask = async function(taskId) {
  const db = getDB();
  db.run(`UPDATE tasks SET retired = 0 WHERE task_id = ?`, [taskId]);
  await saveDB();
  const { logAction } = await import('./app.js');
  await logAction(taskId, taskId, 'resumed', '');
  renderTaskList();
  const { renderDashboard } = await import('./dashboard.js');
  renderDashboard();
};

// --- Type-aware form: show/hide fields based on type ---
function updateTypeFields() {
  const type = document.getElementById('tc-type').value;

  document.getElementById('tc-cal-group').style.display = type === 'calendar' ? '' : 'none';
  document.getElementById('tc-seq-group').style.display = type === 'sequence' ? '' : 'none';
  document.getElementById('tc-stock-group').style.display = type === 'stock' ? '' : 'none';
  document.getElementById('tc-standalone-group').style.display = type === 'standalone' ? '' : 'none';
}

// --- Calendar sub-options: show/hide based on frequency ---
function updateCalFields() {
  const freq = document.getElementById('tc-cal-freq').value;
  document.getElementById('tc-cal-days-group').style.display = freq === 'weekly' ? '' : 'none';
  document.getElementById('tc-cal-day-group').style.display = freq === 'monthly' ? '' : 'none';
}

// --- Init the task creation page ---
export function initTaskCreatePage() {
  renderTaskList();

  const typeSelect = document.getElementById('tc-type');
  typeSelect.addEventListener('change', updateTypeFields);

  const calFreq = document.getElementById('tc-cal-freq');
  calFreq.addEventListener('change', updateCalFields);

  // Populate assigned-to select
  const assignedSelect = document.getElementById('tc-assigned');
  getAllUsers().forEach(u => {
    const opt = document.createElement('option');
    opt.value = u;
    opt.textContent = u;
    assignedSelect.appendChild(opt);
  });

  // Form submit
  document.getElementById('task-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = document.getElementById('tc-name').value.trim();
    const type = typeSelect.value;
    const assigned = assignedSelect.value;
    const exempt = document.getElementById('tc-exempt').value.trim();
    const grace = parseInt(document.getElementById('tc-grace').value) || 0;
    const trackTime = document.getElementById('tc-track-time').checked ? 1 : 0;

    let recurrence = '';
    let initialStock = 0;

    if (type === 'calendar') {
      const freq = document.getElementById('tc-cal-freq').value;
      if (freq === 'weekly') {
        const days = [];
        ['mon','tue','wed','thu','fri','sat','sun'].forEach(d => {
          if (document.getElementById(`tc-day-${d}`).checked) days.push(d);
        });
        recurrence = `weekly:${days.join(',')}`;
      } else if (freq === 'monthly') {
        const day = document.getElementById('tc-cal-day').value;
        recurrence = `monthly:${day}`;
      } else {
        recurrence = freq; // daily, quarterly, annual
      }
    } else if (type === 'sequence') {
      const days = parseInt(document.getElementById('tc-seq-days').value) || 1;
      recurrence = `${days}d`;
    } else if (type === 'stock') {
      const threshold = parseInt(document.getElementById('tc-stock-threshold').value) || 0;
      initialStock = parseInt(document.getElementById('tc-stock-initial').value) || 0;
      recurrence = `threshold:${threshold}`;
    } else if (type === 'standalone') {
      const deadline = document.getElementById('tc-standalone-deadline').value;
      recurrence = deadline || 'none';
    }

    // Generate task_id
    const taskId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Insert locally
    const db = getDB();
    db.run(
      `INSERT OR REPLACE INTO tasks (task_id, name, type, recurrence, assigned_user, exempt_days, grace_min, show_all_instances, track_time, retired, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [taskId, name, type, recurrence, assigned, exempt, grace, 1, trackTime, 0]
    );

    // Stock: initial restock
    if (type === 'stock' && initialStock > 0) {
      const ts = new Date().toISOString();
      const user = localStorage.getItem('fe_user');
      db.run(`INSERT INTO stock (task_id, event, qty, ts, user) VALUES (?,?,?,?,?)`, [taskId, 'restock', initialStock, ts, user]);
    }

    // Standalone: create instance
    if (type === 'standalone') {
      const dueDate = recurrence === 'none' ? new Date().toISOString().slice(0, 10) : recurrence;
      db.run(`INSERT INTO instances (instance_id, task_id, due_date, status) VALUES (?,?,?, 'pending')`, [`${taskId}-0001`, taskId, dueDate]);
    }

    await saveDB();

    // Push task definition to tasks/
    const taskDef = [
      'task_id|name|type|recurrence|assigned_user|exempt_days|grace_min|show_all_instances|track_time',
      `${taskId}|${name}|${type}|${recurrence}|${assigned}|${exempt}|${grace}|1|${trackTime}`
    ].join('\n');
    await pushFile(`tasks/${taskId}.csv`, taskDef, `${localStorage.getItem('fe_user')}: created task ${name}`);

    // Log creation event
    const { logAction } = await import('./app.js');
    await logAction(taskId, taskId, 'created', `${name}|${type}|${recurrence}|${assigned}|${exempt}|${grace}|1|${trackTime}`);

    // Reset + refresh
    document.getElementById('task-form').reset();
    updateTypeFields();
    renderTaskList();

    const { renderDashboard } = await import('./dashboard.js');
    renderDashboard();
  });

  updateTypeFields();
}   
