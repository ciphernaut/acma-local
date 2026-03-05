# MCP Authentication Rework (Option C)

This document outlines the planned implementation for securing the ACMA RRL MCP Server.

## Current State
The server currently uses a **Network-Open** mode with placeholders for authentication. This is suitable for local development but must be secured before deployment.

## Future Auth Model: Bearer Tokens

### 1. Token Generation
- Implementation of a simple API key or JWT-based system.
- Tokens will be required in the `Authorization` header.

### 2. Middleware Implementation
The Express server will be updated with:
```typescript
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send('Unauthorized');
  }
  // Validate token...
  next();
};
```

### 3. MCP SDK Integration
The `@modelcontextprotocol/sdk` provides `authenticator` hooks that will be integrated into the `StreamableHttpServerTransport`.

## Security Best Practices
- **HTTPS**: All network traffic must be encrypted.
- **Rate Limiting**: Implement to prevent abuse of the ACMA search and sync tools.
- **CORS Partitioning**: Restrict access to known MCP Host origins if applicable.
