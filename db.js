const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'companies.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT UNIQUE NOT NULL,
    company_name TEXT,
    description TEXT,
    linkedin_url TEXT,
    location TEXT,
    industry TEXT,
    operating_status TEXT,
    current_crm TEXT,
    current_marketing_tools TEXT,
    business_summary TEXT,
    hubspot_fit TEXT,
    fit_reason TEXT,
    email_pitch TEXT,
    linkedin_pitch TEXT,
    research_status TEXT DEFAULT 'pending',
    hubspot_sync_status TEXT DEFAULT 'not_pushed',
    hubspot_company_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const stmts = {
  insert: db.prepare(`
    INSERT INTO companies (domain, company_name, description, linkedin_url, location, industry)
    VALUES (:domain, :company_name, :description, :linkedin_url, :location, :industry)
  `),
  byDomain: db.prepare('SELECT * FROM companies WHERE domain = ?'),
  byId: db.prepare('SELECT * FROM companies WHERE id = ?'),
  all: db.prepare('SELECT * FROM companies ORDER BY created_at DESC'),
  pending: db.prepare("SELECT * FROM companies WHERE research_status = 'pending' ORDER BY created_at ASC"),
  completedNotPushed: db.prepare("SELECT * FROM companies WHERE research_status = 'completed' AND hubspot_sync_status = 'not_pushed' ORDER BY created_at ASC"),
  updateResearch: db.prepare(`
    UPDATE companies SET
      operating_status = :operating_status,
      current_crm = :current_crm,
      current_marketing_tools = :current_marketing_tools,
      business_summary = :business_summary,
      hubspot_fit = :hubspot_fit,
      fit_reason = :fit_reason,
      email_pitch = :email_pitch,
      linkedin_pitch = :linkedin_pitch,
      research_status = 'completed',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = :id
  `),
  updateStatus: db.prepare("UPDATE companies SET research_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"),
  updateHubspot: db.prepare("UPDATE companies SET hubspot_sync_status = ?, hubspot_company_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"),
  delete: db.prepare('DELETE FROM companies WHERE id = ?'),
};

module.exports = {
  insertCompany(data) {
    return stmts.insert.run(data).lastInsertRowid;
  },
  getCompanyByDomain(domain) {
    return stmts.byDomain.get(domain);
  },
  getCompanyById(id) {
    return stmts.byId.get(id);
  },
  getAllCompanies() {
    return stmts.all.all();
  },
  getPendingCompanies() {
    return stmts.pending.all();
  },
  getCompletedNotPushed() {
    return stmts.completedNotPushed.all();
  },
  updateCompanyResearch(id, data) {
    stmts.updateResearch.run({ ...data, id });
  },
  updateCompanyStatus(id, status) {
    stmts.updateStatus.run(status, id);
  },
  updateHubspotSync(id, status, hubspotId = null) {
    stmts.updateHubspot.run(status, hubspotId, id);
  },
  deleteCompany(id) {
    stmts.delete.run(id);
  },
};
