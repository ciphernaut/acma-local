import { initializeDatabase } from '../src/db';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import * as path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Database Initialization', () => {
    const dbPath = path.join(__dirname, 'test_acma.db');

    beforeEach(() => {
        if (fs.existsSync(dbPath)) {
            fs.unlinkSync(dbPath);
        }
    });

    afterAll(() => {
        if (fs.existsSync(dbPath)) {
            fs.unlinkSync(dbPath);
        }
    });

    test('should create all required tables', () => {
        initializeDatabase(dbPath);
        const db = new Database(dbPath);
        const tables = ['site', 'client', 'licence', 'device_details', 'antenna'].map(name =>
            db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)
        );
        tables.forEach(table => expect(table).toBeDefined());
        db.close();
    });
});
