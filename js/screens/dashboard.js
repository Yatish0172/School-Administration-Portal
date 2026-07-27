/**
 * Role-aware dashboard (SPEC §5). Tiles come back from the server already filtered
 * by permission, so this screen renders whatever it is given rather than deciding
 * who sees what.
 */

import { api } from '../api.js';
import { el, page, card, grid, statGrid, stat, table, chip, fmt, button, icon, empty } from '../ui.js';
import { renderAsync } from './_common.js';
import { navigate } from '../router.js';

export async function render(container) {
  await renderAsync(container, () => api.get('/api/dashboard'), build);
}

function build(data) {
  const tiles = data.tiles || {};

  return page({
    title: greeting(data),
    subtitle: subtitleFor(data),
    wide: true,
    children: el('div', { class: 'space-y-5' }, [
      alerts(data.alerts),
      statRow(data, tiles),
      el('div', { class: 'grid grid-cols-1 gap-4 lg:grid-cols-3' }, [
        el('div', { class: 'space-y-4 lg:col-span-2' }, [
          tiles.myPeriods ? myDay(tiles.myPeriods) : null,
          tiles.attendancePending ? pendingAttendance(tiles.attendancePending) : null,
          tiles.dues ? duesCard(tiles.dues) : null,
          tiles.admissions ? admissionsCard(tiles.admissions) : null,
        ]),
        el('div', { class: 'space-y-4' }, [
          noticesCard(data.notices),
          tiles.birthdays && tiles.birthdays.length ? birthdaysCard(tiles.birthdays) : null,
          tiles.library ? libraryCard(tiles.library) : null,
          tiles.transport ? transportCard(tiles.transport) : null,
          tiles.online ? onlineCard(tiles.online) : null,
          tiles.security ? securityCard(tiles.security) : null,
          systemCard(data, tiles),
        ]),
      ]),
    ]),
  });
}

function greeting(data) {
  const hour = Number(String(data.localTime || '09:00').slice(0, 2));
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = String(data.greetingName || '').split(' ')[0];
  return `${part}${firstName ? `, ${firstName}` : ''}`;
}

function subtitleFor(data) {
  const parts = [
    `${data.dayName} ${fmt.date(data.localDate)}`,
    `server time ${fmt.time(data.serverTime)}`,
  ];
  if (data.closeTimeLabel) parts.push(`closes ${data.closeTimeLabel}`);
  else if (data.nextOpening) {
    const when =
      data.nextOpening.offset === 0 ? 'today' : data.nextOpening.offset === 1 ? 'tomorrow' : data.nextOpening.dayName;
    parts.push(`closed — opens ${when} at ${fmt.time(data.nextOpening.open)}`);
  }
  if (data.academicYear) parts.push(`year ${data.academicYear.name}`);
  return parts.join(' • ');
}

