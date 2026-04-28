# Sync staleness detection & full-download fallback

## Problem

`src/sync.ts` cannot recover when the local dataset is too far out of date to be patched by an incremental update.

Two specific failure modes:

1. **Stale input zip.** `performFullSync` (sync.ts:79-85) blindly trusts `inputs/spectra_rrl.zip` whenever the file exists, regardless of age. The current input is dated 2026-03-05; using it to seed a new install produces a database that is already weeks behind, and outside the ~24-hour incremental window.
2. **No fallback from failed incremental.** When `meta.as_of` is older than ACMA's incremental window (~24h), the request to `incrementalUrl` either 404s or returns a non-`SUCCESS` payload. The catch block at sync.ts:198-201 logs and gives up — the database stays stuck.

Together these mean a sufficiently old install has no automated path back to a current dataset.

## Goals

- Detect when `inputs/spectra_rrl.zip` is older than the upstream dataset and skip it in favour of a fresh download.
- Detect when the database is too far behind to be patched incrementally, and trigger a full download instead of attempting (and failing at) incremental sync.
- Preserve existing behaviour for the common case: DB exists, within 24h of upstream, incremental sync works.

## Non-goals

- Changing the 12-hour origin-contact cooldown.
- Retries or backoff on download/network failure.
- Checksum or integrity verification of the downloaded zip.
- Reworking the incremental-update parsing or apply logic.

## Design

### Two new pure helpers

```ts
parseRemoteTimestamp(s: string): Date | null
```

Parses ACMA's `datetime-of-extract.txt` payload (`YYYY-MM-DD HH:MM:SS`, per the fixture at tests/sync.test.ts:34). Returns `null` on any parse failure. Used to convert the raw text fetched from `timestampUrl` into something comparable.

```ts
isInputZipStale(zipPath: string, remoteTimestamp: Date): boolean
```

Returns `true` iff the file at `zipPath` exists AND its mtime is earlier than `remoteTimestamp`. Returns `false` if the file is missing (caller decides what to do — this helper only answers the staleness question).

```ts
shouldDoFullSync(asOf: Date | null, remoteTimestamp: Date): boolean
```

Returns `true` iff `asOf` is null OR `remoteTimestamp - asOf > 24h`. The 24-hour threshold matches ACMA's incremental window; outside that window, incremental sync cannot succeed.

### Changes to `performFullSync`

Signature: `performFullSync(config: SyncConfig, remoteTimestamp?: string)`.

- If `remoteTimestamp` is not passed, fetch it as today (preserves direct-CLI behaviour at sync.ts:205-207).
- After resolving `remoteTimestamp`, parse it via `parseRemoteTimestamp`.
- Before the `existsSync(zipPathFromInput)` check (sync.ts:79):
  - If parse succeeded AND `isInputZipStale(zipPathFromInput, parsed)` is true → log "Input zip is stale (mtime=X, remote=Y); downloading fresh dataset." and skip the input.
  - If parse failed → fall through to existing behaviour (prefer the input zip; the remote timestamp text is then stored in `meta.as_of` unchanged, as today).
- Everything else in `performFullSync` is unchanged.

### Changes to `sync()`

Restructured order of operations:

1. Cooldown gate (unchanged — sync.ts:162-174).
2. Fetch `remoteTimestamp` once, up front. On fetch failure, log and return (no different in net effect from today's "couldn't reach origin" outcome).
3. Parse it. If parsing fails, fall through to today's behaviour (attempt incremental if DB exists, else full sync) — we cannot make a gap decision without a parsed timestamp.
4. If no DB → `performFullSync(config, remoteTimestamp)`.
5. Else read `meta.as_of` from the DB, parse it, and call `shouldDoFullSync(asOf, parsedRemote)`.
   - If true → log "DB as_of=X is N hours behind remote=Y; performing full sync" and call `performFullSync(config, remoteTimestamp)`.
   - Else → attempt incremental sync exactly as today. On failure, log and bail (no auto-fallback — the gap check above already routed the only case that needs one).

### Why no auto-fallback on incremental failure

The gap check (step 5) catches every "DB too old" case before incremental is even attempted. Any remaining incremental failure is therefore either (a) a transient network blip — retrying on the next scheduled sync is correct — or (b) a server-side problem at ACMA that a 70 MB re-download won't fix. So the `catch` block keeps its current "log and bail" behaviour.

### Logging

New log lines (using `console.log`, matching existing style):

- `[SYNC] Input zip mtime=<iso> is older than remote=<iso>; ignoring stale input.`
- `[SYNC] DB as_of=<iso> is <N>h behind remote=<iso>; full sync required.`
- `[SYNC] Could not parse remote timestamp '<raw>'; proceeding without staleness check.`

## Tests

Add to `tests/sync.test.ts`:

- `parseRemoteTimestamp` — happy path (`'2026-03-05 06:00:00'`), malformed input, empty string.
- `isInputZipStale` — file missing → `false`; mtime older than remote → `true`; mtime newer than remote → `false`.
- `shouldDoFullSync` — null `asOf` → `true`; gap < 24h → `false`; gap > 24h → `true`; gap exactly 24h → boundary documented in test.

Orchestration tests for `sync()` and `performFullSync()` are out of scope for this change — the helpers above carry the decision logic, and wiring them into the existing functions is straight-line code.

## Out-of-scope follow-ups

- Telemetry / metrics on how often the gap check trips full syncs.
- Treating a malformed remote timestamp as a hard error rather than a soft fall-through.
- Configuring the 24h threshold (currently hard-coded to match ACMA's incremental window).
