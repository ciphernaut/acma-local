#!/usr/bin/env node
/**
 * YAML (canonical) + overlay patches → seed/spectrum_plan.sql
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

interface Service {
    name: string;
    primary: boolean;
    inline_footnotes: string[];
    qualifier?: string;
}

interface Allocation {
    freq_start_hz: number;
    freq_end_hz: number;
    unit: string;
    page: number;
    services: Service[];
    footnotes: string[];
    raw: string;
    region?: number;
}

interface Footnote {
    ref: string;
    text: string;
    page: number;
}

export interface SourceDoc {
    meta: {
        generation: number;
        source: Record<string, unknown>;
        extracted_at: string;
        extractor_version: string;
    };
    au_allocations: Allocation[];
    region_allocations: Allocation[];
    au_footnotes: Footnote[];
    intl_footnotes: Footnote[];
}

type Operation =
    | { op: 'replace_footnote'; table: 'au_footnotes' | 'intl_footnotes'; ref: string; text: string }
    | { op: 'replace_allocation'; freq_start_hz: number; freq_end_hz: number; region?: number; new: Allocation }
    | { op: 'insert_allocation'; region?: number; new: Allocation }
    | { op: 'delete_allocation'; freq_start_hz: number; freq_end_hz: number; region?: number };

export interface Overlay {
    meta: { patch_id: string; applied_to: number; description: string; source: Record<string, unknown> };
    operations: Operation[];
}

function sqlString(s: string): string {
    return `'${s.replace(/'/g, "''")}'`;
}

function jsonCol(obj: unknown): string {
    return sqlString(JSON.stringify(obj));
}

/**
 * Overlay rows are hand-written YAML. Validate every field we interpolate:
 * an absent one used to reach the SQL as the literal `undefined`, producing a
 * file that parses fine here and fails only when SQLite executes it.
 */
function assertInt(value: unknown, field: string, ctx: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error(`${ctx}: ${field} must be an integer, got ${JSON.stringify(value)}`);
    }
    return value;
}

function assertText(value: unknown, field: string, ctx: string): string {
    if (typeof value !== 'string') {
        throw new Error(`${ctx}: ${field} must be a string, got ${JSON.stringify(value)}`);
    }
    return value;
}

function assertList(value: unknown, field: string, ctx: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`${ctx}: ${field} must be an array, got ${JSON.stringify(value)}`);
    }
    return value;
}

/**
 * Validate an overlay-supplied allocation and pin its region.
 *
 * `region` is written at the OP level for replace/delete (see
 * seed/patches/README.md) but belongs on the row itself, so a region-scoped
 * replacement whose `new:` block omits it used to land in
 * spectrum_region_allocations with region === undefined.
 */
function normaliseAllocation(alloc: Allocation, region: number | undefined, ctx: string): Allocation {
    if (alloc === null || typeof alloc !== 'object') {
        throw new Error(`${ctx}: "new" must be an allocation object, got ${JSON.stringify(alloc)}`);
    }
    const start = assertInt(alloc.freq_start_hz, 'freq_start_hz', ctx);
    const end = assertInt(alloc.freq_end_hz, 'freq_end_hz', ctx);
    if (end <= start) {
        throw new Error(`${ctx}: freq_end_hz (${end}) must be greater than freq_start_hz (${start})`);
    }
    const out: Allocation = {
        freq_start_hz: start,
        freq_end_hz: end,
        unit: assertText(alloc.unit, 'unit', ctx),
        page: assertInt(alloc.page, 'page', ctx),
        services: assertList(alloc.services, 'services', ctx) as Service[],
        footnotes: assertList(alloc.footnotes, 'footnotes', ctx) as string[],
        raw: assertText(alloc.raw, 'raw', ctx),
    };
    const resolved = region ?? alloc.region;
    if (resolved !== undefined) {
        if (![1, 2, 3].includes(resolved)) {
            throw new Error(`${ctx}: region must be 1, 2 or 3, got ${JSON.stringify(resolved)}`);
        }
        out.region = resolved;
    }
    return out;
}

