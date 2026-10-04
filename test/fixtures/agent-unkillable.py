#!/usr/bin/env python3
"""Runs guitop-agent.py with its kill calls disarmed.

A process in uninterruptible sleep (a hung GPU driver) is sent SIGKILL and does not exit
until whatever it waits on returns. No unprivileged test can put a process in D-state, but
from the agent's side the two look identical: the kill is issued and wait() keeps blocking.
Disarming the kill reproduces that, and the hang ends when the command finishes on its own.
"""

import importlib.util
import os
import subprocess
import sys

# Importing the agent would otherwise leave an agent/__pycache__ in the tree.
sys.dont_write_bytecode = True

AGENT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'agent', 'guitop-agent.py')
spec = importlib.util.spec_from_file_location('guitop_agent', AGENT)
guitop_agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guitop_agent)

# The agent calls os.killpg on POSIX and Popen.kill elsewhere.
if hasattr(os, 'killpg'):
  os.killpg = lambda pid, sig: None
subprocess.Popen.kill = lambda self: None

sys.argv[0] = AGENT
guitop_agent.main()
