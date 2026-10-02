#!/bin/sh
set -eu

# guiTOP remote agent installation script

AGENT_DIR="${HOME}/.local/share/guitop-agent"
SYSTEMD_DIR="${HOME}/.config/systemd/user"

# Create directories
mkdir -p "$AGENT_DIR"
mkdir -p "$SYSTEMD_DIR"

# Copy agent script and commands
cp "$(dirname "$0")/guitop-agent.py" "$AGENT_DIR/"
chmod +x "$AGENT_DIR/guitop-agent.py"

if [ -f "$(dirname "$0")/commands.json" ]; then
  cp "$(dirname "$0")/commands.json" "$AGENT_DIR/"
fi

# Copy systemd unit
cp "$(dirname "$0")/guitop-agent.service" "$SYSTEMD_DIR/"

# Reload systemd and enable/start the service
systemctl --user daemon-reload
systemctl --user enable --now guitop-agent

# Print token file location
TOKEN_FILE="${HOME}/.config/guitop-agent/token"
echo "Agent installed and started."
echo "Token file: $TOKEN_FILE"
echo "Add to guiTOP hosts.json: \"transport\": \"agent\", \"agentToken\": \"<token-from-file>\""
echo ""
echo "To run the agent without a login session, enable user lingering:"
echo "  loginctl enable-linger $USER"
