/**
 * Shared plumbing for screens: lookup caching, the class/section pickers that
 * appear on half the screens, and small wrappers that keep error handling and
 * read-only checks consistent.
 */

import { api } from '../api.js';
import { state, setLookups, can, isReadOnly, readOnlyReason } from '../state.js';
import { el, spinner, errorBox, toast, filterSelect, filterInput, banner, button, icon, fmt } from '../ui.js';
import { blockedMessage } from '../hours.js';

let lookupsPromise = null;

/**
 * Classes, sections, subjects, teachers and years for the current academic year.
 * Cached for the session because they change rarely and every screen wants them.
 */
export async function lookups({ force = false } = {}) {
  if (force) {
    lookupsPromise = null;
    setLookups(null);
  }
  if (state.lookups) return state.lookups;
  if (!lookupsPromise) {
    lookupsPromise = api
      .get('/api/lookups')
      .then((data) => {
        setLookups(data);
        return data;
      })
      .catch((err) => {
        lookupsPromise = null;
        throw err;
      });
  }
  return lookupsPromise;
}

export function invalidateLookups() {
  lookupsPromise = null;
  setLookups(null);
}

export function classById(id) {
  return (state.lookups?.classes || []).find((row) => row.id === id) || null;
}

export function sectionById(id) {
  return (state.lookups?.sections || []).find((row) => row.id === id) || null;
}

export function sectionLabel(sectionId) {
  const section = sectionById(sectionId);
  if (!section) return '—';
  const klass = classById(section.classId);
  return `${klass ? klass.name : ''} ${section.name}`.trim();
}

export function teacherName(userId) {
  const teacher = (state.lookups?.teachers || []).find((row) => row.id === userId);
  return teacher ? teacher.name : '—';
}

export function subjectName(subjectId) {
  const subject = (state.lookups?.subjects || []).find((row) => row.id === subjectId);
  return subject ? subject.name : '—';
}

export function classOptions() {
  return (state.lookups?.classes || []).map((row) => ({ value: row.id, label: row.name }));
}

export function sectionOptions(classId = null) {
  return (state.lookups?.sections || [])
    .filter((row) => !classId || row.classId === classId)
    .map((row) => ({ value: row.id, label: sectionLabel(row.id) }));
}

/**
 * Sections the signed-in user may actually work with. A class teacher sees only
 * their own — the server enforces the same rule, this just avoids offering a
 * choice that will be refused.
 */
/**
 * True when this user may only work with their own sections — a class teacher.
 * The server decides this independently; this only keeps the pickers honest so
 * nobody is offered a choice that would come back refused.
 */
export function isSectionBound() {
  return !!state.user?.scopeSectionIds && !can('attendance.mark.any');
}

export function mySectionOptions() {
  const scoped = state.user?.scopeSectionIds;
  const all = state.lookups?.sections || [];
  const usable = isSectionBound() ? all.filter((row) => scoped.includes(row.id)) : all;
  return usable.map((row) => ({ value: row.id, label: sectionLabel(row.id) }));
}

export function subjectOptions(classId = null) {
  return (state.lookups?.subjects || [])
    .filter((row) => !classId || row.classId === classId)
    .map((row) => ({ value: row.id, label: row.name }));
}

export function teacherOptions() {
  return (state.lookups?.teachers || []).map((row) => ({ value: row.id, label: row.name }));
}

export function yearOptions() {
  return (state.lookups?.years || []).map((row) => ({
    value: row.id,
    label: `${row.name}${row.isCurrent ? ' (current)' : ''}${row.status === 'closed' ? ' — closed' : ''}`,
  }));
}

/* --------------------------------------------------------------- rendering */

/**
 * Standard async screen wrapper: shows a spinner, then either the content or a
 * retryable error. `build` receives the loaded data and returns a node.
 */
export async function renderAsync(container, load, build) {
  container.replaceChildren(spinner());
  try {
    const data = await load();
    container.replaceChildren(build(data));
  } catch (err) {
    console.error(err);
    container.replaceChildren(
      el('div', { class: 'mx-auto w-full max-w-3xl px-4 py-6' }, [
        errorBox(err.message, () => renderAsync(container, load, build)),
      ])
    );
  }
}

/** Re-runs a screen's own render function. Screens pass their entry point. */
export function reloader(container, renderFn, context) {
  return () => renderFn(container, context);
}

/* ------------------------------------------------------------- write guards */

/**
 * Wraps a save. Refuses early with the real reason when the portal is read-only or
 * the licence has lapsed, so the user is not left staring at a spinner.
 */
