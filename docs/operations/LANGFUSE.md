# LLM observability — Langfuse

Every LLM call the agents service makes is traced: the prompt, the tool calls,
token counts, latency, and cost, grouped into a session per chat thread. That
is what turns "the agent gave a weird answer" from a guess into something you
can open and read.

**Two deployments, one code path.** The agents service reads three environment
variables and traces to whatever is behind them. It does not know or care which
kind of Langfuse it is talking to.

| Where | Langfuse | Why |
| --- | --- | --- |
| Local dev | Open-source, self-hosted (`docker-compose.langfuse.yml`) | No account needed, no contract text leaves the laptop |
| Cloud Run | Langfuse Cloud, free **Hobby** tier | Nothing to operate; the trace volume of a hosted demo fits inside the free tier |
| Self-host | Your own Langfuse install | Traces contain contract text — keep them in your perimeter |

| Variable | Purpose |
| --- | --- |
| `LANGFUSE_PUBLIC_KEY` | Project public key (`pk-lf-…`) |
| `LANGFUSE_SECRET_KEY` | Project secret key (`sk-lf-…`) |
| `LANGFUSE_HOST` | Base URL of the Langfuse instance |

**All three must be set or tracing stays off.** That is deliberate: a
half-configured block fails closed rather than silently shipping prompts
somewhere unintended. With tracing off the agents run exactly as before, just
unobserved — tracing is never on the critical path
(`apps/agents/app/tracing.py`).

---

## 1. Local — self-hosted open source

```bash
pnpm langfuse:up
```

First boot pulls ~1.5 GB of images and takes a few minutes (ClickHouse
migrations run on startup). Then add to `.env`:

```
LANGFUSE_PUBLIC_KEY=pk-lf-draftlegal-local
LANGFUSE_SECRET_KEY=sk-lf-draftlegal-local
LANGFUSE_HOST=http://localhost:3100
```

Restart the agents service and run any agent turn. Traces appear at
**http://localhost:3100** — sign in with `dev@draft-legal.local` /
`langfuse-local-dev`.

Those keys are not something you have to go and create. `docker-compose.langfuse.yml`
seeds the org, project, API keys, and login on first boot via `LANGFUSE_INIT_*`,
so the values above work the moment the stack is healthy. The seed is
idempotent: restarting never clobbers traces you have already collected.

| Command | |
| --- | --- |
| `pnpm langfuse:up` | Start |
| `pnpm langfuse:down` | Stop (keeps traces) |
| `pnpm langfuse:reset` | Stop and **delete all trace data** |
| `pnpm langfuse:logs` | Tail web + worker |

### What it runs, and what it costs you

Langfuse v3 needs Postgres, ClickHouse, Redis, and S3-compatible storage.
This compose file brings its own of each on a private network, entirely
separate from the app's stack in `docker-compose.yml` — the two can never
collide. Budget roughly **2 GB RAM**; that is why it is a separate compose
project you opt into rather than part of the everyday dev stack.

Only two ports are published: **3100** (UI) and **9191** (MinIO console).
Everything else is internal. The credentials in the file are fixed and weak on
purpose, matching the convention in `docker-compose.yml` — it is a development
file, and pointing a real deployment at it would be a mistake.

---

## 2. Cloud Run — Langfuse Cloud (Hobby)

1. Create a free account at <https://cloud.langfuse.com>, make a project, and
   copy its public + secret keys.

2. Put the keys in Secret Manager and let the agents runtime service account
   read them:

   ```bash
   printf 'pk-lf-…' | gcloud secrets create langfuse-public-key \
     --data-file=- --replication-policy=automatic
   printf 'sk-lf-…' | gcloud secrets create langfuse-secret-key \
     --data-file=- --replication-policy=automatic

   for s in langfuse-public-key langfuse-secret-key; do
     gcloud secrets add-iam-policy-binding "$s" \
       --member "serviceAccount:cr-agents@$(gcloud config get-value project).iam.gserviceaccount.com" \
       --role roles/secretmanager.secretAccessor
   done
   ```

3. Check `LANGFUSE_HOST` in `env.agents.yaml` matches the **region** your
   Langfuse project lives in — `https://us.cloud.langfuse.com` or
   `https://eu.cloud.langfuse.com`. A region mismatch authenticates fine and
   then shows zero traces, which is a genuinely annoying hour to lose.

4. Deploy:

   ```bash
   ./scripts/deploy.sh agents
   ```

`scripts/deploy.sh` binds the two secrets **only if both already exist**, and
prints which way it went:

```
langfuse: keys found — tracing ON (host from env.agents.yaml)
langfuse: langfuse-public-key / langfuse-secret-key not in Secret Manager — deploying UNTRACED
```

