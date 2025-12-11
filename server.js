const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3');
const { Server } = require('socket.io');
const http = require('http');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

const db = new sqlite3.Database('./data.db');

function run(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function get(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDb() {
  await run(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      owner INTEGER,
      finished INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      title TEXT,
      description TEXT,
      assignee TEXT,
      status TEXT DEFAULT 'todo',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      author TEXT,
      body TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      author TEXT,
      body TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS collaborators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      user_id INTEGER,
      role TEXT DEFAULT 'member',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      project_id INTEGER,
      body TEXT,
      read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
}

initDb().catch(err => {
  console.error('DB init error', err);
  process.exit(1);
});

// Auth helpers
async function createUser(username, password) {
  const hash = await bcrypt.hash(password, 10);
  return run('INSERT INTO users(username, password) VALUES(?, ?)', [username, hash]);
}

async function findUserByUsername(username) {
  return get('SELECT id, username, password FROM users WHERE username = ?', [username]);
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'Missing authorization' });
  const parts = h.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'Invalid authorization' });
  const token = parts[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Routes
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  try {
    await createUser(username, password);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: 'User exists or invalid' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await findUserByUsername(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username } });
});

// Projects
app.post('/api/projects', authMiddleware, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const result = await run('INSERT INTO projects(name, owner) VALUES(?, ?)', [name, req.user.id]);
  const project = await get('SELECT * FROM projects WHERE id = ?', [result.lastID]);
  // add owner as collaborator
  await run('INSERT INTO collaborators(project_id, user_id, role) VALUES(?, ?, ?)', [project.id, req.user.id, 'owner']);
  io.emit('project:created', project);
  res.json(project);
});

app.get('/api/projects', authMiddleware, async (req, res) => {
  const projects = await all('SELECT p.*, u.username AS owner_name FROM projects p LEFT JOIN users u ON p.owner = u.id');
  res.json(projects);
});

app.get('/api/projects/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  const project = await get('SELECT p.*, u.username AS owner_name FROM projects p LEFT JOIN users u ON p.owner = u.id WHERE p.id = ?', [id]);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const tasks = await all('SELECT * FROM tasks WHERE project_id = ?', [id]);
  // group tasks by status
  const grouped = { todo: [], inprogress: [], done: [] };
  tasks.forEach(t => { grouped[t.status || 'todo'].push(t); });
  const collaborators = await all('SELECT c.user_id, c.role, u.username FROM collaborators c LEFT JOIN users u ON c.user_id = u.id WHERE c.project_id = ?', [id]);
  res.json({ project, tasks: grouped, collaborators });
});

app.post('/api/projects/:id/finish', authMiddleware, async (req, res) => {
  const id = req.params.id;
  const project = await get('SELECT * FROM projects WHERE id = ?', [id]);
  if (!project) return res.status(404).json({ error: 'Not found' });
  await run('UPDATE projects SET finished = 1 WHERE id = ?', [id]);
  const updated = await get('SELECT * FROM projects WHERE id = ?', [id]);
  io.emit('project:finished', updated);
  res.json(updated);
});

// Tasks
app.post('/api/projects/:projectId/tasks', authMiddleware, async (req, res) => {
  const { title, description, assignee } = req.body;
  const projectId = req.params.projectId;
  if (!title) return res.status(400).json({ error: 'Missing title' });
  const r = await run('INSERT INTO tasks(project_id, title, description, assignee) VALUES(?, ?, ?, ?)', [projectId, title, description || '', assignee || null]);
  const task = await get('SELECT * FROM tasks WHERE id = ?', [r.lastID]);
  io.to(`project-${projectId}`).emit('task:created', task);
  res.json(task);
});

app.get('/api/projects/:projectId/tasks', authMiddleware, async (req, res) => {
  const projectId = req.params.projectId;
  const tasks = await all('SELECT * FROM tasks WHERE project_id = ?', [projectId]);
  res.json(tasks);
});

app.put('/api/tasks/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  const { title, description, assignee, status } = req.body;
  const task = await get('SELECT * FROM tasks WHERE id = ?', [id]);
  if (!task) return res.status(404).json({ error: 'Not found' });
  await run('UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description), assignee = COALESCE(?, assignee), status = COALESCE(?, status) WHERE id = ?', [title, description, assignee, status, id]);
  const updated = await get('SELECT * FROM tasks WHERE id = ?', [id]);
  io.to(`project-${updated.project_id}`).emit('task:updated', updated);
  res.json(updated);
});

// Comments
app.post('/api/tasks/:taskId/comments', authMiddleware, async (req, res) => {
  const taskId = req.params.taskId;
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'Missing body' });
  const author = req.user.username;
  const r = await run('INSERT INTO comments(task_id, author, body) VALUES(?, ?, ?)', [taskId, author, body]);
  const comment = await get('SELECT * FROM comments WHERE id = ?', [r.lastID]);
  const t = await get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (t) io.to(`project-${t.project_id}`).emit('comment:created', comment);
  res.json(comment);
});

