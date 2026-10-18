// ===== CONFIG (different repo) =====
const EXP_GH = {
  owner: "camdevelopers",
  repo: "storesoffinancialstoresatrandomrepoandstuffvariablesvariedforever",
  branch: "main"
};
const SEP = "|";
const HEADER = "user|type|date|detail|amount|value|receipt|file|remarks\n";

const TYPE_LABELS = {
  "EXPENSE": "Expense",
  "EMPLOYEE PAID": "Employee",
  "PETTY CASH RECEIVED": "Petty Cash",
  "REIMBURSED": "Reimbursed",
  "PAID BY SIR": "Paid by Sir",
  "PAID BY MAM": "Paid by Mam",
  "BROUGHT FORWARD": "Brought Forward"
};

// ===== STATE =====
let expUser = null;
let expMonth = null;
let expRows = [];
let expEditingId = null;
let expAvailableMonths = [];
let expInitialized = false;

// ===== HELPERS =====
function expGetCurrentMonth() {
  const d = new Date();
  return `${String(d.getFullYear()).slice(2)}_${String(d.getMonth()+1).padStart(2,"0")}`;
}
function expGetFileName(user, month) { return `${user}_${month}.csv`; }
function expPrevMonth(yy, mm) {
  let y = +yy, m = +mm; m--;
  if (m === 0) { m = 12; y--; }
  return `${String(y).slice(-2)}_${String(m).padStart(2,"0")}`;
}
function expMonthLabel(yy_mm) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [yy, mm] = yy_mm.split("_");
  return `${months[+mm - 1]}-${yy}`;
}
function expTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// ===== PERSIST =====
function expSaveState() {
  localStorage.setItem("fe_rows", JSON.stringify(expRows));
  localStorage.setItem("fe_month", expMonth);
  expUpdateOfflineBanner();
}
function expUpdateOfflineBanner() {
  const banner = document.getElementById("exp-offlineBanner");
  const pending = expRows.filter(r => r.user === expUser && r.synced === 0).length;
  const isOffline = !navigator.onLine;
  if (isOffline && pending > 0) {
    document.getElementById("exp-pendingCount").textContent = pending;
    banner.style.display = "block";
    document.getElementById("page-expenses").classList.add("exp-offline");
  } else {
    banner.style.display = "none";
    document.getElementById("page-expenses").classList.remove("exp-offline");
  }
}

// ===== AUTH (uses main app's token) =====
function expAuthHeaders() {
  return {
    "Authorization": `Bearer ${localStorage.getItem("fe_token")}`,
    "Accept": "application/vnd.github.v3+json",
    "Content-Type": "application/json"
  };
}

// ===== LIST MONTHS =====
async function expListUserMonths(user) {
  const url = `https://api.github.com/repos/${EXP_GH.owner}/${EXP_GH.repo}/contents/`;
  const res = await fetch(url, { headers: expAuthHeaders() });
  if (!res.ok) return [];
  const files = await res.json();
  const pattern = new RegExp(`^${user}_(\\d{2})_(\\d{2})\\.csv$`);
  const months = [];
  for (const f of files) {
    const m = f.name.match(pattern);
    if (m) months.push(`${m[1]}_${m[2]}`);
  }
  months.sort().reverse();
  return months;
}

// ===== PREVIOUS MONTH TOTAL =====
async function expGetPrevMonthTotal(user, yy, mm) {
  const prev = expPrevMonth(yy, mm);
  const fileName = expGetFileName(user, prev);
  const url = `https://api.github.com/repos/${EXP_GH.owner}/${EXP_GH.repo}/contents/${fileName}`;
  const res = await fetch(url, { headers: expAuthHeaders() });
  if (!res.ok) return 0;
  const data = await res.json();
  const csv = atob(data.content);
  const lines = csv.trim().split("\n").slice(1);
  let total = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(SEP);
    const val = parseFloat(parts[5]);
    if (!isNaN(val)) total += val;
  }
  return total;
}

