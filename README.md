# Company Research Agent

A full-stack lead research web application. Upload a CSV of prospective companies, run each through a local Ollama LLM for HubSpot fit analysis, and push results to HubSpot — all from a single browser tab.

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [Ollama](https://ollama.com/) installed and running locally
- [ngrok](https://ngrok.com/) (optional, for public exposure)
- A HubSpot account with a Private App token

---

## 1. Pull the Ollama model

The app defaults to `llama3.1:70b` and falls back to `llama3.1:8b` automatically. Pull at least one:

```bash
ollama pull llama3.1:70b
# or for a lighter model:
ollama pull llama3.1:8b
```

Make sure Ollama is running before starting the app:

```bash
ollama serve
```

---

## 2. Create the `.env` file

Copy the example and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```
HUBSPOT_TOKEN=your_private_app_token_here
OLLAMA_MODEL=llama3.1:70b
OLLAMA_HOST=http://localhost:11434
PORT=3000
```

**To get a HubSpot Private App token:**
1. In HubSpot, go to **Settings → Integrations → Private Apps**
2. Click **Create a private app**
3. Give it a name (e.g. "Research Agent")
4. Under **Scopes**, enable: `crm.objects.companies.read` and `crm.objects.companies.write`
5. Click **Create app** and copy the token

---

## 3. Create custom HubSpot properties

These properties must exist in HubSpot before syncing. Create them under **Settings → Properties → Company Properties → Create property**:

| Internal name | Label | Field type |
|---|---|---|
| `aerev_current_crm` | Current CRM | Single-line text |
| `aerorev_hubspot_fit` | HubSpot Fit | Single-line text |
| `aerorev_fit_reason` | Fit Reason | Multi-line text |
| `aerorev_email_pitch` | Email Pitch | Multi-line text |
| `aerorev_linkedin_pitch` | LinkedIn Pitch | Multi-line text |

**Step-by-step:**
1. Log in to HubSpot → click your account name → **Settings**
2. Left sidebar → **Properties**
3. In the "Filter by" dropdown, select **Company properties**
4. Click **Create property** (top right)
5. Set **Object type**: Company, **Group**: Company information
6. Enter the internal name exactly as shown above
7. Set **Field type** to "Single-line text" or "Multi-line text" as listed
8. Click **Create**
9. Repeat for all five properties

---

## 4. Install dependencies

```bash
npm install
```

---

## 5. Start the app

```bash
npm start
```

The app runs at **http://localhost:3000**.

For development with auto-restart:

```bash
npm run dev
```

---

## 6. Expose publicly via ngrok

```bash
ngrok http 3000
```

ngrok will print a public URL like `https://abc123.ngrok-free.app`. Share that URL to access the app remotely.

---

## CSV format

Upload a CSV with these columns (column order and casing don't matter):

```csv
company_name,description,domain,linkedin_url,location,industry
Acme Corp,A B2B SaaS company for HR teams,acmecorp.com,https://linkedin.com/company/acme,San Francisco,Software
Globex Inc,Manufacturing and supply chain,globex.com,,Chicago,Manufacturing
```

Required: `domain` (used as the deduplication key).  
Optional but recommended: `company_name`, `description`, `linkedin_url`, `location`, `industry`.

---

## How deduplication works

When you upload a CSV, each row's `domain` is checked against the database:

- **domain exists + research completed** → skipped, shown in the "skipped duplicates" collapsible with its existing data
- **domain exists + research failed** → reset to `pending` and re-queued for research
- **domain exists + research pending** → skipped (already in queue)
- **domain not found** → inserted as a new record and queued

---

## How to retry failed companies

**From the History table:**
- Find the company with status "Failed"
- Click the **Retry** button in the Actions column
- Then click **Start Research** to run research again

**From the company detail modal:**
- Click **View** on any failed company
- Click **🔄 Retry Research** at the bottom of the modal

**By re-uploading:**
- Re-upload a CSV containing the same domain
- Failed companies are automatically reset and re-queued

---

## API reference

| Method | Path | Description |
|---|---|---|
| `POST` | `/upload` | Upload CSV (multipart `csv` field) |
| `GET` | `/research/stream` | SSE stream — processes all pending companies |
| `GET` | `/companies` | List all companies |
| `GET` | `/companies/:id` | Get single company |
| `DELETE` | `/companies/:id` | Delete a company |
| `POST` | `/companies/:id/retry` | Reset failed company to pending |
| `POST` | `/hubspot/push/:id` | Push single company to HubSpot |
| `POST` | `/hubspot/push-all` | Push all completed + not-yet-pushed companies |
| `GET` | `/health` | Health check: `{ status, ollama, hubspot }` |

---

## Troubleshooting

**Ollama not running:**  
The app will show a red indicator and an error when you click "Start Research". Fix with:
```bash
ollama serve
```

**HubSpot token missing or invalid:**  
The HubSpot health indicator will be red. Check that `HUBSPOT_TOKEN` in `.env` is a valid Private App token with company read/write scopes.

**Custom property errors when pushing:**  
Make sure all five custom properties are created in HubSpot exactly as listed in Step 3. HubSpot will reject writes to properties that don't exist.

**Model too slow / timing out:**  
Switch to the 8b model for faster responses:
```
OLLAMA_MODEL=llama3.1:8b
```
in your `.env`, then restart the app.
