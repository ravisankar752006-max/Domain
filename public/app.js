const api = (path, opts={}) => {
  const token = localStorage.getItem('token');
  const headers = Object.assign({'Content-Type':'application/json'}, opts.headers || {});
  if (token) headers.Authorization = 'Bearer ' + token;
  return fetch('/api' + path, Object.assign({headers}, opts)).then(r=>r.json());
}

let socket;
function ensureSocket() {
  if (socket) return socket;
  socket = io();
  // identify if token exists
  const token = localStorage.getItem('token');
  if (token) socket.emit('identify', token);
  return socket;
}

// Auth helpers
document.getElementById('btn-signin').onclick = () => { window.location = '/auth.html'; };
document.getElementById('btn-logout').onclick = () => { localStorage.removeItem('token'); localStorage.removeItem('user'); location.reload(); };

function onLogin(user) {
  document.getElementById('btn-signin').style.display = 'none';
  document.getElementById('user-info').style.display = 'inline';
  document.getElementById('who').innerText = user.username;
  loadProjects();
  ensureSocket();
}

// Projects
async function loadProjects() {
  const r = await api('/projects');
  const el = document.getElementById('projects-list');
  el.innerHTML = '';
  if (!Array.isArray(r)) return;
  r.forEach(p => {
    const d = document.createElement('div'); d.className='list-item'; d.style.minWidth='160px'; d.style.cursor='pointer';
    d.innerHTML = `<b>${p.name}</b> <div style="font-size:12px;color:#9aa">by ${p.owner_name||p.owner}</div>`;
    d.onclick = () => openProject(p.id, p.name);
    el.appendChild(d);
  });
}

document.getElementById('btn-create-project').onclick = async () => {
  const name = document.getElementById('project-name').value;
  const r = await api('/projects', {method:'POST', body: JSON.stringify({name})});
  if (r.id) {
    document.getElementById('project-name').value='';
    loadProjects();
  } else alert(r.error||JSON.stringify(r));
}

let currentProject = null;
async function openProject(id, name) {
  currentProject = id;
  document.getElementById('board-title').innerText = 'Board — ' + name;
  const s = ensureSocket();
  s.emit('joinProject', id);
  s.off('task:created'); s.off('task:updated'); s.off('comment:created'); s.off('message:created'); s.off('project:finished');
  s.on('task:created', (t) => { if (t.project_id==currentProject) loadProject(); });
  s.on('task:updated', (t) => { if (t.project_id==currentProject) loadProject(); });
  s.on('comment:created', (c) => { renderCommentsForSelected(); });
  s.on('message:created', (m) => { if (m.project_id==currentProject) appendMessage(m); });
  s.on('project:finished', (p) => { if (p.id==currentProject) alert('Project marked finished'); loadProject(); });
  loadProject();
}

async function loadProject(){
  if (!currentProject) return;
  const r = await api(`/projects/${currentProject}`);
  if (r.error) return alert(r.error||JSON.stringify(r));
  const project = r.project;
  document.getElementById('board-title').innerText = 'Board — ' + project.name + (project.finished ? ' (Finished)' : '');
  // render columns
  ['todo','inprogress','done'].forEach(s => { document.getElementById('col-'+s).innerHTML=''; });
  const tasksGrouped = r.tasks || {todo:[], inprogress:[], done:[]};
  Object.keys(tasksGrouped).forEach(status => {
    tasksGrouped[status].forEach(t => appendTaskCard(t));
  });
  // collaborators
  window.currentCollaborators = r.collaborators || [];
  renderCollaborators(window.currentCollaborators);
  refreshAssigneeOptions();
  // load messages and comments area
  renderCommentsForSelected();
  loadMessages();
}

