/**
 * Department analytics.
 *
 * One screen, one tab per department the signed-in role may see. The server
 * decides which tabs exist and what goes in them; this file only draws.
 *
 * Chart forms follow the data's job rather than variety: trends are lines,
 * comparisons are single-hue bars, part-to-whole is a stacked bar with a legend.
 * There are no pies and no second y-axis anywhere. Every chart carries a
 * "Show numbers" table, which is both the accessibility relief the palette
 * requires and the thing anyone writing a board paper actually wants.
 */

import { api } from '../api.js';
import { el, page, card, table, fmt, spinner, chip, button, empty, filterSelect, toast, icon } from '../ui.js';
import { trendChart, barChart, columnChart, stackedBar, figure, panel, statTile, tileRow, meter, SERIES, compact } from '../charts.js';
import { can } from '../state.js';
import { navigate } from '../router.js';

export async function render(container, context = {}) {
  container.replaceChildren(spinner());

  let index;
  try {
    index = await api.get('/api/analytics');
  } catch (err) {
    container.replaceChildren(el('div', { class: 'p-6' }, [el('p', { class: 'text-sm text-rose-700', text: err.message })]));
    return;
  }

  if (!index.departments.length) {
    container.replaceChildren(
      page({
        title: 'Analytics',
        children: empty('Your role does not have analytics for any department yet.'),
      })
    );
    return;
  }

  const view = {
    department: context.query?.department || index.departments[0].key,
    academicYearId: index.academicYear?.id || null,
    examId: context.query?.examId || null,
  };
  if (!index.departments.some((row) => row.key === view.department)) {
    view.department = index.departments[0].key;
  }

  const tabsHost = el('div', { class: 'mb-4 flex flex-wrap gap-1 border-b border-ink-200 no-print' });
  const bodyHost = el('div');

  function paintTabs() {
    tabsHost.replaceChildren(
      ...index.departments.map((department) =>
        el('button', {
          class: [
            '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
            department.key === view.department
              ? 'border-brand-600 text-brand-700'
              : 'border-transparent text-ink-500 hover:text-ink-800',
          ].join(' '),
          text: department.label,
          on: {
            click: () => {
              view.department = department.key;
              view.examId = null;
              paintTabs();
              load();
            },
          },
        })
      )
    );
  }

  async function load() {
    bodyHost.replaceChildren(spinner('Working out the figures…'));
    try {
      const data = await api.get(`/api/analytics/${view.department}`, {
        academicYearId: view.academicYearId,
        examId: view.examId,
      });
      bodyHost.replaceChildren(build(data, view, load));
    } catch (err) {
      bodyHost.replaceChildren(el('div', { class: 'card p-4 text-sm text-rose-700', text: err.message }));
    }
  }

  paintTabs();

  container.replaceChildren(
    page({
      title: 'Analytics',
      subtitle: 'Every figure here is computed live from the same records the module screens use.',
      wide: true,
      actions: [
        index.years.length > 1
          ? filterSelect({
              options: index.years.map((year) => ({
                value: year.id,
                label: `${year.name}${year.isCurrent ? ' (current)' : ''}`,
              })),
              value: view.academicYearId,
              placeholder: 'Academic year',
              width: '11rem',
              onChange: (value) => {
                view.academicYearId = value;
                load();
              },
            })
          : null,
        can('report.export')
          ? button('Export to Excel', {
              iconName: 'download',
              onClick: async () => {
                try {
                  const name = await api.download(`/api/analytics/${view.department}/export`, {
                    academicYearId: view.academicYearId,
                    examId: view.examId,
                  });
                  toast(`Downloaded ${name}`, 'good');
                } catch (err) {
                  toast(err.message, 'bad');
                }
              },
            })
          : null,
        button('Print', { iconName: 'print', onClick: () => window.print() }),
      ],
      children: el('div', {}, [tabsHost, bodyHost]),
    })
  );

  await load();
}

/* ------------------------------------------------------------------ builder */

function build(data, view, reload) {
  if (data.empty) return empty(data.empty);

  const sections = {
    overview: overviewPanels,
    admissions: admissionsPanels,
    attendance: attendancePanels,
    fees: feesPanels,
    exams: examsPanels,
    library: libraryPanels,
    transport: transportPanels,
    staff: staffPanels,
  };

  return el('div', { class: 'space-y-5' }, [
    el('p', { class: 'text-xs text-ink-500', text: data.scope }),
    tileRow((data.tiles || []).map(tile)),
    ...(sections[data.department] ? sections[data.department](data.charts, data, view, reload) : []),
  ]);
}

