# Zalo profile relay

Zalo User Access Token v4 can be exchanged by Render, but Zalo may reject the
profile request when Render's egress IP is outside Vietnam (`error: -501`).
This small relay forwards only the fixed Zalo profile request from a machine in
Vietnam. It is not a general HTTP proxy.

## Security

- The relay accepts only `POST /zalo/profile` and always calls
  `https://graph.zalo.me/v2.0/me?fields=id,name,picture`.
- The access token is sent in JSON request body and never in the relay URL.
- Render authenticates with `x-zalo-profile-relay-secret`.
- The relay secret, access token, authorization code, refresh token, app secret,
  cookie and request body are never logged.
- Quick Tunnel URLs are temporary. Do not put the current `trycloudflare.com`
  URL in Git; set it only in the Render Environment settings.

## Run locally

PowerShell example; replace the placeholder in memory and do not echo the
secret:

```powershell
$env:ZALO_PROFILE_RELAY_SECRET = '<RELAY_SECRET_PLACEHOLDER_32_CHARS_MINIMUM>'
$env:ZALO_PROFILE_RELAY_PORT = '8787'
pnpm --filter @eco-oil/api relay:zalo-profile
```

The relay listens on `http://127.0.0.1:8787`. Keep the process running while
the tunnel is active:

```powershell
.\.tools\cloudflared.exe tunnel --url http://127.0.0.1:8787
```

Check the public tunnel with `GET /health`; it returns `{"status":"ok"}`.

## Render Environment

Set these values in Render, replacing the URL placeholder with the current
HTTPS Quick Tunnel URL. The URL below is deliberately not committed because
Quick Tunnel URLs change:

```text
ZALO_PROFILE_RELAY_URL=https://<CURRENT_QUICK_TUNNEL_HOST>.trycloudflare.com
ZALO_PROFILE_RELAY_SECRET=<same-secret-as-the-local-relay>
```

Render continues to exchange the authorization code directly with Zalo. Only
the profile request is relayed to:

```text
POST ${ZALO_PROFILE_RELAY_URL}/zalo/profile
x-zalo-profile-relay-secret: ${ZALO_PROFILE_RELAY_SECRET}
Content-Type: application/json
{"access_token":"<Zalo access token>"}
```
