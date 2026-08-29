# Spectrum Plan Overlay Patches

Files in this directory are YAML overlays applied on top of `../spectrum_plan_source.yaml` when generating `../spectrum_plan.sql`. Each patch records an amendment to the 2021 baseline (generation 2). Applied in lexicographic order by filename — name patches `YYYY-MM-DD-<topic>.yaml`.

## Format

```yaml
meta:
  patch_id: "2026-amendment-1"
  applied_to: 2                     # base generation this patches
  description: "Adjusts AUS49 wording and 2 sub-ranges in the 5 GHz band."
  source:
    url: "https://..."
    pdf_sha256: "..."
    published_date: "2026-XX-XX"

operations:
  - op: "replace_footnote"
    table: "au_footnotes"           # or "intl_footnotes"
    ref: "AUS49"
    text: "New text..."

  - op: "replace_allocation"
    freq_start_hz: 5000000000
    freq_end_hz: 5150000000
    region: 3                       # omit for AU
    new:
      freq_start_hz: 5000000000
      freq_end_hz: 5150000000
      unit: "MHz"
      page: 75
      services: [...]
      footnotes: [...]
      raw: "..."

  - op: "insert_allocation"
    region: 2                       # omit for AU; also accepted inside `new`
    new: { ... }                    # rejects duplicate key

  - op: "delete_allocation"
    freq_start_hz: ...
    freq_end_hz: ...
    region: 1                       # omit for AU
```

`region` belongs to the operation, not to the row: the generator copies it onto
the row it writes, and rejects a value outside 1-3. Every field of `new` is
validated before it reaches the SQL — a missing `page`, a non-numeric bound or
an inverted range fails generation with a message naming the field, rather than
producing a seed file that only fails later when SQLite executes it.

## Applying a patch

```bash
# Drop the YAML into this directory, then:
npx tsx scripts/generate-spectrum-seed.ts   # rebuild SQL
npm run import-spectrum-plan -- --reseed    # apply to DB
```

Or in one step, which copies the file in for you and reverts it if generation
fails:

```bash
npm run import-spectrum-plan -- --patch path/to/2026-08-01-topic.yaml --reseed
```

`--reseed` applies the committed `spectrum_plan.sql` atomically: a seed that
fails to load leaves the existing data in place. It does not regenerate the SQL
on its own — pass `--patch`, or run the generator directly.
