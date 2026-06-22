/**
 * Preload (`node -r ./scripts/dns-pin.js ...`) that forces a hostname to a
 * single IPv4 address. Used only when running DB tooling from this sandbox,
 * where Neon's DNS returns an unreachable IPv6 + rotating IPv4s and Node's
 * happy-eyeballs occasionally stalls. TLS SNI still uses the real hostname
 * (pg passes `servername`), so Neon routing is unaffected.
 *
 *   PIN_HOST=<host> PIN_IP=<ipv4> node -r ./scripts/dns-pin.js ...
 */
const dns = require('dns');
const HOST = process.env.PIN_HOST;
const IP = process.env.PIN_IP;

if (HOST && IP) {
  const patch = (orig) =>
    function lookup(hostname, options, callback) {
      if (hostname === HOST) {
        if (typeof options === 'function') {
          callback = options;
          options = {};
        }
        if (options && options.all) {
          return process.nextTick(callback, null, [{ address: IP, family: 4 }]);
        }
        return process.nextTick(callback, null, IP, 4);
      }
      return orig(hostname, options, callback);
    };
  dns.lookup = patch(dns.lookup.bind(dns));
  if (dns.promises && dns.promises.lookup) {
    const origP = dns.promises.lookup.bind(dns.promises);
    dns.promises.lookup = function (hostname, options) {
      if (hostname === HOST) {
        if (options && options.all) return Promise.resolve([{ address: IP, family: 4 }]);
        return Promise.resolve({ address: IP, family: 4 });
      }
      return origP(hostname, options);
    };
  }
}
