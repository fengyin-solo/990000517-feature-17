/* Integration tests for the board export feature.
 * Boots the real server against an isolated temp database + export dir
 * and exercises it over HTTP using the built-in fetch client.
 *
 * Run: node test/export.test.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-test-'));
const DB_PATH = path.join(TMP_ROOT, 'test.db');
const EXPORT_DIR = path.join(TMP_ROOT, 'exports');
const PORT = '3999';

let serverProc;
let failures = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/health`);
      if (res.ok) return;
    } catch (_) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Server did not start in time');
}

async function startServer() {
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, TASKBOARD_DB_PATH: DB_PATH, PORT },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  serverProc.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
  await waitForServer();
}

async function stopServer() {
  if (serverProc) {
    serverProc.kill();
    await new Promise(r => serverProc.on('exit', r));
  }
}

function api(token, method, urlPath, body) {
  return fetch(`http://localhost:${PORT}/api${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

function listExportFiles(boardId) {
  if (!fs.existsSync(EXPORT_DIR)) return [];
  const pattern = new RegExp(`^board-${boardId}-summary-.+\\.json$`);
  return fs.readdirSync(EXPORT_DIR).filter(f => pattern.test(f));
}

async function registerUser(suffix) {
  const res = await api(null, 'POST', '/auth/register', {
    username: `tester_${suffix}_${Date.now()}`,
    password: 'pass1234'
  });
  assert.strictEqual(res.status, 201, `register status ${res.status}`);
  const data = await res.json();
  return data.token;
}

async function createBoard(token, name) {
  const res = await api(token, 'POST', '/boards', { name, description: 'desc' });
  assert.strictEqual(res.status, 201);
  return res.json();
}

async function run() {
  await startServer();

  const token = await registerUser('a');
  const token2 = await registerUser('b');

  test('default columns are marked with source=default; custom columns are custom', async () => {
    const board = await createBoard(token, 'Board 1');
    const res = await api(token, 'GET', `/boards/${board.id}/columns`);
    const columns = await res.json();
    assert.strictEqual(columns.length, 3);
    assert.deepStrictEqual(
      columns.map(c => [c.name, c.source, c.is_default]),
      [['To Do', 'default', true], ['In Progress', 'default', true], ['Done', 'default', true]]
    );
    // Existing fields still present
    assert.ok('id' in columns[0] && 'position' in columns[0] && 'card_count' in columns[0]);

    const add = await api(token, 'POST', `/boards/${board.id}/columns`, { name: 'Backlog' });
    assert.strictEqual(add.status, 201);
    const custom = await add.json();
    assert.strictEqual(custom.source, 'custom');
    assert.strictEqual(custom.is_default, false);
  });

  test('boards list exposes last_updated_at and keeps existing fields', async () => {
    const res = await api(token, 'GET', '/boards');
    const boards = await res.json();
    for (const b of boards) {
      assert.ok(b.last_updated_at, 'last_updated_at present');
      assert.ok(!Number.isNaN(Date.parse(b.last_updated_at)));
      assert.ok('column_count' in b && 'card_count' in b && 'created_at' in b && 'name' in b);
    }
  });

  test('export downloads hierarchical summary with sources and timestamps', async () => {
    const board = await createBoard(token, 'Export Board');
    const cols = await (await api(token, 'GET', `/boards/${board.id}/columns`)).json();
    // Add a card to "To Do"
    const cardRes = await api(token, 'POST', `/columns/${cols[0].id}/cards`, {
      title: 'Task A', description: 'do it', priority: 'high', due_date: '2026-10-01'
    });
    assert.strictEqual(cardRes.status, 201);

    const res = await api(token, 'GET', `/boards/${board.id}/export`);
    assert.strictEqual(res.status, 200);
    assert.ok(/attachment/.test(res.headers.get('content-disposition')));
    assert.match(res.headers.get('content-disposition'), /filename="board-\d+-summary-[^"]+\.json"/);

    const summary = await res.json();
    assert.strictEqual(summary.type, 'board_summary');
    assert.strictEqual(summary.board.id, board.id);
    assert.strictEqual(summary.board.name, 'Export Board');
    assert.ok(summary.board.created_at);
    assert.ok(summary.board.last_updated_at);
    assert.ok(summary.exported_at);
    assert.strictEqual(summary.totals.column_count, 3);
    assert.strictEqual(summary.totals.card_count, 1);
    assert.strictEqual(summary.columns.length, 3);
    const todo = summary.columns.find(c => c.name === 'To Do');
    assert.strictEqual(todo.source, 'default');
    assert.strictEqual(todo.card_count, 1);
    assert.strictEqual(todo.cards[0].title, 'Task A');
    assert.strictEqual(todo.cards[0].priority, 'high');
    assert.strictEqual(todo.cards[0].due_date, '2026-10-01');

    const files = listExportFiles(board.id);
    assert.strictEqual(files.length, 1, 'exactly one export file on disk');
  });

  test('re-export keeps exactly one file (no duplicates)', async () => {
    const boards = await (await api(token, 'GET', '/boards')).json();
    const board = boards.find(b => b.name === 'Export Board');
    await api(token, 'GET', `/boards/${board.id}/export`);
    await new Promise(r => setTimeout(r, 5));
    await api(token, 'GET', `/boards/${board.id}/export`);
    const files = listExportFiles(board.id);
    assert.strictEqual(files.length, 1, 're-export replaces, never duplicates');
  });

  test('overview matches actual content and disk state', async () => {
    const res = await api(token, 'GET', '/exports');
    const overview = await res.json();
    const boards = await (await api(token, 'GET', '/boards')).json();
    assert.strictEqual(overview.totals.board_count, boards.length);
    for (const b of boards) {
      const entry = overview.boards.find(o => o.id === b.id);
      assert.ok(entry, `overview contains board ${b.id}`);
      assert.strictEqual(entry.name, b.name);
      assert.ok(entry.last_updated_at);
      const files = listExportFiles(b.id);
      if (files.length === 1) {
        assert.ok(entry.export, `board ${b.id} marked exported`);
        assert.strictEqual(entry.export.file_name, files[0]);
      } else {
        assert.strictEqual(entry.export, null);
      }
    }
    const exportedBoard = overview.boards.find(o => o.name === 'Export Board');
    assert.ok(exportedBoard.export);
  });

  test('mutation invalidates existing export; overview and re-export agree', async () => {
    const boards = await (await api(token, 'GET', '/boards')).json();
    const board = boards.find(b => b.name === 'Export Board');
    // ensure exported
    await api(token, 'GET', `/boards/${board.id}/export`);
    assert.strictEqual(listExportFiles(board.id).length, 1);

    // add another card -> stale file must be removed
    const cols = await (await api(token, 'GET', `/boards/${board.id}/columns`)).json();
    await api(token, 'POST', `/columns/${cols[1].id}/cards`, { title: 'Task B' });
    assert.strictEqual(listExportFiles(board.id).length, 0, 'export removed after mutation');

    const overview = (await (await api(token, 'GET', '/exports')).json())
      .boards.find(o => o.id === board.id);
    assert.strictEqual(overview.export, null, 'overview says not exported');

    const res = await api(token, 'GET', `/boards/${board.id}/export`);
    const summary = await res.json();
    assert.strictEqual(summary.totals.card_count, 2, 're-export reflects actual content');
    assert.strictEqual(listExportFiles(board.id).length, 1);
  });

  test('empty board exports valid summary with zero counts', async () => {
    const board = await createBoard(token, 'Empty Board');
    const res = await api(token, 'GET', `/boards/${board.id}/export`);
    assert.strictEqual(res.status, 200);
    const summary = await res.json();
    assert.strictEqual(summary.totals.column_count, 3);
    assert.strictEqual(summary.totals.card_count, 0);
    for (const c of summary.columns) {
      assert.strictEqual(c.card_count, 0);
      assert.deepStrictEqual(c.cards, []);
      assert.strictEqual(c.source, 'default');
    }
    assert.strictEqual(listExportFiles(board.id).length, 1);
    // overview agrees
    const overview = (await (await api(token, 'GET', '/exports')).json())
      .boards.find(o => o.id === board.id);
    assert.ok(overview.export);
  });

  test('interrupted download leaves complete file and no temp files', async () => {
    const board = await createBoard(token, 'Interrupt Board');
    const cols = await (await api(token, 'GET', `/boards/${board.id}/columns`)).json();
    for (let i = 0; i < 3; i++) {
      await api(token, 'POST', `/columns/${cols[0].id}/cards`, { title: `C${i}` });
    }

    const controller = new AbortController();
    const promise = fetch(`http://localhost:${PORT}/api/boards/${board.id}/export`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    // Abort right after headers arrive (file generation is synchronous before stream)
    const res = await promise;
    assert.strictEqual(res.status, 200);
    controller.abort();
    await new Promise(r => setTimeout(r, 200));

    const files = listExportFiles(board.id);
    assert.strictEqual(files.length, 1, 'no duplicate from aborted download');
    const saved = JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, files[0]), 'utf8'));
    assert.strictEqual(saved.totals.card_count, 3, 'saved file is complete, not truncated');
    const temps = fs.readdirSync(EXPORT_DIR).filter(f => f.startsWith('.tmp-'));
    assert.strictEqual(temps.length, 0, 'no temp files left behind');
  });

  test('deleting a card/column/board removes export and stays consistent', async () => {
    const board = await createBoard(token, 'Delete Board');
    const cols = await (await api(token, 'GET', `/boards/${board.id}/columns`)).json();
    const card = await (await api(token, 'POST', `/columns/${cols[2].id}/cards`, { title: 'Gone' })).json();
    await api(token, 'GET', `/boards/${board.id}/export`);
    assert.strictEqual(listExportFiles(board.id).length, 1);

    await api(token, 'DELETE', `/cards/${card.id}`);
    assert.strictEqual(listExportFiles(board.id).length, 0, 'card delete invalidates');

    await api(token, 'GET', `/boards/${board.id}/export`);
    await api(token, 'DELETE', `/columns/${cols[0].id}`);
    assert.strictEqual(listExportFiles(board.id).length, 0, 'column delete invalidates');

    await api(token, 'GET', `/boards/${board.id}/export`);
    assert.strictEqual(listExportFiles(board.id).length, 1);
    await api(token, 'DELETE', `/boards/${board.id}`);
    assert.strictEqual(listExportFiles(board.id).length, 0, 'board delete removes file');

    const gone = await api(token, 'GET', `/boards/${board.id}/export`);
    assert.strictEqual(gone.status, 404, 'cannot export deleted board');

    const overview = await (await api(token, 'GET', '/exports')).json();
    assert.ok(!overview.boards.find(o => o.id === board.id), 'deleted board absent from overview');
  });

  test('overview reconciles contradictory and duplicate files', async () => {
    const boards = await (await api(token, 'GET', '/boards')).json();
    const board = boards.find(b => b.name === 'Empty Board');
    const dir = EXPORT_DIR;
    fs.mkdirSync(dir, { recursive: true });

    // A contradictory file claiming wrong totals
    const stale = `board-${board.id}-summary-2000-01-01T00-00-00-000Z.json`;
    fs.writeFileSync(path.join(dir, stale), JSON.stringify({
      type: 'board_summary',
      exported_at: '2000-01-01T00:00:00.000Z',
      board: { id: board.id, last_updated_at: '2000-01-01T00:00:00.000Z' },
      totals: { column_count: 99, card_count: 99 },
      columns: []
    }));
    // A corrupt file matching the pattern
    fs.writeFileSync(path.join(dir, `board-${board.id}-summary-2001-01-01T00-00-00-000Z.json`), 'not json');

    const overview = await (await api(token, 'GET', '/exports')).json();
    const entry = overview.boards.find(o => o.id === board.id);
    assert.strictEqual(entry.export, null, 'contradictory/corrupt files rejected');
    const remaining = listExportFiles(board.id);
    assert.strictEqual(remaining.length, 0, 'reconciliation deletes bad files');

    // Orphan file for a board id that does not exist anywhere
    fs.writeFileSync(path.join(dir, 'board-999999-summary-2000-01-01T00-00-00-000Z.json'), '{}');
    await api(token, 'GET', '/exports');
    assert.ok(
      !fs.readdirSync(dir).includes('board-999999-summary-2000-01-01T00-00-00-000Z.json'),
      'orphan file removed'
    );
  });

  test('concurrent exports produce exactly one file', async () => {
    const board = await createBoard(token, 'Concurrent Board');
    await Promise.all([
      api(token, 'GET', `/boards/${board.id}/export`),
      api(token, 'GET', `/boards/${board.id}/export`),
      api(token, 'GET', `/boards/${board.id}/export`),
      api(token, 'GET', `/boards/${board.id}/export`),
      api(token, 'GET', `/boards/${board.id}/export`)
    ]);
    assert.strictEqual(listExportFiles(board.id).length, 1, 'single file under concurrency');
  });

  test('cross-user isolation: no export or overview leakage', async () => {
    const boards = await (await api(token, 'GET', '/boards')).json();
    const board = boards[0];
    const res = await api(token2, 'GET', `/boards/${board.id}/export`);
    assert.strictEqual(res.status, 404);
    const overview = await (await api(token2, 'GET', '/exports')).json();
    assert.strictEqual(overview.totals.board_count, 0);
  });

  test('existing field shapes preserved on cards and columns endpoints', async () => {
    const board = await createBoard(token, 'Compat Board');
    const col = (await (await api(token, 'GET', `/boards/${board.id}/columns`)).json())[0];
    const card = await (await api(token, 'POST', `/columns/${col.id}/cards`, {
      title: 'X', description: 'd', priority: 'low'
    })).json();
    for (const key of ['id', 'column_id', 'title', 'description', 'priority', 'due_date', 'position', 'created_at', 'updated_at']) {
      assert.ok(key in card, `card has ${key}`);
    }
    const listed = await (await api(token, 'GET', `/columns/${col.id}/cards`)).json();
    assert.strictEqual(listed.length, 1);
  });

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failures += 1;
      console.error(`  ✗ ${t.name}`);
      console.error(`    ${err.stack || err.message}`);
    }
  }

  await stopServer();
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  if (failures > 0) {
    console.error('TEMP DATA LEFT FOR DEBUG:', TMP_ROOT);
    process.exit(1);
  }
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  process.exit(0);
}

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED', err);
  process.exit(1);
});

run().catch(async err => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