export async function guardedSave(action, { successMessage, onDone } = {}) {
  const blocked = blockedMessage();
  if (blocked) {
    toast(blocked, 'warn', 8000);
    return null;
  }
  try {
    const result = await action();
    if (successMessage) toast(successMessage, 'good');
    if (onDone) await onDone(result);
    return result;
  } catch (err) {
    if (err.isConflict) {
      toast(err.message, 'warn', 9000);
    } else if (err.isLocked) {
      toast(err.message, 'warn', 9000);
    } else if (err.fields) {
      toast(err.message, 'bad', 8000);
      throw err;
    } else {
      toast(err.message, 'bad', 8000);
    }
    throw err;
  }
}

/** Inline notice shown above forms when saving is not possible right now. */
export function readOnlyNotice() {
  if (!isReadOnly()) return null;
  return banner(readOnlyReason() || 'The portal is read-only right now.', 'warn');
}

export function disabledIfReadOnly(node) {
  if (isReadOnly() && node) node.disabled = true;
  return node;
}

/* ------------------------------------------------------------ filter widgets */

/** Class + section pair that keeps the section list in step with the class. */
export function classSectionFilters({ classId, sectionId, onChange, sectionsOnly = false, mine = false }) {
  const nodes = [];
  if (!sectionsOnly) {
    nodes.push(
      filterSelect({
        label: 'Class',
        options: classOptions(),
        value: classId,
        placeholder: 'All classes',
        onChange: (value) => onChange({ classId: value, sectionId: null }),
      })
    );
  }
  nodes.push(
    filterSelect({
      label: 'Section',
      options: mine ? mySectionOptions() : sectionOptions(classId),
      value: sectionId,
      placeholder: 'All sections',
      width: '12rem',
      onChange: (value) => onChange({ classId, sectionId: value }),
    })
  );
  return nodes;
}

export function dateFilter({ label = 'Date', value, onChange, max }) {
  return filterInput({ label, type: 'date', value: value || fmt.today(), onChange, max });
}

export function monthFilter({ label = 'Month', value, onChange }) {
  return filterInput({ label, type: 'month', value: value || fmt.thisMonth(), onChange, width: '9rem' });
}

export function dateRangeFilters({ from, to, onChange }) {
  return [
    filterInput({ label: 'From', type: 'date', value: from, onChange: (value) => onChange({ from: value, to }) }),
    filterInput({ label: 'To', type: 'date', value: to, onChange: (value) => onChange({ from, to: value }) }),
  ];
}

export function exportButton(path, query, label = 'Export to Excel') {
  return button(label, {
    iconName: 'download',
    onClick: async (event) => {
      const original = event.currentTarget.textContent;
      event.currentTarget.disabled = true;
      try {
        const name = await api.download(path, query);
        toast(`Downloaded ${name}`, 'good');
      } catch (err) {
        toast(err.message, 'bad');
      } finally {
        event.currentTarget.disabled = false;
        event.currentTarget.textContent = original;
      }
    },
  });
}

export function printButton(onPrint, label = 'Print') {
  return button(label, { iconName: 'print', onClick: onPrint });
}

/** Header block reused by every printed document. */
export function printHeader(school, title, subtitle) {
  return el('div', { class: 'mb-4 border-b border-ink-300 pb-3 text-center' }, [
    el('h1', { class: 'font-display text-xl font-bold uppercase tracking-wide', text: school?.name || 'School' }),
    school?.addressLine1
      ? el('p', {
          class: 'text-xs text-ink-600',
          text: [school.addressLine1, school.addressLine2, school.city, school.state, school.pincode]
            .filter(Boolean)
            .join(', '),
        })
      : null,
    school?.phone || school?.email
      ? el('p', {
          class: 'text-xs text-ink-600',
          text: [school.phone, school.email].filter(Boolean).join(' • '),
        })
      : null,
    school?.affiliationNo
      ? el('p', { class: 'text-xs text-ink-500', text: `Affiliation No. ${school.affiliationNo}` })
      : null,
    el('h2', { class: 'mt-2 text-base font-semibold uppercase tracking-wider', text: title }),
    subtitle ? el('p', { class: 'text-xs text-ink-600', text: subtitle }) : null,
  ]);
}

export function printFooter(generatedBy, generatedAt) {
  return el('div', { class: 'mt-6 flex justify-between border-t border-ink-200 pt-2 text-[10px] text-ink-500' }, [
    el('span', { text: `Generated by ${generatedBy || '—'} on ${fmt.dateTime(generatedAt || new Date().toISOString())}` }),
    el('span', { text: 'School Admin Portal' }),
  ]);
}

/** Used by list screens with a primary action the role may not have. */
export function actionIf(permission, node) {
  return can(permission) ? node : null;
}

export function sectionHeading(text, action) {
  return el('div', { class: 'mb-2 mt-6 flex items-center justify-between gap-3' }, [
    el('h2', { class: 'text-base font-semibold text-ink-900', text }),
    action || null,
  ]);
}

export function iconRow(name, text) {
  return el('span', { class: 'inline-flex items-center gap-1 text-sm' }, [icon(name, 'text-base text-ink-400'), text]);
}
