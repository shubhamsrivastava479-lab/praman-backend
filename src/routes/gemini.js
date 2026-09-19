const express = require('express');
const gemini = require('../services/gemini');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.post('/translate', async (req, res) => {
  const { text, targetLang } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    const translated = await gemini.translateText(text, targetLang || 'English');
    res.json({ translated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/translate-case/:caseId', async (req, res) => {
  await db.read();
  const items = db.data.evidence.filter(e => e.caseId === req.params.caseId && e.caption);
  try {
    for (const item of items) {
      if (!item.captionEn) item.captionEn = await gemini.translateText(item.caption, 'English');
    }
    await db.write();
    res.json({ translated: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
