/**
 * The Access screen (SPEC §1, T07). This is what the admin puts on the wall.
 *
 * Only reachable from the server PC — the server refuses it from anywhere else.
 * The QR code, the fallback name, the firewall command and the plain-English
 * security warning all live here so there is one thing to print.
 */

import { api } from '../api.js';
import { el, page, card, button, fmt, spinner, chip, icon, toast, printNode, errorBox } from '../ui.js';
import { qrSvg, isAvailable } from '../qr.js';

export async function render(container) {
  container.replaceChildren(spinner());

  let data;
  try {
    data = await api.get('/api/access');
  } catch (err) {
    container.replaceChildren(
      el('div', { class: 'mx-auto w-full max-w-2xl px-4 py-6' }, [
        errorBox(
          err.status === 403
            ? 'The access details are only shown on the server PC itself. Open the portal on the office computer to see the QR code.'
            : err.message
        ),
      ])
    );
    return;
  }

  const url = data.url || data.localUrl;
  const qrOk = isAvailable();

  container.replaceChildren(
    page({
      title: 'Staff access',
      subtitle: 'How staff reach this portal from their own phones and laptops.',
      wide: true,
      actions: [
        button('Print this page', {
          variant: 'primary',
          iconName: 'print',
          onClick: () => printNode(printableSheet(data, url), { title: 'Staff access' }),
        }),
      ],
      children: el('div', { class: 'space-y-4' }, [
        data.addressChanged
          ? el('div', { class: 'banner-warn rounded-lg' }, [
              icon('warning'),
              el('span', {
                class: 'flex-1',
                text: `Address changed from ${data.previousIp} to ${data.ip} — reprint the QR code, any printed copy is now wrong.`,
              }),
            ])
          : null,
        data.clockWarning
          ? el('div', { class: 'banner-bad rounded-lg' }, [
              icon('error'),
              el('span', { class: 'flex-1', text: data.clockWarning }),
            ])
          : null,

        el('div', { class: 'grid grid-cols-1 gap-4 lg:grid-cols-3' }, [
          card({
            class: 'lg:col-span-2',
            title: 'Scan or type this',
            body: el('div', { class: 'flex flex-col items-center gap-4 sm:flex-row sm:items-start' }, [
              el('div', { class: 'flex flex-col items-center gap-2' }, [
                qrOk
                  ? qrSvg(url, { size: 220, title: `QR code for ${url}` })
                  : el('div', { class: 'flex h-[220px] w-[220px] items-center justify-center rounded bg-rose-50 p-4 text-center text-xs text-rose-700' }, [
                      'The QR library is missing from this build. Staff can still type the address below.',
                    ]),
                el('p', { class: 'text-xs text-ink-500', text: 'Point the camera app at this' }),
              ]),
              el('div', { class: 'flex-1 space-y-3' }, [
                bigAddress('Address', url, () => copy(url)),
                bigAddress('Or by name', data.mdnsUrl, () => copy(data.mdnsUrl)),
                el('div', { class: 'space-y-1 text-sm' }, [
                  row('This PC', data.hostname),
                  row('Network adapter', data.adapter || '—'),
                  row('Server time', `${fmt.date(data.localDate)} ${fmt.time(data.serverTime)} (${data.timezone})`),
                  row(
                    'Portal status',
                    data.phase === 'closed' || data.phase === 'beforeOpen'
                      ? 'Closed'
                      : `Open${data.closeTimeLabel ? ` until ${data.closeTimeLabel}` : ''}`
                  ),
                  row('Signed in now', String(data.usersOnline)),
                ]),
              ]),
            ]),
          }),
          card({
            title: 'Read this to the school',
            body: el('div', { class: 'space-y-3 text-sm text-ink-700' }, [
              warning(data.guidance.security),
              el('p', { text: data.guidance.wiring }),
            ]),
          }),
        ]),

        card({
          title: 'Keeping the address the same',
          subtitle: 'The IP changes on reboot unless it is fixed. Do at least one of these.',
          body: el('div', { class: 'grid grid-cols-1 gap-4 md:grid-cols-2' }, [
            el('div', { class: 'rounded-lg bg-ink-50 p-3' }, [
              el('div', { class: 'mb-1 flex items-center gap-2' }, [
                chip('Recommended', 'good'),
                el('p', { class: 'text-sm font-semibold', text: 'DHCP reservation on the router' }),
              ]),
              el('p', { class: 'text-sm text-ink-700', text: data.guidance.dhcp }),
              data.mac
                ? el('p', { class: 'mt-2 font-mono text-xs text-ink-600', text: `MAC address: ${data.mac}` })
                : null,
            ]),
            el('div', { class: 'rounded-lg bg-ink-50 p-3' }, [
              el('p', { class: 'mb-1 text-sm font-semibold', text: `Name: ${data.mdnsHostname}` }),
              el('p', { class: 'text-sm text-ink-700', text: data.guidance.mdns }),
            ]),
          ]),
        }),

        card({
          title: 'One-time firewall rule',
          subtitle:
            'Run this once, in a Command Prompt opened as Administrator on this PC. It opens the port on private networks only.',
          actions: [button('Copy command', { iconName: 'content_copy', onClick: () => copy(data.firewallCommand) })],
          body: el('pre', {
            class: 'overflow-x-auto rounded-lg bg-ink-900 p-3 text-xs text-ink-100',
            text: data.firewallCommand,
          }),
        }),

        data.interfaces.length > 1
          ? card({
              title: 'All network addresses on this PC',
              subtitle:
                'The portal picked the first one. If staff cannot connect, try another — and ignore anything marked virtual.',
              body: el(
                'ul',
                { class: 'space-y-1 text-sm' },
                data.interfaces.map((iface) =>
                  el('li', { class: 'flex flex-wrap items-center gap-2' }, [
                    el('span', { class: 'font-mono', text: `http://${iface.address}:${data.port}` }),
                    el('span', { class: 'text-xs text-ink-500', text: iface.name }),
                    iface.virtual ? chip('Virtual — not usable', 'bad') : null,
                    iface.address === data.ip ? chip('In use', 'good') : null,
                  ])
                )
              ),
            })
          : null,
      ]),
    })
  );
}

