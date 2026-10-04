#!/usr/bin/env python3
"""guiTOP remote agent — HTTP server for GPU monitoring commands."""

import os
import sys
import json
import secrets
import argparse
import hmac
import threading
import subprocess
import time
import signal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import logging

__version__ = '1.0.0'

# Suppress per-request logging from BaseHTTPRequestHandler
logging.getLogger('http.server').setLevel(logging.WARNING)

# Global shutdown event
shutdown_event = threading.Event()


class WorkerThread(threading.Thread):
  """Worker thread for running and caching command output."""

  def __init__(self, name, cmd, interval, shell, run_timeout):
    super().__init__(daemon=True)
    self.name = name
    self.cmd = cmd
    self.interval = interval  # seconds between re-runs for stream commands
    self.shell = shell
    self.run_timeout = run_timeout
    self.running = True
    self.result = None  # {code, out}
    self.result_at = None  # monotonic time when result was last set
    self.started_at = None  # monotonic time when current run started, None if idle
    self.last_request_at = time.monotonic()
    self.waiters = []  # list of Event objects waiting for first result
    self.lock = threading.Lock()
    self.start()

  def run(self):
    """Main worker loop: run command periodically and cache result."""
    while self.running:
      with self.lock:
        time_since_request = time.monotonic() - self.last_request_at

      # Idle timeout: 60s for stream (interval=2), 600s for one-shot (interval=300)
      idle_timeout = 600 if self.interval > 10 else 60

      if time_since_request > idle_timeout:
        self.running = False
        break

      # Re-run every `interval` seconds
      self._run_command()
      time.sleep(self.interval)

  def _run_command(self):
    """Execute the command and cache the result."""
    # Mark start time BEFORE running (without holding lock during execution)
    with self.lock:
      self.started_at = time.monotonic()

    try:
      process = subprocess.Popen(
        [self.shell, '-c', self.cmd],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        # A process name with invalid UTF-8 must not turn the whole sample into an error.
        errors='replace',
        # Own process group, so a timeout kills the shell's children too. Killing only the
        # shell orphans anything it forked (a pipe, a `;` list) and orphans pile up per run.
        start_new_session=(os.name == 'posix')
      )
      try:
        stdout, _ = process.communicate(timeout=self.run_timeout)
        # Cap at 4 MB
        if len(stdout) > 4 * 1024 * 1024:
          stdout = stdout[:4 * 1024 * 1024]
        code = process.returncode
      except subprocess.TimeoutExpired:
        if os.name == 'posix':
          try:
            os.killpg(process.pid, signal.SIGKILL)
          except ProcessLookupError:
            pass
        else:
          process.kill()
        # Wait for the killed process. May block forever on D-state child,
        # which is acceptable: HTTP requests check started_at and answer 'stuck'.
        process.wait()
        code = -1  # Timeout marker
        stdout = ''

      with self.lock:
        self.result = {'code': code, 'out': stdout}
        self.result_at = time.monotonic()
        self.started_at = None  # Clear: run is complete, no longer running
        # Wake any waiters on first result
        for event in self.waiters:
          event.set()
        self.waiters.clear()
    except Exception as e:
      with self.lock:
        self.result = {'code': 1, 'out': str(e)}
        self.result_at = time.monotonic()
        self.started_at = None  # Clear on error too

  def get_result(self, wait_first=False, now=None):
    """
    Get the cached result. If wait_first and no result yet, wait up to 3s.
    Returns {state, code, out, ageMs} or None if no result.
    """
    if now is None:
      now = time.monotonic()

    with self.lock:
      self.last_request_at = now

      # A run already past the timeout will not finish in the next 3s. Waiting anyway pins the
      # client's one kept-alive socket and delays every other command for this host behind it.
      if self.started_at is not None and (now - self.started_at) > self.run_timeout:
        wait_first = False

      if self.result is None and wait_first:
        event = threading.Event()
        self.waiters.append(event)

    # Release lock while waiting (up to 3s for first result)
    if self.result is None and wait_first:
      event.wait(timeout=3.0)
      with self.lock:
        if event in self.waiters:
          self.waiters.remove(event)
      # The result landed during the wait; ages measured from before it come out negative.
      now = time.monotonic()

    with self.lock:
      if self.result is None:
        # A first run that never finishes (a driver hung since boot) must read as
        # stuck, not as an endless warm-up.
        if self.started_at is not None and (now - self.started_at) > self.run_timeout:
          return {'state': 'stuck', 'code': None, 'out': '', 'ageMs': int((now - self.started_at) * 1000)}
        return None

      # Determine state: 'ok' when result exists and no stuck run;
      # 'stuck' when a run is in progress and has exceeded timeout;
      # 'pending' when no result yet (but we have a result, so never here)
      is_stuck = self.started_at is not None and (now - self.started_at) > self.run_timeout

      if is_stuck:
        state = 'stuck'
        # For stuck state, ageMs is the elapsed time of the run
        ageMs = int((now - self.started_at) * 1000)
      else:
        state = 'ok'
        # For ok state, ageMs is the age of the result
        if self.result_at is not None:
          ageMs = int((now - self.result_at) * 1000)
        else:
          ageMs = 0

      return {
        'state': state,
        'code': self.result['code'],
        'out': self.result['out'],
        'ageMs': ageMs
      }

  def is_alive_check(self):
    """Check if the worker thread is still running."""
    return self.running and super().is_alive()

  def stop(self):
    """Stop the worker thread."""
    self.running = False


