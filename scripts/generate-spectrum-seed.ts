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
    | { op: 'insert_allocation'; new: Allocation }
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

export function applyOverlay(doc: SourceDoc, overlay: Overlay): SourceDoc {
    const result: SourceDoc = JSON.parse(JSON.stringify(doc));
    for (const op of overlay.operations) {
        if (op.op === 'replace_footnote') {
            const table = result[op.table];
            const target = table.find(f => f.ref === op.ref);
            if (!target) throw new Error(`Footnote ${op.ref} not found in ${op.table}`);
            target.text = op.text;
        } else if (op.op === 'replace_allocation') {
            const list = op.region !== undefined ? result.region_allocations : result.au_allocations;
            const idx = list.findIndex(a =>
                a.freq_start_hz === op.freq_start_hz &&
                a.freq_end_hz === op.freq_end_hz &&
                a.region === op.region
            );
            if (idx < 0) throw new Error(`Allocation ${op.freq_start_hz}-${op.freq_end_hz} not found`);
            list[idx] = op.new;
        } else if (op.op === 'insert_allocation') {
            const list = op.new.region !== undefined ? result.region_allocations : result.au_allocations;
            const dup = list.find(a =>
                a.freq_start_hz === op.new.freq_start_hz &&
                a.freq_end_hz === op.new.freq_end_hz &&
                a.region === op.new.region
            );
            if (dup) throw new Error(`Allocation ${op.new.freq_start_hz}-${op.new.freq_end_hz} already exists`);
            list.push(op.new);
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

export function generateSeedSql(doc: SourceDoc): string {
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
        lines.push(
            `INSERT INTO spectrum_allocations(freq_start_hz, freq_end_hz, unit, page, services_json, footnotes_json, raw) VALUES(${a.freq_start_hz}, ${a.freq_end_hz}, ${sqlString(a.unit)}, ${a.page}, ${jsonCol(a.services)}, ${jsonCol(a.footnotes)}, ${sqlString(a.raw)});`
        );
    }
    for (const a of doc.region_allocations) {
        lines.push(
            `INSERT INTO spectrum_region_allocations(region, freq_start_hz, freq_end_hz, unit, page, services_json, footnotes_json, raw) VALUES(${a.region}, ${a.freq_start_hz}, ${a.freq_end_hz}, ${sqlString(a.unit)}, ${a.page}, ${jsonCol(a.services)}, ${jsonCol(a.footnotes)}, ${sqlString(a.raw)});`
        );
    }
    for (const f of doc.au_footnotes) {
        lines.push(
            `INSERT INTO spectrum_australian_footnotes(footnote_ref, footnote_text, page) VALUES(${sqlString(f.ref)}, ${sqlString(f.text)}, ${f.page});`
        );
    }
    for (const f of doc.intl_footnotes) {
        lines.push(
            `INSERT INTO spectrum_international_footnotes(footnote_ref, footnote_text, page) VALUES(${sqlString(f.ref)}, ${sqlString(f.text)}, ${f.page});`
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
    for (const [k, v] of metaPairs) {
        lines.push(`INSERT INTO spectrum_plan_meta(key, value) VALUES(${sqlString(k)}, ${sqlString(v)});`);
    }

    lines.push('COMMIT;');
    return lines.join('\n') + '\n';
}

function main(): void {
    // fileURLToPath, not URL.pathname: the latter percent-encodes, so any repo
    // path containing a space resolves to a nonexistent directory.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const sourcePath = path.join(repoRoot, 'seed', 'spectrum_plan_source.yaml');
    const patchesDir = path.join(repoRoot, 'seed', 'patches');
    const outPath = path.join(repoRoot, 'seed', 'spectrum_plan.sql');

    const sourceYaml = fs.readFileSync(sourcePath, 'utf8');
    let doc = yaml.load(sourceYaml) as SourceDoc;

    if (fs.existsSync(patchesDir)) {
        const patches = fs.readdirSync(patchesDir)
            .filter(f => f.endsWith('.yaml') && f !== 'README.md.yaml')
            .sort();
        for (const p of patches) {
            const overlay = yaml.load(fs.readFileSync(path.join(patchesDir, p), 'utf8')) as Overlay;
            doc = applyOverlay(doc, overlay);
        }
    }

    fs.writeFileSync(outPath, generateSeedSql(doc), 'utf8');
    console.error(`Wrote ${outPath}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('generate-spectrum-seed.ts');
if (isMain) main();
