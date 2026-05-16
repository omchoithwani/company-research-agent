const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const CONFIGURED_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:70b';
const TIMEOUT_MS = 120000; // 2 min — 70b can be slow on first token

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
  console.log(`[Ollama] Using model: ${cachedModel}`);
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

function extractJson(text) {
  // Strip markdown code fences if present (```json ... ``` or ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Find the outermost JSON object
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON object found in model response. Got: ${text.slice(0, 200)}`);
  }
  const jsonStr = text.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`JSON parse failed: ${e.message}. Raw: ${jsonStr.slice(0, 200)}`);
  }
}

async function attemptResearch(model, prompt, company) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    console.log(`[Ollama] Researching: ${company.company_name || company.domain}`);
    const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama HTTP ${response.status}: ${body}`);
    }
    const data = await response.json();
    const text = (data.response || '').trim();
    console.log(`[Ollama] Raw response for ${company.domain}:\n${text.slice(0, 500)}`);
    return extractJson(text);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timed out after 2 minutes waiting for Ollama');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function researchCompany(company) {
  const model = await resolveModel();
  const prompt = buildPrompt(company);
  try {
    return await attemptResearch(model, prompt, company);
  } catch (e) {
    console.warn(`[Ollama] First attempt failed for ${company.domain}: ${e.message}. Retrying...`);
    return await attemptResearch(model, prompt, company);
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