export function applyOverlay(doc: SourceDoc, overlay: Overlay): SourceDoc {
    const result: SourceDoc = JSON.parse(JSON.stringify(doc));
    for (const op of overlay.operations) {
        if (op.op === 'replace_footnote') {
            const table = result[op.table];
            const target = table.find(f => f.ref === op.ref);
            if (!target) throw new Error(`Footnote ${op.ref} not found in ${op.table}`);
            target.text = op.text;
        } else if (op.op === 'replace_allocation') {
            const region = op.region ?? op.new?.region;
            const where = region === undefined ? '' : ` (region ${region})`;
            const ctx = `replace_allocation ${op.freq_start_hz}-${op.freq_end_hz}${where}`;
            const list = region !== undefined ? result.region_allocations : result.au_allocations;
            const idx = list.findIndex(a =>
                a.freq_start_hz === op.freq_start_hz &&
                a.freq_end_hz === op.freq_end_hz &&
                a.region === region
            );
            if (idx < 0) throw new Error(`Allocation ${op.freq_start_hz}-${op.freq_end_hz}${where} not found`);
            list[idx] = normaliseAllocation(op.new, region, ctx);
        } else if (op.op === 'insert_allocation') {
            const region = op.region ?? op.new?.region;
            const alloc = normaliseAllocation(op.new, region, 'insert_allocation');
            const list = region !== undefined ? result.region_allocations : result.au_allocations;
            const dup = list.find(a =>
                a.freq_start_hz === alloc.freq_start_hz &&
                a.freq_end_hz === alloc.freq_end_hz &&
                a.region === alloc.region
            );
            if (dup) throw new Error(`Allocation ${alloc.freq_start_hz}-${alloc.freq_end_hz} already exists`);
            list.push(alloc);
        } else if (op.op === 'delete_allocation') {
            const list = op.region !== undefined ? result.region_allocations : result.au_allocations;
            const idx = list.findIndex(a =>
                a.freq_start_hz === op.freq_start_hz &&
                a.freq_end_hz === op.freq_end_hz &&
                a.region === op.region
            );
            if (idx >= 0) list.splice(idx, 1);
        }
    }
    return result;
}

