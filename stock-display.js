import { getDB, saveDB } from './db.js';

export function getStock(taskId) {
  const db = getDB();
  const res = db.exec(
    `SELECT COALESCE(SUM(CASE WHEN event='restock' THEN qty ELSE -qty END), 0) FROM stock WHERE task_id = ?`,
    [taskId]
  );
  return res.length > 0 ? res[0].values[0][0] : 0;
}

export function renderStockBar(task) {
  const stock = getStock(task.task_id);
  const threshold = parseInt((task.recurrence || '').replace('threshold:', '')) || 0;
  const max = Math.max(stock, threshold * 3, 10);
  const pct = Math.min((stock / max) * 100, 100);
  const isLow = stock <= threshold;

  const bar = document.createElement('div');
  bar.className = 'stock-bar-wrap';
  bar.innerHTML = `
    <div class="stock-label">
      <span>Stock: <strong>${stock}</strong></span>
      <span class="muted">threshold: ${threshold}</span>
      ${isLow ? '<span class="badge badge-low">LOW</span>' : ''}
    </div>
    <div class="stock-bar-bg">
      <div class="stock-bar-fill ${isLow ? 'low' : ''}" style="width:${pct}%"></div>
    </div>
  `;

  const btns = document.createElement('div');
  btns.className = 'stock-btns';
  btns.innerHTML = `
    <button class="btn-consume">Consume</button>
    <button class="btn-restock">Restock</button>
  `;

  btns.querySelector('.btn-consume').addEventListener('click', async () => {
    const qty = parseInt(prompt('Quantity to consume:', '1'));
    if (!qty || qty < 1) return;
    await logStockEvent(task.task_id, 'consume', qty);
  });

  btns.querySelector('.btn-restock').addEventListener('click', async () => {
    const qty = parseInt(prompt('Quantity to restock:', '25'));
    if (!qty || qty < 1) return;
    await logStockEvent(task.task_id, 'restock', qty);
  });

  bar.appendChild(btns);
  return bar;
}

async function logStockEvent(taskId, event, qty) {
  const db = getDB();
  const user = localStorage.getItem('fe_user');
  const ts = new Date().toISOString();

  db.run(`INSERT INTO stock (task_id, event, qty, ts, user) VALUES (?,?,?,?,?)`, [taskId, event, qty, ts, user]);
  await saveDB();

  const { logAction } = await import('./app.js');
  await logAction(`${taskId}-stock-${Date.now()}`, taskId, event, String(qty));

  const { renderDashboard } = await import('./dashboard.js');
  renderDashboard();
}   
