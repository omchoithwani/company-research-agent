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
  const crmTools = scraped.detectedCrm.length > 0
    ? `CONFIRMED from HTML: ${scraped.detectedCrm.join(', ')}`
    : 'None detected';
  const marketingTools = scraped.detectedMarketing.length > 0
    ? `CONFIRMED from HTML: ${scraped.detectedMarketing.join(', ')}`
    : 'None detected';

  const title        = scraped.title       || 'N/A';
  const metaDesc     = scraped.description || 'N/A';
  const headings     = scraped.scraped ? (scraped.headings.join(' | ') || 'N/A') : 'N/A';
  const bodyText     = scraped.bodyText    || 'N/A';

  return `You are two specialists working together to assess a B2B company and write outreach angles for AeroRev, a HubSpot Solutions Partner.

You will be given company data, live scraped website content, and a confirmed tech stack detected directly from their HTML. Use all of this to produce a structured research output.

---

COMPANY DATA:
Name: ${company.company_name || 'Unknown'}
Domain: ${company.domain}
Industry: ${company.industry || 'Not provided'}
Location: ${company.location || 'Not provided'}
Description: ${company.description || 'Not provided'}
LinkedIn: ${company.linkedin_url || 'Not provided'}

SCRAPED WEBSITE:
Title: ${title}
Meta description: ${metaDesc}
Headings: ${headings}
Body (first 2000 chars): ${bodyText}

TECH STACK CONFIRMED FROM HTML:
CRM tools detected: ${crmTools}
Marketing tools detected: ${marketingTools}

---

ROLE 1 — RevOps Analyst
Assess HubSpot fit honestly based on the full picture: confirmed tech stack, industry, company description, and website signals.

Fit rating rules:
- "Strong" — already using HubSpot (high adoption potential for AeroRev services), OR using a recognised CRM/marketing tool (Pipedrive, Zoho, ActiveCampaign, Mailchimp etc.) which shows they understand the use case and are a switchable prospect, OR clear B2B sales or marketing operation with no CRM detected (greenfield opportunity)
- "Moderate" — some signals of a sales or marketing operation but tech stack is unclear, or tools detected are peripheral (live chat, analytics only), or industry fit is uncertain
- "Weak" — using enterprise tools they are unlikely to leave (Salesforce + Marketo, Microsoft Dynamics), or no meaningful web presence, or B2C with no clear HubSpot use case

For fit_reason: be specific. Name the tool they are using if confirmed. Name the HubSpot product most relevant to them (Sales Hub, Marketing Hub, Service Hub, or a combination). Call out any real blocker if fit is Weak or Moderate. One sentence, direct.

ROLE 2 — Outreach Specialist
Write pitch angles for AeroRev reaching out as a HubSpot Solutions Partner. AeroRev helps B2B companies implement, optimise, and get measurable results from HubSpot.

Rules for both pitches:
- Use plain, normal language. No buzzwords, no corporate tone.
- Reference something real and specific from their website or confirmed tech stack. Never write a pitch that could apply to any company.
- Do not open with compliments, "I came across your company", "I hope this finds you well", or any variant of "are you getting the most out of [tool]"
- The angle should feel like a useful observation, not a sales pitch
- AeroRev is the sender, not an individual

If they already use HubSpot:
- Angle is about adoption and getting real value from the tool, not selling HubSpot itself
- Reference what AeroRev does as a partner (implementation, RevOps, automation, reporting)
- The hook should come from something on their site that suggests a gap (e.g. they have a sales team but no clear pipeline process visible, or they run email marketing but no automation signals detected)

If they use a different CRM or marketing tool:
- Angle is about the switch or consolidation, grounded in what they are currently using
- Be specific about what they would gain, based on their industry and what the site suggests they actually do

If no tools detected:
- Angle is about building the right foundation, framed around their specific business type and what HubSpot would actually solve for them

email_pitch format: 2-3 sentences. The first sentence is the observation or hook grounded in their business. The second is the connection to what AeroRev does. Optional third sentence is a low-friction call to action or question. No subject line.

linkedin_pitch format: 1-2 sentences. More conversational and direct than the email. Reads like a message from a real person, not a campaign. No opener, just the point.

---

OUTPUT RULES:
- Return ONLY a valid JSON object
- No markdown, no backticks, no explanation, no text before or after the JSON
- Field names must be exactly as shown below
- hubspot_fit must be exactly "Strong", "Moderate", or "Weak"
- operating_status must be exactly "Active", "Likely Active", or "Unclear"
- Do not override confirmed tech stack fields with guesses if they are already detected from HTML

{
  "operating_status": "",
  "current_crm": "",
  "current_marketing_tools": "",
  "business_summary": "",
  "hubspot_fit": "",
  "fit_reason": "",
  "email_pitch": "",
  "linkedin_pitch": ""
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
