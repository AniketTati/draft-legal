# 20 — Publish draftLegal: step-by-step launch guide

This guide takes you from "I have the code on my Mac" to "the app is live on the internet" with **no prior cloud experience required**. Every step tells you exactly what to do, what to type, where to click, and what success looks like.

**Total time:** ~2 hours of focused work, spread across small steps.
**Total cost:** **$0/month** while you have 1–2 users.

---

## What you're doing, in plain English

You have an app with three parts that need to live on the internet:

1. **The website** (what users see in their browser) — goes to **Firebase Hosting** (free).
2. **The API + AI brain** (does the work behind the scenes) — goes to **Google Cloud Run** (free when nobody's using it).
3. **The database, cache, search, and file storage** — uses **free tiers from Neon, Upstash, Bonsai, and Google Cloud Storage**.

The big idea: when nobody's using the app, everything turns off and costs $0. When someone visits, it wakes up in 1–2 seconds.

---

## Before you start — checklist

You need:

- [ ] A Mac with Terminal (the black-screen app)
- [ ] A credit card for the Google Cloud account (you won't be charged at this scale, but Google requires one to verify you're real)
- [ ] A Google account (Gmail works)
- [ ] About 2 hours
- [ ] (Optional) Your own domain name like `yourname.com`. If you don't have one, skip the domain part — the app still works at a default URL like `draftlegal-yourname.web.app`.

**Tip:** Open the macOS **Notes** app right now and create a new note called **"draftLegal launch secrets"**. You'll paste connection strings and keys into it as you go. We'll call this your **secrets notebook** throughout this guide. Keep it private — these are like passwords.

---

## Part 1 — Install the tools on your Mac (~10 min)

You need 5 command-line tools. Open **Terminal** (Cmd+Space, type "Terminal", hit Enter).

### 1.1 Install Homebrew (skip if you already have it)

Copy this whole line, paste into Terminal, press Enter:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

It'll ask for your Mac password. Type it (you won't see the characters — that's normal) and press Enter. Takes ~5 min.

**Success looks like:** the last line says `Installation successful!`.

### 1.2 Install Node.js, pnpm, Firebase CLI, gcloud CLI, openssl

```bash
brew install node@22 pnpm openssl
brew install --cask google-cloud-sdk
npm install -g firebase-tools
```

**Success looks like:** all four commands finish without "Error:". To double-check, run:

```bash
node --version    # should print v22.x.x
pnpm --version    # should print 9.x or 10.x
gcloud --version  # should print "Google Cloud SDK 4xx.x.x"
firebase --version # should print 13.x or higher
```

If any of those say "command not found", restart Terminal (quit and reopen) and try again.

### 1.3 Get into the project folder

```bash
cd ~/Documents/Code/draft-legal
```

(Adjust the path if your project is somewhere else.)

### 1.4 Install the project's own dependencies

```bash
pnpm install
```

Takes ~2 min. Lots of text scrolls by — that's normal.

---

## Part 2 — Sign up for Neon (Postgres database) (~5 min)

Neon stores the contracts, users, and everything that needs to persist.

1. Go to **https://neon.tech** in your browser.
2. Click **Sign Up**, use your Google account.
3. After signup, click **Create a project**.
   - **Project name:** `draftlegal`
   - **Postgres version:** 16 (default)
   - **Region:** pick the one closest to you. **US East (N. Virginia)** is a safe default.
4. Click **Create project**.
5. You'll land on a dashboard with a box labeled **"Connection string"**. There's a copy button — click it.
6. **Paste it into your secrets notebook** under a line that says:
   ```
   DATABASE_URL = postgresql://...   (paste here)
   ```
   It looks like `postgresql://draftlegal_owner:abcXYZ@ep-something-123456.us-east-2.aws.neon.tech/draftlegal?sslmode=require`.

### 2.1 Enable the `pgvector` extension (required for AI search)

In the Neon dashboard, click **SQL Editor** in the left sidebar. Paste this and click **Run**:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

**Success looks like:** "Query executed successfully."

---

## Part 3 — Sign up for Upstash (Redis cache) (~5 min)

Upstash holds short-term things like login sessions.

1. Go to **https://upstash.com**.
2. Click **Sign Up**, use Google.
3. Click **Create Database**.
   - **Name:** `draftlegal-redis`
   - **Type:** Regional (cheaper than Global)
   - **Region:** **US East 1 (N. Virginia)** to match Neon
   - **Eviction:** leave default (no eviction)
4. Click **Create**.
5. On the database details page, scroll to the **"Connect to your database"** section.
6. Find the line labeled **"UPSTASH_REDIS_REST_URL"**? No — instead, switch to the **"@upstash/redis"** tab and look for a TLS connection string starting with `rediss://`. (Note the **two** s's — that means encrypted.)
7. **Copy it into your secrets notebook**:
   ```
   REDIS_URL = rediss://default:abc...@us1-something-12345.upstash.io:6379
   ```

---

## Part 4 — Sign up for Bonsai (Elasticsearch) (~5 min)

Bonsai handles fast keyword search across contracts.

1. Go to **https://bonsai.io**.
2. Click **Sign Up Free**.
3. Click **Create Cluster**.
   - **Plan:** Sandbox (free, the one that says $0/mo)
   - **Name:** `draftlegal`
   - **Region:** US East (Virginia) to match the others
   - **Version:** Elasticsearch 8.x
4. Click **Create Cluster**.
5. After ~30 seconds the cluster is ready. Click into it.
6. On the **Access** or **Credentials** tab, you'll see a **"Full Access URL"** that looks like `https://USERNAME:PASSWORD@something-12345678.us-east-1.bonsaisearch.net`.
7. **Copy it into your secrets notebook**:
   ```
   ELASTICSEARCH_URL = https://...
   ```

---

## Part 5 — Set up Google Cloud (~10 min)

This is the biggest piece. Take your time.

### 5.1 Log in via Terminal

```bash
gcloud auth login
```

A browser window opens. Pick your Google account. Click **Allow**. The browser will say "You are now authenticated".

### 5.2 Create a Google Cloud project

In Terminal:

```bash
gcloud projects create draftlegal-prod-$RANDOM --name="draftLegal Production"
```

The `$RANDOM` makes the project ID unique. The command prints the project ID it picked (e.g. `draftlegal-prod-23847`). **Write that ID into your secrets notebook** as `GCP_PROJECT`.

Set it as your current project:

```bash
gcloud config set project YOUR_PROJECT_ID_HERE
```

Replace `YOUR_PROJECT_ID_HERE` with the ID from the previous step.

### 5.3 Link a billing account

Go to **https://console.cloud.google.com/billing** in your browser. If you've never used GCP before, click **Add billing account**, enter your card. Google gives you **$300 in free credit for 90 days** — but at the scale of this app you won't use it anyway.

Once you have a billing account, link your project to it:

1. Stay on the billing page.
2. Click **My Projects** in the left menu.
3. Find `draftLegal Production` in the list.
4. Click the three-dot menu next to it → **Change billing**.
5. Select your billing account → **Set account**.

**Without this step, the next command will fail.** Cloud Run requires a billing account even if you stay in the free tier.

### 5.4 Enable the Google services we'll use

Back in Terminal:

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  storage.googleapis.com
```

Takes ~1 min. **Success looks like:** "Operation finished successfully."

---

## Part 6 — Create the file-storage bucket (~5 min)

This is where uploaded contracts, PDFs, etc. live.

### 6.1 Create the bucket

```bash
BUCKET_NAME="draftlegal-documents-$(date +%s)"
echo "Your bucket name: $BUCKET_NAME"
gcloud storage buckets create "gs://$BUCKET_NAME" --location=US --uniform-bucket-level-access
```

**Copy the printed bucket name into your secrets notebook** as `S3_BUCKET`.

### 6.2 Generate HMAC keys (lets the app talk to the bucket like Amazon S3)

```bash
gcloud iam service-accounts create gcs-app --display-name="draftLegal GCS Access"
PROJECT_ID=$(gcloud config get-value project)
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:gcs-app@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
gcloud storage hmac create "gcs-app@${PROJECT_ID}.iam.gserviceaccount.com"
```

The last command prints something like:

```
accessId: GOOG1EABC123DEF456GHI789JKL
secret: aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890ABCD
```

**Copy both into your secrets notebook:**

```
S3_ACCESS_KEY = GOOG1E...
S3_SECRET_KEY = aBcDe...
```

⚠️ **The `secret` value is shown ONCE.** If you close Terminal before copying it, you'll have to delete and recreate the HMAC key.

---

## Part 7 — Generate the app's own secret keys (~2 min)

These are random strings the app uses internally. Run each line, copy the output into your secrets notebook:

```bash
echo "JWT_SECRET = $(openssl rand -base64 32)"
echo "PORTAL_JWT_SECRET = $(openssl rand -base64 32)"
echo "INTERNAL_SERVICE_SECRET = $(openssl rand -base64 32)"
echo "AI_KEY_ENCRYPTION_KEY = $(openssl rand -base64 32)"
```

Your notebook should now have **four** new lines with random strings.

---

## Part 8 — Sign up for AI provider keys (~10 min)

Pick **at least one**. Anthropic is the recommended default.

### 8.1 Anthropic (Claude) — recommended

1. Go to **https://console.anthropic.com**, sign up.
2. Top-up at least $5 of API credits (the "billing" section).
3. Go to **API Keys** → **Create Key**, name it `draftlegal-prod`.
4. Copy the key (starts with `sk-ant-`) into your secrets notebook as `ANTHROPIC_API_KEY`.

### 8.2 OpenAI (optional)

1. Go to **https://platform.openai.com**, sign up.
2. Top-up at least $5 of API credits.
3. Go to **API keys** → **Create new secret key**.
4. Copy (starts with `sk-`) into your secrets notebook as `OPENAI_API_KEY`.

### 8.3 Google Gemini (optional)

1. Go to **https://aistudio.google.com/app/apikey**.
2. Click **Create API key**.
3. Copy (starts with `AIza`) into your secrets notebook as `GOOGLE_API_KEY`.

Skip 8.2 and 8.3 if you're using just Anthropic. For any provider you skip, leave the value as `placeholder` in the next step — the app handles missing providers gracefully.

---

## Part 9 — Put all secrets into Google Secret Manager (~10 min)

Now we move every secret from your notebook into Google's secret vault so the running app can read them.

### 9.1 Create the secret slots

Copy this whole block, paste into Terminal, press Enter:

```bash
for s in database-url redis-url elasticsearch-url \
         jwt-secret portal-jwt-secret internal-secret ai-key-enc \
         gcs-hmac-access gcs-hmac-secret \
         anthropic-key openai-key google-key sendgrid-key; do
  gcloud secrets create "$s" --replication-policy=automatic 2>/dev/null || \
    echo "(already exists: $s — that's fine)"
done
```

> **Optional — LLM tracing.** `langfuse-public-key` and `langfuse-secret-key`
> are deliberately not in that list. Skip them and everything deploys and runs
> normally, just without LLM traces. Add them later to see every agent call
> (prompt, tool calls, tokens, cost) in Langfuse Cloud's free Hobby tier —
> `LANGFUSE.md` has the four steps.

### 9.2 Fill in each secret

For each secret, copy the value from your notebook and run **one** of these commands. Replace `PASTE_VALUE_HERE` with the actual value. (Keep the single quotes — they protect special characters.)

```bash
echo -n 'PASTE_VALUE_HERE' | gcloud secrets versions add database-url --data-file=-
echo -n 'PASTE_VALUE_HERE' | gcloud secrets versions add redis-url --data-file=-
echo -n 'PASTE_VALUE_HERE' | gcloud secrets versions add elasticsearch-url --data-file=-
echo -n 'PASTE_VALUE_HERE' | gcloud secrets versions add jwt-secret --data-file=-
echo -n 'PASTE_VALUE_HERE' | gcloud secrets versions add portal-jwt-secret --data-file=-
echo -n 'PASTE_VALUE_HERE' | gcloud secrets versions add internal-secret --data-file=-
echo -n 'PASTE_VALUE_HERE' | gcloud secrets versions add ai-key-enc --data-file=-
echo -n 'PASTE_VALUE_HERE' | gcloud secrets versions add gcs-hmac-access --data-file=-
echo -n 'PASTE_VALUE_HERE' | gcloud secrets versions add gcs-hmac-secret --data-file=-
echo -n 'PASTE_VALUE_HERE' | gcloud secrets versions add anthropic-key --data-file=-
echo -n 'placeholder'      | gcloud secrets versions add openai-key --data-file=-
echo -n 'placeholder'      | gcloud secrets versions add google-key --data-file=-
echo -n 'placeholder'      | gcloud secrets versions add sendgrid-key --data-file=-
```

If you skipped OpenAI / Google / SendGrid, leave `placeholder` for those.

**Verify everything is in place:**

```bash
gcloud secrets list
```

You should see all 13 secrets.

---

## Part 10 — Initialize the database (~5 min)

Right now Neon is empty. We need to create the tables and seed the first admin user.

In Terminal, replace `YOUR_NEON_URL` with the Postgres URL from your notebook:

```bash
DATABASE_URL='YOUR_NEON_URL' pnpm --filter api prisma migrate deploy
DATABASE_URL='YOUR_NEON_URL' pnpm --filter api db:seed
```

**Success looks like:** "All migrations have been successfully applied" and then "Seed completed." This creates an admin user: `admin@demo.com` / `password123` (you should change this immediately after first login).

Optionally, load demo data so the app isn't empty on first visit:

```bash
DATABASE_URL='YOUR_NEON_URL' pnpm --filter api tsx scripts/seed-ai-demo.ts
```

---

## Part 11 — Set up Firebase Hosting (~5 min)

Firebase will host the front-end website.

### 11.1 Log in

```bash
firebase login
```

A browser opens — pick your Google account, allow.

### 11.2 Create a Firebase project

```bash
firebase projects:create draftlegal-web-$RANDOM --display-name "draftLegal Web"
```

It prints a project ID like `draftlegal-web-23847`. **Copy that ID.**

### 11.3 Wire the project ID into the repo

Open the file `.firebaserc` at the repo root (any text editor — TextEdit, VS Code, whatever). Replace `REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID` with the ID from the previous step. Save the file.

The contents should look like:

```json
{
  "projects": {
    "default": "draftlegal-web-23847"
  }
}
```

---

## Part 12 — Fill in the config files (~5 min)

There are two config files that tell the API and agent services what URLs to talk to.

### 12.1 Copy the templates

```bash
cp env.api.example.yaml env.api.yaml
cp env.agents.example.yaml env.agents.yaml
```

### 12.2 Edit `env.api.yaml`

Open `env.api.yaml` in a text editor. You'll fix these lines:

| Line | What to change |
|---|---|
| `FRONTEND_URL:` | If you have a custom domain, set to `https://app.yourdomain.com`. **Otherwise leave blank for now** — we'll fix it after Firebase is deployed. |
| `AGENTS_URL:` | Leave the `REPLACE` placeholder. We'll fix it in step 13.3. |
| `GOTENBERG_URL:` | Leave the `REPLACE` placeholder. Same. |
| `S3_BUCKET:` | Set to the bucket name from your notebook (e.g. `draftlegal-documents-1700000000`). |
| `EMAIL_FROM:` | Set to something like `noreply@yourdomain.com`, or leave default for now. |

Save the file.

### 12.3 `env.agents.yaml` needs no changes

The defaults work. You can leave it alone.

---

## Part 13 — Deploy the back end (3 services) (~15 min)

We deploy in a specific order: the simple services first, then the API last, because the API needs to know where the others live.

### 13.1 Deploy Gotenberg (PDF generator)

```bash
./scripts/deploy.sh gotenberg
```

Takes ~3 min. Lots of build output. **Success looks like:** "Service [gotenberg] revision [...] has been deployed and is serving 100 percent of traffic." with a URL like `https://gotenberg-abc123-uc.a.run.app`.

**Copy that URL.** You'll paste it shortly.

### 13.2 Deploy the agents service (AI brain)

```bash
./scripts/deploy.sh agents
```

Takes ~5 min (Python packages are heavy). **Success looks like:** another `https://agents-service-...run.app` URL.

**Copy that URL too.**

### 13.3 Update `env.api.yaml` with the two URLs

Open `env.api.yaml` again. Replace:

- `AGENTS_URL: https://agents-service-REPLACE.a.run.app` → the agents URL from step 13.2
- `GOTENBERG_URL: https://gotenberg-REPLACE.a.run.app` → the gotenberg URL from step 13.1

Save.

### 13.4 Deploy the API

```bash
./scripts/deploy.sh api
```

Takes ~5 min. **Success looks like:** an `https://api-service-...run.app` URL.

**Copy this URL — this is your API's address.**

### 13.5 Lock down agents and gotenberg (so only the API can call them)

```bash
PROJECT_ID=$(gcloud config get-value project)
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
API_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud run services add-iam-policy-binding agents-service \
  --member="serviceAccount:${API_SA}" --role="roles/run.invoker" \
  --region us-central1

gcloud run services add-iam-policy-binding gotenberg \
  --member="serviceAccount:${API_SA}" --role="roles/run.invoker" \
  --region us-central1
```

**Success looks like:** "Updated IAM policy for service ..."

### 13.6 Quick API health check

```bash
curl https://YOUR-API-URL/health
```

Should print `{"status":"ok"}` (first call may take 2–3 seconds because Cloud Run wakes the service up).

---

## Part 14 — Deploy the front-end website (~5 min)

```bash
export VITE_API_URL=https://YOUR-API-URL
./scripts/deploy.sh web
```

Replace `YOUR-API-URL` with the API URL from step 13.4.

**Success looks like:** "Deploy complete!" with a hosting URL like `https://draftlegal-web-23847.web.app`.

**Open that URL in a browser** — you should see the login page. Try logging in with `admin@demo.com` / `password123`.

🎉 **At this point your app is live on the internet.** Everything below is optional polish.

---

## Part 15 — (Optional) Connect your own domain (~15 min)

Skip this part if you're happy with the `.web.app` URL for now. Adding it later is fine.

### 15.1 Map `app.yourdomain.com` to Firebase Hosting

1. Go to **https://console.firebase.google.com**, pick your project.
2. Left sidebar → **Hosting**.
3. Click **Add custom domain**.
4. Enter `app.yourdomain.com`. Click **Continue**.
5. Firebase shows you DNS records to add. **Keep this tab open.**
6. In a new tab, go to your Cloudflare dashboard → your domain → **DNS** → **Records**.
7. Add the records Firebase showed you (usually one or two `A` records, or one `CNAME`).
   - **Important:** click the **orange cloud** to make it **gray** ("DNS only") for these records until Firebase says "Connected". Then you can turn the orange cloud back on.
8. Back in Firebase, click **Verify**. It may take 5–60 minutes to propagate.

### 15.2 Map `api.yourdomain.com` to Cloud Run

```bash
gcloud beta run domain-mappings create \
  --service api-service \
  --domain api.yourdomain.com \
  --region us-central1
```

The command prints DNS records. Add them to Cloudflare the same way (**gray cloud** during verification).

### 15.3 Update the API and rebuild the front-end

Edit `env.api.yaml` → set `FRONTEND_URL: https://app.yourdomain.com`. Then:

```bash
./scripts/deploy.sh api
export VITE_API_URL=https://api.yourdomain.com
./scripts/deploy.sh web
```

---

## Part 16 — Final verification checklist

Go through each item:

- [ ] Open `https://your-app-url` → login page loads.
- [ ] Log in with `admin@demo.com` / `password123` → dashboard appears.
- [ ] Upload a contract → it shows up in the list.
- [ ] Open a contract → AI summary / chat works (this hits Anthropic via Cloud Run).
- [ ] Generate a PDF → downloads successfully.
- [ ] Wait 15 minutes without touching it. Open **Cloud Run console** → all three services show **0 active instances**. ✅ Scale-to-zero working.
- [ ] Open **GCP Billing → Reports → Today** → total should be in cents, not dollars.

---

## If something goes wrong

| Symptom | Most likely cause | Fix |
|---|---|---|
| `gcloud: command not found` | Path not set up | Quit and reopen Terminal, or run `source "$(brew --prefix)/share/google-cloud-sdk/path.bash.inc"` |
| `Billing account is required` when deploying | Project not linked to billing | Re-do step 5.3 |
| Cloud Run deploy hangs at "Building" for > 15 min | Cloud Build is slow on first run | Wait it out, or check **https://console.cloud.google.com/cloud-build/builds** for the error |
| API health check returns 500 | Usually a missing secret or DB issue | Run `gcloud run services logs read api-service --region us-central1 --limit 50` and read the error |
| Front-end loads but API calls fail with CORS error | `FRONTEND_URL` doesn't match the actual front-end URL | Edit `env.api.yaml`, redeploy api |
| `prisma migrate deploy` fails | Wrong DATABASE_URL or pgvector not enabled | Re-check the URL, re-run the SQL `CREATE EXTENSION vector;` in Neon |
| Login works but contracts page is empty | No demo data | Run the optional seed-ai-demo step in Part 10 |
| Cloud Run service stuck on "Revision didn't become healthy" | Container crashed on startup, usually env-var typo | Run `gcloud run services logs read <service> --region us-central1 --limit 100`, look for the first error line |

### General debugging recipe

```bash
# See live logs from any service
gcloud run services logs tail api-service --region us-central1
gcloud run services logs tail agents-service --region us-central1
gcloud run services logs tail gotenberg --region us-central1
```

Press Ctrl+C to stop tailing.

---

## After you're live — what to watch

### Daily cost

Bookmark **https://console.cloud.google.com/billing** → reports. Filter to today. If it's ever over $1, something's wrong — check the **Cost Breakdown** to see which service.

### When you'll need to upgrade

| Trigger | Upgrade | Cost |
|---|---|---|
| Neon free 0.5 GB storage full (looks like "out of compute hours" or "storage limit reached") | Neon Launch tier | ~$19/mo |
| Bonsai sandbox returning errors at index time | Bonsai Standard | ~$10/mo |
| Cloud Run scaling to >2 instances frequently | Raise `--max-instances`; cost grows with traffic, still pay-per-use | varies |
| Real user traffic, want no cold starts | Set `--min-instances=1` on api-service | ~$5–10/mo |

### Updating the deployed app

After you change code:

```bash
./scripts/deploy.sh api       # if back-end changed
./scripts/deploy.sh agents    # if Python AI code changed
export VITE_API_URL=https://api.yourdomain.com
./scripts/deploy.sh web       # if front-end changed
./scripts/deploy.sh all       # everything at once
```

Each deploy is zero-downtime — old version keeps serving requests until the new one is healthy.

### Rolling back if a deploy breaks something

```bash
gcloud run revisions list --service api-service --region us-central1
gcloud run services update-traffic api-service \
  --to-revisions=PREVIOUS-REVISION-NAME=100 \
  --region us-central1
```

The first command lists revisions (newest first). Pick the second-newest from the output for the second command.

---

## Cost ceiling reference

| Service | Free tier | What pushes you over |
|---|---|---|
| Cloud Run | 2M requests, 360k GB-sec, 180k vCPU-sec per month | ~50k–100k real user actions/mo |
| Firebase Hosting | 10 GB bandwidth/mo, 360 MB/day | Heavy SPA traffic |
| Neon Postgres | 0.5 GB data, auto-suspend when idle | Lots of contracts |
| Upstash Redis | 10k commands/day, 256 MB | Heavy session traffic |
| Bonsai ES | 1 GB index, slow | Many indexed documents |
| GCS | 5 GB-mo storage, 1 GB egress/mo | Lots of uploaded files |
| Cloudflare DNS | unlimited | n/a |
| Artifact Registry | 0.5 GB | More than ~5 image builds |
| Secret Manager | 6 active secrets, 10k accesses/mo | Beyond demo scale |
| **Steady-state cost** | **~$0/mo at 1–2 users** | First upgrade ~$19/mo Neon |

---

## Reference: known technical issues (read only if curious)

These don't block your deploy but are worth knowing:

- **Real-time collaboration is disabled.** Cloud Run only allows one port per service, and the collab feature uses a second. For 1–2 users it doesn't matter. The flag `COLLAB_DISABLED=1` in `env.api.yaml` controls this.
- **Background scheduled jobs only run when the app gets traffic.** Renewal reminders, etc. wait until someone hits the API. If you want them on a schedule regardless, hook up Cloud Scheduler later (still free).
- **Cold starts:** first request after 15 min idle takes 1–2 seconds for the API and 3–5 seconds for the AI agent. Subsequent requests are instant.

That's it. Welcome to production.