export function generateSeedSql(doc: SourceDoc, opts: { lastPatchDate?: string } = {}): string {
    const lines: string[] = [];
    lines.push('-- Generated from seed/spectrum_plan_source.yaml + seed/patches/*.yaml');
    lines.push('-- DO NOT EDIT BY HAND — regenerate via: npx tsx scripts/generate-spectrum-seed.ts');
    lines.push('BEGIN TRANSACTION;');
    lines.push('DELETE FROM spectrum_allocations;');
    lines.push('DELETE FROM spectrum_region_allocations;');
    lines.push('DELETE FROM spectrum_australian_footnotes;');
    lines.push('DELETE FROM spectrum_international_footnotes;');
    lines.push('DELETE FROM spectrum_plan_meta;');

    for (const a of doc.au_allocations) {
        const ctx = `au_allocations[${a.freq_start_hz}-${a.freq_end_hz}]`;
        lines.push(
            `INSERT INTO spectrum_allocations(freq_start_hz, freq_end_hz, unit, page, services_json, footnotes_json, raw) VALUES(${assertInt(a.freq_start_hz, 'freq_start_hz', ctx)}, ${assertInt(a.freq_end_hz, 'freq_end_hz', ctx)}, ${sqlString(assertText(a.unit, 'unit', ctx))}, ${assertInt(a.page, 'page', ctx)}, ${jsonCol(a.services)}, ${jsonCol(a.footnotes)}, ${sqlString(assertText(a.raw, 'raw', ctx))});`
        );
    }
    for (const a of doc.region_allocations) {
        const ctx = `region_allocations[region ${a.region}: ${a.freq_start_hz}-${a.freq_end_hz}]`;
        lines.push(
            `INSERT INTO spectrum_region_allocations(region, freq_start_hz, freq_end_hz, unit, page, services_json, footnotes_json, raw) VALUES(${assertInt(a.region, 'region', ctx)}, ${assertInt(a.freq_start_hz, 'freq_start_hz', ctx)}, ${assertInt(a.freq_end_hz, 'freq_end_hz', ctx)}, ${sqlString(assertText(a.unit, 'unit', ctx))}, ${assertInt(a.page, 'page', ctx)}, ${jsonCol(a.services)}, ${jsonCol(a.footnotes)}, ${sqlString(assertText(a.raw, 'raw', ctx))});`
        );
    }
    for (const f of doc.au_footnotes) {
        const ctx = `au_footnotes[${f.ref}]`;
        lines.push(
            `INSERT INTO spectrum_australian_footnotes(footnote_ref, footnote_text, page) VALUES(${sqlString(assertText(f.ref, 'ref', ctx))}, ${sqlString(assertText(f.text, 'text', ctx))}, ${assertInt(f.page, 'page', ctx)});`
        );
    }
    for (const f of doc.intl_footnotes) {
        const ctx = `intl_footnotes[${f.ref}]`;
        lines.push(
            `INSERT INTO spectrum_international_footnotes(footnote_ref, footnote_text, page) VALUES(${sqlString(assertText(f.ref, 'ref', ctx))}, ${sqlString(assertText(f.text, 'text', ctx))}, ${assertInt(f.page, 'page', ctx)});`
        );
    }

    const meta = doc.meta;
    const rowCounts = {
        au_allocations: doc.au_allocations.length,
        region_allocations: doc.region_allocations.length,
        au_footnotes: doc.au_footnotes.length,
        intl_footnotes: doc.intl_footnotes.length,
    };
    const source = meta.source as { title?: string; pdf_published?: string; pdf_sha256?: string };
    const metaPairs: Array<[string, string]> = [
        ['generation', String(meta.generation)],
        ['source_title', source.title ?? ''],
        ['published_date', source.pdf_published ?? ''],
        ['pdf_sha256', source.pdf_sha256 ?? ''],
        ['imported_at', meta.extracted_at],
        ['extractor_version', meta.extractor_version],
        ['row_counts', JSON.stringify(rowCounts)],
    ];
    // Read back by readSourceMeta() and surfaced in get_frequency_allocation's
    // staleness warning; absent when no overlay has been applied.
    if (opts.lastPatchDate) {
        metaPairs.push(['last_patch_date', opts.lastPatchDate]);
    }
    for (const [k, v] of metaPairs) {
        lines.push(`INSERT INTO spectrum_plan_meta(key, value) VALUES(${sqlString(k)}, ${sqlString(v)});`);
    }

    lines.push('COMMIT;');
    return lines.join('\n') + '\n';
}

/** The amendment's own published date, else the YYYY-MM-DD filename prefix. */
export function patchDateOf(overlay: Overlay, filename: string): string | undefined {
    const published = (overlay.meta?.source as { published_date?: unknown } | undefined)?.published_date;
    if (typeof published === 'string' && published.trim() !== '') return published.trim();
    return /^(\d{4}-\d{2}-\d{2})/.exec(filename)?.[1];
}

function main(): void {
    // fileURLToPath, not URL.pathname: the latter percent-encodes, so any repo
    // path containing a space resolves to a nonexistent directory.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const sourcePath = path.join(repoRoot, 'seed', 'spectrum_plan_source.yaml');
    const patchesDir = path.join(repoRoot, 'seed', 'patches');
    const outPath = path.join(repoRoot, 'seed', 'spectrum_plan.sql');
    let lastPatchDate: string | undefined;

    const sourceYaml = fs.readFileSync(sourcePath, 'utf8');
    let doc = yaml.load(sourceYaml) as SourceDoc;

    if (fs.existsSync(patchesDir)) {
        const patches = fs.readdirSync(patchesDir)
            .filter(f => f.endsWith('.yaml') && f !== 'README.md.yaml')
            .sort();
        for (const p of patches) {
            const overlay = yaml.load(fs.readFileSync(path.join(patchesDir, p), 'utf8')) as Overlay;
            doc = applyOverlay(doc, overlay);
            lastPatchDate = patchDateOf(overlay, p) ?? lastPatchDate;
        }
    }

    fs.writeFileSync(outPath, generateSeedSql(doc, lastPatchDate === undefined ? {} : { lastPatchDate }), 'utf8');
    console.error(`Wrote ${outPath}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('generate-spectrum-seed.ts');
if (isMain) main();
