# Sentinel Office credential rotation

Status: the local staged-rotation workflow is implemented and tested. It does not configure,
change or contact a production Office Core deployment.

## Safety contract

- rotation always uses a new `keyId` and a new 32–128 byte random secret;
- the next credential is added beside the current credential in Windows Credential Manager;
- the current credential is never overwritten or deleted by staging;
- the secret is accepted only through a hidden interactive prompt, never argv, JSON, logs or renderer IPC;
- the local status receipt contains only producer/key identities and presence booleans;
- server activation, Sentinel cutover, delivery verification and old-key retirement are separate steps;
- old-key deletion remains the existing explicit command with its exact confirmation phrase.

The local status does not prove that either key is active in Office Core. Office Core remains the
authority for producer/workspace bindings and server-side key activation.

## Zero-downtime runbook

Run commands from the Sentinel repository root in a trusted local PowerShell session. Replace the
example key IDs with deployment-approved identifiers. Do not place the producer secret in a command,
script, `.env`, issue, chat message or saved transcript.

1. Confirm the current local key and empty next slot:

   ```powershell
   node .\bin\sentinel-office-credentials rotation-status eclipse-hopson-sentinel sentinel-prod-01 sentinel-prod-02
   ```

   Expected state: the current credential is present and the next credential can be staged.

2. In the production deployment secret manager, add `sentinel-prod-02` for the same producer and exact
   workspace allowlist while keeping `sentinel-prod-01` active. Generate a new random secret; never
   reuse the current secret.

3. Stage the matching next secret locally. The prompt is hidden and the secret is not accepted as an
   argument:

   ```powershell
   node .\bin\sentinel-office-credentials stage-rotation eclipse-hopson-sentinel sentinel-prod-01 sentinel-prod-02
   ```

4. Confirm the local dual-key state:

   ```powershell
   node .\bin\sentinel-office-credentials rotation-status eclipse-hopson-sentinel sentinel-prod-01 sentinel-prod-02
   ```

   Expected state: both credentials are present. Stop if the result is `next-only` or `blocked`.

5. Change only `SENTINEL_OFFICE_KEY_ID` to `sentinel-prod-02`, restart Sentinel, publish one bounded
   Safe Operator lifecycle and verify its accepted Office Core event/receipt. Do not infer success from
   local credential presence.

6. Keep the old server key active through the deployment's signed-request skew and retry window. If
   verification fails, restore `SENTINEL_OFFICE_KEY_ID=sentinel-prod-01`; the old local credential is
   still available.

7. After delivery with the next key is verified, disable `sentinel-prod-01` in the production secret
   manager. Observe the deployment before local retirement.

8. Retire the old local credential with the separate destructive command:

   ```powershell
   node .\bin\sentinel-office-credentials delete eclipse-hopson-sentinel sentinel-prod-01
   ```

   Type the exact confirmation displayed by the command. Staging never performs this deletion.

## Local status states

- `ready-to-stage`: current present, next absent;
- `staged`: both present; server activation and delivery still require verification;
- `next-only`: current absent, next present; verify server state before enabling Sentinel;
- `blocked`: neither credential is present.

## Recovery rules

- If staging rejects `SECRET_REUSE`, generate a genuinely new secret.
- If the next key already exists, inspect `rotation-status`; never overwrite it implicitly.
- If staging reports a postcondition failure, stop. Inspect both key IDs and do not delete either one.
- If Office Core rejects the next key, roll Sentinel back to the current key while it is still active.
- Production provisioning and rotation require an authorized operator and deployment-specific audit
  evidence; local tests are not production proof.
