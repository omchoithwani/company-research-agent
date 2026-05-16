const SCRAPE_TIMEOUT_MS = 10000;

// Detected from script srcs, inline JS variables, pixel URLs, and cookie names in the HTML source.
// Each array entry is a substring to look for (case-insensitive) anywhere in the raw HTML.

const CRM_PATTERNS = {
  // --- Major CRMs ---
  HubSpot:              ['js.hs-scripts.com', 'hs-scripts.com', 'hbspt.', '_hsq =', '_hsq=',
                         '_hsq,', 'hubspot.com/hs-script', 'hubspot.net', 'hubspotforms',
                         'js.hubspot.com', 'hs-banner.com', 'hsadspixel.net', 'hs-script-loader'],
  Salesforce:           ['salesforce.com', 'force.com', 'lightning.force', 'sfdc', 'sfdcstatic.com'],
  'MS Dynamics':        ['dynamics.com', 'microsoftdynamics', 'crm.dynamics.com', 'd365'],
  Zoho:                 ['zohocrm.com', 'zohopublic.com', 'zoho.com/crm', 'zohocrm'],
  Pipedrive:            ['pipedrive.com'],
  Freshsales:           ['freshsales.io', 'freshworks.com', 'freshchat.com'],
  Copper:               ['copper.com', 'prosperworks.com'],
  Insightly:            ['insightly.com'],
  Close:                ['close.com/js', 'closecrm', 'close.io'],
  Keap:                 ['keap.com', 'infusionsoft.com', 'app.infusionsoft'],
  SugarCRM:             ['sugarcrm.com'],
  Nimble:               ['nimble.com'],
  Streak:               ['streak.com'],
  Monday:               ['monday.com/js', 'assets.monday.com'],
  Nutshell:             ['nutshell.com'],
};

const MARKETING_PATTERNS = {
  // --- Marketing automation & email ---
  HubSpot:              ['hs-scripts.com', 'hsforms.com', 'hsblog', 'hubspot.com', 'hs-analytics',
                         'js.hs-scripts.com', 'js.hubspot.com', 'hs-script-loader'],
  Marketo:              ['munchkin.marketo.net', 'mktoresp.com', 'marketo.net', 'marketo.com'],
  Pardot:               ['pardot.com', 'pi.pardot.com', 'go.pardot'],
  Eloqua:               ['eloqua.com', 'elqimg.com', 'elq.com'],
  Mailchimp:            ['mailchimp.com', 'list-manage.com', 'chimpstatic.com', 'mc.us'],
  ActiveCampaign:       ['activecampaign.com', 'trackcmp.net'],
  Klaviyo:              ['klaviyo.com', 'a.klaviyo.com', 'static.klaviyo.com'],
  Braze:                ['braze.com', 'appboycdn.com', 'braze-cdn.com'],
  Iterable:             ['iterable.com', 'static.iterable.com'],
  'Customer.io':        ['customer.io', 'assets.customer.io', 'csio'],
  Brevo:                ['brevo.com', 'sibautomation.com', 'sendinblue.com'],
  Drip:                 ['drip.com', 'getdrip.com'],
  ConvertKit:           ['convertkit.com', 'ck.page'],
  Omnisend:             ['omnisend.com'],
  Klaviyo:              ['klaviyo.com', 'a.klaviyo.com'],
  MailerLite:           ['mailerlite.com'],
  GetResponse:          ['getresponse.com', 'gr-cdn.com'],
  AWeber:               ['aweber.com'],
  'Constant Contact':   ['constantcontact.com', 'r20.rs6.net'],
  Campaign_Monitor:     ['campaignmonitor.com', 'createsend.com'],

  // --- Chat & engagement ---
  Intercom:             ['intercom.io', 'intercomcdn.com', 'widget.intercom.io'],
  Drift:                ['drift.com', 'js.driftt.com'],
  Zendesk:              ['zendesk.com', 'zdassets.com', 'zopim.com'],
  Freshdesk:            ['freshdesk.com', 'freshwidget.com'],
  Crisp:                ['crisp.chat', 'client.crisp.chat'],
  Tawk:                 ['tawk.to', 'embed.tawk.to'],

  // --- Ad & analytics (useful signal for sales approach) ---
  Segment:              ['cdn.segment.com', 'segment.io', 'analytics.js'],
  Mixpanel:             ['mixpanel.com', 'cdn.mxpnl.com'],
};

function detect(html, patterns) {
  const lower = html.toLowerCase();
  return Object.entries(patterns)
    .filter(([, sigs]) => sigs.some(s => lower.includes(s.toLowerCase())))
    .map(([tool]) => tool);
}

function extractMeta(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const desc =
    (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,400})/i) || [])[1] ||
    (html.match(/<meta[^>]+content=["']([^"']{0,400})[^>]+name=["']description["']/i) || [])[1] || '';
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 6);
  return {
    title: title.replace(/<[^>]+>/g, '').trim(),
    desc: desc.trim(),
    h1s,
    h2s,
  };
}

function extractBodyText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

async function tryFetch(url) {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const ct = resp.headers.get('content-type') || '';
  if (!ct.includes('html')) throw new Error('Not HTML');
  return resp.text();
}

async function scrapeCompany(domain) {
  const base = domain.startsWith('www.') ? domain : `www.${domain}`;
  const urls = [`https://${base}`, `https://${domain}`];

  for (const url of urls) {
    try {
      const html = await tryFetch(url);
      const meta = extractMeta(html);
      return {
        scraped: true,
        url,
        title: meta.title,
        description: meta.desc,
        headings: [...meta.h1s, ...meta.h2s].slice(0, 8),
        bodyText: extractBodyText(html),
        detectedCrm: detect(html, CRM_PATTERNS),
        detectedMarketing: detect(html, MARKETING_PATTERNS),
      };
    } catch {
      // try next URL
    }
  }

  return { scraped: false, detectedCrm: [], detectedMarketing: [] };
}

module.exports = { scrapeCompany };