/** Server tiles carry their own format and tone; this only renders them. */
function tile(spec) {
  const value =
    spec.value === null || spec.value === undefined
      ? 'Not recorded'
      : spec.format === 'money'
        ? `₹${compact(spec.value)}`
        : spec.format === 'percent'
          ? `${spec.value}%`
          : compact(spec.value);

  return statTile({
    label: spec.label,
    value,
    delta: spec.delta,
    deltaLabel: spec.deltaLabel,
    trend: spec.trend && spec.trend.filter((point) => point !== null).length > 1 ? spec.trend : null,
    hint: spec.hint,
    upIsGood: spec.upIsGood !== false,
    tone:
      spec.tone === 'good'
        ? 'emerald-700'
        : spec.tone === 'warn'
          ? 'amber-700'
          : spec.tone === 'bad'
            ? 'rose-700'
            : null,
  });
}

function two(...children) {
  return el('div', { class: 'grid grid-cols-1 gap-4 lg:grid-cols-2' }, children.filter(Boolean));
}

const LABEL_COL = { key: 'label', label: 'Item' };
const numberCol = (label, format = 'number') => ({ key: 'value', label, numeric: true, format });

/* ------------------------------------------------------------------ overview */

/**
 * Panels appear only when the server sent their series. It omits anything the
 * role may not see, so a class teacher's overview simply has no fee section
 * rather than an empty one hinting at data they cannot open.
 */
function overviewPanels(charts) {
  return [
    charts.attendanceTrend
      ? panel(
          'Attendance over the last 20 school days',
          'A dip that lasts more than a day or two is usually a bus, a festival, or an outbreak.',
          figure({
            chart: trendChart(charts.attendanceTrend, { format: 'percent', goal: 90 }),
            columns: [{ key: 'label', label: 'Day' }, numberCol('Attendance', 'percent')],
            rows: charts.attendanceTrend.filter((row) => row.value !== null),
            empty: 'No attendance has been recorded yet.',
          })
        )
      : null,
    two(
      charts.collectionTrend
        ? panel(
            'Fee collection by month',
            'Cash actually received, excluding anything since reversed.',
            figure({
              chart: trendChart(charts.collectionTrend, { format: 'money', color: SERIES[2] }),
              columns: [{ key: 'label', label: 'Month' }, numberCol('Collected', 'money')],
              rows: charts.collectionTrend,
            })
          )
        : null,
      panel(
        'Students per class',
        null,
        figure({
          chart: barChart(charts.enrolmentByClass),
          columns: [{ ...LABEL_COL, label: 'Class' }, numberCol('Students')],
          rows: charts.enrolmentByClass,
        })
      )
    ),
    two(
      charts.ageing
        ? panel(
            'Outstanding dues by age',
            'Anything past 90 days rarely collects itself.',
            figure({
              chart: stackedBar(charts.ageing, { format: 'money' }),
              columns: [{ ...LABEL_COL, label: 'Age' }, numberCol('Outstanding', 'money')],
              rows: charts.ageing.filter((row) => row.value > 0),
              empty: 'Nothing outstanding.',
            })
          )
        : null,
      panel(
        'Section capacity',
        'How full each section is against the capacity set for it.',
        charts.sectionFill.some((row) => row.capacity)
          ? el(
              'div',
              { class: 'space-y-2.5' },
              charts.sectionFill
                .filter((row) => row.capacity)
                .map((row) => meter({ value: row.value, max: row.capacity, label: row.label }))
            )
          : empty('No sections have a capacity set.')
      )
    ),
    panel(
      'Students by gender',
      null,
      figure({
        chart: stackedBar(charts.genderSplit),
        columns: [{ ...LABEL_COL, label: 'Gender' }, numberCol('Students')],
        rows: charts.genderSplit,
      })
    ),
  ];
}

/* ---------------------------------------------------------------- admissions */