class AgentHandler(BaseHTTPRequestHandler):
  """HTTP request handler for the agent."""

  # HTTP/1.0 closes the socket after every response, which defeats the client's
  # keep-alive and costs a TCP connection per poll. Every response sends
  # Content-Length, so 1.1 is safe. The timeout frees a thread pinned by an idle
  # or dead client.
  protocol_version = 'HTTP/1.1'
  timeout = 60

  def log_message(self, format, *args):
    """Suppress per-request logging."""
    pass

  def _check_auth(self):
    """Check bearer token authentication."""
    auth = self.headers.get('Authorization', '')
    if not auth.startswith('Bearer '):
      self._send_401()
      return False

    token = auth[7:]  # Remove 'Bearer '
    expected = self.server.token
    # Compare bytes: compare_digest raises on non-ASCII str, which would drop the
    # connection instead of answering 401.
    if not hmac.compare_digest(token.encode('utf-8'), expected.encode('utf-8')):
      self._send_401()
      return False

    return True

  def do_GET(self):
    """Handle GET requests."""
    path = urlparse(self.path).path
    query = parse_qs(urlparse(self.path).query)

    if path == '/v1/health':
      if not self._check_auth():
        return
      self._handle_health()
    elif path == '/v1/run':
      if not self._check_auth():
        return
      names = query.get('name', [])
      if not names:
        self._send_404()
        return
      name = names[0]
      self._handle_run(name)
    else:
      self._send_404()

  def _handle_health(self):
    """Handle /v1/health endpoint."""
    names = list(self.server.commands.keys())
    response = {
      'ok': True,
      'version': __version__,
      'names': sorted(names)
    }
    self._send_json(response)

  def _handle_run(self, name):
    """Handle /v1/run endpoint."""
    if name not in self.server.commands:
      self._send_404()
      return

    cmd_entry = self.server.commands[name]

    # Get or create worker for this name
    with self.server.workers_lock:
      if name not in self.server.workers:
        worker = WorkerThread(
          name,
          cmd_entry['cmd'],
          cmd_entry['interval'],
          self.server.shell,
          self.server.run_timeout
        )
        self.server.workers[name] = worker
      else:
        worker = self.server.workers[name]
        # If worker is dead, replace it
        if not worker.is_alive_check():
          worker = WorkerThread(
            name,
            cmd_entry['cmd'],
            cmd_entry['interval'],
            self.server.shell,
            self.server.run_timeout
          )
          self.server.workers[name] = worker

    # Wait for first result (up to 3s), then return whatever we have
    result = worker.get_result(wait_first=True)

    if result is None:
      response = {
        'name': name,
        'state': 'pending',
        'code': None,
        'out': '',
        'ageMs': None
      }
    else:
      response = {
        'name': name,
        'state': result['state'],
        'code': result['code'],
        'out': result['out'],
        'ageMs': result['ageMs']
      }

    self._send_json(response)

  def _send_json(self, obj):
    """Send a JSON response."""
    body = json.dumps(obj).encode('utf-8')
    self.send_response(200)
    self.send_header('Content-Type', 'application/json')
    self.send_header('Content-Length', str(len(body)))
    self.end_headers()
    self.wfile.write(body)

  def _send_401(self):
    """Send a 401 response."""
    body = b'{"error":"unauthorized"}'
    self.send_response(401)
    self.send_header('Content-Type', 'application/json')
    self.send_header('Content-Length', str(len(body)))
    self.end_headers()
    self.wfile.write(body)

  def _send_404(self):
    """Send a 404 response."""
    body = b'{"error":"not found"}'
    self.send_response(404)
    self.send_header('Content-Type', 'application/json')
    self.send_header('Content-Length', str(len(body)))
    self.end_headers()
    self.wfile.write(body)