function alerts(list) {
  if (!list || !list.length) return null;
  const tone = { critical: 'border-rose-200 bg-rose-50 text-rose-900', warning: 'border-amber-200 bg-amber-50 text-amber-900', info: 'border-sky-200 bg-sky-50 text-sky-900' };
  return el(
    'div',
    { class: 'space-y-2' },
    list.map((alert) =>
      el('div', { class: `flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm ${tone[alert.severity] || tone.info}` }, [
        icon(alert.severity === 'critical' ? 'error' : alert.severity === 'warning' ? 'warning' : 'info'),
        el('span', { class: 'flex-1', text: alert.message }),
        alert.route
          ? button('Open', {
              size: 'sm',
              onClick: () => navigate(alert.route.replace(/^#/, '')),
            })
          : null,
      ])
    )
  );
}

function statRow(data, tiles) {
  const cells = [];

  if (tiles.enrolment) {
    cells.push(
      stat({
        label: 'Students on roll',
        value: fmt.number(tiles.enrolment.active),
        sub: `${fmt.number(tiles.enrolment.total)} records in total`,
        onClick: () => navigate('/students'),
      })
    );
  }

  if (tiles.attendance) {
    const percent = tiles.attendance.percent;
    cells.push(
      stat({
        label: "Today's attendance",
        value: percent === null || percent === undefined ? 'Not marked' : fmt.percent(percent),
        sub:
          tiles.attendance.marked
            ? `${fmt.number(tiles.attendance.marked)} students marked`
            : 'No section has been marked yet',
        tone: percent === null ? 'warn' : percent >= 90 ? 'good' : percent >= 75 ? 'warn' : 'bad',
        onClick: () => navigate('/attendance'),
      })
    );
  }

  if (tiles.fees) {
    cells.push(
      stat({
        label: 'Collected today',
        value: fmt.money(tiles.fees.todayTotal),
        sub: `${fmt.number(tiles.fees.receiptsToday)} receipts • ${fmt.money(tiles.fees.monthTotal)} this month`,
        onClick: () => navigate('/fees'),
      })
    );
    cells.push(
      stat({
        label: 'Outstanding dues',
        value: fmt.money(tiles.fees.outstanding),
        tone: tiles.fees.outstanding > 0 ? 'warn' : 'good',
        onClick: () => navigate('/fees/reports'),
      })
    );
  }

  if (tiles.staff) {
    cells.push(
      stat({
        label: 'Staff on roll',
        value: fmt.number(tiles.staff.active),
        sub: `${fmt.number(tiles.staff.total)} records in total`,
        onClick: () => navigate('/staff'),
      })
    );
  }

  if (tiles.library) {
    cells.push(
      stat({
        label: 'Books out',
        value: fmt.number(tiles.library.outstanding),
        sub: `${fmt.number(tiles.library.overdue)} overdue`,
        tone: tiles.library.overdue > 0 ? 'warn' : 'neutral',
        onClick: () => navigate('/library'),
      })
    );
  }

  if (!cells.length) return null;
  return statGrid(cells);
}

function myDay(periods) {
  return card({
    title: 'Your periods today',
    body: table({
      dense: true,
      columns: [
        { key: 'period', label: 'Period', width: '5rem' },
        { key: 'time', label: 'Time', render: (row) => (row.startTime ? `${fmt.time(row.startTime)}` : '—') },
        { key: 'subjectName', label: 'Subject' },
        { key: 'label', label: 'Class' },
        { key: 'roomNo', label: 'Room' },
        {
          key: 'action',
          label: '',
          render: (row) =>
            button('Attendance', {
              size: 'sm',
              onClick: () => navigate(`/attendance?sectionId=${row.sectionId}`),
            }),
        },
      ],
      rows: periods,
      emptyMessage: 'No periods scheduled for you today.',
    }),
  });
}

function pendingAttendance(pending) {
  if (pending.count === 0) {
    return card({
      title: 'Attendance',
      body: el('div', { class: 'flex items-center gap-2 text-sm text-emerald-700' }, [
        icon('check_circle'),
        'Every section has been marked today.',
      ]),
    });
  }
  return card({
    title: `Attendance not yet marked (${pending.count})`,
    actions: [button('Open attendance', { size: 'sm', onClick: () => navigate('/attendance') })],
    body: el(
      'div',
      { class: 'flex flex-wrap gap-2' },
      pending.sections.map((section) =>
        button(`${section.label} · ${section.strength}`, {
          size: 'sm',
          onClick: () => navigate(`/attendance?sectionId=${section.sectionId}`),
        })
      )
    ),
  });
}

function duesCard(dues) {
  return card({
    title: 'Largest outstanding balances',
    subtitle: `${fmt.money(dues.outstanding)} owed across ${fmt.number(dues.students)} students`,
    actions: [button('Dues report', { size: 'sm', onClick: () => navigate('/fees/reports') })],
    body: table({
      dense: true,
      columns: [
        { key: 'name', label: 'Student' },
        { key: 'className', label: 'Class' },
        { key: 'phone', label: 'Phone' },
        { key: 'total', label: 'Due', type: 'money' },
      ],
      rows: dues.topDefaulters,
      emptyMessage: 'Nothing outstanding.',
    }),
  });
}

function admissionsCard(admissions) {
  return card({
    title: 'Admissions',
    subtitle: `${fmt.number(admissions.openEnquiries)} open enquiries • ${fmt.number(admissions.converted)} converted`,
    actions: [button('Open', { size: 'sm', onClick: () => navigate('/admissions') })],
    body: admissions.due.length
      ? table({
          dense: true,
          columns: [
            { key: 'childName', label: 'Child' },
            { key: 'parentName', label: 'Parent' },
            { key: 'phone', label: 'Phone' },
            { key: 'followUpDate', label: 'Follow up', type: 'date' },
          ],
          rows: admissions.due,
          onRowClick: (row) => navigate(`/admissions?enquiry=${row.id}`),
        })
      : empty('No follow-up calls are due.'),
  });
}

function noticesCard(notices) {
  return card({
    title: 'Notices',
    actions: [button('All', { size: 'sm', onClick: () => navigate('/notices') })],
    body:
      notices && notices.length
        ? el(
            'ul',
            { class: 'divide-y divide-ink-100' },
            notices.map((notice) =>
              el('li', { class: 'py-2' }, [
                el('div', { class: 'flex items-start justify-between gap-2' }, [
                  el('p', { class: 'text-sm font-medium text-ink-900', text: notice.title }),
                  notice.priority !== 'normal'
                    ? chip(fmt.humanise(notice.priority), notice.priority === 'urgent' ? 'bad' : 'warn')
                    : null,
                ]),
                el('p', { class: 'mt-0.5 line-clamp-2 text-xs text-ink-600', text: notice.body }),
                el('p', { class: 'mt-1 text-[11px] text-ink-400', text: fmt.ago(notice.publishedAt) }),
              ])
            )
          )
        : empty('No notices right now.'),
  });
}

function birthdaysCard(birthdays) {
  return card({
    title: `Birthdays today (${birthdays.length})`,
    body: el(
      'ul',
      { class: 'space-y-1 text-sm' },
      birthdays.map((student) =>
        el('li', { class: 'flex items-center gap-2' }, [
          icon('cake', 'text-base text-ink-400'),
          el('a', { class: 'hover:underline', href: `#/students/${student.id}`, text: student.name }),
        ])
      )
    ),
  });
}

function libraryCard(library) {
  return card({
    title: 'Library today',
    body: el('div', { class: 'space-y-1 text-sm' }, [
      row('Issued', fmt.number(library.issuedToday)),
      row('Returned', fmt.number(library.returnedToday)),
      row('Overdue', fmt.number(library.overdue)),
      row('Fines pending', fmt.money(library.finesPending)),
    ]),
  });
}

function transportCard(transport) {
  return card({
    title: 'Transport',
    body: el('div', { class: 'space-y-2' }, [
      row('Routes', fmt.number(transport.routes)),
      transport.expiring
        ? el('div', { class: 'rounded-lg bg-amber-50 p-2 text-xs text-amber-900' }, [
            el('p', { class: 'font-medium', text: `${transport.expiring} document(s) expiring soon` }),
            el(
              'ul',
              { class: 'mt-1 space-y-0.5' },
              transport.alerts.map((alert) =>
                el('li', { text: `${alert.kind} ${alert.name} — ${fmt.date(alert.expiresOn)}` })
              )
            ),
          ])
        : el('p', { class: 'text-xs text-emerald-700', text: 'No documents expiring in the next 45 days.' }),
    ]),
  });
}

function onlineCard(online) {
  return card({
    title: `Signed in now (${online.count})`,
    body:
      online.users.length
        ? el(
            'ul',
            { class: 'space-y-1 text-sm' },
            online.users.map((user) =>
              el('li', { class: 'flex items-center justify-between gap-2' }, [
                el('span', { text: user.userName }),
                el('span', { class: 'text-xs text-ink-500', text: fmt.humanise(user.roleKey) }),
              ])
            )
          )
        : empty('Nobody else is signed in.'),
  });
}

function securityCard(security) {
  return card({
    title: 'Last 7 days',
    body: el('div', { class: 'space-y-1 text-sm' }, [
      row('Refused for hours', fmt.number(security.refusedForHours)),
      row('Failed sign-ins', fmt.number(security.failedLogins)),
      row('Account lockouts', fmt.number(security.lockouts)),
      row('Device refusals', fmt.number(security.deviceRefusals)),
      el('p', {
        class: 'pt-1 text-xs text-ink-500',
        text: 'Full detail is in the audit log.',
      }),
    ]),
  });
}

function systemCard(data, tiles) {
  const items = [];
  if (tiles.backup) {
    items.push(
      row(
        'Last backup',
        tiles.backup.lastSuccessAt
          ? `${fmt.ago(tiles.backup.lastSuccessAt)} (${fmt.bytes(tiles.backup.sizeBytes)})`
          : 'never'
      )
    );
  }
  if (tiles.license) {
    items.push(
      row(
        'Licence',
        tiles.license.daysLeft === null
          ? fmt.humanise(tiles.license.status)
          : `${fmt.humanise(tiles.license.status)} — ${tiles.license.daysLeft} day(s)`
      )
    );
  }
  items.push(row('Server time', fmt.time(data.serverTime)));
  if (!items.length) return null;
  return card({ title: 'System', body: el('div', { class: 'space-y-1 text-sm' }, items) });
}

function row(label, value) {
  return el('div', { class: 'flex items-baseline justify-between gap-3' }, [
    el('span', { class: 'text-ink-500', text: label }),
    el('span', { class: 'font-medium tabular-nums', text: value }),
  ]);
}