function appendTaskCard(t) {
  const container = document.getElementById('col-'+(t.status||'todo'));
  const d = document.createElement('div'); d.className='list-item';
  d.innerHTML = `<b>${t.title}</b> <small>${t.status}</small> <div>${t.description||''}</div>
      <div>Assignee: ${t.assignee||'-'}</div>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
        <button data-id='${t.id}' class='btn-comment'>Comments</button>
        <button data-id='${t.id}' class='btn-edit'>Edit</button>
        <button data-id='${t.id}' class='btn-set-status' data-status='todo'>To Do</button>
        <button data-id='${t.id}' class='btn-set-status' data-status='inprogress'>In Progress</button>
        <button data-id='${t.id}' class='btn-set-status' data-status='done'>Done</button>
      </div>`;
  d.querySelector('.btn-comment').onclick = () => selectTask(t.id);
  d.querySelector('.btn-edit').onclick = async () => {
    const newTitle = prompt('Title', t.title) || t.title;
    await api(`/tasks/${t.id}`, {method:'PUT', body: JSON.stringify({title:newTitle})});
    loadProject();
  };
  d.querySelectorAll('.btn-set-status').forEach(btn => {
    btn.onclick = async (ev) => {
      const newStatus = ev.currentTarget.getAttribute('data-status');
      if (newStatus === t.status) return;
      await api(`/tasks/${t.id}`, {method:'PUT', body: JSON.stringify({status:newStatus})});
      loadProject();
    };
  });

  // per-task assign controls
  const assignContainer = document.createElement('div');
  assignContainer.style.marginTop = '8px';
  assignContainer.style.display = 'flex';
  assignContainer.style.gap = '6px';
  assignContainer.style.alignItems = 'center';
  const assignSel = document.createElement('select');
  // include role shortcuts followed by individual members
  const roles = ['team boss','team tester','developer','analist'];
  let opts = '<option value="">Assign to...</option>' + roles.map(r=>`<option value="role:${r}">Role: ${r}</option>`).join('');
  opts += (window.currentCollaborators||[]).map(c => `<option value="user:${c.username}">${c.username} (${c.role||''})</option>`).join('');
  assignSel.innerHTML = opts;
  const assignBtn = document.createElement('button'); assignBtn.innerText = 'Assign';
  assignBtn.onclick = async () => {
    const val = assignSel.value;
    if (!val) return alert('Choose a member or role');
    if (val.startsWith('user:')) {
      const who = val.slice(5);
      await api(`/tasks/${t.id}`, {method:'PUT', body: JSON.stringify({assignee: who})});
    } else if (val.startsWith('role:')) {
      const role = val.slice(5);
      // find a collaborator with that role
      const pick = (window.currentCollaborators||[]).find(c => (c.role||'').toLowerCase() === role.toLowerCase());
      if (!pick) return alert('No member with role ' + role);
      await api(`/tasks/${t.id}`, {method:'PUT', body: JSON.stringify({assignee: pick.username})});
    }
    loadProject();
  };
  assignContainer.appendChild(assignSel);
  assignContainer.appendChild(assignBtn);
  d.appendChild(assignContainer);
  container.appendChild(d);
}

// update assignee select when collaborators change
function refreshAssigneeOptions(){
  const sel = document.getElementById('task-assignee');
  if (!sel) return;
  sel.innerHTML = '<option value="">Unassigned</option>';
  (window.currentCollaborators||[]).forEach(c => {
    const opt = document.createElement('option'); opt.value = c.username; opt.text = c.username + (c.role ? ' ('+c.role+')' : ''); sel.appendChild(opt);
  });
}

document.getElementById('btn-create-task').onclick = async () => {
  if (!currentProject) return alert('Open a project first');
  const title = document.getElementById('task-title').value;
  const assignee = document.getElementById('task-assignee').value;
  const r = await api(`/projects/${currentProject}/tasks`, {method:'POST', body: JSON.stringify({title,assignee})});
  document.getElementById('task-title').value='';
  document.getElementById('task-assignee').value='';
  loadProject();
}

document.getElementById('btn-finish-project').onclick = async () => {
  if (!currentProject) return alert('Open a project first');
  const r = await api(`/projects/${currentProject}/finish`, {method:'POST'});
  if (r.id) { alert('Project marked finished'); loadProject(); }
}

let selectedTask = null;
function selectTask(id){
  selectedTask = id; renderCommentsForSelected();
}

