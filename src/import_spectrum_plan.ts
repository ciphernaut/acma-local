/**
 * CLI entry point for spectrum-plan operations.
 *
 * Usage:
 *   npm run import-spectrum-plan -- --reseed [--patch <path.yaml>]
 *   npm run import-spectrum-plan -- --patch <path.yaml>
 *
 * --patch <file>   Copy <file> into seed/patches/, then regenerate seed/spectrum_plan.sql.
 * --reseed         After regenerating the SQL seed, apply it to the runtime DB
 *                  (drops + recreates spectrum tables, then loads).
 *
 * Patch-only (--patch without --reseed) just updates the seed file; the new
 * data is picked up the next time the DB is bootstrapped or --reseed is used.
 */
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { initializeDatabase } from './db.js';
import { resetSpectrumTables, execSeedSql } from './spectrum_plan.js';
import { DEFAULT_CONFIG } from './sync.js';
import { log } from './logger.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage(): never {
    console.error(`Usage:
  npm run import-spectrum-plan -- --reseed [--patch <path.yaml>]
  npm run import-spectrum-plan -- --patch <path.yaml>
`);
    process.exit(1);
}

function getArg(argv: string[], flag: string): string | undefined {
    const i = argv.indexOf(flag);
    return i >= 0 && i < argv.length - 1 ? argv[i + 1] : undefined;
}

function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 0) usage();

    const reseed = argv.includes('--reseed');
    const patchArg = getArg(argv, '--patch');

    if (!reseed && !patchArg) usage();

    // If a patch file was provided, copy it into seed/patches/ first.
    if (patchArg) {
        if (!fs.existsSync(patchArg)) {
            log.error(`Error: patch file not found: ${patchArg}`);
            process.exit(1);
        }
        const patchesDir = path.join(repoRoot, 'seed', 'patches');
        fs.mkdirSync(patchesDir, { recursive: true });
        const dest = path.join(patchesDir, path.basename(patchArg));
        fs.copyFileSync(patchArg, dest);
        log.info(`Copied patch to ${dest}`);
    }

    // Regenerate seed/spectrum_plan.sql from YAML source + any patches.
    log.info('Regenerating seed/spectrum_plan.sql...');
    execSync('npx tsx scripts/generate-spectrum-seed.ts', { stdio: 'inherit', cwd: repoRoot });

    if (reseed) {
        const dbPath = process.env.ACMA_DB_PATH ?? DEFAULT_CONFIG.dbPath;
        if (!fs.existsSync(dbPath)) {
            log.info(`Initialising new DB at ${dbPath}`);
        }
        initializeDatabase(dbPath);

        const db = new Database(dbPath);
        try {
            resetSpectrumTables(db);
            const seedPath = path.join(repoRoot, 'seed', 'spectrum_plan.sql');
            const sql = fs.readFileSync(seedPath, 'utf-8');
            execSeedSql(db, sql);
            const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
            log.info(`[SPECTRUM] Reseeded: ${n} allocation rows loaded.`);
        } finally {
            db.close();
        }
    }
}

main();