// ===== ENSURE FILE =====
async function expEnsureFile(user, month) {
  const fileName = expGetFileName(user, month);
  const url = `https://api.github.com/repos/${EXP_GH.owner}/${EXP_GH.repo}/contents/${fileName}`;
  const res = await fetch(url, { headers: expAuthHeaders() });
  if (res.ok) return;

  const [yy, mm] = month.split("_");
  const bfValue = await expGetPrevMonthTotal(user, yy, mm);
  const bfDate = expTodayStr();
  const bfLine = `${user}|BROUGHT FORWARD|${bfDate}|-|0|${bfValue}|-|-|-`;
  const content = HEADER + bfLine + "\n";

  const createRes = await fetch(url, {
    method: "PUT",
    headers: expAuthHeaders(),
    body: JSON.stringify({ message: `Create ${fileName} (BF: ${bfValue})`, content: btoa(content), branch: EXP_GH.branch })
  });
  if (!createRes.ok) {
    const err = await createRes.json();
    throw new Error(err.message || "Failed to create file");
  }
}

// ===== FILE UPLOAD =====
async function expUploadFile(file) {
  const fileName = `${expUser}_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
  const path = `uploads/${fileName}`;
  const url = `https://api.github.com/repos/${EXP_GH.owner}/${EXP_GH.repo}/contents/${path}`;
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const res = await fetch(url, {
    method: "PUT",
    headers: expAuthHeaders(),
    body: JSON.stringify({ message: `Upload ${fileName}`, content: base64, branch: EXP_GH.branch })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "File upload failed");
  }
  return `https://github.com/${EXP_GH.owner}/${EXP_GH.repo}/blob/${EXP_GH.branch}/${path}`;
}

// ===== CSV PARSER =====
function expParseCsv(csv, user) {
  const lines = csv.trim().split("\n").slice(1);
  return lines.filter(l => l.trim()).map((line, i) => {
    const parts = line.split(SEP);
    return {
      id: `${user}-${expMonth}-${i}-${parts[4]}`,
      user: parts[0], type: parts[1], date: parts[2], detail: parts[3],
      amount: +parts[4] || 0, value: +parts[5] || 0,
      receipt: parts[6] || "YES", file: parts[7] || "", remarks: parts[8] || "",
      synced: 1
    };
  });
}

// ===== COMPUTE =====
function expComputeValue(type, amount) {
  if (type === "EXPENSE" || type === "EMPLOYEE PAID") return -amount;
  if (type === "PETTY CASH RECEIVED" || type === "REIMBURSED") return amount;
  if (type === "PAID BY SIR" || type === "PAID BY MAM") return 0;
  if (type === "BROUGHT FORWARD") return amount;
  return -amount;
}
function expRunningBalance(userRows) {
  let bal = 0;
  return userRows.map(r => ({ ...r, balance: (bal += r.value) }));
}

// ===== SYNC =====
async function expFullSync() {
  expAvailableMonths = await expListUserMonths(expUser);
  await expEnsureFile(expUser, expMonth);

  if (localStorage.getItem("fe_pending_rewrite") === "1") {
    expShowToast("⏳ Syncing pending changes…");
    const ok = await expRewriteSelfCsv(`${expUser}: offline sync [${expMonth}]`);
    if (ok) expShowToast("✅ Pending changes synced");
  }

  await expPullOthers();
  await expPushSelf();
  expRenderMonthSelector();
  expRender();
  expSaveState();
}

async function expPullOthers() {
  const shas = JSON.parse(localStorage.getItem("fe_shas") || "{}");
  const newShas = { ...shas };

  for (const user of Object.keys(shas).concat(expUser)) {
    if (user === expUser) continue;
    if (!user) continue;

    const fileName = expGetFileName(user, expMonth);
    const url = `https://api.github.com/repos/${EXP_GH.owner}/${EXP_GH.repo}/contents/${fileName}`;
    const headers = expAuthHeaders();
    const shaKey = `${user}_${expMonth}`;
    if (shas[shaKey]) headers["If-None-Match"] = shas[shaKey];

    const res = await fetch(url, { headers });
    if (res.status === 404 || res.status === 304) continue;

    const data = await res.json();
    newShas[shaKey] = data.sha;
    const csv = atob(data.content);
    const remoteRows = expParseCsv(csv, user);
    expRows = expRows.filter(r => r.user !== user).concat(remoteRows);
  }

  await expPullSelf();
  localStorage.setItem("fe_shas", JSON.stringify(newShas));
}

