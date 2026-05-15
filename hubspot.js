const HUBSPOT_BASE = 'https://api.hubapi.com';

function getToken() {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error('HUBSPOT_TOKEN is not set in .env');
  return token;
}

async function hubspotRequest(path, method = 'GET', body = null) {
  const token = getToken();
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== null) options.body = JSON.stringify(body);

  const response = await fetch(`${HUBSPOT_BASE}${path}`, options);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HubSpot API error ${response.status}: ${errorText}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function findCompanyByDomain(domain) {
  const result = await hubspotRequest('/crm/v3/objects/companies/search', 'POST', {
    filterGroups: [
      { filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }] },
    ],
    properties: ['name', 'domain'],
    limit: 1,
  });
  return result?.results?.[0] || null;
}

function buildProperties(company) {
  const props = {
    name: company.company_name || '',
    domain: company.domain || '',
    description: company.business_summary || '',
  };
  if (company.industry) props.industry = company.industry;
  if (company.location) props.city = company.location;
  if (company.current_crm) props.aerev_current_crm = company.current_crm;
  if (company.hubspot_fit) props.aerorev_hubspot_fit = company.hubspot_fit;
  if (company.fit_reason) props.aerorev_fit_reason = company.fit_reason;
  if (company.email_pitch) props.aerorev_email_pitch = company.email_pitch;
  if (company.linkedin_pitch) props.aerorev_linkedin_pitch = company.linkedin_pitch;
  return props;
}

async function pushToHubspot(company) {
  const existing = await findCompanyByDomain(company.domain);
  const properties = buildProperties(company);

  if (existing) {
    await hubspotRequest(`/crm/v3/objects/companies/${existing.id}`, 'PATCH', { properties });
    return String(existing.id);
  } else {
    const result = await hubspotRequest('/crm/v3/objects/companies', 'POST', { properties });
    return String(result.id);
  }
}

async function checkHubspotHealth() {
  try {
    getToken();
    await hubspotRequest('/crm/v3/objects/companies?limit=1&properties=domain');
    return true;
  } catch {
    return false;
  }
}

module.exports = { pushToHubspot, checkHubspotHealth };