The conditional is the point. `gcloud run deploy --set-secrets` hard-fails on a
secret that does not exist, so binding them unconditionally would mean every
deploy by anyone who has not set up Langfuse dies at the last step. Optional
observability must never be able to break a deploy.

**Hobby tier limits** (at time of writing): 50k units/month, 30-day retention,
2 users, community support. Enough for a demo or a small pilot. It is a
per-observation cost, so the agents' many small tool-routing calls count
individually — if you start dropping events, that limit is the first thing to
check.

---

## 3. Self-hosted draftLegal

`docker-compose.selfhost.yml` passes `LANGFUSE_*` through to `agents-service`,
sourced from `.env.selfhost`. All three are blank by default, so self-host runs
untraced until you opt in.

Run Langfuse's own production compose or Helm chart on your own infrastructure —
**not** the dev file in this repo, and preferably not a hosted SaaS. Traces
carry prompt and completion text, which for this product means contract
content; routing it to a third party would undo the reason you self-hosted.

Set `LANGFUSE_HOST` to something reachable **from inside the container**: a
compose service name if Langfuse shares the network, or
`http://host.docker.internal:3100` if it runs elsewhere on the host. Not
`localhost` — inside a container that is the container itself.

---

## 4. What lands in a trace

`apps/agents/app/router.py` resolves a model and attaches a Langfuse callback
per call; every agent and tool inherits it. Each trace carries:

- **Session** — the chat thread, so a multi-turn conversation reads as one unit
- **Tags** — `tier:`, `provider:`, `model:`, `source:` (platform vs BYOK),
  `tool:`
- **Metadata** — org, user, thread, tool name
- **Trace name** — the call site, e.g. `review.analyze`, `app_agent.ask`

Those are the filter axes in the UI: *"every BYOK Anthropic call from org X that
used the redline tool"* is a query, not a grep.

Buffered events are flushed on FastAPI shutdown (`apps/agents/main.py`), so a
clean restart does not drop the last few traces.

## 5. When traces do not show up

Work down this list — it is ordered by how often each one is the cause.

| Symptom | Cause |
| --- | --- |
| No traces at all, agents fine | One of the three vars is blank. All three are required. |
| `[tracing] failed to build Langfuse handler — continuing untraced` | SDK generation mismatch — see below. |
| `[tracing] Langfuse keys are set but no CallbackHandler could be imported` | SDK version drift. Check `langfuse>=3.0.0,<5.0` in `apps/agents/requirements.txt` and run `node scripts/agents/deps-check.mjs`. |
| Auth works, zero traces (Cloud) | `LANGFUSE_HOST` region does not match the project's region. |
| Traces accepted, never visible (local) | `langfuse-worker` is down — it is what folds S3 events into ClickHouse. `pnpm langfuse:logs`. |
| Nothing on Cloud Run | The deploy printed `deploying UNTRACED`. Create the secrets, grant the accessor role, redeploy. |
| Traces named `ChatAnthropic` / `FakeListChatModel` | The run name is not reaching the trace — `tracing.py` sets it on the root run. |
| Last trace of a run missing | Process was killed before the shutdown flush. |

### The failure mode worth knowing about

The Langfuse SDK has had two incompatible handler designs. In v2 auth and the
trace attributes were constructor arguments; from v3 auth moved to a client
singleton and the attributes moved into the LangChain run config. Passing v2's
arguments to a v3+ handler raises `TypeError` — which `get_callback()` catches,
logs at WARNING, and turns into `None`.

The result is the nastiest shape a bug can take: `tracing_enabled()` returns
`True`, nothing errors, every agent answers normally, and not one trace is ever
recorded. `apps/agents/app/tracing.py` implements both designs; its module
docstring is the reference if you change the pin.

### Checking it

Two levels, and you want both — the first cannot detect the failure above.

```bash
# Offline: is the wiring shaped right? No network, no keys needed.
python apps/agents/scripts/smoke_d07.py
```

```bash
# Live: does a trace actually arrive? Sends one and reads it back.
LANGFUSE_HOST=http://localhost:3100 \
LANGFUSE_PUBLIC_KEY=pk-lf-draftlegal-local \
LANGFUSE_SECRET_KEY=sk-lf-draftlegal-local \
python apps/agents/scripts/smoke_langfuse_live.py
```

The live check uses a fake chat model, so it needs no LLM provider key and
spends nothing. It covers both root shapes — a direct model call and a
chain-rooted run — because they take different paths inside the handler, and
asserts the trace name, session, user, tags, and metadata that the dashboard
filters on. Point it at Langfuse Cloud with the same three variables to verify
a production deploy; it writes traces named `smoke.live.*`, so prefer a dev
project.
