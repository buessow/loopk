import { format } from 'node:util';
import newrelic from 'newrelic';

const LEVELS = {
  log: 'INFO',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  debug: 'DEBUG',
};

/** Keep console output and send each application log line to New Relic. */
export function forwardConsoleLogs (logger = console, agent = newrelic) {
  for (const [method, level] of Object.entries(LEVELS)) {
    const original = logger[method].bind(logger);
    logger[method] = (...args) => {
      original(...args);
      try {
        agent.recordLogEvent({ message: format(...args), level });
      } catch (err) {
        original(`Unable to forward ${method} log to New Relic`, err);
      }
    };
  }
}
