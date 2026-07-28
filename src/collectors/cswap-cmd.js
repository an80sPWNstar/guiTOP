// One place that knows how to invoke the cswap CLI, because the answer differs
// by platform and getting it wrong is silent: every call site used to hard-code
// `cmd.exe /c cswap ...`, which on the Linux AppImage/.deb builds simply failed
// and reported the Claude strip as "cswap not installed".
//
// Windows keeps going through cmd.exe: cswap is installed by `uv tool install`,
// and depending on the installer version the thing on PATH is either cswap.exe
// or a .cmd shim, which execFile cannot launch on its own.
//
// SECURITY: callers pass a fixed argument ARRAY. Nothing here builds a shell
// string, so no argument can inject a command regardless of its contents.

function cswapCmd(args) {
  if (process.platform === 'win32') {
    return { file: 'cmd.exe', args: ['/c', 'cswap', ...args] }
  }
  return { file: 'cswap', args: [...args] }
}

module.exports = { cswapCmd }
