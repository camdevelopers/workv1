import { getDB } from './db.js';

export function getDuration(instanceId) {
  const db = getDB();
  const res = db.exec(
    `SELECT ts FROM events WHERE instance_id = ? AND action IN ('doing','will_do') ORDER BY ts ASC LIMIT 1`,
    [instanceId]
  );
  const doneRes = db.exec(
    `SELECT ts FROM events WHERE instance_id = ? AND action = 'done' ORDER BY ts DESC LIMIT 1`,
    [instanceId]
  );

  if (res.length === 0 || res[0].values.length === 0) return null;
  if (doneRes.length === 0 || doneRes[0].values.length === 0) return null;

  const start = new Date(res[0].values[0][0]).getTime();
  const end = new Date(doneRes[0].values[0][0]).getTime();
  return Math.round((end - start) / 60000);
}

export function renderDuration(instanceId, task) {
  if (!task.track_time) return null;
  const mins = getDuration(instanceId);
  if (mins === null) return null;

  const el = document.createElement('span');
  el.className = 'duration';
  el.textContent = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  return el;
}

export function renderLeaveBadge(task) {
  const db = getDB();
  const today = new Date().toISOString().slice(0, 10);
  const res = db.exec(
    `SELECT type FROM leave WHERE user = ? AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)`,
    [task.assigned_user, today, today]
  );
  if (res.length === 0 || res[0].values.length === 0) return null;

  const el = document.createElement('span');
  el.className = 'badge badge-leave-badge';
  el.textContent = `${task.assigned_user} on leave`;
  return el;
}   
