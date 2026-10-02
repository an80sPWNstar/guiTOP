# guiTOP Agent

Minimal Python 3.8+ HTTP server running GPU commands on behalf of guiTOP. Replaces SSH polling when `transport: 'agent'` is set in hosts.json.

## Installation

Run `./install.sh` on the target host, then enable lingering:

```bash
loginctl enable-linger $USER
```

Without this, the agent stops when you log out. The script creates `~/.config/guitop-agent/token` (mode 0600) and writes commands to `~/.local/share/guitop-agent/`.

## Configuration

Listen address is `0.0.0.0:17581`. Restrict it to the LAN only; do not expose to the internet.

In hosts.json:

```json
{
  "host": "192.168.1.50",
  "transport": "agent",
  "agentToken": "<token from ~/.config/guitop-agent/token>",
  "agentPort": 17581
}
```

guiTOP encrypts the plaintext token on startup using `safeStorage`.

## Switching back to SSH

Remove `"transport": "agent"` or set `"transport": "stream"`. Also remove `agentToken` and `agentPort`.

## Service management

Stop: `systemctl --user stop guitop-agent`  
Logs: `journalctl --user -u guitop-agent -f`
