/* Kenema Veteran Financial Management System - frontend */
'use strict';

const API = {
  async req(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  },
  get: (u) => API.req('GET', u),
  post: (u, b) => API.req('POST', u, b),
  put: (u, b) => API.req('PUT', u, b),
  del: (u) => API.req('DELETE', u)
};

const fmt = (n) => 'NLe ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtPeriod = (p) => { if (!p || !/^\d{4}-\d{2}$/.test(p)) return p || ''; const [y, m] = p.split('-'); return `${MONTHS[+m - 1]} ${y}`; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = { user: null, members: [], contributions: [], expenditures: [], users: [] };

// ---------- toast ----------
function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3000);
}

// ---------- auth ----------
async function checkAuth() {
  try {
    state.user = await API.get('/api/me');
    showApp();
  } catch {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('loginView').classList.remove('hidden');
  document.getElementById('appView').classList.add('hidden');
}

function showApp() {
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('appView').classList.remove('hidden');
  document.getElementById('currentUser').textContent =
    `${state.user.username} (${state.user.role})`;
  document.querySelectorAll('.admin-only').forEach(el =>
    el.classList.toggle('hidden', state.user.role !== 'admin'));
  switchView('dashboard');
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('loginError');
  errEl.classList.add('hidden');
  try {
    const r = await API.post('/api/login', {
      username: document.getElementById('loginUsername').value,
      password: document.getElementById('loginPassword').value
    });
    state.user = r.user;
    document.getElementById('loginForm').reset();
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await API.post('/api/logout');
  state.user = null;
  showLogin();
});

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

function switchView(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + name));
  if (name === 'dashboard') loadDashboard();
  if (name === 'members') loadMembers();
  if (name === 'contributions') {
    populateMemberFilter().then(() => loadContributions()).catch(err => toast(err.message, true));
  }
  if (name === 'expenditures') loadExpenditures();
  if (name === 'users') loadUsers();
}

// ---------- modal helpers ----------
const modal = document.getElementById('modal');
const modalFields = document.getElementById('modalFields');
const modalForm = document.getElementById('modalForm');

function openModal(title, fields, onSave) {
  document.getElementById('modalTitle').textContent = title;
  modalFields.innerHTML = fields.map(f => {
    if (f.type === 'select') {
      return `<label>${esc(f.label)}</label><select id="mf_${f.name}">${f.options.map(o => {
        const v = typeof o === 'object' ? o.value : o;
        const l = typeof o === 'object' ? o.label : o;
        return `<option value="${esc(v)}" ${v === f.value ? 'selected' : ''}>${esc(l)}</option>`;
      }).join('')}</select>`;
    }
    if (f.type === 'textarea') {
      return `<label>${esc(f.label)}</label><textarea id="mf_${f.name}" rows="2">${esc(f.value || '')}</textarea>`;
    }
    return `<label>${esc(f.label)}</label><input id="mf_${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${f.required ? 'required' : ''} ${f.step ? `step="${f.step}"` : ''}>`;
  }).join('');
  document.getElementById('modalError').classList.add('hidden');
  modalForm.onsubmit = async (e) => {
    e.preventDefault();
    const data = {};
    fields.forEach(f => data[f.name] = document.getElementById('mf_' + f.name).value);
    try {
      await onSave(data);
      closeModal();
    } catch (err) {
      const el = document.getElementById('modalError');
      el.textContent = err.message;
      el.classList.remove('hidden');
    }
  };
  modal.showModal();
}
function closeModal() { modal.close(); }

