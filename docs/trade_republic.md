# Trade Republic (local setup)

Trade Republic sync runs the vendored **pytr** entrypoints
(`services/api/python/tr_login.py`, `tr_export.py`) as Python subprocesses. The API
spawns them using the interpreter named by **`PYTR_PYTHON_BIN`**
(`services/api/src/services/pytr/runner.ts`, default `python3`). If that interpreter has
no `pytr` installed, `tr_login.py` exits with `pytr not installed` and the route returns
**502 `tr_pairing_failed`** — the web UI shows the generic *"Something went wrong. Please
try again."*

Production handles this in the `Dockerfile` (a venv at `/opt/pytr-venv`). Local dev needs
the same two steps:

## Setup

```sh
make pytr-venv            # creates .venv-pytr and installs pytr (pinned in requirements.txt)
```

Then set the interpreter in your root `.env` to the venv's python, using an **absolute**
path (the subprocess is spawned with cwd under `services/api`, so a relative path is
ambiguous):

```
PYTR_PYTHON_BIN=/abs/path/to/portfolio-tracker/.venv-pytr/bin/python
```

Restart `make dev` so the API re-reads `.env`.

Verify the interpreter can import pytr:

```sh
.venv-pytr/bin/python -c "from pytr.api import TradeRepublicApi; print('ok')"
```

## Pairing (v2 push-approval)

Trade Republic killed the v1 SMS login; pytr 0.4.9 uses the **v2 push-approval** flow.
On **Connect**, enter your TR phone number and PIN — Trade Republic sends a push to your
**TR mobile app**. There is no SMS code: foreground the app and **approve the login
there**. The pairing window is bounded (`PYTR_APPROVAL_TIMEOUT_S`, default 180s on the
Python side); approve promptly or the attempt expires and you start over.

## Relevant config

| Var | Default | Purpose |
|-----|---------|---------|
| `PYTR_PYTHON_BIN` | `python3` | Interpreter that runs the pytr entrypoints; point at the venv python. |
| `PYTR_WAF_STRATEGY` | `awswaf` | AWS-WAF token strategy. `awswaf` is no-browser; `playwright` needs a bundled Chromium (not installed by default). |
| `PYTR_ENABLED` | `true` | Master switch for the TR feature (subprocess + routes). |
| `DB_ENCRYPTION_KEY` | — | Required: phone/PIN/session are encrypted at rest. Missing → 503 `encryption_required`. |
