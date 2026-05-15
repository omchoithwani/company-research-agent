const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const CONFIGURED_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:70b';
const FALLBACK_MODEL = 'llama3.1:8b';
const TIMEOUT_MS = 60000;

let cachedModel = null;

async function resolveModel() {
  if (cachedModel) return cachedModel;
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error('tags fetch failed');
    const data = await resp.json();
    const names = (data.models || []).map(m => m.name);
    if (names.some(n => n.startsWith('llama3.1:70b'))) {
      cachedModel = 'llama3.1:70b';
    } else if (names.some(n => n.startsWith('llama3.1:8b'))) {
      cachedModel = 'llama3.1:8b';
    } else {
      cachedModel = CONFIGURED_MODEL;
    }
  } catch {
    cachedModel = CONFIGURED_MODEL;
  }
  return cachedModel;
}

function buildPrompt(company) {
  return `You are a HubSpot RevOps consultant researching a prospective client. Analyze the company below and return a structured JSON assessment.

Company Information:
- Name: ${company.company_name || 'Unknown'}
- Description: ${company.description || 'Not provided'}
- Domain: ${company.domain}
- LinkedIn: ${company.linkedin_url || 'Not provided'}
- Location: ${company.location || 'Not provided'}
- Industry: ${company.industry || 'Not provided'}

Return ONLY a valid JSON object. No markdown, no backticks, no explanation, no extra text before or after. Exactly these fields:

{
  "operating_status": "Active" or "Likely Active" or "Unclear",
  "current_crm": "Salesforce" or "Pipedrive" or "Zoho" or "HubSpot" or "None detected" or "Unknown",
  "current_marketing_tools": "Mailchimp" or "ActiveCampaign" or "Klaviyo" or "None detected" or "Unknown",
  "business_summary": "2 sentences on what they do and who they serve",
  "hubspot_fit": "Strong" or "Moderate" or "Weak",
  "fit_reason": "One sentence on why HubSpot would specifically help or not help this company",
  "email_pitch": "2-3 sentence cold email pitch angle with core hook and value prop, personalised to their tools and business. Not a full email. No generic lines.",
  "linkedin_pitch": "1-2 sentence LinkedIn message angle. Conversational, not salesy."
}`;
}

async function attemptResearch(model, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
    const data = await response.json();
    const text = (data.response || '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON object found in response');
    return JSON.parse(match[0]);
  } finally {
    clearTimeout(timer);
  }
}

async function researchCompany(company) {
  const model = await resolveModel();
  const prompt = buildPrompt(company);
  try {
    return await attemptResearch(model, prompt);
  } catch {
    // single retry
    return await attemptResearch(model, prompt);
  }
}

async function checkOllamaHealth() {
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch {
    return false;
  }
}

module.exports = { researchCompany, checkOllamaHealth, resolveModel };