// ---------- dashboard ----------
async function loadDashboard() {
  try {
  const d = await API.get('/api/dashboard');
  const t = d.totals;
  document.getElementById('dashCards').innerHTML = `
    <div class="card"><div class="label">Total Members</div><div class="value">${t.members}</div></div>
    <div class="card"><div class="label">Active Members</div><div class="value">${t.activeMembers}</div></div>
    <div class="card"><div class="label">Expected (${fmtPeriod(d.thisPeriod)})</div><div class="value">${fmt(t.expectedThisMonth)}</div></div>
    <div class="card good"><div class="label">Collected (${fmtPeriod(d.thisPeriod)})</div><div class="value">${fmt(t.paidThisMonth)}</div></div>
    <div class="card bad"><div class="label">Outstanding</div><div class="value">${fmt(t.outstandingThisMonth)}</div></div>
    <div class="card"><div class="label">Total Contributions</div><div class="value">${fmt(t.totalContributions)}</div></div>
    <div class="card"><div class="label">Total Expenditures</div><div class="value">${fmt(t.totalExpenditures)}</div></div>
    <div class="card ${t.balance >= 0 ? 'good' : 'bad'}"><div class="label">Balance</div><div class="value">${fmt(t.balance)}</div></div>`;

  document.querySelector('#monthsTable tbody').innerHTML = d.months.map(m => `
    <tr><td>${fmtPeriod(m.period)}</td><td class="num">${fmt(m.collected)}</td>
    <td class="num">${fmt(m.spent)}</td><td class="num">${m.payers}</td>
    <td class="num" style="color:${m.collected - m.spent >= 0 ? 'var(--primary)' : 'var(--danger)'}">${fmt(m.collected - m.spent)}</td></tr>`).join('');

  document.getElementById('statusCounts').innerHTML = Object.entries(d.statusCounts)
    .map(([st, n]) => `<div class="chip">${esc(st)} <b>${n}</b></div>`).join('');

  document.getElementById('arrearsTitle').textContent =
    `Members Not Yet Paid — ${fmtPeriod(d.thisPeriod)} (${d.totals.membersInArrears})`;
  document.querySelector('#arrearsTable tbody').innerHTML = d.arrears.length
    ? d.arrears.map(a => `<tr><td>${esc(a.fullName)}</td><td>${esc(a.phone || '—')}</td><td class="num">${fmt(a.monthlyDues)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">All active members have paid. 🎉</td></tr>';
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- members ----------
async function loadMembers() {
  try {
  const q = document.getElementById('memberSearch').value.trim();
  const st = document.getElementById('memberStatusFilter').value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (st) params.set('status', st);
  state.members = await API.get('/api/members?' + params);
  document.querySelector('#membersTable tbody').innerHTML = state.members.map(m => `
    <tr>
      <td>${esc(m.fullName)}</td><td>${esc(m.phone || '—')}</td><td>${esc(m.joinDate || '—')}</td>
      <td class="num">${fmt(m.monthlyDues)}</td>
      <td><span class="badge ${esc(m.status)}">${esc(m.status)}</span></td>
      <td>
        <button class="btn btn-sm btn-ghost" onclick="openMemberModal('${m.id}')">Edit</button>
        ${state.user.role === 'admin' ? `<button class="btn btn-sm btn-danger" onclick="deleteRecord('members', '${m.id}', 'Delete this member and all their payment records?')">Delete</button>` : ''}
      </td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">No members found. Add your first member.</td></tr>';
  } catch (err) {
    toast(err.message, true);
  }
}
document.getElementById('memberSearch').addEventListener('input', () => loadMembers());
document.getElementById('memberStatusFilter').addEventListener('change', () => loadMembers());

function openMemberModal(id) {
  const m = state.members.find(x => x.id === id) || {};
  openModal(m.id ? 'Edit Member' : 'Add Member', [
    { name: 'fullName', label: 'Full Name', value: m.fullName, required: true },
    { name: 'phone', label: 'Phone', value: m.phone },
    { name: 'joinDate', label: 'Join Date', type: 'date', value: m.joinDate || new Date().toISOString().slice(0, 10) },
    { name: 'monthlyDues', label: 'Monthly Dues (NLe)', type: 'number', step: '0.01', value: m.monthlyDues ?? 0 },
    { name: 'status', label: 'Membership Status', type: 'select', options: ['Active', 'Inactive', 'Suspended', 'Deceased'], value: m.status || 'Active' },
    { name: 'notes', label: 'Notes', type: 'textarea', value: m.notes }
  ], async (data) => {
    if (m.id) await API.put('/api/members/' + m.id, data);
    else await API.post('/api/members', data);
    toast(m.id ? 'Member updated' : 'Member added');
    loadMembers();
  });
}

async function deleteRecord(entity, id, message) {
  const actions = {
    members: { success: 'Member deleted', reload: loadMembers },
    contributions: { success: 'Record deleted', reload: loadContributions },
    expenditures: { success: 'Record deleted', reload: loadExpenditures },
    users: { success: 'Account deleted', reload: loadUsers }
  };
  const action = actions[entity];
  if (!action || !confirm(message)) return;
  try {
    await API.del('/api/' + entity + '/' + encodeURIComponent(id));
    toast(action.success);
    await action.reload();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- contributions ----------
async function populateMemberFilter() {
  if (!state.members.length) state.members = await API.get('/api/members');
  const sel = document.getElementById('contribMemberFilter');
  sel.innerHTML = '<option value="">All members</option>' +
    state.members.map(m => `<option value="${m.id}">${esc(m.fullName)}</option>`).join('');
}

async function loadContributions() {
  try {
  const params = new URLSearchParams();
  const mid = document.getElementById('contribMemberFilter').value;
  const period = document.getElementById('contribPeriodFilter').value;
  if (mid) params.set('memberId', mid);
  if (period) params.set('period', period);
  state.contributions = await API.get('/api/contributions?' + params);
  document.querySelector('#contribTable tbody').innerHTML = state.contributions.map(c => `
    <tr>
      <td>${esc(c.memberName)}</td><td>${fmtPeriod(c.period)}</td>
      <td class="num">${fmt(c.amount)}</td><td>${esc(c.datePaid)}</td><td>${esc(c.method)}</td>
      <td>${esc(c.recordedBy)}</td>
      <td>${state.user.role === 'admin' ? `<button class="btn btn-sm btn-danger" onclick="deleteRecord('contributions', '${c.id}', 'Delete this contribution record?')">Delete</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">No contributions recorded yet.</td></tr>';
  } catch (err) {
    toast(err.message, true);
  }
}
document.getElementById('contribMemberFilter').addEventListener('change', () => loadContributions());
document.getElementById('contribPeriodFilter').addEventListener('change', () => loadContributions());

function openContribModal() {
  if (!state.members.length) { toast('Add a member first', true); return; }
  const now = new Date().toISOString().slice(0, 7);
  openModal('Record Monthly Contribution', [
    { name: 'memberId', label: 'Member', type: 'select', options: state.members.map(m => ({ value: m.id, label: m.fullName })), value: state.members[0].id },
    { name: 'amount', label: 'Amount (NLe)', type: 'number', step: '0.01', required: true },
    { name: 'period', label: 'For Month', type: 'month', value: now, required: true },
    { name: 'datePaid', label: 'Date Paid', type: 'date', value: new Date().toISOString().slice(0, 10) },
    { name: 'method', label: 'Payment Method', type: 'select', options: ['Cash', 'Mobile Money', 'Bank Transfer', 'Other'] }
  ], async (data) => {
    await API.post('/api/contributions', data);
    toast('Contribution recorded');
    loadContributions();
  });
}



// ---------- expenditures ----------
async function loadExpenditures() {
  try {
  const period = document.getElementById('expendPeriodFilter').value;
  state.expenditures = await API.get('/api/expenditures' + (period ? '?period=' + period : ''));
  document.querySelector('#expendTable tbody').innerHTML = state.expenditures.map(e => `
    <tr>
      <td>${esc(e.dateSpent)}</td><td>${esc(e.description)}</td><td>${esc(e.category)}</td>
      <td class="num">${fmt(e.amount)}</td><td>${esc(e.recordedBy)}</td>
      <td>${state.user.role === 'admin' ? `<button class="btn btn-sm btn-danger" onclick="deleteRecord('expenditures', '${e.id}', 'Delete this expenditure record?')">Delete</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">No expenditures recorded yet.</td></tr>';
  } catch (err) {
    toast(err.message, true);
  }
}
document.getElementById('expendPeriodFilter').addEventListener('change', () => loadExpenditures());

function openExpendModal() {
  openModal('Add Expenditure', [
    { name: 'description', label: 'Description', required: true },
    { name: 'category', label: 'Category', type: 'select', options: ['Operations', 'Welfare', 'Events', 'Administrative', 'Other'] },
    { name: 'amount', label: 'Amount (NLe)', type: 'number', step: '0.01', required: true },
    { name: 'dateSpent', label: 'Date', type: 'date', value: new Date().toISOString().slice(0, 10) }
  ], async (data) => {
    await API.post('/api/expenditures', data);
    toast('Expenditure added');
    loadExpenditures();
  });
}



// ---------- users (admin) ----------
async function loadUsers() {
  try {
  if (state.user.role !== 'admin') return;
  state.users = await API.get('/api/users');
  document.querySelector('#usersTable tbody').innerHTML = state.users.map(u => `
    <tr>
      <td>${esc(u.username)}</td><td>${esc(u.fullName)}</td><td>${esc(u.role)}</td>
      <td>${(u.createdAt || '').slice(0, 10)}</td>
      <td>${u.role !== 'admin' || state.users.filter(x => x.role === 'admin').length > 1
      ? `<button class="btn btn-sm btn-danger" onclick="deleteRecord('users', '${u.id}', 'Delete this user account?')">Delete</button>` : ''}</td>
    </tr>`).join('');
  } catch (err) {
    toast(err.message, true);
  }
}

function openUserModal() {
  openModal('Create Login Account', [
    { name: 'fullName', label: 'Full Name', required: true },
    { name: 'username', label: 'Username', required: true },
    { name: 'password', label: 'Password (min 6 chars)', type: 'password', required: true },
    { name: 'role', label: 'Role', type: 'select', options: ['staff', 'admin'] }
  ], async (data) => {
    await API.post('/api/users', data);
    toast('Account created');
    loadUsers();
  });
}



// ---------- init ----------
checkAuth();
