# Task Board

A lightweight Trello-like task board application built with Vue 3 and Express.

## Tech Stack

### Frontend
- Vue 3 + Vite
- Vue Router
- Pinia (state management)
- Element Plus (UI components)
- vuedraggable (drag and drop)
- Axios (HTTP client)

### Backend
- Node.js + Express
- better-sqlite3 (SQLite database)
- jsonwebtoken (JWT authentication)
- bcryptjs (password hashing)
- cors

## Project Structure

```
task-board/
├── frontend/          # Vue 3 frontend (port 5174)
│   ├── src/
│   │   ├── api/       # Axios API layer
│   │   ├── components/# Reusable Vue components
│   │   ├── router/    # Vue Router configuration
│   │   ├── stores/    # Pinia stores (auth, board)
│   │   └── views/     # Page-level components
│   └── vite.config.js
├── backend/           # Express API (port 3002)
│   ├── db/            # Database init and seed scripts
│   ├── middleware/    # Auth middleware (JWT)
│   ├── routes/       # API route handlers
│   ├── data/         # SQLite database file
│   └── server.js
└── README.md
```

## Getting Started

### Prerequisites
- Node.js 18+

### Backend Setup

```bash
cd backend
npm install
npm run seed     # Seed database with demo data
npm run dev      # Start server on port 3002
```

### Frontend Setup

```bash
cd frontend
npm install
npm run dev      # Start dev server on port 5174
```

### Demo Account

- Username: `demo`
- Password: `demo123`

The seed script creates a demo user with a sample board "My Project" containing 3 columns (To Do, In Progress, Done) and 7 sample cards.

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login (returns JWT)

### Boards
- `GET /api/boards` - List user's boards (includes `column_count`, `card_count`, `last_updated_at`)
- `POST /api/boards` - Create board
- `DELETE /api/boards/:id` - Delete board
- `GET /api/boards/:id/export` - Download a hierarchical JSON summary of the board, its columns and cards

### Columns
- `GET /api/boards/:boardId/columns` - Get columns for a board (with card counts, `is_default` flag and `source`: `default`/`custom`)
- `POST /api/boards/:boardId/columns` - Add column
- `PUT /api/columns/:id` - Update column (rename/reorder)
- `DELETE /api/columns/:id` - Delete column

### Cards
- `GET /api/columns/:columnId/cards` - Get cards in column
- `POST /api/columns/:columnId/cards` - Add card
- `PUT /api/cards/:id` - Update card
- `DELETE /api/cards/:id` - Delete card
- `PUT /api/cards/:id/move` - Move card to another column

### Exports
- `GET /api/exports` - Overview of all boards and their downloadable summary files

## Board summary export

`GET /api/boards/:id/export` returns a downloadable JSON file containing a
hierarchical snapshot of a board:

```json
{
  "type": "board_summary",
  "exported_at": "2026-09-24T09:40:01.790Z",
  "board": {
    "id": 1,
    "name": "My Project",
    "description": "sample",
    "created_at": "2026-09-24T09:40:01.000Z",
    "last_updated_at": "2026-09-24T09:40:01.000Z"
  },
  "totals": { "column_count": 4, "card_count": 2 },
  "columns": [
    {
      "id": 1,
      "name": "To Do",
      "position": 0,
      "source": "default",
      "is_default": true,
      "card_count": 1,
      "cards": [ { "id": 1, "title": "Task 1", "priority": "high", "position": 0 } ]
    }
  ]
}
```

- Columns shipped with every new board (`To Do`, `In Progress`, `Done`) are
  marked `"source": "default"`; columns added by users are `"source": "custom"`.
- Files are written atomically (temp file + rename) into
  `backend/data/exports/` as `board-<id>-summary-<timestamp>.json`. Re-exporting
  replaces the previous file, so each board has at most one summary on disk;
  concurrent exports of the same board are coalesced.
- Any create/update/delete/move on a board's columns or cards (or deleting the
  board itself) removes the stale summary, and `GET /api/exports` reconciles
  the directory against live data — contradictory, corrupt, duplicate or
  orphaned files are deleted automatically.
- An interrupted download cannot corrupt or duplicate the stored file, and an
  empty board exports a valid summary with zero counts.

### Tests

```bash
cd backend
npm test         # boots the API against an isolated temp database
```

## Features

- User authentication with JWT
- Create and manage multiple boards
- Add, rename, and delete columns
- Create cards with title, description, priority (low/medium/high), and due date
- Drag and drop cards between columns
- Drag and drop to reorder columns
- Responsive design with Element Plus UI
