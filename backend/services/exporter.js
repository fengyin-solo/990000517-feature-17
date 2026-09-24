const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/init');

const EXPORT_DIR = path.join(__dirname, '..', 'data', 'exports');
const EXPORT_VERSION = 1;

function ensureExportDir() {
  if (!fs.existsSync(EXPORT_DIR)) {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
  }
}

// One canonical file per board, so re-exports never create duplicates.
function exportFilePath(boardId) {
  return path.join(EXPORT_DIR, `board-${boardId}-summary.json`);
}

// Build the hierarchical summary (board -> columns -> cards) from current DB state.
// Returns null when the board does not exist.
function buildBoardSummary(db, boardId) {
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);
  if (!board) return null;

  const columns = db.prepare(`
    SELECT * FROM columns WHERE board_id = ? ORDER BY position ASC
  `).all(boardId);

  const cardsStmt = db.prepare('SELECT * FROM cards WHERE column_id = ? ORDER BY position ASC');

  const timestamps = [board.created_at];
  let cardCount = 0;

  const columnSummaries = columns.map((col) => {
    const cards = cardsStmt.all(col.id);
    timestamps.push(col.created_at);
    for (const card of cards) {
      timestamps.push(card.created_at, card.updated_at);
    }
    cardCount += cards.length;

    return {
      id: col.id,
      name: col.name,
      position: col.position,
      is_default: !!col.is_default,
      source: col.is_default ? 'default' : 'custom',
      created_at: col.created_at,
      card_count: cards.length,
      cards: cards.map((card) => ({
        id: card.id,
        title: card.title,
        description: card.description,
        priority: card.priority,
        due_date: card.due_date,
        position: card.position,
        created_at: card.created_at,
        updated_at: card.updated_at
      }))
    };
  });

  // SQLite datetimes are zero-padded 'YYYY-MM-DD HH:MM:SS', so lexicographic max works.
  const lastUpdatedAt = timestamps.filter(Boolean).sort().pop() || null;

  return {
    version: EXPORT_VERSION,
    generated_at: new Date().toISOString(),
    board: {
      id: board.id,
      name: board.name,
      description: board.description,
      created_at: board.created_at,
      last_updated_at: lastUpdatedAt,
      column_count: columnSummaries.length,
      card_count: cardCount,
      columns: columnSummaries
    }
  };
}

// Write via a unique tmp file + atomic rename: an interrupted write can never
// leave a partial or corrupted summary at the canonical path.
function writeFileAtomic(filePath, content) {
  ensureExportDir();
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* already gone */ }
    throw err;
  }
}

// Remove leftover tmp files from interrupted previous exports of this board.
function cleanupStaleTmpFiles(boardId) {
  ensureExportDir();
  const prefix = `board-${boardId}-summary.json.`;
  for (const entry of fs.readdirSync(EXPORT_DIR)) {
    if (entry.startsWith(prefix) && entry.endsWith('.tmp')) {
      try { fs.unlinkSync(path.join(EXPORT_DIR, entry)); } catch (_) { /* ignore */ }
    }
  }
}

// Regenerate the export file for a board from current DB state.
// Returns { summary, filePath }, or null when the board no longer exists.
function generateBoardExport(boardId) {
  const db = getDb();
  let summary;
  try {
    summary = buildBoardSummary(db, boardId);
  } finally {
    db.close();
  }
  if (!summary) return null;

  cleanupStaleTmpFiles(boardId);
  const filePath = exportFilePath(boardId);
  writeFileAtomic(filePath, JSON.stringify(summary, null, 2));
  return { summary, filePath };
}

// Best-effort refresh used by read/mutation routes; never throws.
function refreshBoardExport(boardId) {
  try {
    generateBoardExport(boardId);
  } catch (err) {
    console.error(`Failed to refresh export for board ${boardId}:`, err.message);
  }
}

// Remove the export file (and stale tmp files) for a deleted board. Idempotent.
function removeBoardExport(boardId) {
  try {
    cleanupStaleTmpFiles(boardId);
    const filePath = exportFilePath(boardId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error(`Failed to remove export for board ${boardId}:`, err.message);
  }
}

module.exports = {
  EXPORT_DIR,
  exportFilePath,
  buildBoardSummary,
  generateBoardExport,
  refreshBoardExport,
  removeBoardExport
};