function admissionsPanels(charts) {
  return [
    two(
      panel(
        'Where enquiries stand',
        'Everyone currently in the pipeline, by stage.',
        figure({
          chart: barChart(charts.funnelStages),
          columns: [{ ...LABEL_COL, label: 'Stage' }, numberCol('Enquiries')],
          rows: charts.funnelStages,
          empty: 'No enquiries recorded yet.',
        })
      ),
      panel(
        'Which sources actually convert',
        'Volume is the bar; the conversion rate is in the numbers.',
        figure({
          chart: barChart(charts.bySource),
          columns: [
            { key: 'label', label: 'Source' },
            { key: 'value', label: 'Enquiries', numeric: true },
            { key: 'conversionPercent', label: 'Converted', numeric: true, format: 'percent' },
          ],
          rows: charts.bySource,
          empty: 'No enquiries recorded yet.',
        })
      )
    ),
    panel(
      'Enquiries and conversions by month',
      'The gap between the two lines is the pipeline that has not closed.',
      figure({
        chart: trendChart(charts.byMonth, { color: SERIES[0] }),
        columns: [
          { key: 'label', label: 'Month' },
          { key: 'value', label: 'Enquiries', numeric: true },
        ],
        rows: charts.byMonth,
        empty: 'No enquiries recorded yet.',
      })
    ),
    two(
      panel(
        'Admissions taken by month',
        null,
        figure({
          chart: columnChart(charts.admissionsByMonth),
          columns: [{ key: 'label', label: 'Month' }, numberCol('Admitted')],
          rows: charts.admissionsByMonth,
        })
      ),
      panel(
        'Seats left per section',
        'Where the waiting list actually needs to form.',
        figure({
          chart: barChart(
            charts.capacity.filter((row) => row.capacity).map((row) => ({
              label: row.label,
              value: row.free ?? 0,
              tone: (row.free ?? 0) === 0 ? 'critical' : undefined,
              note: `${row.value} of ${row.capacity} filled`,
            }))
          ),
          columns: [
            { key: 'label', label: 'Section' },
            { key: 'value', label: 'Enrolled', numeric: true },
            { key: 'capacity', label: 'Capacity', numeric: true },
            { key: 'free', label: 'Free', numeric: true },
          ],
          rows: charts.capacity,
          empty: 'No sections have a capacity set.',
        })
      )
    ),
  ];
}

/* ---------------------------------------------------------------- attendance */

function attendancePanels(charts) {
  return [
    panel(
      'Attendance over the last 30 school days',
      'The amber line is the 90% mark most schools aim at.',
      figure({
        chart: trendChart(charts.trend, { format: 'percent', goal: 90, height: 220 }),
        columns: [{ key: 'label', label: 'Day' }, numberCol('Attendance', 'percent')],
        rows: charts.trend.filter((row) => row.value !== null),
        empty: 'No attendance has been recorded yet.',
      })
    ),
    two(
      panel(
        'By class',
        null,
        figure({
          chart: barChart(charts.byClass, { format: 'percent', max: 100 }),
          columns: [{ ...LABEL_COL, label: 'Class' }, numberCol('Attendance', 'percent')],
          rows: charts.byClass,
        })
      ),
      panel(
        'By day of the week',
        'Mondays and the day after a holiday are usually the weak spots.',
        figure({
          chart: columnChart(charts.byWeekday, { format: 'percent' }),
          columns: [{ key: 'label', label: 'Day' }, numberCol('Attendance', 'percent')],
          rows: charts.byWeekday,
        })
      )
    ),
    two(
      panel(
        'What the marks were',
        null,
        figure({
          chart: stackedBar(charts.statusMix),
          columns: [{ ...LABEL_COL, label: 'Status' }, numberCol('Records')],
          rows: charts.statusMix,
        })
      ),
      panel(
        `Students needing a call home (${charts.defaulters.length})`,
        'Below the threshold set in Settings.',
        charts.defaulters.length
          ? table({
              dense: true,
              columns: [
                { key: 'name', label: 'Student' },
                { key: 'className', label: 'Class', width: '6rem' },
                { key: 'percent', label: 'Attendance', type: 'percent' },
                { key: 'guardianPhone', label: 'Phone', width: '9rem' },
              ],
              rows: charts.defaulters,
            })
          : el('div', { class: 'flex items-center gap-2 py-6 text-sm text-emerald-700' }, [
              icon('check_circle'),
              'Everyone is above the threshold.',
            ])
      )
    ),
  ];
}

/* --------------------------------------------------------------------- fees */

