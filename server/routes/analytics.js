'use strict';

const express = require('express');

const { ok, handler, str } = require('../http');
const { need, has } = require('../middleware/permission');
const analytics = require('../store/analytics');
const academics = require('../store/academics');
const exporter = require('../store/exporter');
const audit = require('../store/audit');
const settings = require('../store/settings');
const { sendXlsx } = require('./system');
const errors = require('../errors');

const router = express.Router();

/**
 * Department analytics (SPEC §4 departments).
 *
 * Each department is gated by the permission that already governs its data, so a
 * role can never see through analytics what it cannot see on the module screen.
 * A class teacher's attendance figures are additionally scoped to their own
 * sections, the same way the marking screen is.
 */

router.get(
  '/analytics',
  handler(async (req, res) => {
    const departments = analytics.availableFor(req.user);
    return ok(res, {
      departments,
      academicYear: await academics.currentYear(),
      years: await academics.listYears(),
    });
  })
);

router.get(
  '/analytics/:department',
  handler(async (req, res) => {
    const key = str(req.params.department, { max: 20 });
    const definition = analytics.DEPARTMENTS.find((row) => row.key === key);
    if (!definition) throw errors.notFound('There is no analytics view by that name.');

    if (!has(req.user, definition.permission) || (definition.extra && !has(req.user, definition.extra))) {
      throw errors.forbidden(
        `Your role cannot see the ${definition.label.toLowerCase()} figures. Ask the administrator if you need them.`
      );
    }

    const academicYearId = str(req.query.academicYearId, { max: 40 });
    const data = await buildFor(key, req, academicYearId);

    return ok(res, { department: key, label: definition.label, ...data });
  })
);

async function buildFor(key, req, academicYearId) {
  switch (key) {
    case 'overview':
      // Assembled from several modules, so it is filtered by what this user may see.
      return analytics.overview(academicYearId, req.user.permissions);
    case 'admissions':
      return analytics.admissions(academicYearId);
    case 'attendance': {
      // A class teacher sees their own sections only, exactly as on the marking screen.
      let sectionIds = null;
      if (!has(req.user, 'attendance.mark.any') && !has(req.user, 'academics.edit')) {
        const year = await academics.resolveYear(academicYearId);
        sectionIds = await academics.sectionsForTeacher(req.user.id, year.id);
      }
      return analytics.attendance(academicYearId, { sectionIds });
    }
    case 'fees':
      return analytics.fees(academicYearId);
    case 'exams':
      return analytics.exams(academicYearId, { examId: str(req.query.examId, { max: 40 }) });
    case 'library':
      return analytics.library();
    case 'transport':
      return analytics.transport(academicYearId);
    case 'staff':
      return analytics.staff(academicYearId);
    default:
      throw errors.notFound('There is no analytics view by that name.');
  }
}

/**
 * Exports the headline figures and every series behind them, one sheet per chart,
 * so the numbers can be checked or pasted into a board paper.
 */
router.get(
  '/analytics/:department/export',
  need('report.export'),
  handler(async (req, res) => {
    const key = str(req.params.department, { max: 20 });
    const definition = analytics.DEPARTMENTS.find((row) => row.key === key);
    if (!definition) throw errors.notFound('There is no analytics view by that name.');
    if (!has(req.user, definition.permission)) {
      throw errors.forbidden(`Your role cannot export the ${definition.label.toLowerCase()} figures.`);
    }

    const data = await buildFor(key, req, str(req.query.academicYearId, { max: 40 }));
    const meta = {
      schoolName: await settings.get('school.name'),
      generatedBy: req.user.name,
      generatedAt: new Date().toISOString(),
    };

    const sheets = [
      {
        sheetName: 'Headlines',
        title: `${definition.label} analytics`,
        subtitle: data.scope,
        columns: [
          { key: 'label', label: 'Measure', width: 34 },
          { key: 'value', label: 'Value', width: 18 },
          { key: 'hint', label: 'Note', width: 40 },
        ],
        rows: (data.tiles || []).map((tile) => ({
          label: tile.label,
          value: tile.value === null || tile.value === undefined ? 'not recorded' : tile.value,
          hint: tile.hint || '',
        })),
      },
    ];

    for (const [name, series] of Object.entries(data.charts || {})) {
      if (!Array.isArray(series) || !series.length) continue;
      const keys = [...new Set(series.flatMap((row) => Object.keys(row)))].filter(
        (columnKey) => !['date'].includes(columnKey)
      );
      sheets.push({
        sheetName: humanSheetName(name),
        title: humanSheetName(name),
        subtitle: definition.label,
        columns: keys.map((columnKey) => ({
          key: columnKey,
          label: humanSheetName(columnKey),
          width: columnKey === 'label' || columnKey === 'name' ? 30 : 16,
          type: typeof series[0][columnKey] === 'number' ? 'num' : 'text',
        })),
        rows: series,
      });
    }

    const buffer = await exporter.buildWorkbook(sheets, meta);
    await audit.fromRequest(req, {
      action: audit.ACTIONS.EXPORT_GENERATED,
      entityType: 'analytics',
      entityId: key,
      message: `Exported the ${definition.label} analytics`,
    });
    return sendXlsx(res, buffer, exporter.fileName(`${definition.label}-analytics`));
  })
);

/** 'topDefaulters' -> 'Top defaulters', within Excel's 31-character sheet limit. */
function humanSheetName(value) {
  const words = String(value)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[._-]/g, ' ')
    .trim();
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return label.slice(0, 31);
}

module.exports = { router };
