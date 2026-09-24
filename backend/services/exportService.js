const path = require('path');
const fs = require('fs');
const { DB_PATH } = require('../db/init');

const EXPORT_DIR = path.join(path.dirname(DB_PATH), 'exports');

// Board not found / not owned — mapped to 404 by routes.
class BoardNotFoundError extends Error {}

// SQLite stores `datetime('now')` as "YYYY-MM-DD HH:MM:SS" in UTC.
function toIso(value) {
  if (!value) return null;
  return new Date(value.replace(' ', 'T') + 'Z').toISOString();
}

// Latest update timestamp across a board, its columns and its cards.
const boardLastUpdatedStmt = `
  SELECT MAX(t) AS last_updated_at FROM (
    SELECT MAX(created_at) AS t FROM columns WHERE board_id = @id
    UNION ALL
    SELECT MAX(c.updated_at) AS t
      FROM cards c JOIN columns col ON c.column_id = col.id
     WHERE col.board_id = @id
    UNION ALL
    SELECT MAX(c.created_at) AS t
      FROM cards c JOIN columns col ON c.column_id = col.id
     WHERE col.board_id = @id
  )
`;

function getBoardMeta(db, boardId, userId) {
  const board = db
    .prepare('SELECT * FROM boards WHERE id = ? AND user_id = ?')
    .get(boardId, userId);
  if (!board) return null;
  const row = db.prepare(boardLastUpdatedStmt).get({ id: boardId });
  board.last_updated_at = toIso(row.last_updated_at) || toIso(board.created_at);
  return board;
}

function summaryFileName(boardId, exportedAt) {
  const stamp = exportedAt.toISOString().replace(/[:.]/g, '-');
  return `board-${boardId}-summary-${stamp}.json`;
}

// Matches summary files owned by a specific board: board-<id>-summary-<ts>.json
function summaryFilePattern(boardId) {
  return new RegExp(`^board-${boardId}-summary-(.+)\\.json$`);
}

