const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { invalidateBoardExport } = require('../services/exportService');

const router = express.Router();

router.use(authMiddleware);

// Additive column metadata: keep all existing fields and expose whether the
// column was created with the board (default) or added by the user (custom).
function decorateColumn(column) {
  return { ...column, is_default: !!column.is_default, source: column.is_default ? 'default' : 'custom' };
}

// Helper: verify that the board belongs to the user
function verifyBoardOwnership(db, boardId, userId) {
  return db.prepare('SELECT * FROM boards WHERE id = ? AND user_id = ?').get(boardId, userId);
}

// GET /api/boards/:boardId/columns - Get columns for a board (with card counts)
router.get('/boards/:boardId/columns', (req, res) => {
  const db = getDb();
  try {
    const board = verifyBoardOwnership(db, req.params.boardId, req.user.id);
    if (!board) {
      db.close();
      return res.status(404).json({ error: 'Board not found' });
    }

    const columns = db.prepare(`
      SELECT col.*,
        (SELECT COUNT(*) FROM cards WHERE column_id = col.id) AS card_count
      FROM columns col
      WHERE col.board_id = ?
      ORDER BY col.position ASC
    `).all(req.params.boardId);

    db.close();
    res.json(columns.map(decorateColumn));
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to fetch columns' });
  }
});

// POST /api/boards/:boardId/columns - Add column
router.post('/boards/:boardId/columns', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Column name is required' });
  }

  const db = getDb();
  try {
    const board = verifyBoardOwnership(db, req.params.boardId, req.user.id);
    if (!board) {
      db.close();
      return res.status(404).json({ error: 'Board not found' });
    }

    // Get the max position
    const maxPos = db.prepare('SELECT MAX(position) AS maxPos FROM columns WHERE board_id = ?').get(req.params.boardId);
    const newPosition = (maxPos.maxPos ?? -1) + 1;

    const result = db.prepare('INSERT INTO columns (board_id, name, position) VALUES (?, ?, ?)').run(
      req.params.boardId,
      name.trim(),
      newPosition
    );

    const column = db.prepare('SELECT * FROM columns WHERE id = ?').get(result.lastInsertRowid);
    db.close();

    invalidateBoardExport(Number(req.params.boardId));

    res.status(201).json(decorateColumn(column));
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to create column' });
  }
});

// PUT /api/columns/:id - Update column (rename, reorder)
router.put('/columns/:id', (req, res) => {
  const { name, position } = req.body;
  const db = getDb();

  try {
    const column = db.prepare(`
      SELECT col.*, b.user_id FROM columns col
      JOIN boards b ON col.board_id = b.id
      WHERE col.id = ?
    `).get(req.params.id);

    if (!column || column.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Column not found' });
    }

    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name.trim());
    }

    if (position !== undefined) {
      // Reorder: shift other columns
      const oldPos = column.position;
      const newPos = position;

      if (oldPos !== newPos) {
        if (newPos > oldPos) {
          db.prepare(`
            UPDATE columns SET position = position - 1
            WHERE board_id = ? AND position > ? AND position <= ?
          `).run(column.board_id, oldPos, newPos);
        } else {
          db.prepare(`
            UPDATE columns SET position = position + 1
            WHERE board_id = ? AND position >= ? AND position < ?
          `).run(column.board_id, newPos, oldPos);
        }
        updates.push('position = ?');
        params.push(newPos);
      }
    }

    if (updates.length > 0) {
      params.push(req.params.id);
      db.prepare(`UPDATE columns SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    const updated = db.prepare('SELECT * FROM columns WHERE id = ?').get(req.params.id);
    db.close();

    invalidateBoardExport(column.board_id);

    res.json(decorateColumn(updated));
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to update column' });
  }
});

// DELETE /api/columns/:id - Delete column
router.delete('/columns/:id', (req, res) => {
  const db = getDb();
  try {
    const column = db.prepare(`
      SELECT col.*, b.user_id FROM columns col
      JOIN boards b ON col.board_id = b.id
      WHERE col.id = ?
    `).get(req.params.id);

    if (!column || column.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Column not found' });
    }

    // Delete all cards in the column first (cascade should handle it, but be explicit)
    db.prepare('DELETE FROM cards WHERE column_id = ?').run(req.params.id);
    db.prepare('DELETE FROM columns WHERE id = ?').run(req.params.id);

    // Reorder remaining columns
    db.prepare(`
      UPDATE columns SET position = position - 1
      WHERE board_id = ? AND position > ?
    `).run(column.board_id, column.position);

    db.close();

    invalidateBoardExport(column.board_id);

    res.json({ message: 'Column deleted' });
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to delete column' });
  }
});

module.exports = router;
