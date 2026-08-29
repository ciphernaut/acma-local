/**
 * Seed invariants gate — Sprint 1 (docs/spectrum-sprint-01-seed-invariants.md).
 *
 * Asserts the structural properties `seed/spectrum_plan.sql` should have, with
 * today's known defects recorded as an EXACT baseline rather than a tolerance.
 *
 * The baseline cuts both ways, deliberately:
 *   - a NEW violation fails, even if the total is no worse than before;
 *   - FIXING a known violation also fails, until its baseline entry is deleted
 *     in the same commit. That deletion is the definition of done for the
 *     sprint named against each constant below.
 *
 * This suite tests the shipped data, not the loader — it execs the seed
 * directly rather than going through bootstrapSpectrumPlan().
 */
import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLE_METADATA } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.join(__dirname, '..', 'seed', 'spectrum_plan.sql');
const FRAGMENT_BASELINE_PATH = path.join(__dirname, 'fixtures', 'seed_fragment_baseline.json');
const DROPPED_SERVICE_BASELINE_PATH = path.join(__dirname, 'fixtures', 'seed_dropped_service_baseline.json');

const SPECTRUM_TABLE_NAMES = [
    'spectrum_allocations',
    'spectrum_region_allocations',
    'spectrum_australian_footnotes',
    'spectrum_international_footnotes',
    'spectrum_plan_meta',
] as const;

/** Radiocommunications Act envelope: the plan covers 0 Hz – 420 THz. */
const PLAN_MAX_HZ = 420_000_000_000_000;
/** Physical PDF pages carrying allocation tables (tools/extract-rrsp/extract.py). */
const FIRST_ALLOCATION_PAGE = 31;
const LAST_ALLOCATION_PAGE = 112;

// ─── Known defects ───────────────────────────────────────────────────────────

/**
 * #3 — frequency.py joins arbitrary space-separated digit runs, so the render
 * artefact "1 6121.35 – 1 626.5" parsed as 16 121.35 MHz → 1 626.5 MHz.
 * Cleared by: Sprint 4.
 */
const KNOWN_INVERTED_RANGES: Violation[] = [
    { table: 'spectrum_region_allocations', region: 3, freq_start_hz: 16121350000, freq_end_hz: 1626500000, page: 69 },
];

/**
 * #2 — extract.py skips a page whose unit line is unreadable (`if not unit: continue`).
 * Cleared by: Sprint 4.
 */
const KNOWN_MISSING_PAGES: number[] = [58];

/**
 * #2 (collateral) — the page-58 drop leaves 161.9875–162.0375 MHz, a real VHF
 * marine / land-mobile segment, with no AU allocation.
 * Cleared by: Sprint 4.
 */
const KNOWN_AU_RANGE_BREAKS: Violation[] = [
    { kind: 'gap', prev_end_hz: 161987500, next_start_hz: 162037500 },
];

/**
 * #1 — cell_parser.py treats every line as a service, so PDF-wrapped names are
 * split into fragments ("RADIONAVIGATION–" + "SATELLITE"). 922 entries.
 * Cleared by: Sprint 5, which replaces this heuristic with an ITU service
 * vocabulary check (see the spec).
 */
function loadFragmentBaseline(): Violation[] {
    return JSON.parse(fs.readFileSync(FRAGMENT_BASELINE_PATH, 'utf-8')) as Violation[];
}

/**
 * #16 — _build_allocation_row() treats the first line of a cell as the
 * frequency range and parses services from the REST, but pdfplumber often
 * emits the range and the first service on one line ("8.3 - 9 METEOROLOGICAL
 * AIDS 54A"), so that service is discarded. 327 region rows, many left with
 * services: [] which reads as "not allocated".
 * Cleared by: Sprint 5.
 */
function loadDroppedServiceBaseline(): Violation[] {
    return JSON.parse(fs.readFileSync(DROPPED_SERVICE_BASELINE_PATH, 'utf-8')) as Violation[];
}

