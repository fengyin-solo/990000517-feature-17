const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { getExportOverview } = require('../services/exportService');

const router = express.Router();

router.use(authMiddleware);

// GET /api/exports - Overview of boards and their downloadable summary files.
// Reconciles on-disk exports with live data: stale/contradictory/duplicate or
// orphan files are removed, so the response always matches actual content.
router.get('/', (req, res) => {
  const db = getDb();
  try {
    const overview = getExportOverview(db, req.user.id);
    db.close();
    res.json(overview);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to fetch export overview' });
  }
});

module.exports = router;
