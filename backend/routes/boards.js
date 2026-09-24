const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { DEFAULT_COLUMNS } = require('../constants');
const {
  prepareBoardExport,
  writeBoardExport,
  invalidateBoardExport,
  BoardNotFoundError
} = require('../services/exportService');

const router = express.Router();

// All board routes require authentication
router.use(authMiddleware);

// Concurrent exports of the same board share one file write, so they can never
// produce duplicate files. Keyed by board id; resolved once writing finishes.
const exportLocks = new Map();

// GET /api/boards - List user's boards
router.get('/', (req, res) => {
  const db = getDb();
  try {
    const boards = db.prepare(`
      SELECT b.*,
        (SELECT COUNT(*) FROM columns WHERE board_id = b.id) AS column_count,
        (SELECT COUNT(*) FROM cards c JOIN columns col ON c.column_id = col.id WHERE col.board_id = b.id) AS card_count,
        (
          SELECT MAX(t) FROM (
            SELECT MAX(created_at) AS t FROM columns WHERE board_id = b.id
            UNION ALL
            SELECT MAX(c.updated_at) AS t FROM cards c JOIN columns col ON c.column_id = col.id WHERE col.board_id = b.id
            UNION ALL
            SELECT MAX(c.created_at) AS t FROM cards c JOIN columns col ON c.column_id = col.id WHERE col.board_id = b.id
          )
        ) AS last_updated_at_raw
      FROM boards b
      WHERE b.user_id = ?
      ORDER BY b.created_at DESC
    `).all(req.user.id);
    db.close();
    // New field uses ISO 8601 (UTC); all pre-existing fields are untouched.
    for (const board of boards) {
      const value = board.last_updated_at_raw || board.created_at;
      board.last_updated_at = value ? new Date(value.replace(' ', 'T') + 'Z').toISOString() : null;
      delete board.last_updated_at_raw;
    }
    res.json(boards);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to fetch boards' });
  }
});

// POST /api/boards - Create board
router.post('/', (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Board name is required' });
  }

  const db = getDb();
  try {
    const result = db.prepare('INSERT INTO boards (user_id, name, description) VALUES (?, ?, ?)').run(
      req.user.id,
      name.trim(),
      description || ''
    );
    const boardId = result.lastInsertRowid;

    // Create default columns
    const insertCol = db.prepare(
      'INSERT INTO columns (board_id, name, position, is_default) VALUES (?, ?, ?, 1)'
    );
    for (const col of DEFAULT_COLUMNS) {
      insertCol.run(boardId, col.name, col.position);
    }

    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);
    db.close();
    res.status(201).json(board);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to create board' });
  }
});

// GET /api/boards/:id/export - Download a hierarchical summary file
router.get('/:id/export', async (req, res) => {
  const boardId = Number(req.params.id);

  // Ownership is always checked up front, including for waiters joining an
  // in-flight export, so one user can never receive another user's file.
  const ownershipDb = getDb();
  const owned = ownershipDb
    .prepare('SELECT id FROM boards WHERE id = ? AND user_id = ?')
    .get(boardId, req.user.id);
  ownershipDb.close();
  if (!owned) {
    return res.status(404).json({ error: 'Board not found' });
  }

  // Concurrent exports of the same board share the in-flight write so they
  // can never produce duplicate files.
  const existing = exportLocks.get(boardId);
  if (existing) {
    try {
      const result = await existing;
      sendSummary(res, result);
    } catch (err) {
      if (err instanceof BoardNotFoundError) {
        return res.status(404).json({ error: 'Board not found' });
      }
      res.status(500).json({ error: 'Failed to export board' });
    }
    return;
  }

  const db = getDb();
  let prepared;
  try {
    // All DB reads happen synchronously on this open connection, giving a
    // consistent snapshot and avoiding use-after-close races.
    prepared = prepareBoardExport(db, boardId, req.user.id);
  } catch (err) {
    db.close();
    if (err instanceof BoardNotFoundError) {
      return res.status(404).json({ error: 'Board not found' });
    }
    return res.status(500).json({ error: 'Failed to export board' });
  }

  // Filesystem write happens after the DB snapshot; the connection stays open
  // so the post-write existence guard can detect a board deleted mid-export.
  const writePromise = Promise.resolve().then(() => writeBoardExport(prepared, db));
  exportLocks.set(boardId, writePromise);
  writePromise.finally(() => {
    db.close();
    if (exportLocks.get(boardId) === writePromise) exportLocks.delete(boardId);
  });

  try {
    const result = await writePromise;
    sendSummary(res, result);
  } catch (err) {
    if (err instanceof BoardNotFoundError) {
      return res.status(404).json({ error: 'Board not found' });
    }
    res.status(500).json({ error: 'Failed to export board' });
  }
});

// Stream the already-complete summary file; an aborted download cannot affect
// the stored file, so no partial or duplicate artifacts are ever produced.
function sendSummary(res, { filePath, fileName }) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.download(filePath, fileName, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: 'Failed to download summary' });
    }
  });
}

// DELETE /api/boards/:id - Delete board
router.delete('/:id', (req, res) => {
  const db = getDb();
  try {
    const board = db.prepare('SELECT * FROM boards WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!board) {
      db.close();
      return res.status(404).json({ error: 'Board not found' });
    }

    db.prepare('DELETE FROM boards WHERE id = ?').run(req.params.id);
    db.close();

    // Remove any exported summary so no file outlives its board.
    invalidateBoardExport(Number(req.params.id));

    res.json({ message: 'Board deleted' });
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to delete board' });
  }
});

module.exports = router;