async function expPullSelf() {
  const fileName = expGetFileName(expUser, expMonth);
  const url = `https://api.github.com/repos/${EXP_GH.owner}/${EXP_GH.repo}/contents/${fileName}`;
  const res = await fetch(url, { headers: expAuthHeaders() });
  if (!res.ok) return;
  const data = await res.json();
  const csv = atob(data.content);
  const remoteRows = expParseCsv(csv, expUser);
  const localPending = expRows.filter(r => r.user === expUser && r.synced === 0);
  expRows = expRows.filter(r => r.user !== expUser).concat(remoteRows, localPending);
}

async function expPushSelf() {
  const pending = expRows.filter(r => r.user === expUser && (r.synced === 0 || r.synced === 2));
  if (!pending.length) return;

  const fileName = expGetFileName(expUser, expMonth);
  const url = `https://api.github.com/repos/${EXP_GH.owner}/${EXP_GH.repo}/contents/${fileName}`;

  for (const row of pending) {
    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      let sha = null, existing = HEADER;
      try {
        const getRes = await fetch(url, { headers: expAuthHeaders() });
        if (getRes.ok) { const d = await getRes.json(); sha = d.sha; existing = atob(d.content); }
      } catch { expSaveState(); return; }

      const newLine = [row.user, row.type, row.date, row.detail, row.amount, row.value, row.receipt, row.file || "", row.remarks || ""].join(SEP);
      const newCsv = existing.endsWith("\n") ? existing + newLine + "\n" : existing + "\n" + newLine + "\n";

      let putRes;
      try {
        putRes = await fetch(url, {
          method: "PUT", headers: expAuthHeaders(),
          body: JSON.stringify({ message: `${row.user}: ${row.detail} (${row.amount})`, content: btoa(newCsv), branch: EXP_GH.branch, ...(sha ? { sha } : {}) })
        });
      } catch { expSaveState(); return; }

      if (putRes.ok) { row.synced = 1; break; }
      if (putRes.status === 409) continue;
      row.synced = 2; break;
    }
  }
  expSaveState();
}

async function expRewriteSelfCsv(commitMsg) {
  const fileName = expGetFileName(expUser, expMonth);
  const url = `https://api.github.com/repos/${EXP_GH.owner}/${EXP_GH.repo}/contents/${fileName}`;
  let attempts = 0;

  while (attempts < 3) {
    attempts++;
    let sha = null;
    try {
      const getRes = await fetch(url, { headers: expAuthHeaders() });
      if (getRes.ok) { const d = await getRes.json(); sha = d.sha; }
    } catch {
      expRows.filter(r => r.user === expUser).forEach(r => r.synced = 2);
      localStorage.setItem("fe_pending_rewrite", "1");
      expSaveState(); return false;
    }

    const myRows = expRows.filter(r => r.user === expUser);
    let newCsv = HEADER;
    for (const r of myRows) {
      newCsv += [r.user, r.type, r.date, r.detail, r.amount, r.value, r.receipt, r.file || "", r.remarks || ""].join(SEP) + "\n";
    }

    let putRes;
    try {
      putRes = await fetch(url, {
        method: "PUT", headers: expAuthHeaders(),
        body: JSON.stringify({ message: commitMsg || `${expUser}: update ${expMonth}`, content: btoa(newCsv), branch: EXP_GH.branch, ...(sha ? { sha } : {}) })
      });
    } catch {
      expRows.filter(r => r.user === expUser).forEach(r => r.synced = 2);
      localStorage.setItem("fe_pending_rewrite", "1");
      expSaveState(); return false;
    }

    if (putRes.ok) {
      myRows.forEach(r => r.synced = 1);
      localStorage.removeItem("fe_pending_rewrite");
      expSaveState(); return true;
    }
    if (putRes.status === 409) continue;
    expRows.filter(r => r.user === expUser).forEach(r => r.synced = 2);
    localStorage.setItem("fe_pending_rewrite", "1");
    expSaveState(); return false;
  }
  return false;
}

// ===== RENDER =====
function expRenderMonthSelector() {
  const sel = document.getElementById("exp-monthSelect");
  const allMonths = [...new Set([...expAvailableMonths, expMonth])];
  allMonths.sort().reverse();
  sel.innerHTML = allMonths.map(m =>
    `<option value="${m}" ${m === expMonth ? "selected" : ""}>${expMonthLabel(m)}</option>`
  ).join("");
}