function feesPanels(charts) {
  return [
    panel(
      'Collection over the last 30 days',
      'What actually came in, day by day.',
      figure({
        chart: trendChart(charts.dailyCollection, { format: 'money', color: SERIES[2], height: 220 }),
        columns: [{ key: 'label', label: 'Day' }, numberCol('Collected', 'money')],
        rows: charts.dailyCollection,
      })
    ),
    two(
      panel(
        'Collected by fee head',
        null,
        figure({
          chart: barChart(charts.byHead, { format: 'money', color: SERIES[2] }),
          columns: [{ ...LABEL_COL, label: 'Fee head' }, numberCol('Collected', 'money')],
          rows: charts.byHead,
          empty: 'Nothing collected yet.',
        })
      ),
      panel(
        'How parents paid',
        'Cash share is worth watching — it is the part that has to be tallied by hand.',
        figure({
          chart: stackedBar(charts.byMode, { format: 'money' }),
          columns: [
            { key: 'label', label: 'Mode', render: (row) => fmt.humanise(row.label) },
            numberCol('Collected', 'money'),
          ],
          rows: charts.byMode,
          empty: 'Nothing collected yet.',
        })
      )
    ),
    two(
      panel(
        'Outstanding by age',
        null,
        figure({
          chart: stackedBar(charts.ageing, { format: 'money' }),
          columns: [{ ...LABEL_COL, label: 'Age' }, numberCol('Outstanding', 'money')],
          rows: charts.ageing.filter((row) => row.value > 0),
          empty: 'Nothing outstanding.',
        })
      ),
      panel(
        'Collected by class',
        null,
        figure({
          chart: barChart(charts.byClass, { format: 'money', color: SERIES[2] }),
          columns: [
            { key: 'label', label: 'Class' },
            { key: 'billed', label: 'Billed', numeric: true, format: 'money' },
            { key: 'value', label: 'Collected', numeric: true, format: 'money' },
            { key: 'outstanding', label: 'Outstanding', numeric: true, format: 'money' },
          ],
          rows: charts.byClass,
        })
      )
    ),
    panel(
      `Largest outstanding balances (${charts.topDefaulters.length})`,
      'Ring these before the next invoice run.',
      charts.topDefaulters.length
        ? table({
            dense: true,
            columns: [
              { key: 'admissionNo', label: 'Admission No', width: '9rem' },
              { key: 'name', label: 'Student' },
              { key: 'className', label: 'Class', width: '7rem' },
              { key: 'total', label: 'Outstanding', type: 'money' },
              { key: '90+', label: 'Over 90 days', type: 'money' },
              { key: 'guardianPhone', label: 'Phone', width: '9rem' },
            ],
            rows: charts.topDefaulters,
          })
        : el('div', { class: 'flex items-center gap-2 py-6 text-sm text-emerald-700' }, [
            icon('check_circle'),
            'Nothing outstanding.',
          ])
    ),
  ];
}

/* -------------------------------------------------------------------- exams */

