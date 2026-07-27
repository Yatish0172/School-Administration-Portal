'use strict';

const os = require('os');

/**
 * LAN address detection and mDNS advertising (SPEC §1, T07).
 * Everything here is local-network only — no runtime network calls leave the LAN.
 */

const MDNS_HOSTNAME = 'school-portal.local';
const MDNS_SERVICE_NAME = 'School Admin Portal';

/**
 * Picks the address staff should type. Prefers wired Ethernet, then Wi-Fi.
 *
 * Virtual adapters have to be filtered out or they win: a VirtualBox host-only
 * adapter is named "Ethernet 3", looks wired, sits in a private range, and hands
 * out an address no phone on the school Wi-Fi can reach. The adapter name alone is
 * not enough, so the MAC prefix is checked too — those are assigned per hypervisor
 * and are far more reliable than a name Windows made up.
 */
const VIRTUAL_NAME_PATTERNS = /(virtual|vmware|vbox|hyper-v|loopback|wsl|docker|tap|tun|bluetooth|vethernet|zerotier|tailscale|radmin|hamachi)/i;

const VIRTUAL_MAC_PREFIXES = [
  '0a:00:27', // VirtualBox host-only
  '08:00:27', // VirtualBox
  '00:15:5d', // Hyper-V / WSL
  '00:50:56', // VMware
  '00:0c:29', // VMware
  '00:05:69', // VMware
  '00:1c:14', // VMware
  '02:42', // Docker bridge
  '00:ff', // Windows tunnel adapters
];

/** Ranges hypervisors and container runtimes claim by default. */
const VIRTUAL_SUBNETS = [/^192\.168\.56\./, /^192\.168\.99\./, /^172\.1[7-9]\./, /^172\.2\d\./, /^169\.254\./];

function looksVirtual(name, mac, address) {
  if (VIRTUAL_NAME_PATTERNS.test(name)) return true;
  const normalised = String(mac || '').toLowerCase();
  if (VIRTUAL_MAC_PREFIXES.some((prefix) => normalised.startsWith(prefix))) return true;
  if (VIRTUAL_SUBNETS.some((pattern) => pattern.test(address))) return true;
  return false;
}

function candidates() {
  const interfaces = os.networkInterfaces();
  const found = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      const virtual = looksVirtual(name, address.mac, address.address);
      const wired = /ethernet|eth\d|en\d/i.test(name) && !/wi-?fi|wlan/i.test(name);
      const wireless = /wi-?fi|wlan|wl\d/i.test(name);
      const privateRange =
        /^10\./.test(address.address) ||
        /^192\.168\./.test(address.address) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(address.address);
      found.push({
        name,
        address: address.address,
        mac: address.mac,
        netmask: address.netmask,
        virtual,
        wired,
        wireless,
        privateRange,
        score:
          (virtual ? -100 : 0) +
          (privateRange ? 30 : 0) +
          (wired ? 20 : 0) +
          (wireless ? 10 : 0),
      });
    }
  }
  return found.sort((a, b) => b.score - a.score);
}

function lanAddress() {
  const list = candidates();
  return list.length ? list[0] : null;
}

function accessInfo(port) {
  const primary = lanAddress();
  const all = candidates();
  return {
    port,
    ip: primary ? primary.address : null,
    mac: primary ? primary.mac : null,
    adapter: primary ? primary.name : null,
    url: primary ? `http://${primary.address}:${port}` : null,
    mdnsUrl: `http://${MDNS_HOSTNAME}:${port}`,
    localUrl: `http://localhost:${port}`,
    hostname: os.hostname(),
    interfaces: all.map(({ name, address, mac, virtual, wired, wireless }) => ({
      name,
      address,
      mac,
      virtual,
      wired,
      wireless,
    })),
  };
}

/* -------------------------------------------------------------------- mDNS */

let bonjour = null;
let published = null;

/**
 * Advertises `school-portal.local` so the address survives a DHCP change.
 * Best effort: some routers and Windows configurations block mDNS, which is why
 * the Access screen shows the raw IP and the DHCP-reservation instructions too.
 */
function startMdns(port) {
  if (published) return published;
  try {
    const { Bonjour } = require('bonjour-service');
    bonjour = new Bonjour();
    published = bonjour.publish({
      name: MDNS_SERVICE_NAME,
      type: 'http',
      port,
      host: MDNS_HOSTNAME,
      txt: { path: '/' },
    });
    published.on('error', (err) => {
      console.warn(`[mdns] could not advertise ${MDNS_HOSTNAME}: ${err.message}`);
    });
    console.log(`[mdns] advertising ${MDNS_HOSTNAME}:${port}`);
    return published;
  } catch (err) {
    console.warn(`[mdns] unavailable: ${err.message}`);
    return null;
  }
}

async function stopMdns() {
  if (!bonjour) return;
  await new Promise((resolve) => {
    try {
      bonjour.unpublishAll(() => resolve());
    } catch (err) {
      resolve();
    }
  });
  try {
    bonjour.destroy();
  } catch (err) {
    // Nothing useful to do at shutdown.
  }
  bonjour = null;
  published = null;
}

/** Printable one-time firewall rule for the Access screen. */
function firewallCommand(port) {
  return (
    'netsh advfirewall firewall add rule name="School Admin Portal" ' +
    `dir=in action=allow protocol=TCP localport=${port} profile=private`
  );
}

module.exports = {
  MDNS_HOSTNAME,
  candidates,
  lanAddress,
  accessInfo,
  startMdns,
  stopMdns,
  firewallCommand,
};
