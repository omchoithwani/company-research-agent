require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const path = require('path');
const db = require('./db');
const { researchCompany, checkOllamaHealth } = require('./ollama');
const { pushToHubspot, checkHubspotHealth } = require('./hubspot');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// POST /upload
app.post('/upload', upload.single('csv'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let records;
  try {
    records = parse(req.file.buffer.toString('utf8'), {
      columns: header => header.map(h => h.toLowerCase().trim().replace(/\s+/g, '_')),
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  } catch (e) {
    return res.status(400).json({ error: 'Invalid CSV: ' + e.message });
  }

  const newCompanies = [];
  const skippedDuplicates = [];

  for (const row of records) {
    const domain = (row.domain || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
    if (!domain) continue;

    const payload = {
      domain,
      company_name: row.company_name || row.name || row.company || '',
      description: row.description || '',
      linkedin_url: row.linkedin_url || row.linkedin || '',
      location: row.location || row.city || '',
      industry: row.industry || '',
    };

    const existing = db.getCompanyByDomain(domain);

    if (existing) {
      if (existing.research_status === 'completed') {
        skippedDuplicates.push(existing);
        continue;
      }
      if (existing.research_status === 'failed') {
        db.updateCompanyStatus(existing.id, 'pending');
        newCompanies.push(db.getCompanyById(existing.id));
        continue;
      }
      // already pending — skip silently (don't duplicate)
      skippedDuplicates.push(existing);
    } else {
      const id = db.insertCompany(payload);
      newCompanies.push(db.getCompanyById(id));
    }
  }

  res.json({
    newCompanies,
    skippedDuplicates,
    count: { new: newCompanies.length, skipped: skippedDuplicates.length },
  });
});

// GET /research/stream — SSE
app.get('/research/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const ollamaOk = await checkOllamaHealth();
  if (!ollamaOk) {
    send('error', { message: 'Ollama is not running. Start it with: ollama serve' });
    res.end();
    return;
  }

  const pending = db.getPendingCompanies();
  if (pending.length === 0) {
    send('done', { message: 'No pending companies to research' });
    res.end();
    return;
  }

  send('start', { total: pending.length });

  for (let i = 0; i < pending.length; i++) {
    const company = pending[i];
    if (res.writableEnded) break;

    send('progress', {
      current: i + 1,
      total: pending.length,
      companyName: company.company_name || company.domain,
      id: company.id,
    });

    try {
      const result = await researchCompany(company);
      db.updateCompanyResearch(company.id, result);
      send('result', { id: company.id, success: true, company: db.getCompanyById(company.id) });
    } catch (e) {
      console.error(`[Research] FAILED for ${company.domain}: ${e.message}`);
      db.failCompany(company.id, e.message);
      send('result', { id: company.id, success: false, error: e.message, company: db.getCompanyById(company.id) });
    }

    // Brief pause between companies to let the system breathe
    if (i < pending.length - 1 && !res.writableEnded) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  send('done', { message: 'Research complete' });
  res.end();
});

// GET /companies
app.get('/companies', (req, res) => {
  res.json(db.getAllCompanies());
});

// GET /companies/:id
app.get('/companies/:id', (req, res) => {
  const company = db.getCompanyById(req.params.id);
  if (!company) return res.status(404).json({ error: 'Not found' });
  res.json(company);
});

// DELETE /companies/:id
app.delete('/companies/:id', (req, res) => {
  const company = db.getCompanyById(req.params.id);
  if (!company) return res.status(404).json({ error: 'Not found' });
  db.deleteCompany(req.params.id);
  res.json({ success: true });
});

// POST /companies/:id/retry
app.post('/companies/:id/retry', (req, res) => {
  const company = db.getCompanyById(req.params.id);
  if (!company) return res.status(404).json({ error: 'Not found' });
  db.updateCompanyStatus(company.id, 'pending');
  res.json({ success: true, company: db.getCompanyById(company.id) });
});

// POST /hubspot/push/:id
app.post('/hubspot/push/:id', async (req, res) => {
  const company = db.getCompanyById(req.params.id);
  if (!company) return res.status(404).json({ error: 'Not found' });
  if (company.research_status !== 'completed') {
    return res.status(400).json({ error: 'Company research is not completed yet' });
  }
  try {
    const hubspotId = await pushToHubspot(company);
    db.updateHubspotSync(company.id, 'pushed', hubspotId);
    res.json({ success: true, hubspotId, company: db.getCompanyById(company.id) });
  } catch (e) {
    db.updateHubspotSync(company.id, 'failed');
    res.status(500).json({ error: e.message, company: db.getCompanyById(company.id) });
  }
});

// POST /hubspot/push-all
app.post('/hubspot/push-all', async (req, res) => {
  const companies = db.getCompletedNotPushed();
  const results = [];
  for (const company of companies) {
    try {
      const hubspotId = await pushToHubspot(company);
      db.updateHubspotSync(company.id, 'pushed', hubspotId);
      results.push({ id: company.id, success: true, hubspotId });
    } catch (e) {
      db.updateHubspotSync(company.id, 'failed');
      results.push({ id: company.id, success: false, error: e.message });
    }
  }
  res.json({ results, pushed: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length });
});

// GET /health
app.get('/health', async (req, res) => {
  const [ollama, hubspot] = await Promise.all([checkOllamaHealth(), checkHubspotHealth()]);
  res.json({ status: 'ok', ollama, hubspot });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Company Research Agent running on http://localhost:${PORT}`);
});