function bigAddress(label, value, onCopy) {
  return el('div', {}, [
    el('p', { class: 'text-xs uppercase tracking-wide text-ink-500', text: label }),
    el('div', { class: 'flex flex-wrap items-center gap-2' }, [
      el('p', { class: 'font-mono text-lg font-semibold text-ink-900', text: value }),
      button('Copy', { size: 'sm', onClick: onCopy }),
    ]),
  ]);
}

function row(label, value) {
  return el('div', { class: 'flex justify-between gap-3' }, [
    el('span', { class: 'text-ink-500', text: label }),
    el('span', { class: 'font-medium', text: value }),
  ]);
}

function warning(text) {
  return el('div', { class: 'rounded-lg bg-amber-50 p-3' }, [
    el('div', { class: 'flex gap-2' }, [
      icon('warning', 'text-amber-600'),
      el('p', { class: 'text-sm text-amber-900', text }),
    ]),
  ]);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.', 'good', 2000);
  } catch (err) {
    toast('Could not copy — select the text and copy it manually.', 'warn');
  }
}

/** A single sheet the office can tape to the wall. */
function printableSheet(data, url) {
  return el('div', { class: 'print-page mx-auto max-w-2xl bg-white p-8' }, [
    el('h1', { class: 'font-display text-2xl font-bold', text: data.schoolName }),
    el('h2', { class: 'mb-4 text-lg', text: 'How to open the school portal on your phone' }),
    el('div', { class: 'mb-4 flex items-start gap-6' }, [
      qrSvg(url, { size: 200 }),
      el('div', { class: 'space-y-2 text-sm' }, [
        el('p', { class: 'font-semibold', text: '1. Connect to the school Wi-Fi.' }),
        el('p', { class: 'font-semibold', text: '2. Scan this code with your camera.' }),
        el('p', { class: 'font-semibold', text: '3. Or type this address into your browser:' }),
        el('p', { class: 'font-mono text-base font-bold', text: url }),
        el('p', { class: 'text-xs', text: `If that stops working, try: ${data.mdnsUrl}` }),
        el('p', { class: 'font-semibold', text: '4. Sign in with the username the office gave you.' }),
      ]),
    ]),
    el('div', { class: 'rounded border border-ink-400 p-3 text-sm' }, [
      el('p', { class: 'font-semibold', text: 'First time on this device?' }),
      el('p', {
        text:
          'Ask the office for a device enrollment code. It is valid for ten minutes and works once. Without it, sign-in is refused even with the right password.',
      }),
    ]),
    el('p', {
      class: 'mt-4 text-xs text-ink-600',
      text: `Printed ${fmt.dateTime(new Date().toISOString())}. If the office says the address has changed, ask for a new copy of this sheet.`,
    }),
  ]);
}