/** A cell's first line: the frequency range, plus anything the PDF packed after it. */
const RANGE_LINE = /^\s*\d+(?:\s\d+)*(?:\.\d+)?\s*[–-]\s*\d+(?:\s\d+)*(?:\.\d+)?\s*(.*)$/;
const FOOTNOTE_TOKEN = /\b(?:AUS\d+[A-Z]*|\d{1,3}[A-Z]{0,2})\b/g;

// ─── Exact-multiset violation matching ───────────────────────────────────────

type Violation = Record<string, string | number | null>;

function keyOf(v: Violation): string {
    return Object.keys(v).sort().map(k => `${k}=${String(v[k])}`).join('|');
}

/** Counts, not a set: 23 baseline fragments share a key with another fragment
 *  in the same cell (e.g. two "…–\nSATELLITE" wraps in one allocation), and a
 *  set would silently under-count them. */
function multiset(vs: Violation[]): Map<string, { sample: Violation; count: number }> {
    const m = new Map<string, { sample: Violation; count: number }>();
    for (const v of vs) {
        const k = keyOf(v);
        const hit = m.get(k);
        if (hit) hit.count += 1;
        else m.set(k, { sample: v, count: 1 });
    }
    return m;
}

function describeSome(items: Violation[], limit = 10): string {
    const shown = items.slice(0, limit).map(v => `    ${JSON.stringify(v)}`).join('\n');
    const rest = items.length > limit ? `\n    …and ${items.length - limit} more` : '';
    return shown + rest;
}

/**
 * Assert the violation multiset equals the baseline exactly. Reports new and
 * newly-cleared violations separately, because the two need opposite responses.
 */
function assertExactViolations(
    label: string,
    actual: Violation[],
    baseline: Violation[],
    clearedBy: string,
): void {
    const a = multiset(actual);
    const b = multiset(baseline);
    const unexpected: Violation[] = [];
    const cleared: Violation[] = [];

    for (const [k, v] of a) {
        const known = b.get(k)?.count ?? 0;
        for (let i = 0; i < v.count - known; i++) unexpected.push(v.sample);
    }
    for (const [k, v] of b) {
        const seen = a.get(k)?.count ?? 0;
        for (let i = 0; i < v.count - seen; i++) cleared.push(v.sample);
    }

    const problems: string[] = [];
    if (unexpected.length > 0) {
        problems.push(
            `  ${unexpected.length} NEW violation(s) not in the baseline — the seed regressed:\n${describeSome(unexpected)}`,
        );
    }
    if (cleared.length > 0) {
        problems.push(
            `  ${cleared.length} baseline entr${cleared.length === 1 ? 'y' : 'ies'} no longer violate${cleared.length === 1 ? 's' : ''} — ` +
            `if this is ${clearedBy} landing, delete them from the baseline in the same commit:\n${describeSome(cleared)}`,
        );
    }
    if (problems.length > 0) {
        throw new Error(`${label}\n\n${problems.join('\n\n')}\n`);
    }
}

// ─── Fragment classifier (heuristic; retired in Sprint 5) ────────────────────

function countChar(s: string, c: string): number {
    let n = 0;
    for (const ch of s) if (ch === c) n += 1;
    return n;
}

