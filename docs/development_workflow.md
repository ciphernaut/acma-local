# Development Workflow with Test Harness

This project follows a Test-Driven Development (TDD) approach using Jest and TypeScript.

## Prerequisites

- Node.js >= 18
- npm

## Setup

```bash
npm install
```

## Running the Server

### Development Mode

Starts the server with `tsx` (TypeScript Execute) for rapid development:

```bash
npm run dev
```

### Build and Run

Compiles TypeScript to JavaScript (ESM) and runs the build:

```bash
npm run build
node dist/index.js
```

## Testing

The project includes a comprehensive test suite covering the database, synchronization logic, and tool implementations.

### Running All Tests

```bash
npm test
```

### Running Specific Tests

- **Database Schema**: `npm test tests/db.test.ts`
- **Synchronization Logic**: `npm test tests/sync.test.ts`
- **Search Logic**: `npm test tests/logic.test.ts`

## Test Infrastructure

- **Jest**: Configured for ESM and TypeScript via `ts-jest`.
- **Scratch Directories**: Tests use `scratch_test` directories to avoid polluting production data.
- **Test Seeding**: Logic tests seed a temporary SQLite database with known data points to verify query accuracy.

## Adding New Tools

1.  **Logic**: Implement the database query logic in `src/logic.ts`.
2.  **Test**: Add test cases in `tests/logic.test.ts` to verify the new logic.
3.  **MCP Handler**: Register the tool and its input schema in `src/index.ts`.
4.  **Verification**: Run `npm test` to ensure everything is integrated correctly.