function expRender() {
  const myRows = expRunningBalance(expRows.filter(r => r.user === expUser));
  const tbody = document.getElementById("exp-tbody");

  tbody.innerHTML = myRows.map((r, i) => {
    const isBF = r.type === "BROUGHT FORWARD";
    const valClass = r.value < 0 ? 'val-neg' : r.value > 0 ? 'val-pos' : 'val-zero';
    return `
    <tr class="${expEditingId === r.id ? 'editing' : ''} ${isBF ? 'bf-row' : ''}">
      <td>${i + 1}${r.synced === 0 ? ' <span style="color:#f57c00;font-size:0.7rem;">⏳</span>' : ''}</td>
      <td>${r.date || "—"}</td>
      <td>${TYPE_LABELS[r.type] || r.type}</td>
      <td>${r.detail || "—"}</td>
      <td>${isBF ? "—" : r.amount.toFixed(2)}</td>
      <td class="${valClass}">${r.value >= 0 ? '+' : ''}${r.value.toFixed(2)}</td>
      <td>${r.balance.toFixed(2)}</td>
      <td>${isBF ? "—" : r.receipt}</td>
      <td>${r.file ? `<a class="file-link" href="#" onclick="expViewFile('${r.file}');return false;">📎 view</a>` : "—"}</td>
      <td>${isBF ? "—" : (r.remarks || "—")}</td>
      <td class="row-actions">
        ${isBF ? "" : `<button class="btn-edit" onclick="expStartEdit('${r.id}')">✏️</button>`}
        ${isBF ? "" : `<button class="btn-del" onclick="expDeleteRow('${r.id}')">🗑️</button>`}
      </td>
    </tr>`;
  }).join("");

  const total = myRows.length ? myRows[myRows.length - 1].balance : 0;
  document.getElementById("exp-balanceTotal").textContent =
    `Total Balance: ${total >= 0 ? '+' : ''}${total.toFixed(2)}`;
}

// ===== ACTIONS (exposed to window for inline onclick) =====
window.expSwitchMonth = async function(month) {
  if (month === expMonth) return;
  if (expEditingId) expCancelEdit();
  expMonth = month;
  localStorage.setItem("fe_month", expMonth);
  expShowToast(`⏳ Loading ${expMonthLabel(month)}…`);
  await expEnsureFile(expUser, expMonth);
  expRows = expRows.filter(r => r.user !== expUser);
  await expPullSelf();
  expRenderMonthSelector();
  expRender();
  expShowToast(`✅ ${expMonthLabel(month)}`);
};

window.expStartEdit = function(id) {
  const row = expRows.find(r => r.id === id && r.user === expUser);
  if (!row) return;
  expEditingId = id;
  document.getElementById("exp-fType").value = row.type;
  document.getElementById("exp-fAmount").value = row.amount;
  document.getElementById("exp-fDate").value = row.date;
  document.getElementById("exp-fReceipt").value = row.receipt;
  document.getElementById("exp-fDetail").value = row.detail;
  document.getElementById("exp-fRemarks").value = row.remarks;
  document.getElementById("exp-fFile").value = "";
  document.getElementById("exp-formTitle").textContent = "Edit Entry";
  document.getElementById("exp-btnSubmit").textContent = "💾 Save Changes";
  document.getElementById("exp-btnCancel").style.display = "block";
  document.getElementById("exp-fileRow").style.display = "none";
  expRender();
};

window.expCancelEdit = function() {
  expEditingId = null;
  expResetForm();
  expRender();
};

window.expDeleteRow = async function(id) {
  const row = expRows.find(r => r.id === id && r.user === expUser);
  if (!row) return;
  if (!confirm(`Delete "${row.detail || TYPE_LABELS[row.type] || 'entry'}" (${row.amount})?`)) return;
  expRows = expRows.filter(r => r.id !== id);
  expSaveState();
  if (expEditingId === id) expCancelEdit();
  expRender();
  expShowToast("⏳ Deleting…");
  const ok = await expRewriteSelfCsv(`${expUser}: delete ${row.detail} [${expMonth}]`);
  expShowToast(ok ? "✅ Deleted" : "❌ Delete failed.");
  expRender();
};

