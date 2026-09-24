const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { generateBoardExport, refreshBoardExport, removeBoardExport } = require('../services/exporter');

const router = express.Router();

// All board routes require authentication
router.use(authMiddleware);

// GET /api/boards - List user's boards
router.get('/', (req, res) => {
  const db = getDb();
  try {
    const boards = db.prepare(`
      SELECT b.*,
        (SELECT COUNT(*) FROM columns WHERE board_id = b.id) AS column_count,
        (SELECT COUNT(*) FROM cards c JOIN columns col ON c.column_id = col.id WHERE col.board_id = b.id) AS card_count
      FROM boards b
      WHERE b.user_id = ?
      ORDER BY b.created_at DESC
    `).all(req.user.id);
    db.close();
    // Keep the downloadable summaries in sync with what was just read
    for (const board of boards) {
      refreshBoardExport(board.id);
    }
    res.json(boards);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to fetch boards' });
  }
});

// GET /api/boards/:id/export - Download the hierarchical summary file for a board
router.get('/:id/export', (req, res) => {
  const db = getDb();
  let board;
  try {
    board = db.prepare('SELECT * FROM boards WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    db.close();
  } catch (err) {
    db.close();
    return res.status(500).json({ error: 'Failed to export board' });
  }

  if (!board) {
    return res.status(404).json({ error: 'Board not found' });
  }

  try {
    // Regenerate from current DB state so the download always matches actual content
    const result = generateBoardExport(board.id);
    if (!result) {
      return res.status(404).json({ error: 'Board not found' });
    }
    res.download(result.filePath, `board-${board.id}-summary.json`, (err) => {
      // Client may abort mid-download; the file on disk is already complete
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'Failed to download export' });
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to export board' });
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
    const insertCol = db.prepare('INSERT INTO columns (board_id, name, position, is_default) VALUES (?, ?, ?, ?)');
    insertCol.run(boardId, 'To Do', 0, 1);
    insertCol.run(boardId, 'In Progress', 1, 1);
    insertCol.run(boardId, 'Done', 2, 1);

    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);
    db.close();
    refreshBoardExport(boardId);
    res.status(201).json(board);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to create board' });
  }
});

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
    // The summary of a deleted board must not linger on disk
    removeBoardExport(req.params.id);
    res.json({ message: 'Board deleted' });
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to delete board' });
  }
});

module.exports = router;
