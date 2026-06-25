// The MCP stdio transport requires stdout to carry ONLY JSON-RPC frames.
// Some dependencies print to stdout via console.log — notably pdf.js (used by
// pdf-parse), which emits `Warning: ...` lines for malformed PDFs — and any
// such write corrupts the protocol stream and breaks the connection.
//
// Route every console channel to stderr so stdout stays clean. The MCP SDK
// writes protocol frames with process.stdout.write directly, so redirecting
// console does not affect them. Importing this module first applies the guard
// before any tool handler can trigger a noisy dependency.
import { format } from 'node:util';

const toStderr = (...args: unknown[]): void => {
  process.stderr.write(`${format(...args)}\n`);
};

console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;
// console.error already writes to stderr; leave it as-is.