function examsPanels(charts, data, view, reload) {
  const picker = data.exams?.length
    ? filterSelect({
        label: 'Exam',
        width: '20rem',
        options: data.exams.map((exam) => ({ value: exam.id, label: exam.label })),
        value: data.selectedExamId,
        placeholder: 'Choose an exam',
        onChange: (value) => {
          view.examId = value;
          reload();
        },
      })
    : null;

  return [
    picker ? el('div', { class: 'flex flex-wrap items-end gap-2 no-print' }, [picker]) : null,
    two(
      panel(
        'Average score by subject',
        'Shown as a percentage so subjects out of 50 and 100 can sit side by side.',
        figure({
          chart: barChart(charts.subjectAverages, { format: 'percent', max: 100 }),
          columns: [
            { key: 'label', label: 'Subject' },
            { key: 'value', label: 'Average', numeric: true, format: 'percent' },
            { key: 'note', label: 'Raw' },
          ],
          rows: charts.subjectAverages,
          empty: 'No marks entered yet.',
        })
      ),
      panel(
        'Pass rate by subject',
        'A subject well below the others usually means the paper, not the class.',
        figure({
          chart: barChart(charts.passBySubject, { format: 'percent', max: 100, color: SERIES[2] }),
          columns: [{ ...LABEL_COL, label: 'Subject' }, numberCol('Pass rate', 'percent')],
          rows: charts.passBySubject,
          empty: 'No marks entered yet.',
        })
      )
    ),
    panel(
      'Grade distribution',
      'How the class actually spread across the grade bands.',
      figure({
        chart: columnChart(charts.gradeDistribution),
        columns: [{ ...LABEL_COL, label: 'Grade' }, numberCol('Students')],
        rows: charts.gradeDistribution.filter((row) => row.value > 0),
        empty: 'No grades to distribute yet.',
      })
    ),
    two(
      panel(
        'Top of the class',
        null,
        charts.toppers.length
          ? table({
              dense: true,
              columns: [
                { key: 'rank', label: '#', width: '3rem', type: 'num' },
                { key: 'name', label: 'Student' },
                { key: 'percent', label: 'Percent', type: 'percent' },
              ],
              rows: charts.toppers.slice(0, 10),
            })
          : empty('No results yet.')
      ),
      panel(
        `Needing attention (${charts.failures.length})`,
        'Below the pass mark in at least one subject.',
        charts.failures.length
          ? table({
              dense: true,
              columns: [
                { key: 'name', label: 'Student' },
                { key: 'percent', label: 'Percent', type: 'percent' },
                { key: 'failedSubjects', label: 'Subjects', type: 'num' },
              ],
              rows: charts.failures,
            })
          : el('div', { class: 'flex items-center gap-2 py-6 text-sm text-emerald-700' }, [
              icon('check_circle'),
              'Everyone passed every subject.',
            ])
      )
    ),
    charts.termComparison?.exams?.length > 1
      ? panel(
          'Term comparison',
          'The same students across every published exam, so a slipping child is visible early.',
          table({
            dense: true,
            columns: [
              { key: 'rollNo', label: 'Roll', width: '4rem' },
              { key: 'name', label: 'Student' },
              ...charts.termComparison.exams.map((exam) => ({
                key: exam.id,
                label: exam.name,
                type: 'percent',
                render: (row) => (row.terms[exam.id] === null ? '—' : `${row.terms[exam.id]}%`),
              })),
            ],
            rows: charts.termComparison.rows,
          })
        )
      : null,
  ];
}

/* ------------------------------------------------------------------ library */

function libraryPanels(charts) {
  return [
    panel(
      'Books issued over the last 30 days',
      null,
      figure({
        chart: trendChart(charts.issuesPerDay, { color: SERIES[6] }),
        columns: [{ key: 'label', label: 'Day' }, numberCol('Issued')],
        rows: charts.issuesPerDay,
      })
    ),
    two(
      panel(
        'Most borrowed titles',
        'What to buy more copies of.',
        figure({
          chart: barChart(charts.topTitles, { color: SERIES[6] }),
          columns: [{ ...LABEL_COL, label: 'Title' }, numberCol('Times issued')],
          rows: charts.topTitles,
          empty: 'Nothing has been issued yet.',
        })
      ),
      panel(
        'Stock by category',
        null,
        figure({
          chart: barChart(charts.byCategory),
          columns: [{ ...LABEL_COL, label: 'Category' }, numberCol('Copies')],
          rows: charts.byCategory,
          empty: 'No copies catalogued yet.',
        })
      )
    ),
    two(
      panel(
        'Where the stock is',
        null,
        figure({
          chart: stackedBar(charts.stockStatus),
          columns: [
            { key: 'label', label: 'Status', render: (row) => fmt.humanise(row.label) },
            numberCol('Copies'),
          ],
          rows: charts.stockStatus,
        })
      ),
      panel(
        'How late the overdue books are',
        null,
        figure({
          chart: barChart(charts.overdueBuckets.map((row) => ({ ...row, tone: 'warning' }))),
          columns: [{ ...LABEL_COL, label: 'Overdue by' }, numberCol('Books')],
          rows: charts.overdueBuckets,
          empty: 'Nothing is overdue.',
        })
      )
    ),
  ];
}

/* ---------------------------------------------------------------- transport */

