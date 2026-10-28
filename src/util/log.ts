export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type Logger = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function fmt(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v.subarray(0, 6)).toString('hex') + (v.length > 6 ? '..' : '');
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'object') return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  return String(v);
}

export function makeLogger(name: string, minLevel: LogLevel = 'info', out: (s: string) => void = (s) => process.stderr.write(s + '\n')): Logger {
  return (level, msg, fields) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    const t = new Date().toISOString().slice(11, 23);
    let line = `${t} ${level.padEnd(5)} [${name}] ${msg}`;
    if (fields) {
      for (const [k, v] of Object.entries(fields)) line += ` ${k}=${fmt(v)}`;
    }
    out(line);
  };
}

export const silentLogger: Logger = () => {};
