const { scrapeCompany } = require('./scraper');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const CONFIGURED_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:70b';
const TIMEOUT_MS = 120000;

let cachedModel = null;

async function resolveModel() {
  if (cachedModel) return cachedModel;
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error('tags fetch failed');
    const data = await resp.json();
    const names = (data.models || []).map(m => m.name);
    if (names.some(n => n.startsWith('llama3.1:70b'))) cachedModel = 'llama3.1:70b';
    else if (names.some(n => n.startsWith('llama3.1:8b'))) cachedModel = 'llama3.1:8b';
    else cachedModel = CONFIGURED_MODEL;
  } catch {
    cachedModel = CONFIGURED_MODEL;
  }
  console.log(`[Ollama] Using model: ${cachedModel}`);
  return cachedModel;
}

function buildPrompt(company, scraped) {
  // Definitive tech stack from HTML scanning — tell model these are confirmed, not guesses
  const confirmedCrm = scraped.detectedCrm.length > 0
    ? `CONFIRMED from website HTML: ${scraped.detectedCrm.join(', ')} — use this, do not guess`
    : 'Not detected in page source — infer from company type/size/industry';
  const confirmedMarketing = scraped.detectedMarketing.length > 0
    ? `CONFIRMED from website HTML: ${scraped.detectedMarketing.join(', ')} — use this, do not guess`
    : 'Not detected in page source — infer from company type/size/industry';
  const allDetected = [...new Set([...scraped.detectedCrm, ...scraped.detectedMarketing])];
  const fullStackNote = allDetected.length > 0
    ? `Full detected stack (all tools found in page source): ${allDetected.join(', ')}`
    : 'No tools detected in page source.';

  const websiteSection = scraped.scraped ? `
LIVE WEBSITE DATA (scraped from ${scraped.url}):
- Page title: ${scraped.title || 'N/A'}
- Meta description: ${scraped.description || 'N/A'}
- Key headings on site: ${scraped.headings.join(' | ') || 'N/A'}
- Website text (first 2000 chars): ${scraped.bodyText || 'N/A'}
` : `
WEBSITE DATA: Could not be scraped — rely on the company info below.
`;

  return `You are a senior HubSpot RevOps consultant doing pre-sales research on a prospect. Your goal is to produce highly personalised, insight-driven research that a sales rep can use immediately.

COMPANY INFO:
- Name: ${company.company_name || 'Unknown'}
- Description: ${company.description || 'Not provided'}
- Domain: ${company.domain}
- LinkedIn: ${company.linkedin_url || 'Not provided'}
- Location: ${company.location || 'Not provided'}
- Industry: ${company.industry || 'Not provided'}
${websiteSection}
TECH STACK DETECTION:
- CRM: ${confirmedCrm}
- Marketing tools: ${confirmedMarketing}
- ${fullStackNote}

INSTRUCTIONS:
- For current_crm and current_marketing_tools: if marked CONFIRMED, use that exact value. Do not override confirmed detections.
- If multiple tools are confirmed, list them all (comma-separated) in the relevant field.
- For business_summary: describe what the company actually does based on the website content above — be specific, not generic.
- For hubspot_fit: assess based on their size, industry, current tools, and operational complexity visible on the site.
- For fit_reason: reference something specific about this company — their current tools, their apparent sales process, their team size, or their market — explain concretely why HubSpot would or wouldn't move the needle for them.
- For email_pitch: reference something real and specific from their website (a service they offer, their positioning, a pain point implied by their current stack). Include a concrete HubSpot value prop relevant to their situation. Do NOT write generic lines like "I noticed you're in the X industry".
- For linkedin_pitch: casual and specific — reference something concrete about them. One hook, conversational tone.

Return ONLY a valid JSON object. No markdown, no backticks, no explanation, nothing before or after the JSON.

{
  "operating_status": "Active" or "Likely Active" or "Unclear",
  "current_crm": "HubSpot" or "Salesforce" or "Pipedrive" or "Zoho" or "None detected" or "Unknown",
  "current_marketing_tools": "HubSpot" or "Mailchimp" or "ActiveCampaign" or "Klaviyo" or "Marketo" or "None detected" or "Unknown",
  "business_summary": "2 specific sentences on what they do and who they serve — reference actual services/products from the website",
  "hubspot_fit": "Strong" or "Moderate" or "Weak",
  "fit_reason": "One specific sentence referencing their actual situation — tools, team, or market",
  "email_pitch": "2-3 sentences. Reference something real from their website. Explain a specific HubSpot value prop for their situation. No generic openers.",
  "linkedin_pitch": "1-2 sentences. Specific and conversational. Reference something concrete about them."
}`;
}

function extractJson(text) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON object in response. Got: ${text.slice(0, 300)}`);
  }
  const jsonStr = text.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`JSON parse failed: ${e.message}. Raw snippet: ${jsonStr.slice(0, 300)}`);
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
    console.log(`[Ollama] Raw response for ${company.domain}:\n${text.slice(0, 600)}`);
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

  console.log(`[Scraper] Fetching website: ${company.domain}`);
  const scraped = await scrapeCompany(company.domain);
  if (scraped.scraped) {
    console.log(`[Scraper] OK — CRM detected: [${scraped.detectedCrm.join(', ') || 'none'}] | Marketing: [${scraped.detectedMarketing.join(', ') || 'none'}]`);
  } else {
    console.log(`[Scraper] Could not fetch website for ${company.domain}`);
  }

  const prompt = buildPrompt(company, scraped);
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