/** Precedence-ordered and mutually exclusive: first match wins. */
export function fragmentKind(name: string): string | null {
    if (/[–-]$/.test(name)) return 'trailing-dash';
    if (countChar(name, '(') !== countChar(name, ')')) return 'unbalanced-paren';
    if (/^(AND|OR)\b/.test(name)) return 'leading-conjunction';
    if (name.trim() === 'SATELLITE') return 'bare-satellite';
    return null;
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

interface AllocRow {
    region: number | null;
    freq_start_hz: number;
    freq_end_hz: number;
    page: number;
    services_json: string;
    footnotes_json: string;
    raw: string;
}
interface Service {
    name: string;
    primary: boolean;
    inline_footnotes: string[];
}

let db: Database.Database;

/** Every allocation row from both tables, region null for the AU table. */
function allAllocations(): AllocRow[] {
    const au = db.prepare(
        'SELECT NULL AS region, freq_start_hz, freq_end_hz, page, services_json, footnotes_json, raw FROM spectrum_allocations',
    ).all() as AllocRow[];
    const region = db.prepare(
        'SELECT region, freq_start_hz, freq_end_hz, page, services_json, footnotes_json, raw FROM spectrum_region_allocations',
    ).all() as AllocRow[];
    return [...au, ...region];
}

function tableOf(row: AllocRow): string {
    return row.region === null ? 'spectrum_allocations' : 'spectrum_region_allocations';
}

beforeAll(() => {
    db = new Database(':memory:');
    for (const name of SPECTRUM_TABLE_NAMES) {
        const meta = TABLE_METADATA[name]!;
        db.exec(meta.ddl);
        if (meta.post_load_ddl) db.exec(meta.post_load_ddl);
    }
    db.exec(fs.readFileSync(SEED_PATH, 'utf-8'));
});

afterAll(() => {
    if (db?.open) db.close();
});

// ─── Invariants ──────────────────────────────────────────────────────────────

describe('seed invariants', () => {
    test('the seed loaded', () => {
        const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
        expect(n).toBeGreaterThan(0);
    });

    test('I1 no inverted or empty ranges', () => {
        const violations: Violation[] = allAllocations()
            .filter(r => r.freq_end_hz <= r.freq_start_hz)
            .map(r => ({
                table: tableOf(r),
                region: r.region,
                freq_start_hz: r.freq_start_hz,
                freq_end_hz: r.freq_end_hz,
                page: r.page,
            }));
        assertExactViolations('I1 — inverted or empty frequency ranges', violations, KNOWN_INVERTED_RANGES, 'Sprint 4 (#3)');
    });

    test('I2 every source page 31-112 contributes rows', () => {
        const present = new Set<number>(
            allAllocations().map(r => r.page),
        );
        const missing: number[] = [];
        for (let p = FIRST_ALLOCATION_PAGE; p <= LAST_ALLOCATION_PAGE; p++) {
            if (!present.has(p)) missing.push(p);
        }
        // Baseline is exact: a newly-dropped page fails, and clearing page 58
        // requires deleting it from KNOWN_MISSING_PAGES (Sprint 4, #2).
        expect(missing).toEqual(KNOWN_MISSING_PAGES);
    });

    test('I3 AU allocations tile 0 Hz - 420 THz without gaps or overlaps', () => {
        const rows = db.prepare(
            'SELECT freq_start_hz, freq_end_hz FROM spectrum_allocations ORDER BY freq_start_hz, freq_end_hz',
        ).all() as Array<{ freq_start_hz: number; freq_end_hz: number }>;

        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0]!.freq_start_hz).toBe(0);
        expect(rows[rows.length - 1]!.freq_end_hz).toBe(PLAN_MAX_HZ);

        const violations: Violation[] = [];
        for (let i = 1; i < rows.length; i++) {
            const prev = rows[i - 1]!;
            const next = rows[i]!;
            if (next.freq_start_hz === prev.freq_end_hz) continue;
            violations.push({
                kind: next.freq_start_hz > prev.freq_end_hz ? 'gap' : 'overlap',
                prev_end_hz: prev.freq_end_hz,
                next_start_hz: next.freq_start_hz,
            });
        }
        assertExactViolations('I3 — breaks in AU allocation coverage', violations, KNOWN_AU_RANGE_BREAKS, 'Sprint 4 (#2)');
    });

    test('I4 no fragmented service names', () => {
        const violations: Violation[] = [];
        for (const row of allAllocations()) {
            for (const svc of JSON.parse(row.services_json) as Service[]) {
                const kind = fragmentKind(svc.name);
                if (kind === null) continue;
                violations.push({
                    table: tableOf(row),
                    region: row.region,
                    freq_start_hz: row.freq_start_hz,
                    freq_end_hz: row.freq_end_hz,
                    name: svc.name,
                    kind,
                });
            }
        }
        assertExactViolations('I4 — fragmented service names', violations, loadFragmentBaseline(), 'Sprint 5 (#1)');
    });

    test('I5 every cited footnote ref resolves', () => {
        const au = new Set<string>(
            (db.prepare('SELECT footnote_ref FROM spectrum_australian_footnotes').all() as Array<{ footnote_ref: string }>)
                .map(r => r.footnote_ref),
        );
        const intl = new Set<string>(
            (db.prepare('SELECT footnote_ref FROM spectrum_international_footnotes').all() as Array<{ footnote_ref: string }>)
                .map(r => r.footnote_ref),
        );

        const dangling: Violation[] = [];
        for (const row of allAllocations()) {
            const refs = [
                ...(JSON.parse(row.footnotes_json) as string[]),
                ...(JSON.parse(row.services_json) as Service[]).flatMap(s => s.inline_footnotes),
            ];
            for (const ref of refs) {
                const resolved = /^AUS/i.test(ref) ? au.has(ref) : intl.has(ref);
                if (!resolved) {
                    dangling.push({
                        table: tableOf(row),
                        region: row.region,
                        freq_start_hz: row.freq_start_hz,
                        freq_end_hz: row.freq_end_hz,
                        ref,
                    });
                }
            }
        }
        // No baseline: this passes today (733 distinct refs, 0 dangling) and is
        // a pure regression guard.
        assertExactViolations('I5 — footnote refs with no matching footnote row', dangling, [], 'a fix');
    });

    test('I6 meta keys present and row_counts accurate', () => {
        const meta = new Map<string, string>(
            (db.prepare('SELECT key, value FROM spectrum_plan_meta').all() as Array<{ key: string; value: string }>)
                .map(r => [r.key, r.value]),
        );
        // `last_patch_date` is deliberately absent: the generator never writes it
        // (#6). Assert it here once Sprint 2 lands, guarded on seed/patches/.
        for (const key of ['generation', 'source_title', 'published_date', 'pdf_sha256', 'imported_at', 'extractor_version', 'row_counts']) {
            expect(meta.get(key)).toBeTruthy();
        }

        const count = (t: string): number =>
            (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
        expect(JSON.parse(meta.get('row_counts')!)).toEqual({
            au_allocations: count('spectrum_allocations'),
            region_allocations: count('spectrum_region_allocations'),
            au_footnotes: count('spectrum_australian_footnotes'),
            intl_footnotes: count('spectrum_international_footnotes'),
        });
    });

    test('I8 first-line service text survives into services_json', () => {
        const violations: Violation[] = [];
        for (const row of allAllocations()) {
            const first = row.raw.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
            const m = RANGE_LINE.exec(first);
            if (m === null) continue;
            const trailing = (m[1] ?? '').replace(FOOTNOTE_TOKEN, '').trim();
            if (trailing === '') continue;
            const names = (JSON.parse(row.services_json) as Service[]).map(s => s.name).join(' ');
            if (names.includes(trailing.toUpperCase())) continue;
            violations.push({
                table: tableOf(row),
                region: row.region,
                freq_start_hz: row.freq_start_hz,
                freq_end_hz: row.freq_end_hz,
                dropped: trailing,
            });
        }
        assertExactViolations(
            'I8 — service text on the frequency line discarded by the extractor',
            violations, loadDroppedServiceBaseline(), 'Sprint 5 (#16)',
        );
    });

    test('I7 all frequencies within the plan envelope', () => {
        // Catches unit-multiplier errors that I1 misses: a GHz value parsed as
        // Hz stays correctly ordered but lands outside the envelope.
        const violations: Violation[] = allAllocations()
            .filter(r => r.freq_start_hz < 0 || r.freq_end_hz > PLAN_MAX_HZ)
            .map(r => ({
                table: tableOf(r),
                region: r.region,
                freq_start_hz: r.freq_start_hz,
                freq_end_hz: r.freq_end_hz,
                page: r.page,
            }));
        assertExactViolations('I7 — frequencies outside 0 Hz – 420 THz', violations, [], 'a fix');
    });
});