window.expAddRow = async function() {
  const type = document.getElementById("exp-fType").value;
  const detail = document.getElementById("exp-fDetail").value.trim();
  const amount = parseFloat(document.getElementById("exp-fAmount").value);
  const date = document.getElementById("exp-fDate").value;
  const receipt = document.getElementById("exp-fReceipt").value;
  const remarks = document.getElementById("exp-fRemarks").value.trim();
  const fileInput = document.getElementById("exp-fFile");

  if (isNaN(amount) || amount <= 0) { alert("Enter a valid amount."); return; }
  if (type !== "PETTY CASH RECEIVED" && type !== "REIMBURSED" &&
      type !== "PAID BY SIR" && type !== "PAID BY MAM" && !detail) {
    alert("Enter a detail."); return;
  }

  if (expEditingId) {
    const row = expRows.find(r => r.id === expEditingId && r.user === expUser);
    if (!row) { expCancelEdit(); return; }
    row.type = type; row.detail = detail; row.amount = amount;
    row.value = expComputeValue(type, amount);
    row.date = date; row.receipt = receipt; row.remarks = remarks;
    if (fileInput.files.length > 0) {
      try { row.file = await expUploadFile(fileInput.files[0]); }
      catch (e) { alert("File upload failed: " + e.message); return; }
    }
    expSaveState(); expRender();
    expShowToast("⏳ Saving…");
    const ok = await expRewriteSelfCsv(`${expUser}: edit ${detail} [${expMonth}]`);
    expShowToast(ok ? "✅ Saved" : "❌ Save failed.");
    expCancelEdit(); expRender();
    return;
  }

  let fileUrl = "";
  if (fileInput.files.length > 0) {
    try { fileUrl = await expUploadFile(fileInput.files[0]); }
    catch (e) { alert("File upload failed: " + e.message); return; }
  }

  expRows.push({
    id: `${expUser}-${expMonth}-${Date.now()}`,
    user: expUser, type, date, detail, amount,
    value: expComputeValue(type, amount),
    receipt, file: fileUrl, remarks, synced: 0
  });
  expSaveState(); expResetForm(); expRender();
  expPushSelf().then(expRender);
};

window.expViewFile = async function(url) {
  const path = url.replace(`https://github.com/${EXP_GH.owner}/${EXP_GH.repo}/blob/${EXP_GH.branch}/`, "");
  const apiPath = `https://api.github.com/repos/${EXP_GH.owner}/${EXP_GH.repo}/contents/${path}`;
  const res = await fetch(apiPath, {
    headers: { "Authorization": `Bearer ${localStorage.getItem("fe_token")}`, "Accept": "application/vnd.github.v3.raw" }
  });
  if (!res.ok) { alert("Failed to load file: " + res.status); return; }
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  window.open(blobUrl, "_blank");
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
};

function expResetForm() {
  document.getElementById("exp-fType").value = "EXPENSE";
  document.getElementById("exp-fAmount").value = "";
  document.getElementById("exp-fDetail").value = "";
  document.getElementById("exp-fRemarks").value = "";
  document.getElementById("exp-fReceipt").value = "YES";
  document.getElementById("exp-fFile").value = "";
  document.getElementById("exp-fDate").value = expTodayStr();
  document.getElementById("exp-formTitle").textContent = "Add Entry";
  document.getElementById("exp-btnSubmit").textContent = "+ Add Row";
  document.getElementById("exp-btnCancel").style.display = "none";
  document.getElementById("exp-fileRow").style.display = "";
}

function expShowToast(msg) {
  const t = document.createElement("div");
  t.textContent = msg;
  t.style.cssText = "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 18px;border-radius:6px;font-size:0.85rem;z-index:9999;";
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ===== INIT (called when page is shown) =====
export function initExpensesPage() {
  if (expInitialized) { expRender(); return; }

  expUser = localStorage.getItem("fe_user");
  if (!expUser) return;

  const savedRows = localStorage.getItem("fe_rows");
  const savedMonth = localStorage.getItem("fe_month");
  if (savedRows) expRows = JSON.parse(savedRows);
  if (savedMonth) expMonth = savedMonth;
  else expMonth = expGetCurrentMonth();

  document.getElementById("exp-userLabel").textContent = expUser;
  document.getElementById("exp-fDate").value = expTodayStr();
  expUpdateOfflineBanner();

  expInitialized = true;
  expFullSync();
}   
