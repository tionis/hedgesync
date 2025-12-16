# HedgeDoc CLI Authentication Enhancement Proposal

## Executive Summary

HedgeDoc currently lacks proper support for programmatic/CLI authentication and service accounts. This document outlines the minimal changes needed to enable these use cases while maintaining security.

## Current State

### How HedgeDoc Authentication Works

HedgeDoc 1.x uses [Passport.js](http://www.passportjs.org/) for authentication with `express-session` for session management:

1. **Session-Based Auth**: All authenticated requests require a `connect.sid` session cookie
2. **Browser-Required OAuth**: OAuth2/OIDC flows use Passport's strategies which:
   - Generate a `state` parameter stored in the session
   - Require browser redirect to IdP
   - Validate the returned `state` on callback
   - Create a session only after successful validation
3. **No Token Exchange**: There is no mechanism to convert an OAuth2 access token into a HedgeDoc session

### Working CLI Authentication Methods

| Method | Requirements | Limitations |
|--------|--------------|-------------|
| Email/Password | HedgeDoc email auth enabled | Requires storing credentials |
| LDAP | HedgeDoc LDAP configured | Requires storing credentials |
| OIDC (browser) | Can open local browser | Not suitable for headless/remote servers |
| Device Code + OIDC | IdP device code support | Requires one-time browser interaction |

### What Doesn't Work

| Method | Why It Fails |
|--------|--------------|
| OAuth2 Client Credentials | Gets a valid token, but HedgeDoc can't use it |
| OAuth2 Device Code (standalone) | Same problem - token can't be exchanged for session |
| Bearer Token Header | HedgeDoc doesn't check for/accept Bearer tokens |

## Proposed Solutions

### Solution 1: Personal Access Tokens (Recommended)

**Complexity**: Medium  
**Security**: High  
**User Experience**: Excellent

Add a Personal Access Token (PAT) system similar to GitHub, GitLab, and other platforms.

#### Database Changes

```sql
-- New table for personal access tokens
CREATE TABLE access_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,          -- User-friendly name
    token_hash VARCHAR(255) NOT NULL,    -- SHA-256 hash of the token
    token_prefix VARCHAR(10) NOT NULL,   -- First 8 chars for identification
    scopes TEXT[],                        -- Optional: limit token permissions
    expires_at TIMESTAMP,                 -- Optional expiry
    last_used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    revoked_at TIMESTAMP,
    UNIQUE(user_id, name)
);
CREATE INDEX idx_access_tokens_hash ON access_tokens(token_hash);
```

#### API Changes

1. **Token Management Endpoints**:
```
POST   /api/tokens           Create new token
GET    /api/tokens           List user's tokens (without values)
DELETE /api/tokens/:id       Revoke a token
```

2. **Authentication Middleware**:
```javascript
// lib/auth.js
function authenticateRequest(req, res, next) {
  // Check for Bearer token first
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    
    const accessToken = await AccessToken.findOne({
      where: { token_hash: tokenHash, revoked_at: null }
    });
    
    if (accessToken && (!accessToken.expires_at || accessToken.expires_at > new Date())) {
      // Update last_used_at
      accessToken.last_used_at = new Date();
      await accessToken.save();
      
      // Attach user to request
      req.user = await User.findByPk(accessToken.user_id);
      return next();
    }
  }
  
  // Fall back to session auth
  return passport.authenticate('session')(req, res, next);
}
```

#### Token Format

Follow GitHub's format for easy identification:
```
hdoc_<base64_random_32_bytes>

Example: hdoc_ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

The prefix makes it easy to:
- Identify HedgeDoc tokens in logs/configs
- Implement secret scanning
- Distinguish from other credentials

#### User Interface

Add a "Personal Access Tokens" section in user settings:

```
┌─────────────────────────────────────────────────────────────┐
│ Personal Access Tokens                                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ Tokens allow CLI tools and scripts to access HedgeDoc on    │
│ your behalf.                                                 │
│                                                              │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ + Create New Token                                     │   │
│ └───────────────────────────────────────────────────────┘   │
│                                                              │
│ Active Tokens:                                               │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ 🔑 My CI Bot (hdoc_abc1...)                           │   │
│ │    Created: 2024-01-15  Last used: 2 hours ago        │   │
│ │    [Revoke]                                           │   │
│ └───────────────────────────────────────────────────────┘   │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ 🔑 Backup Script (hdoc_xyz9...)                       │   │
│ │    Created: 2024-02-01  Never used                    │   │
│ │    [Revoke]                                           │   │
│ └───────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

#### Usage

```bash
# Create token via UI, then use it:
hedgesync get https://hedgedoc.example.com/my-note \
  -H "Authorization: Bearer hdoc_xxxxx"

# Or set as environment variable
export HEDGEDOC_TOKEN="hdoc_xxxxx"
hedgesync get https://hedgedoc.example.com/my-note
```

### Solution 2: Accept OAuth2 Access Tokens (Alternative)

**Complexity**: Low-Medium  
**Security**: Medium (depends on IdP configuration)  
**User Experience**: Good (for OAuth2 users)

Modify HedgeDoc to accept and validate OAuth2 access tokens via Bearer header.

#### Changes Required

1. **Token Validation Middleware**:
```javascript
// lib/auth.js
async function validateOAuth2Token(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next(); // Continue to session auth
  }
  
  const token = authHeader.slice(7);
  
  // Validate token with IdP's introspection endpoint
  // or decode JWT and verify signature
  const tokenInfo = await validateWithIdP(token);
  
  if (!tokenInfo.active) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  
  // Find or create user based on token claims
  const user = await findOrCreateUserFromToken(tokenInfo);
  req.user = user;
  next();
}
```

2. **Configuration Addition**:
```json
{
  "oauth2": {
    "tokenIntrospectionUrl": "https://idp.example.com/oauth/introspect",
    "acceptBearerTokens": true,
    "allowedAudiences": ["hedgedoc"]
  }
}
```

#### Limitations

- Requires IdP to support token introspection (RFC 7662)
- Token validation adds latency to every request
- Tokens are typically short-lived (needs refresh logic)
- Not all IdPs expose necessary endpoints

### Solution 3: Service Accounts (Enterprise Feature)

**Complexity**: High  
**Security**: High  
**User Experience**: Good (for admins)

Add first-class service account support for automated systems.

#### Features

1. **Admin-Created Service Accounts**:
   - Special user type that can't log in interactively
   - Created/managed by admins only
   - Assigned specific permissions/note access

2. **Long-Lived Credentials**:
   - Client ID + Secret (rotatable)
   - No session required - stateless authentication

3. **Audit Logging**:
   - All service account actions logged
   - Easy to track automated changes

#### Database Changes

```sql
CREATE TABLE service_accounts (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    client_id VARCHAR(255) NOT NULL UNIQUE,
    client_secret_hash VARCHAR(255) NOT NULL,
    permissions JSONB DEFAULT '{}',  -- granular permissions
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    last_used_at TIMESTAMP,
    disabled_at TIMESTAMP
);
```

## Comparison

| Feature | PATs | OAuth2 Tokens | Service Accounts |
|---------|------|---------------|------------------|
| Implementation Effort | Medium | Low-Medium | High |
| User Self-Service | ✅ | ✅ (via IdP) | ❌ (admin only) |
| Works Offline | ✅ | ❌ | ✅ |
| Fine-Grained Permissions | Optional | Via IdP scopes | ✅ |
| Audit Trail | Easy | Medium | ✅ |
| Token Rotation | Manual | Automatic (refresh) | Manual |
| Headless/Bot Use | ✅ | Requires setup | ✅ |

## Recommendation

**Start with Personal Access Tokens (Solution 1)** because:

1. **Covers Most Use Cases**: CLI tools, scripts, CI/CD, backups
2. **User Empowerment**: Users can create/manage their own tokens
3. **Simple to Implement**: No external dependencies
4. **Proven Pattern**: Used by GitHub, GitLab, npm, Docker Hub, etc.
5. **Security**: Tokens can be:
   - Scoped to specific permissions
   - Set to expire
   - Easily revoked
   - Audited

## Implementation Roadmap

### Phase 1: Basic PAT Support
1. Database migration for `access_tokens` table
2. API endpoints for token CRUD
3. Bearer token authentication middleware
4. Basic UI for token management
5. CLI support in hedgesync

### Phase 2: Enhanced Security
1. Token scopes (read-only, specific notes, etc.)
2. IP allowlisting per token
3. Rate limiting per token
4. Audit logging

### Phase 3: Service Accounts (Optional)
1. Admin UI for service account management
2. Service account user type
3. Granular permission system

## Socket.IO Considerations

HedgeDoc's real-time collaboration uses Socket.IO, which currently only accepts session cookies for authentication. To support tokens:

```javascript
// app.js - Socket.IO authentication
io.use(async (socket, next) => {
  // Try Bearer token from query string or handshake auth
  const token = socket.handshake.auth?.token || 
                socket.handshake.query?.token;
  
  if (token) {
    const user = await authenticateToken(token);
    if (user) {
      socket.user = user;
      return next();
    }
  }
  
  // Fall back to session auth
  const sessionId = socket.handshake.headers.cookie?.match(/connect\.sid=([^;]+)/)?.[1];
  if (sessionId) {
    const session = await getSession(sessionId);
    if (session?.user) {
      socket.user = session.user;
      return next();
    }
  }
  
  next(new Error('Authentication required'));
});
```

## Security Considerations

### Token Storage
- **Never** store plain tokens - only hashes
- Use SHA-256 or bcrypt for hashing
- Consider using a separate secrets manager in production

### Token Transmission
- Tokens should only be transmitted over HTTPS
- Implement rate limiting on authentication endpoints
- Log failed authentication attempts

### Token Rotation
- Provide easy token rotation mechanism
- Consider automatic expiry for inactive tokens
- Alert users about potentially compromised tokens

## References

- [GitHub Personal Access Tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [GitLab Personal Access Tokens](https://docs.gitlab.com/ee/user/profile/personal_access_tokens.html)
- [OAuth 2.0 Token Introspection (RFC 7662)](https://datatracker.ietf.org/doc/html/rfc7662)
- [HedgeDoc Source Code](https://github.com/hedgedoc/hedgedoc)
- [Passport.js Documentation](http://www.passportjs.org/docs/)
