# Sentinel Safe Operator

`Sentinel Safe Operator` is the first real, bounded Jarvis-style action path in Eclipse Hopson Sentinel. It converts a Russian or English command into a deterministic plan, requires explicit approval, executes one allowlisted read-only skill, and returns a structured receipt.

## What works now

Three local skills are available:

- `workspace.status` — reports a bounded runtime and workspace capability snapshot;
- `memory.preview` — explains the current preview-only memory boundary;
- `skills.status` — reports the allowlist and execution limits.

The authority path does not use an LLM. Natural-language routing is deterministic, so a model cannot silently expand a request into shell access, network access, file writes, installs, deploys, or secret access.

## Desktop flow

1. Open the dashboard in the Electron desktop shell.
2. Enter a command or choose one of the three visible skills.
3. Review the generated plan and its explicit no-write diff.
4. Approve the plan.
5. Release the STOP control for one launch.
6. Execute once and review the receipt.
7. Optionally ask the browser speech engine to read the bounded receipt summary.

The preload exposes only `sentinelOperator.execute(request)`. The main process accepts the fixed `sentinel:operator:execute` channel only from its own trusted window. A plan expires after 30 minutes, approval after 5 minutes, a plan ID cannot be replayed, and execution is limited to six attempts per minute.

When the dashboard runs in an ordinary browser, it returns a clearly labelled `browser-preview` receipt. Browser preview never claims that a native action ran.

## CLI flow

Run the standalone local operator:

```powershell
node .\bin\sentinel-operator
```

Optional Windows speech input and output reuse the fixed first-party STT/TTS scripts:

```powershell
node .\bin\sentinel-operator --stt --ptt --speak --voice Russian
```

The CLI displays the same plan and diff and requires the user to type `ДА` or `yes` before a one-shot execution. It does not call the bridge, a model, a shell command chosen by the user, or the network.

## Security boundary

- Requests and receipts use versioned exact-key schemas.
- Unknown fields, unknown skill IDs, stale approvals, changed plans, and replayed plan IDs fail closed.
- Receipts are bounded and contain no hostname, filesystem path, environment variable, or secret.
- The renderer has no Node.js integration; Electron context isolation and sandboxing remain enabled.
- Renderer navigation is blocked and only explicit HTTPS links may open externally.
- The dashboard CSP blocks remote scripts, remote fonts, plugins, and form submission.

Future write, shell, browser-control, messaging, or deployment skills must not be added to this executor. Each mutable capability needs a separate reviewed contract, resource-scoped approval, rollback story, audit log, and focused abuse tests.

## Verification

Focused regression tests:

```powershell
bun test scripts\sentinel-safe-operator.test.mjs scripts\dashboard-operator-security.test.mjs
```

Dashboard typecheck and production build:

```powershell
cd dashboard
npm run build
```
