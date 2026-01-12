# Publishing Instructions

## Authentication Setup

npm requires either 2FA or a granular access token to publish packages.

### Option 1: Enable 2FA (Recommended)

```bash
npm profile enable-2fa auth-only
```

Follow the prompts to set up 2FA with an authenticator app.

### Option 2: Use Granular Access Token

1. Visit: https://www.npmjs.com/settings/nikushadevashvili/tokens
2. Click "Generate New Token" → "Granular Access Token"
3. Configure:
   - **Type**: Publish
   - **Package**: observa-sdk (or "All packages")
   - **Bypass 2FA**: ✅ Enable this (required for publishing)
4. Copy the token
5. Use it to authenticate:

```bash
npm login --auth-type=legacy
# When prompted for password, paste your token
```

Or add to `~/.npmrc`:

```
//registry.npmjs.org/:_authToken=YOUR_TOKEN_HERE
```

## Publishing

Once authenticated, publish with:

```bash
npm publish --access public
```

The package is ready:

- ✅ Build successful (8.2 kB)
- ✅ Only essential files included (7 files)
- ✅ Clean structure