function ensureExportDir() {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

// Read every column and card of the board and build the hierarchical summary.
// This runs inside the same DB connection/transaction snapshot as the request,
// so the file can never describe content that does not exist at export time.
function buildBoardSummary(db, board) {
  const columns = db
    .prepare('SELECT * FROM columns WHERE board_id = ? ORDER BY position ASC, id ASC')
    .all(board.id);

  const cardsStmt = db.prepare(
    'SELECT * FROM cards WHERE column_id = ? ORDER BY position ASC, id ASC'
  );

  let totalCards = 0;
  const columnSummaries = columns.map(col => {
    const cards = cardsStmt.all(col.id);
    totalCards += cards.length;
    return {
      id: col.id,
      name: col.name,
      position: col.position,
      source: col.is_default ? 'default' : 'custom',
      is_default: !!col.is_default,
      created_at: toIso(col.created_at),
      card_count: cards.length,
      cards: cards.map(card => ({
        id: card.id,
        title: card.title,
        description: card.description,
        priority: card.priority,
        due_date: card.due_date,
        position: card.position,
        created_at: toIso(card.created_at),
        updated_at: toIso(card.updated_at)
      }))
    };
  });

  const lastUpdatedRow = db.prepare(boardLastUpdatedStmt).get({ id: board.id });

  return {
    type: 'board_summary',
    exported_at: null, // filled in by prepareBoardExport
    board: {
      id: board.id,
      name: board.name,
      description: board.description,
      created_at: toIso(board.created_at),
      last_updated_at: toIso(lastUpdatedRow.last_updated_at) || toIso(board.created_at)
    },
    totals: {
      column_count: columns.length,
      card_count: totalCards
    },
    columns: columnSummaries
  };
}

// Build the summary synchronously while the caller's DB connection is open,
// then perform only filesystem work asynchronously. This keeps the exported
// content a consistent snapshot of live data and avoids use-after-close races.
function prepareBoardExport(db, boardId, userId) {
  const board = getBoardMeta(db, boardId, userId);
  if (!board) {
    throw new BoardNotFoundError(`Board ${boardId} not found`);
  }
  const exportedAt = new Date();
  const summary = buildBoardSummary(db, board);
  summary.exported_at = exportedAt.toISOString();
  const fileName = summaryFileName(boardId, exportedAt);
  return { boardId, userId, fileName, summary };
}

// Write a prepared summary atomically: temp file -> rename -> prune older
// summaries for the board. Exactly one valid file can exist for each board.
// After the rename we re-check the board still exists: if it was deleted while
// the write was in flight we remove the file rather than orphaning it.
function writeBoardExport(prepared, db) {
  const { boardId, userId, fileName, summary } = prepared;
  ensureExportDir();
  const finalPath = path.join(EXPORT_DIR, fileName);
  const tmpPath = path.join(EXPORT_DIR, `.tmp-${process.pid}-${boardId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(summary, null, 2), 'utf8');
    fs.renameSync(tmpPath, finalPath);
    pruneOlderSummaries(boardId, fileName);

    if (db && userId !== undefined) {
      const stillExists = db
        .prepare('SELECT id FROM boards WHERE id = ? AND user_id = ?')
        .get(boardId, userId);
      if (!stillExists) {
        try { fs.unlinkSync(finalPath); } catch (_) { /* ignore */ }
        throw new BoardNotFoundError(`Board ${boardId} deleted during export`);
      }
    }
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    throw err;
  }

  return { fileName, filePath: finalPath, exportedAt: new Date(summary.exported_at), summary };
}

// Delete every summary file for a board (called when its content changes).
// Stale files must never survive a mutation — the overview treats a missing
// file as "not exported" and the next export regenerates from current data.
function invalidateBoardExport(boardId) {
  ensureExportDir();
  const pattern = summaryFilePattern(boardId);
  for (const file of fs.readdirSync(EXPORT_DIR)) {
    if (pattern.test(file) || file.startsWith(`.tmp-${process.pid}-${boardId}-`)) {
      try { fs.unlinkSync(path.join(EXPORT_DIR, file)); } catch (_) { /* ignore */ }
    }
  }
}

function pruneOlderSummaries(boardId, keepFileName) {
  const pattern = summaryFilePattern(boardId);
  for (const file of fs.readdirSync(EXPORT_DIR)) {
    if (pattern.test(file) && file !== keepFileName) {
      try { fs.unlinkSync(path.join(EXPORT_DIR, file)); } catch (_) { /* ignore */ }
    }
  }
}

// Remove temporary export files left behind by a previous crashed process.
function cleanupStaleTempFiles() {
  try {
    ensureExportDir();
    for (const file of fs.readdirSync(EXPORT_DIR)) {
      if (file.startsWith('.tmp-')) {
        try { fs.unlinkSync(path.join(EXPORT_DIR, file)); } catch (_) { /* ignore */ }
      }
    }
  } catch (_) { /* ignore */ }
}

// Overview of all the user's boards and their export state. Any file on disk
// that does not match live board data is deleted and reported as not exported,
// so this response always agrees with both the database and the filesystem.
function getExportOverview(db, userId) {
  const boards = db
    .prepare('SELECT * FROM boards WHERE user_id = ? ORDER BY created_at DESC, id DESC')
    .all(userId);

  let filesOnDisk = [];
  try {
    ensureExportDir();
    filesOnDisk = fs.readdirSync(EXPORT_DIR);
  } catch (_) { /* ignore */ }

  let exportedCount = 0;
  const boardOverviews = boards.map(board => {
    const pattern = summaryFilePattern(board.id);
    const matches = filesOnDisk.filter(f => pattern.test(f));

    let exportInfo = null;

    if (matches.length > 1) {
      // Duplicate files (e.g. created by an older release): keep none and force
      // a clean regeneration rather than guessing which one is authoritative.
      for (const file of matches) {
        try { fs.unlinkSync(path.join(EXPORT_DIR, file)); } catch (_) { /* ignore */ }
      }
    } else if (matches.length === 1) {
      const file = matches[0];
      const filePath = path.join(EXPORT_DIR, file);
      let valid = false;
      let summary = null;
      try {
        summary = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (_) { summary = null; }

      if (
        summary &&
        summary.type === 'board_summary' &&
        summary.board &&
        summary.board.id === board.id
      ) {
        const liveSummary = buildBoardSummary(db, board);
        valid =
          liveSummary.totals.column_count === summary.totals.column_count &&
          liveSummary.totals.card_count === summary.totals.card_count &&
          liveSummary.board.last_updated_at === summary.board.last_updated_at &&
          JSON.stringify(liveSummary.columns.map(c => ({
            id: c.id, name: c.name, position: c.position, source: c.source, card_count: c.card_count
          }))) ===
          JSON.stringify(summary.columns.map(c => ({
            id: c.id, name: c.name, position: c.position, source: c.source, card_count: c.card_count
          })));
      }

      if (valid) {
        const stat = fs.statSync(filePath);
        exportInfo = {
          file_name: file,
          exported_at: summary.exported_at,
          file_size: stat.size
        };
        exportedCount += 1;
      } else {
        // Content changed/deleted behind our back: drop the contradictory file.
        try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
      }
    }

    const lastUpdatedRow = db.prepare(boardLastUpdatedStmt).get({ id: board.id });
    return {
      id: board.id,
      name: board.name,
      description: board.description,
      created_at: toIso(board.created_at),
      last_updated_at: toIso(lastUpdatedRow.last_updated_at) || toIso(board.created_at),
      export: exportInfo
    };
  });

  // Remove orphan summary files whose board no longer exists for anyone.
  // Files belonging to another user's boards are left untouched here.
  const boardIds = new Set(boards.map(b => b.id));
  const boardExistsStmt = db.prepare('SELECT 1 FROM boards WHERE id = ?');
  for (const file of filesOnDisk) {
    const m = file.match(/^board-(\d+)-summary-.+\.json$/);
    if (m && !boardIds.has(Number(m[1])) && !boardExistsStmt.get(Number(m[1]))) {
      try { fs.unlinkSync(path.join(EXPORT_DIR, file)); } catch (_) { /* ignore */ }
    }
  }

  return {
    generated_at: new Date().toISOString(),
    totals: {
      board_count: boards.length,
      exported_count: exportedCount
    },
    boards: boardOverviews
  };
}

module.exports = {
  EXPORT_DIR,
  BoardNotFoundError,
  getBoardMeta,
  buildBoardSummary,
  prepareBoardExport,
  writeBoardExport,
  invalidateBoardExport,
  getExportOverview,
  cleanupStaleTempFiles
};
