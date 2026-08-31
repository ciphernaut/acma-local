import { generateQml } from '../src/qml.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const COLUMNS = ['NAME', 'LATITUDE', 'LONGITUDE', 'CHANNELS', 'TX_POWER_W', 'EMISSIONS'];
const ROWS = [['Site A', -29, 134, 20, '100.0', '3K00J3E']];

/** The map tip is XML-escaped element text; decode it back to the HTML QGIS sees. */
function mapTip(qml: string): string {
    const m = /<mapTip>([\s\S]*)<\/mapTip>/.exec(qml);
    if (!m) throw new Error('no mapTip element');
    return m[1]!
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

describe('generateQml', () => {
    it('produces well-formed XML with the three style blocks', () => {
        const qml = generateQml(COLUMNS, ROWS);
        expect(XMLValidator.validate(qml)).toBe(true);
        expect(qml).toContain('<renderer-v2');
        expect(qml).toContain('<labeling');
        expect(qml).toContain('<mapTip>');
        // Declaring the categories keeps QGIS from resetting anything we did not set.
        expect(qml).toContain('styleCategories="Symbology|Labeling|MapTips"');
    });

    it('references every attribute column in the map tip', () => {
        const tip = mapTip(generateQml(COLUMNS, ROWS));
        for (const field of ['NAME', 'CHANNELS', 'TX_POWER_W', 'EMISSIONS']) {
            expect(tip).toContain(`[% "${field}" %]`);
        }
    });

    it('excludes geometry columns from the map tip', () => {
        const tip = mapTip(generateQml(COLUMNS, ROWS));
        expect(tip).not.toContain('LATITUDE');
        expect(tip).not.toContain('LONGITUDE');
    });

    it('labels on NAME when present', () => {
        const qml = generateQml(COLUMNS, ROWS);
        expect(qml).toContain('fieldName="NAME"');
    });

    it('falls back to the first string column when there is no NAME', () => {
        const qml = generateQml(['SITE_LABEL', 'LATITUDE', 'LONGITUDE', 'CHANNELS'],
                                [['A', -29, 134, 20]]);
        expect(qml).toContain('fieldName="SITE_LABEL"');
    });

    it('omits the labeling block when no column can serve as a label', () => {
        const qml = generateQml(['LATITUDE', 'LONGITUDE', 'CHANNELS'], [[-29, 134, 20]]);
        expect(qml).not.toContain('<labeling');
        expect(XMLValidator.validate(qml)).toBe(true);
    });

    it('honours an explicit label_field', () => {
        const qml = generateQml(COLUMNS, ROWS, { labelField: 'EMISSIONS' });
        expect(qml).toContain('fieldName="EMISSIONS"');
    });

    it('honours a fields subset for the map tip', () => {
        const tip = mapTip(generateQml(COLUMNS, ROWS, { fields: ['NAME', 'CHANNELS'] }));
        expect(tip).toContain('[% "NAME" %]');
        expect(tip).toContain('[% "CHANNELS" %]');
        expect(tip).not.toContain('[% "EMISSIONS" %]');
    });

    it('escapes XML metacharacters in column names', () => {
        // A raw & or < in element text is a parse error, and QGIS would reject the
        // whole style rather than just that line.
        const qml = generateQml(['NAME', 'LATITUDE', 'LONGITUDE', 'R&D <notes>'],
                                [['A', -29, 134, 'x']]);
        expect(XMLValidator.validate(qml)).toBe(true);
        expect(qml).toContain('R&amp;D &lt;notes&gt;');
    });

    it('skips a column whose name would break the expression syntax', () => {
        // Field names go inside [% "..." %]; an embedded double quote terminates it.
        const qml = generateQml(['NAME', 'LATITUDE', 'LONGITUDE', 'bad"name'],
                                [['A', -29, 134, 'x']]);
        expect(XMLValidator.validate(qml)).toBe(true);
        expect(mapTip(qml)).not.toContain('bad"name');
    });

    it('parses to a document rooted at qgis', () => {
        const parsed = new XMLParser({ ignoreAttributes: false }).parse(generateQml(COLUMNS, ROWS));
        expect(parsed.qgis).toBeDefined();
        expect(parsed.qgis['@_version']).toMatch(/^3\./);
    });

    it('produces a usable style for a single-column result', () => {
        const qml = generateQml(['NAME', 'LATITUDE', 'LONGITUDE'], [['A', -29, 134]]);
        expect(XMLValidator.validate(qml)).toBe(true);
        expect(mapTip(qml)).toContain('[% "NAME" %]');
    });
});
