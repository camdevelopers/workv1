import { getDB, saveDB } from './db.js';

// --- Day exemption ---
function isExempted(date, exemptDays) {
  if (!exemptDays) return false;
  const days = exemptDays.split(',').map(d => d.trim().toLowerCase());
  const dayName = date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  if (days.includes(dayName)) return true;
  if (days.includes('holidays') && isHoliday(date)) return true;
  return false;
}

function isHoliday(date) {
  const holidays = new Set([
    '2026-10-02', '2026-10-18', '2026-11-08', '2026-12-25',
  ]);
  return holidays.has(date.toISOString().slice(0, 10));
}

// --- Get current stock for a task ---
function getStock(taskId) {
  const db = getDB();
  const res = db.exec(
    `SELECT COALESCE(SUM(CASE WHEN event='restock' THEN qty ELSE -qty END), 0) FROM stock WHERE task_id = ?`,
    [taskId]
  );
  return res.length > 0 ? res[0].values[0][0] : 0;
}

// --- Compute next due date for a task ---
function computeNextDue(task) {
  const db = getDB();
  const now = new Date();

  switch (task.type) {
    case 'sequence': {
      const intervalDays = parseInt(task.recurrence) || 1;
      // Find last done instance
      const lastDone = db.exec(
        `SELECT done_at FROM instances WHERE task_id = ? AND status = 'done' ORDER BY done_at DESC LIMIT 1`,
        [task.task_id]
      );
      let anchor;
      if (lastDone.length > 0 && lastDone[0].values.length > 0) {
        anchor = new Date(lastDone[0].values[0][0]);
      } else {
        // No done yet — use first pending due date or today
        const firstPending = db.exec(
          `SELECT due_date FROM instances WHERE task_id = ? AND status != 'done' ORDER BY due_date ASC LIMIT 1`,
          [task.task_id]
        );
        anchor = (firstPending.length > 0 && firstPending[0].values.length > 0)
          ? new Date(firstPending[0].values[0][0])
          : now;
      }
      const due = new Date(anchor);
      due.setDate(due.getDate() + intervalDays);
      while (isExempted(due, task.exempt_days)) due.setDate(due.getDate() + 1);
      return due;
    }

    case 'calendar': {
      const rule = task.recurrence;
      const d = new Date(now);

      if (rule === 'daily') {
        d.setDate(d.getDate() + 1);
      } else if (rule === 'weekly') {
        d.setDate(d.getDate() + 1);
      } else if (rule === 'monthly') {
        d.setDate(1);
        d.setMonth(d.getMonth() + 1);
      } else if (rule === 'quarterly') {
        const q = Math.floor(d.getMonth() / 3);
        d.setMonth(q * 3, 1);
        d.setMonth(d.getMonth() + 3);
      } else if (rule === 'annual') {
        d.setMonth(0, 1);
        d.setFullYear(d.getFullYear() + 1);
      } else {
        d.setDate(d.getDate() + 1);
      }

      // For weekly: advance to next matching day
      if (rule === 'weekly' || rule === 'daily') {
        // Check if there's a pending instance already scheduled
        const pending = db.exec(
          `SELECT due_date FROM instances WHERE task_id = ? AND status != 'done' AND due_date >= ? ORDER BY due_date ASC LIMIT 1`,
          [task.task_id, now.toISOString().slice(0, 10)]
        );
        if (pending.length > 0 && pending[0].values.length > 0) {
          return new Date(pending[0].values[0][0]);
        }
      }

      while (isExempted(d, task.exempt_days)) d.setDate(d.getDate() + 1);
      return d;
    }

    case 'stock': {
      const threshold = parseInt((task.recurrence || '').replace('threshold:', '')) || 0;
      const stock = getStock(task.task_id);
      if (stock <= threshold) return new Date(); // due now
      return null; // not due yet
    }

    case 'standalone': {
      // Use the fixed deadline from the instance
      const inst = db.exec(
        `SELECT due_date FROM instances WHERE task_id = ? AND status != 'done' LIMIT 1`,
        [task.task_id]
      );
      if (inst.length > 0 && inst[0].values.length > 0) {
        return new Date(inst[0].values[0][0]);
      }
      return null;
    }
  }
  return null;
}

// --- Get the next pending instance for a task (ONE only) ---
export function getNextInstance(task) {
  const db = getDB();

  // First: check if there's already a pending instance in DB
  const pending = db.exec(
    `SELECT * FROM instances WHERE task_id = ? AND status != 'done' ORDER BY due_date ASC LIMIT 1`,
    [task.task_id]
  );
  if (pending.length > 0 && pending[0].values.length > 0) {
    const cols = pending[0].columns;
    return Object.fromEntries(cols.map((c, i) => [c, pending[0].values[0][i]]));
  }

  // No pending instance — compute and create one
  const due = computeNextDue(task);
  if (!due) return null;

  const seq = Date.now().toString(36);
  const instanceId = `${task.task_id}-${seq}`;
  const dueStr = due.toISOString().slice(0, 10);

  db.run(
    `INSERT INTO instances (instance_id, task_id, due_date, status) VALUES (?,?,?, 'pending')`,
    [instanceId, task.task_id, dueStr]
  );

  return { instance_id: instanceId, task_id: task.task_id, due_date: dueStr, status: 'pending', done_by: null, done_at: null, note: null };
}

// --- Get the last completed instance for a task (ONE only) ---
export function getLastCompleted(task) {
  const db = getDB();
  const res = db.exec(
    `SELECT * FROM instances WHERE task_id = ? AND status = 'done' ORDER BY done_at DESC LIMIT 1`,
    [task.task_id]
  );
  if (res.length === 0 || res[0].values.length === 0) return null;
  const cols = res[0].columns;
  return Object.fromEntries(cols.map((c, i) => [c, res[0].values[0][i]]));
}

// --- Missed check ---
export function isMissed(instance, task) {
  if (!instance || instance.status === 'done') return false;
  const due = new Date(instance.due_date + 'T23:59:59');
  const graceMs = (task.grace_min || 0) * 60 * 1000;
  return new Date() > new Date(due.getTime() + graceMs);
}   
