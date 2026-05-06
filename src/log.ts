export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

interface LoggerOptions {
  level: LogLevel;
  base?: Record<string, unknown>;
  sink?: (line: string) => void;
}

function emit(opts: Required<Pick<LoggerOptions, 'sink'>>, payload: Record<string, unknown>): void {
  opts.sink(JSON.stringify(payload));
}

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
  const base = options.base ?? {};
  const threshold = LEVEL_ORDER[options.level];

  function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < threshold) return;
    emit(
      { sink },
      { time: new Date().toISOString(), level, msg, ...base, ...(fields ?? {}) },
    );
  }

  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child: (fields) => createLogger({ level: options.level, base: { ...base, ...fields }, sink }),
  };
}
