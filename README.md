# Domain — Project Boards (demo)

This is a minimal demo of a collaborative project-management tool (Trello/Asana-like) with:

- User registration & login (JWT)
- Create projects (boards)
- Create tasks (cards) and assign to usernames
- Comment on tasks
- Real-time updates via Socket.IO

Quick start

1. Install dependencies

```bash
npm install
```

2. Run the server

```bash
npm start
```

3. Open http://localhost:4000 in your browser

Notes

- This is a compact demo. For production use, change `JWT_SECRET`, add input validation, pagination, and stronger security.
- Database is a simple SQLite database created at `./data.db`.
# Domain