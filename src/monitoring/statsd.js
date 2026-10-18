import dgram from 'node:dgram';

/**
 * Send StatsD gauges over UDP to the local Netdata agent, whose StatsD server
 * listens on 127.0.0.1:8125 by default. UDP keeps metrics fire-and-forget: a
 * missing agent never blocks or fails the caller.
 */
export function createStatsd ({ host = '127.0.0.1', port = 8125 } = {}) {
  const socket = dgram.createSocket('udp4');
  socket.on('error', (err) => console.error('StatsD socket error', err));

  return {
    gauge (name, value) {
      // A leading sign would make StatsD treat the gauge as an increment.
      const message = `${name}:${Math.max(0, value)}|g`;
      socket.send(message, port, host, (err) => {
        if (err) console.error(`Unable to send StatsD metric ${name}`, err);
      });
    },
    close () {
      return new Promise((resolve) => socket.close(resolve));
    },
  };
}