async function renderCommentsForSelected(){
  const area = document.getElementById('comments-area'); area.innerHTML='';
  if (!selectedTask) return area.innerText='Select a task to see comments';
  const comments = await api(`/tasks/${selectedTask}/comments`);
  const box = document.createElement('div');
  box.innerHTML = `<h4>Comments for task ${selectedTask}</h4>`;
  const list = document.createElement('div');
  comments.forEach(c => { const d = document.createElement('div'); d.className='list-item'; d.innerHTML = `<b>${c.author}</b>: ${c.body}`; list.appendChild(d); });
  const ta = document.createElement('textarea'); ta.id='comment-body';
  const btn = document.createElement('button'); btn.innerText='Post Comment';
  btn.onclick = async ()=>{
    const body = ta.value;
    await api(`/tasks/${selectedTask}/comments`, {method:'POST', body: JSON.stringify({body})});
    ta.value=''; renderCommentsForSelected();
  };
  box.appendChild(list); box.appendChild(ta); box.appendChild(btn); area.appendChild(box);
}

// Project chat
async function loadMessages(){
  if (!currentProject) return;
  const msgs = await api(`/projects/${currentProject}/messages`);
  const el = document.getElementById('messages-list'); el.innerHTML='';
  if (!Array.isArray(msgs)) return;
  msgs.forEach(m => appendMessage(m));
}

function appendMessage(m){
  const el = document.getElementById('messages-list');
  const d = document.createElement('div'); d.className='list-item';
  d.innerHTML = `<b>${m.author}</b>: ${m.body}`;
  el.appendChild(d);
}

// Notifications UI
async function loadNotifications(){
  const notes = await api('/notifications');
  const el = document.getElementById('notifications-list'); if (!el) return;
  el.innerHTML = '';
  (notes||[]).forEach(n => {
    const d = document.createElement('div'); d.className='list-item';
    d.innerHTML = `<div><b>${n.body}</b> <small style="color:#999">${n.created_at}</small></div>`;
    el.appendChild(d);
  });
}

// when socket notifies
ensureSocket();
if (socket) {
  socket.on('notification', (n) => { loadNotifications(); alert('Notification: '+ (n.body||'')); });
  socket.on('collaborator:added', (c) => { loadProject(); });
}

// wire add collaborator button
document.getElementById('btn-add-collab').onclick = async () => {
  if (!currentProject) return alert('Open a project first');
  const username = document.getElementById('add-collab-username').value;
  const role = document.getElementById('add-collab-role').value;
  const r = await api(`/projects/${currentProject}/collaborators`, {method:'POST', body: JSON.stringify({username, role})});
  if (r.user_id) { document.getElementById('add-collab-username').value=''; loadProject(); }
  else alert(r.error||JSON.stringify(r));
}

// load notifications initially if logged in
const savedUser = localStorage.getItem('user');
if (savedUser) loadNotifications();

function renderCollaborators(list){
  const el = document.getElementById('project-collaborators');
  if (!el) return;
  el.innerHTML = '';
  list.forEach(c => {
    const d = document.createElement('div'); d.className='list-item'; d.style.display='inline-block'; d.style.marginRight='8px';
    const label = document.createElement('div'); label.innerHTML = `<b>${c.username}</b>`;
    const sel = document.createElement('select');
    sel.innerHTML = ['team boss','team tester','developer','analist'].map(r => `<option value="${r}" ${c.role===r? 'selected' : ''}>${r}</option>`).join('');
    const rem = document.createElement('button'); rem.innerText = 'Remove'; rem.style.marginLeft='6px';
    sel.onchange = async () => { const newRole = sel.value; await api(`/projects/${currentProject}/collaborators/${c.user_id}`, {method:'PUT', body: JSON.stringify({role: newRole})}); loadProject(); };
    rem.onclick = async ()=>{ await api(`/projects/${currentProject}/collaborators/${c.user_id}`, {method:'DELETE'}); loadProject(); };
    d.appendChild(label); d.appendChild(sel); d.appendChild(rem);
    el.appendChild(d);
  });
}

document.getElementById('btn-send-message').onclick = async () => {
  if (!currentProject) return alert('Open a project first');
  const body = document.getElementById('message-body').value;
  if (!body) return;
  await api(`/projects/${currentProject}/messages`, {method:'POST', body: JSON.stringify({body})});
  document.getElementById('message-body').value='';
}

// Init
const saved = localStorage.getItem('user');
if (saved) onLogin(JSON.parse(saved));