class AgentServer(ThreadingHTTPServer):
  """HTTP server for the agent with custom attributes."""

  daemon_threads = True

  def __init__(self, *args, **kwargs):
    self.token = kwargs.pop('token')
    self.commands = kwargs.pop('commands')
    self.shell = kwargs.pop('shell')
    self.run_timeout = kwargs.pop('run_timeout')
    self.workers = {}
    self.workers_lock = threading.Lock()
    super().__init__(*args, **kwargs)

  def shutdown_workers(self):
    """Shutdown all worker threads."""
    with self.workers_lock:
      for worker in self.workers.values():
        worker.stop()


def load_commands(path):
  """Load commands from a JSON file."""
  with open(path, 'r') as f:
    entries = json.load(f)

  commands = {}
  for entry in entries:
    commands[entry['name']] = entry
  return commands


def ensure_token_file(token_file):
  """Ensure token file exists. Create if missing. Return token."""
  token_path = os.path.expanduser(token_file)

  if os.path.exists(token_path):
    with open(token_path, 'r') as f:
      token = f.read().strip()
    if not token:
      print(f'Error: token file {token_path} is empty', file=sys.stderr)
      sys.exit(1)
    return token

  # Create directory
  token_dir = os.path.dirname(token_path)
  os.makedirs(token_dir, exist_ok=True)

  # Create token file with mode 0600 atomically, never world-readable
  token = secrets.token_hex(24)
  fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
  try:
    os.write(fd, (token + '\n').encode())
  finally:
    os.close(fd)

  # Never print the token itself: under systemd, stderr goes to the journal,
  # which other accounts in the adm and systemd-journal groups can read.
  print(f'Created token file: {token_path}', file=sys.stderr)

  return token


def main():
  parser = argparse.ArgumentParser(description='guiTOP remote agent')
  parser.add_argument('--bind', default='0.0.0.0', help='Bind address')
  parser.add_argument('--port', type=int, default=17581, help='Port')
  parser.add_argument('--token-file', default='~/.config/guitop-agent/token', help='Token file path')
  parser.add_argument('--commands', default='commands.json', help='Commands JSON file')
  parser.add_argument('--shell', default='sh', help='Shell command')
  parser.add_argument('--run-timeout', type=int, default=30, help='Command timeout in seconds')

  args = parser.parse_args()

  # Resolve paths
  if args.commands == 'commands.json':
    # Default: same directory as this script
    args.commands = os.path.join(os.path.dirname(__file__), 'commands.json')

  # Ensure token file and get token
  token = ensure_token_file(args.token_file)

  # Load commands
  try:
    commands = load_commands(args.commands)
  except Exception as e:
    print(f'Failed to load commands: {e}', file=sys.stderr)
    sys.exit(1)

  # Create server
  server = AgentServer(
    (args.bind, args.port),
    AgentHandler,
    token=token,
    commands=commands,
    shell=args.shell,
    run_timeout=args.run_timeout
  )

  # Log startup
  # The bound port, not the requested one: --port 0 lets the OS choose.
  print(f'Agent started: {args.bind}:{server.server_address[1]} with {len(commands)} commands', file=sys.stderr)

  # Handle graceful shutdown
  def shutdown_handler(signum, frame):
    print(f'Shutting down...', file=sys.stderr)
    shutdown_event.set()

  signal.signal(signal.SIGTERM, shutdown_handler)
  signal.signal(signal.SIGINT, shutdown_handler)

  # Run serve_forever in a daemon thread
  server_thread = threading.Thread(target=server.serve_forever, daemon=True)
  server_thread.start()

  # Main thread waits for shutdown signal
  try:
    while not shutdown_event.is_set():
      shutdown_event.wait(timeout=0.1)
  except KeyboardInterrupt:
    shutdown_handler(None, None)

  # Shutdown: close connections, stop workers, shut down server
  server.shutdown_workers()
  server.shutdown()
  server.server_close()
  sys.exit(0)


if __name__ == '__main__':
  main()