// Project messages / chat
app.post('/api/projects/:projectId/messages', authMiddleware, async (req, res) => {
  const projectId = req.params.projectId;
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'Missing body' });
  const author = req.user.username;
  const r = await run('INSERT INTO messages(project_id, author, body) VALUES(?, ?, ?)', [projectId, author, body]);
  const msg = await get('SELECT * FROM messages WHERE id = ?', [r.lastID]);
  io.to(`project-${projectId}`).emit('message:created', msg);
  res.json(msg);
});

// Collaborators management
app.post('/api/projects/:projectId/collaborators', authMiddleware, async (req, res) => {
  const projectId = req.params.projectId;
  const { username, role } = req.body;
  if (!username) return res.status(400).json({ error: 'Missing username' });
  const user = await get('SELECT id, username FROM users WHERE username = ?', [username]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // check not already collaborator
  const exists = await get('SELECT * FROM collaborators WHERE project_id = ? AND user_id = ?', [projectId, user.id]);
  if (exists) return res.status(400).json({ error: 'Already collaborator' });
  await run('INSERT INTO collaborators(project_id, user_id, role) VALUES(?, ?, ?)', [projectId, user.id, role || 'member']);
  const coll = await get('SELECT c.user_id, c.role, u.username FROM collaborators c LEFT JOIN users u ON c.user_id = u.id WHERE c.project_id = ? AND c.user_id = ?', [projectId, user.id]);
  // notify the user
  const note = await run('INSERT INTO notifications(user_id, project_id, body) VALUES(?, ?, ?)', [user.id, projectId, `You were added to project ${projectId}`]);
  const notif = await get('SELECT * FROM notifications WHERE id = ?', [note.lastID]);
  io.to(`project-${projectId}`).emit('collaborator:added', coll);
  io.to(`user-${user.id}`).emit('notification', notif);
  res.json(coll);
});

app.get('/api/projects/:projectId/collaborators', authMiddleware, async (req, res) => {
  const projectId = req.params.projectId;
  const coll = await all('SELECT c.user_id, c.role, u.username FROM collaborators c LEFT JOIN users u ON c.user_id = u.id WHERE c.project_id = ?', [projectId]);
  res.json(coll);
});

app.delete('/api/projects/:projectId/collaborators/:userId', authMiddleware, async (req, res) => {
  const projectId = req.params.projectId;
  const userId = req.params.userId;
  await run('DELETE FROM collaborators WHERE project_id = ? AND user_id = ?', [projectId, userId]);
  io.to(`project-${projectId}`).emit('collaborator:removed', { user_id: userId });
  res.json({ ok: true });
});

app.put('/api/projects/:projectId/collaborators/:userId', authMiddleware, async (req, res) => {
  const projectId = req.params.projectId;
  const userId = req.params.userId;
  const { role } = req.body;
  if (!role) return res.status(400).json({ error: 'Missing role' });
  await run('UPDATE collaborators SET role = ? WHERE project_id = ? AND user_id = ?', [role, projectId, userId]);
  const coll = await get('SELECT c.user_id, c.role, u.username FROM collaborators c LEFT JOIN users u ON c.user_id = u.id WHERE c.project_id = ? AND c.user_id = ?', [projectId, userId]);
  // create notification for the user about role change
  const note = await run('INSERT INTO notifications(user_id, project_id, body) VALUES(?, ?, ?)', [userId, projectId, `Your role was changed to ${role} on project ${projectId}`]);
  const notif = await get('SELECT * FROM notifications WHERE id = ?', [note.lastID]);
  io.to(`project-${projectId}`).emit('collaborator:updated', coll);
  io.to(`user-${userId}`).emit('notification', notif);
  res.json(coll);
});

// Notifications
app.get('/api/notifications', authMiddleware, async (req, res) => {
  const notes = await all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
  res.json(notes);
});

app.post('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  const id = req.params.id;
  await run('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?', [id, req.user.id]);
  res.json({ ok: true });
});

app.get('/api/projects/:projectId/messages', authMiddleware, async (req, res) => {
  const projectId = req.params.projectId;
  const msgs = await all('SELECT * FROM messages WHERE project_id = ? ORDER BY created_at ASC', [projectId]);
  res.json(msgs);
});

app.get('/api/tasks/:taskId/comments', authMiddleware, async (req, res) => {
  const taskId = req.params.taskId;
  const comments = await all('SELECT * FROM comments WHERE task_id = ?', [taskId]);
  res.json(comments);
});

// Socket.IO connection
io.on('connection', (socket) => {
  socket.on('identify', async (token) => {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      socket.user = payload;
      socket.join(`user-${payload.id}`);
    } catch (e) {
      // ignore
    }
  });

  socket.on('joinProject', (projectId) => {
    socket.join(`project-${projectId}`);
  });
  socket.on('leaveProject', (projectId) => {
    socket.leave(`project-${projectId}`);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
