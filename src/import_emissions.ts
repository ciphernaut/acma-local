#!/usr/bin/env tsx
/**
 * CLI for the emissions lookup dataset.
 *
 * Usage:
 *   tsx src/import_emissions.ts --dump   [--out seed/emissions.sql]
 *   tsx src/import_emissions.ts --reseed [--source seed/emissions.sql]
 *
 * --dump regenerates seed/emissions.sql from CODE_TABLES.
 * --reseed wipes and re-applies the seed against an existing DB.
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { initializeDatabase } from './db.js';
import { dumpSeedFromCodeTables, applyEmissionReseed } from './emissions.js';

function parseFlag(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    if (i < 0 || i === process.argv.length - 1) return undefined;
    return process.argv[i + 1];
}

function projectRoot(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function main(): void {
    const dbPath = process.env.ACMA_DB_PATH ?? path.join(projectRoot(), 'data', 'acma.db');

    if (process.argv.includes('--dump')) {
        const out = parseFlag('--out') ?? path.join(projectRoot(), 'seed', 'emissions.sql');
        const outDir = path.dirname(out);
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        dumpSeedFromCodeTables(out);
        return;
    }

    if (process.argv.includes('--reseed')) {
        const src = parseFlag('--source') ?? path.join(projectRoot(), 'seed', 'emissions.sql');
        initializeDatabase(dbPath);  // ensure schema is present, idempotent
        const db = new Database(dbPath);
        try {
            applyEmissionReseed(db, src);
        } finally {
            db.close();
        }
        return;
    }

    console.error('Usage:');
    console.error('  tsx src/import_emissions.ts --dump   [--out <path>]');
    console.error('  tsx src/import_emissions.ts --reseed [--source <path>]');
    process.exit(1);
}

// Run main() only when invoked as a CLI, not when imported by tests/modules.
// (Mirrors src/sync.ts; prevents the file from spawning a CLI on `import`.)
if (process.argv[1]?.endsWith('import_emissions.ts') || process.argv[1]?.endsWith('import_emissions.js')) {
    main();
}