function transportPanels(charts) {
  return [
    two(
      panel(
        'How full each route is',
        'Against the seat count on the vehicle assigned to it.',
        el(
          'div',
          { class: 'space-y-2.5' },
          charts.routeUtilisation.filter((row) => row.capacity).length
            ? charts.routeUtilisation
                .filter((row) => row.capacity)
                .map((row) => meter({ value: row.value, max: row.capacity, label: row.label }))
            : [empty('No vehicle capacities have been set.')]
        )
      ),
      panel(
        'Students per route',
        null,
        figure({
          chart: barChart(charts.routeUtilisation),
          columns: [
            { key: 'label', label: 'Route' },
            { key: 'value', label: 'Students', numeric: true },
            { key: 'capacity', label: 'Seats', numeric: true },
            { key: 'free', label: 'Free', numeric: true },
          ],
          rows: charts.routeUtilisation,
          empty: 'No routes set up yet.',
        })
      )
    ),
    two(
      panel(
        'Busiest stops',
        'Where the bus spends its time.',
        figure({
          chart: barChart(charts.byStop.slice(0, 12)),
          columns: [{ ...LABEL_COL, label: 'Stop' }, numberCol('Students')],
          rows: charts.byStop,
          empty: 'Nobody is assigned to a stop yet.',
        })
      ),
      panel(
        'Fare committed per route',
        'What the route is expected to bring in.',
        figure({
          chart: barChart(charts.fareByRoute, { format: 'money', color: SERIES[2] }),
          columns: [{ ...LABEL_COL, label: 'Route' }, numberCol('Fare', 'money')],
          rows: charts.fareByRoute,
          empty: 'No fares recorded.',
        })
      )
    ),
    panel(
      `Documents expiring (${charts.expiries.length})`,
      'Insurance, fitness, PUC, permits and driving licences due in the next 90 days.',
      charts.expiries.length
        ? table({
            dense: true,
            columns: [
              { key: 'kind', label: 'Type', width: '7rem' },
              { key: 'name', label: 'Vehicle or driver' },
              { key: 'document', label: 'Document', render: (row) => fmt.humanise(row.document) },
              { key: 'expiresOn', label: 'Expires', type: 'date' },
              {
                key: 'daysLeft',
                label: 'Status',
                render: (row) =>
                  row.expired ? chip('Expired', 'bad') : chip(`${row.daysLeft} days left`, row.daysLeft < 30 ? 'warn' : 'neutral'),
              },
            ],
            rows: charts.expiries,
          })
        : el('div', { class: 'flex items-center gap-2 py-6 text-sm text-emerald-700' }, [
            icon('check_circle'),
            'Nothing expires in the next 90 days.',
          ])
    ),
  ];
}

/* -------------------------------------------------------------------- staff */

function staffPanels(charts) {
  return [
    panel(
      'Staff attendance by month',
      null,
      figure({
        chart: trendChart(charts.attendanceTrend, { format: 'percent', goal: 95, color: SERIES[6] }),
        columns: [{ key: 'label', label: 'Month' }, numberCol('Attendance', 'percent')],
        rows: charts.attendanceTrend.filter((row) => row.value !== null),
        empty: 'No staff attendance recorded yet.',
      })
    ),
    two(
      panel(
        'Headcount by department',
        null,
        figure({
          chart: barChart(charts.byDepartment),
          columns: [{ ...LABEL_COL, label: 'Department' }, numberCol('Staff')],
          rows: charts.byDepartment,
        })
      ),
      panel(
        'Employment type',
        null,
        figure({
          chart: stackedBar(charts.byEmploymentType),
          columns: [{ ...LABEL_COL, label: 'Type' }, numberCol('Staff')],
          rows: charts.byEmploymentType,
        })
      )
    ),
    two(
      panel(
        'Leave taken by type',
        'Approved days only.',
        figure({
          chart: barChart(charts.leaveByType.map((row) => ({ ...row, label: fmt.humanise(row.label) }))),
          columns: [
            { key: 'label', label: 'Type', render: (row) => fmt.humanise(row.label) },
            numberCol('Days'),
          ],
          rows: charts.leaveByType,
          empty: 'No leave has been approved yet.',
        })
      ),
      panel(
        'Lowest attendance this month',
        null,
        charts.lowestAttendance.length
          ? table({
              dense: true,
              columns: [
                { key: 'name', label: 'Staff member' },
                { key: 'present', label: 'Present', type: 'num' },
                { key: 'absent', label: 'Absent', type: 'num' },
                { key: 'percent', label: 'Attendance', type: 'percent' },
              ],
              rows: charts.lowestAttendance,
            })
          : empty('No staff attendance recorded this month.')
      )
    ),
  ];
}

void card;
void navigate;
