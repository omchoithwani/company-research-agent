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
  const confirmedCrm = scraped.detectedCrm.length > 0
    ? `CONFIRMED from live HTML scan: ${scraped.detectedCrm.join(', ')} — treat as fact, do not change`
    : 'Not detected — infer from company profile';
  const confirmedMarketing = scraped.detectedMarketing.length > 0
    ? `CONFIRMED from live HTML scan: ${scraped.detectedMarketing.join(', ')} — treat as fact, do not change`
    : 'Not detected — infer from company profile';
  const allDetected = [...new Set([...scraped.detectedCrm, ...scraped.detectedMarketing])];
  const stackSummary = allDetected.length > 0
    ? `Full confirmed stack: ${allDetected.join(', ')}`
    : 'No tools confirmed from page source.';

  const websiteSection = scraped.scraped ? `
LIVE WEBSITE DATA (fetched from ${scraped.url}):
Title: ${scraped.title || 'N/A'}
Meta description: ${scraped.description || 'N/A'}
Headings found: ${scraped.headings.join(' | ') || 'N/A'}
Page content snippet: ${scraped.bodyText || 'N/A'}
` : `WEBSITE: Could not be fetched — work from company data only.`;

  return `You are playing two expert roles simultaneously. Think hard in each role — do not produce generic output.

━━━ ROLE 1: RevOps / CRO Analyst (15+ years, VP level) ━━━
Your job: assess whether HubSpot is a genuine fit for this prospect — not a sales pitch, an honest evaluation.
Think about: What is their business model? What stage are they at? What does their current stack tell you about their maturity? Where are the likely RevOps gaps — pipeline visibility, lead routing, reporting, marketing-sales alignment? Would HubSpot's Sales Hub, Marketing Hub, or Service Hub actually move the needle, or are they already well-served? Are there real switching costs or roadblocks (e.g. deep Salesforce customisation, enterprise procurement, small team that doesn't need a CRM)?
Be direct and specific. Reference what you can see on their site.

━━━ ROLE 2: Cold Outreach Specialist (10+ years in sales) ━━━
Your job: write outreach that doesn't feel like outreach. You are not pitching software — you are starting a conversation with a smart, busy executive who deletes 40 emails a day.
Rules:
- NEVER open with "I hope this finds you well", "I came across your company", "I wanted to reach out", or anything that sounds like a template
- The first line must be a pattern interrupt — a sharp observation about their business, a provocative question, or a specific detail that signals you've actually looked at their site
- Show one piece of genuine research in every message — something specific from their website, their positioning, their current tools, or their market
- The value prop must feel like a natural consequence of the insight, not a product pitch
- Short, punchy, confident — write like someone who doesn't need the deal

━━━ COMPANY DATA ━━━
Name: ${company.company_name || 'Unknown'}
Description: ${company.description || 'Not provided'}
Domain: ${company.domain}
LinkedIn: ${company.linkedin_url || 'Not provided'}
Location: ${company.location || 'Not provided'}
Industry: ${company.industry || 'Not provided'}

${websiteSection}

TECH STACK (from live HTML scan — treat as confirmed):
CRM: ${confirmedCrm}
Marketing: ${confirmedMarketing}
${stackSummary}

━━━ OUTPUT INSTRUCTIONS ━━━
Return ONLY a valid JSON object. No markdown, no backticks, no explanation, nothing before or after.

{
  "operating_status": "Active" or "Likely Active" or "Unclear",
  "current_crm": exact tool name(s) if confirmed, else your best inference — list all detected, comma-separated,
  "current_marketing_tools": exact tool name(s) if confirmed, else best inference — list all detected,
  "business_summary": "2 specific sentences describing exactly what they do and who they serve — pull from the actual website content, not generic industry descriptions",
  "hubspot_fit": "Strong" or "Moderate" or "Weak",
  "fit_reason": "2-3 sentences from the CRO perspective: what specific gap does HubSpot fill for this company, what product(s) are relevant, and what is the honest roadblock or risk if any",
  "email_pitch": "3 sentences max. Sentence 1: pattern interrupt or sharp observation about something specific on their site or in their stack. Sentence 2: insight or implied pain point — connect their situation to a consequence they care about. Sentence 3: soft CTA or value prop that feels like help, not a pitch. No filler.",
  "linkedin_pitch": "2 sentences. Sentence 1: specific observation about them that shows real research — reference their product, positioning, or a detail from their site. Sentence 2: one question or hook that creates curiosity. Casual, human, zero jargon."
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
