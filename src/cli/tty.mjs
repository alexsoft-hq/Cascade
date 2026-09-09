// tty.mjs — the one place in this tool that talks to a terminal.
//
// Asking the person at the keyboard. Both readers are SYNCHRONOUS, because
// everything else in this tool is: a promise here would turn the whole command
// into an async program for the sake of one question.
//
// Neither is ever reached without a TTY. Every caller checks `process.stdin.isTTY`
// first and takes the non-interactive path otherwise, which is what makes a
// piped or CI run fail with a sentence instead of hanging on a read.

import fs from 'node:fs';

/** One line from the terminal, echoed as typed. Returns '' at end of input. */
export function promptLine(question) {
  process.stderr.write(question);
  return readLineFromTty(false);
}

/**
 * One line from the terminal with NOTHING echoed: the password reader. The
 * terminal is put in raw mode so the driver stops echoing, which also means
 * this loop owns backspace and Ctrl-C.
 */
export function promptHidden(question) {
  process.stderr.write(question);
  const line = readLineFromTty(true);
  process.stderr.write('\n');
  return line;
}

export function readLineFromTty(hidden) {
  const wasRaw = process.stdin.isRaw === true;
  if (hidden && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true);
  const byte = Buffer.alloc(1);
  const typed = [];
  try {
    for (;;) {
      let n = 0;
      try {
        n = fs.readSync(process.stdin.fd, byte, 0, 1, null);
      } catch (e) {
        // A non-blocking stdin says "nothing yet" rather than blocking; the
        // read is retried. EOF on some platforms arrives as EOF, not as 0.
        if (e.code === 'EAGAIN') continue;
        if (e.code === 'EOF') break;
        throw e;
      }
      if (n === 0) break;
      const c = byte[0];
      if (c === 0x0a || c === 0x0d) break;                       // enter
      if (hidden && c === 0x03) { process.stderr.write('\n'); process.exit(130); }  // ctrl-c
      if (hidden && (c === 0x7f || c === 0x08)) { typed.pop(); continue; }          // backspace
      typed.push(c);
    }
  } finally {
    if (hidden && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(wasRaw);
  }
  // Decoded at the END, so a multi-byte character typed into the prompt survives
  // being read one byte at a time.
  return Buffer.from(typed).toString('utf8').replace(/\r$/, '');
}


/** A yes/no question whose default is NO: anything but y or yes is no. */
export function confirmYesNo(question) {
  return /^(y|yes)$/i.test(promptLine(question).trim());
}
