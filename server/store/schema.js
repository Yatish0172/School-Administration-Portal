'use strict';

/**
 * Single source of truth for every workbook, sheet and column.
 *
 * Column shorthand: `name`, `name:num`, `name:bool`, `name:date`, `name:json`.
 * The type drives Excel cell writing and coercion on read — a number stored as
 * text breaks every downstream total.
 *
 * `base: false` opts a sheet out of the standard stamps. Only insert-only sheets
 * (AuditEvents) do that; everything else carries id/_rev/createdBy/createdAt/
 * updatedBy/updatedAt as required by SPEC §13.
 */

const BASE_HEAD = ['id'];
const BASE_TAIL = ['_rev:num', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt'];

function parseColumn(spec) {
  const [name, type] = spec.split(':');
  return { name, type: type || 'text' };
}

function sheet(columns, options = {}) {
  const withBase =
    options.base === false ? columns : [...BASE_HEAD, ...columns, ...BASE_TAIL];
  return {
    columns: withBase.map(parseColumn),
    insertOnly: !!options.insertOnly,
    monthly: !!options.monthly,
  };
}

const WORKBOOKS = {
  System: {
    file: 'System.xlsx',
    scope: 'static',
    sheets: {
      Settings: sheet(['key', 'value', 'valueType', 'category', 'label']),
      Counters: sheet(['name', 'prefix', 'padding:num', 'current:num', 'scope']),
      AuditEvents: sheet(
        [
          'id',
          'at',
          'userId',
          'userName',
          'role',
          'deviceId',
          'ip',
          'action',
          'entityType',
          'entityId',
          'before:json',
          'after:json',
          'message',
        ],
        { base: false, insertOnly: true }
      ),
      AccessHours: sheet(['day:num', 'dayName', 'open', 'close', 'closed:bool']),
      RoleHours: sheet(['roleKey', 'behaviour', 'extendedUntil', 'note']),
      Holidays: sheet(['name', 'fromDate', 'toDate', 'description']),
      SpecialDays: sheet(['date', 'name', 'open', 'close', 'closed:bool', 'reason']),
      HoursOverrides: sheet([
        'date',
        'startedAt',
        'expiresAt',
        'hours:num',
        'reason',
        'status',
        'grantedBy',
      ]),
      BackupRuns: sheet([
        'at',
        'kind',
        'status',
        'file',
        'sizeBytes:num',
        'checksum',
        'durationMs:num',
        'error',
      ]),
    },
  },

  Users: {
    file: 'Users.xlsx',
    scope: 'static',
    sheets: {
      Users: sheet([
        'username',
        'name',
        'email',
        'phone',
        'roleKey',
        'department',
        'credentialType',
        'passwordHash',
        'status',
        'mustChangePassword:bool',
        'failedAttempts:num',
        'lockedUntil',
        'lastLoginAt',
        'deviceCap:num',
        'staffId',
      ]),
      Roles: sheet(['key', 'name', 'description', 'isSystem:bool', 'sortOrder:num']),
      Permissions: sheet(['key', 'module', 'description']),
      RolePermissions: sheet(['roleKey', 'permissionKey']),
      Sessions: sheet([
        'userId',
        'deviceId',
        'ip',
        'userAgent',
        'startedAt',
        'endedAt',
        'endedReason',
      ]),
      Devices: sheet([
        'deviceId',
        'name',
        'userId',
        'userAgent',
        'os',
        'browser',
        'ip',
        'status',
        'enrolledAt',
        'lastSeenAt',
        'revokedAt',
        'revokedBy',
      ]),
      EnrollmentCodes: sheet([
        'code',
        'userId',
        'expiresAt',
        'usedAt',
        'usedByDeviceId',
        'status',
      ]),
    },
  },

  Students: {
    file: 'Students.xlsx',
    scope: 'static',
    sheets: {
      Students: sheet([
        'admissionNo',
        'firstName',
        'middleName',
        'lastName',
        'dob',
        'gender',
        'bloodGroup',
        'category',
        'religion',
        'nationality',
        'motherTongue',
        'photoFile',
        'admissionDate',
        'status',
        'aadhaar',
        'permanentAddress',
        'correspondenceAddress',
        'city',
        'state',
        'pincode',
        'previousSchool',
        'remarks',
        'tcNumber',
        'tcDate',
        'leftDate',
      ]),
      Guardians: sheet([
        'studentId',
        'relation',
        'name',
        'phone',
        'email',
        'occupation',
        'qualification',
        'annualIncome:num',
        'isPrimary:bool',
      ]),
      StudentDocuments: sheet([
        'studentId',
        'docType',
        'title',
        'storedName',
        'originalName',
        'mimeType',
        'sizeBytes:num',
        'uploadedAt',
      ]),
      Enquiries: sheet([
        'enquiryNo',
        'childName',
        'dob',
        'gender',
        'classSought',
        'parentName',
        'relation',
        'phone',
        'email',
        'address',
        'source',
        'status',
        'followUpDate',
        'notes',
        'convertedStudentId',
        'convertedAt',
      ]),
      EnquiryFollowUps: sheet([
        'enquiryId',
        'at',
        'byUserId',
        'notes',
        'outcome',
        'nextActionDate',
      ]),
      WaitingList: sheet([
        'enquiryId',
        'academicYearId',
        'classId',
        'sectionId',
        'position:num',
        'status',
        'notes',
      ]),
    },
  },

  Academics: {
    file: 'Academics.xlsx',
    scope: 'static',
    sheets: {
      AcademicYears: sheet([
        'name',
        'startDate',
        'endDate',
        'isCurrent:bool',
        'status',
      ]),
      Classes: sheet(['name', 'level:num', 'sortOrder:num', 'status', 'stream']),
      Sections: sheet([
        'classId',
        'academicYearId',
        'name',
        'capacity:num',
        'classTeacherId',
        'roomNo',
        'status',
      ]),
      Subjects: sheet([
        'classId',
        'academicYearId',
        'name',
        'code',
        'type',
        'mode',
        'maxMarks:num',
        'passMarks:num',
        'sortOrder:num',
        'status',
      ]),
      TeacherAssignments: sheet([
        'academicYearId',
        'teacherUserId',
        'classId',
        'sectionId',
        'subjectId',
        'isClassTeacher:bool',
        'status',
      ]),
      StudentEnrollments: sheet([
        'studentId',
        'academicYearId',
        'classId',
        'sectionId',
        'rollNo',
        'status',
        'promotedFromId',
        'enrolledAt',
        'leftReason',
      ]),
      Periods: sheet([
        'academicYearId',
        'period:num',
        'label',
        'startTime',
        'endTime',
        'isBreak:bool',
      ]),
      Timetable: sheet([
        'academicYearId',
        'sectionId',
        'classId',
        'day:num',
        'period:num',
        'subjectId',
        'teacherUserId',
        'roomNo',
        'status',
      ]),
      TimetableSubstitutions: sheet([
        'date',
        'timetableId',
        'sectionId',
        'period:num',
        'originalTeacherId',
        'substituteTeacherId',
        'reason',
      ]),
    },
  },

  Attendance: {
    file: 'Attendance_{year}.xlsx',
    scope: 'year',
    monthlySheet: sheet(
      [
        'date',
        'studentId',
        'enrollmentId',
        'classId',
        'sectionId',
        'periodNo:num',
        'status',
        'reason',
        'markedBy',
        'markedAt',
        'lockedAt',
      ],
      { monthly: true }
    ),
    sheets: {
      AttendanceCorrections: sheet([
        'date',
        'studentId',
        'sectionId',
        'periodNo:num',
        'oldStatus',
        'newStatus',
        'reason',
        'correctedBy',
        'correctedAt',
      ]),
    },
  },

  StaffAttendance: {
    file: 'StaffAttendance_{year}.xlsx',
    scope: 'year',
    monthlySheet: sheet(
      [
        'date',
        'staffId',
        'inTime',
        'outTime',
        'status',
        'leaveType',
        'remarks',
        'markedBy',
        'markedAt',
      ],
      { monthly: true }
    ),
    sheets: {
      LeaveRequests: sheet([
        'staffId',
        'leaveType',
        'fromDate',
        'toDate',
        'days:num',
        'reason',
        'status',
        'approvedBy',
        'approvedAt',
        'rejectionReason',
      ]),
      LeaveBalances: sheet([
        'staffId',
        'leaveType',
        'opening:num',
        'accrued:num',
        'used:num',
      ]),
    },
  },

  Exams: {
    file: 'Exams_{year}.xlsx',
    scope: 'year',
    sheets: {
      Exams: sheet([
        'academicYearId',
        'name',
        'term',
        'classId',
        'startDate',
        'endDate',
        'weightage:num',
        'status',
        'publishedAt',
        'publishedBy',
      ]),
      ExamSubjects: sheet([
        'examId',
        'classId',
        'subjectId',
        'maxMarks:num',
        'passMarks:num',
        'examDate',
        'startTime',
        'endTime',
        'weightage:num',
      ]),
      Marks: sheet([
        'examId',
        'examSubjectId',
        'subjectId',
        'studentId',
        'enrollmentId',
        'sectionId',
        'marksObtained:num',
        'isAbsent:bool',
        'grade',
        'remarks',
        'enteredBy',
        'enteredAt',
      ]),
      GradeRules: sheet([
        'name',
        'classId',
        'minPercent:num',
        'maxPercent:num',
        'grade',
        'points:num',
        'description',
      ]),
      ReportRemarks: sheet([
        'examId',
        'studentId',
        'remarks',
        'conduct',
        'promotedTo',
        'enteredBy',
      ]),
    },
  },

  Fees: {
    file: 'Fees_{year}.xlsx',
    scope: 'year',
    sheets: {
      FeeHeads: sheet([
        'name',
        'code',
        'kind',
        'refundable:bool',
        'sortOrder:num',
        'status',
        'description',
      ]),
      FeeStructures: sheet([
        'academicYearId',
        'classId',
        'feeHeadId',
        'amount:num',
        'frequency',
        'effectiveFrom',
        'effectiveTo',
        'status',
      ]),
      Concessions: sheet([
        'studentId',
        'feeHeadId',
        'kind',
        'mode',
        'value:num',
        'reason',
        'status',
        'requestedBy',
        'approvedBy',
        'approvedAt',
        'rejectionReason',
        'effectiveFrom',
        'effectiveTo',
      ]),
      InvoiceBatches: sheet([
        'academicYearId',
        'classId',
        'period',
        'frequency',
        'dueDate',
        'count:num',
        'totalAmount:num',
        'status',
        'generatedBy',
        'committedAt',
      ]),
      Invoices: sheet([
        'invoiceNo',
        'batchId',
        'studentId',
        'enrollmentId',
        'classId',
        'sectionId',
        'period',
        'issueDate',
        'dueDate',
        'grossAmount:num',
        'concessionAmount:num',
        'netAmount:num',
        'paidAmount:num',
        'status',
      ]),
      StudentCharges: sheet([
        'invoiceId',
        'invoiceNo',
        'studentId',
        'enrollmentId',
        'classId',
        'feeHeadId',
        'period',
        'dueDate',
        'grossAmount:num',
        'concessionAmount:num',
        'netAmount:num',
        'paidAmount:num',
        'status',
      ]),
      Payments: sheet([
        'receiptNo',
        'studentId',
        'enrollmentId',
        'paidAt',
        'mode',
        'amount:num',
        'instrumentNo',
        'instrumentDate',
        'bankName',
        'collectedBy',
        'status',
        'idempotencyKey',
        'remarks',
        'reversalId',
      ]),
      PaymentAllocations: sheet([
        'paymentId',
        'studentChargeId',
        'invoiceId',
        'feeHeadId',
        'amount:num',
      ]),
      Receipts: sheet([
        'receiptNo',
        'paymentId',
        'studentId',
        'issuedAt',
        'issuedBy',
        'amount:num',
        'printCount:num',
        'lastPrintedAt',
        'status',
      ]),
      Reversals: sheet([
        'paymentId',
        'receiptNo',
        'amount:num',
        'reason',
        'requestedBy',
        'requestedAt',
        'approvedBy',
        'approvedAt',
        'status',
        'rejectionReason',
      ]),
      IdempotencyKeys: sheet(['key', 'scope', 'paymentId', 'receiptNo', 'usedAt']),
    },
  },

  Staff: {
    file: 'Staff.xlsx',
    scope: 'static',
    sheets: {
      Staff: sheet([
        'staffCode',
        'name',
        'designation',
        'department',
        'qualification',
        'phone',
        'email',
        'dob',
        'gender',
        'bloodGroup',
        'joiningDate',
        'leavingDate',
        'status',
        'userId',
        'address',
        'aadhaar',
        'panNo',
        'bankAccount',
        'ifsc',
        'photoFile',
        'employmentType',
      ]),
      StaffDocuments: sheet([
        'staffId',
        'docType',
        'title',
        'storedName',
        'originalName',
        'mimeType',
        'sizeBytes:num',
        'uploadedAt',
      ]),
      SalaryStructures: sheet([
        'staffId',
        'effectiveFrom',
        'basic:num',
        'hra:num',
        'da:num',
        'allowances:num',
        'pf:num',
        'professionalTax:num',
        'incomeTax:num',
        'otherDeductions:num',
        'netSalary:num',
        'status',
      ]),
      Payslips: sheet([
        'staffId',
        'month',
        'daysPresent:num',
        'daysPayable:num',
        'grossAmount:num',
        'deductions:num',
        'netAmount:num',
        'status',
        'generatedAt',
        'generatedBy',
      ]),
    },
  },

  Library: {
    file: 'Library.xlsx',
    scope: 'static',
    sheets: {
      Titles: sheet([
        'title',
        'author',
        'publisher',
        'isbn',
        'category',
        'edition',
        'language',
        'price:num',
        'shelf',
        'totalCopies:num',
        'status',
      ]),
      Copies: sheet([
        'titleId',
        'accessionNo',
        'status',
        'purchaseDate',
        'price:num',
        'condition',
        'remarks',
      ]),
      BookIssues: sheet([
        'copyId',
        'titleId',
        'accessionNo',
        'borrowerType',
        'studentId',
        'staffId',
        'issuedAt',
        'dueDate',
        'returnedAt',
        'renewCount:num',
        'status',
        'issuedBy',
        'returnedBy',
        'fineAmount:num',
      ]),
      Fines: sheet([
        'bookIssueId',
        'borrowerType',
        'studentId',
        'staffId',
        'amount:num',
        'daysOverdue:num',
        'reason',
        'status',
        'paidAt',
        'collectedBy',
        'waivedBy',
      ]),
    },
  },

  Transport: {
    file: 'Transport.xlsx',
    scope: 'static',
    sheets: {
      Routes: sheet([
        'name',
        'code',
        'description',
        'driverId',
        'vehicleId',
        'fare:num',
        'status',
      ]),
      Stops: sheet([
        'routeId',
        'name',
        'sequence:num',
        'arrivalTime',
        'departureTime',
        'landmark',
        'fare:num',
      ]),
      Vehicles: sheet([
        'regNo',
        'model',
        'capacity:num',
        'insuranceExpiry',
        'fitnessExpiry',
        'pucExpiry',
        'permitExpiry',
        'status',
      ]),
      Drivers: sheet([
        'name',
        'phone',
        'licenceNo',
        'licenceExpiry',
        'address',
        'bloodGroup',
        'status',
      ]),
      RouteAssignments: sheet([
        'studentId',
        'academicYearId',
        'routeId',
        'stopId',
        'direction',
        'fromDate',
        'toDate',
        'fare:num',
        'status',
      ]),
    },
  },

  Notices: {
    file: 'Notices.xlsx',
    scope: 'static',
    sheets: {
      Notices: sheet([
        'title',
        'body',
        'audience',
        'targetRoles:json',
        'targetClassIds:json',
        'publishFrom',
        'publishTo',
        'priority',
        'status',
        'publishedBy',
        'publishedAt',
        'attachmentFile',
      ]),
      NoticeReads: sheet(['noticeId', 'userId', 'readAt']),
    },
  },

  Imports: {
    file: 'Imports.xlsx',
    scope: 'static',
    sheets: {
      ImportBatches: sheet([
        'kind',
        'fileName',
        'storedName',
        'templateVersion',
        'uploadedBy',
        'uploadedAt',
        'totalRows:num',
        'validRows:num',
        'errorRows:num',
        'importedRows:num',
        'status',
        'committedAt',
        'committedBy',
        'error',
      ]),
      ImportErrors: sheet([
        'batchId',
        'rowNumber:num',
        'column',
        'value',
        'message',
        'severity',
      ]),
    },
  },
};

const STATIC_WORKBOOKS = Object.keys(WORKBOOKS).filter(
  (name) => WORKBOOKS[name].scope === 'static'
);
const YEAR_WORKBOOKS = Object.keys(WORKBOOKS).filter(
  (name) => WORKBOOKS[name].scope === 'year'
);

/** `Attendance` + `2026-27` -> `Attendance_2026-27`. Static books keep their key. */
function workbookKey(name, year) {
  const def = WORKBOOKS[name];
  if (!def) throw new Error(`Unknown workbook: ${name}`);
  if (def.scope !== 'year') return name;
  if (!year) throw new Error(`Workbook ${name} requires an academic year`);
  return `${name}_${year}`;
}

function parseWorkbookKey(key) {
  const idx = key.indexOf('_');
  if (idx === -1) return { name: key, year: null };
  return { name: key.slice(0, idx), year: key.slice(idx + 1) };
}

function fileNameFor(key) {
  const { name, year } = parseWorkbookKey(key);
  const def = WORKBOOKS[name];
  if (!def) throw new Error(`Unknown workbook: ${key}`);
  return def.file.replace('{year}', year || '');
}

/** Monthly sheets are created on demand, so the definition is resolved by name shape. */
function sheetDef(key, sheetName) {
  const { name } = parseWorkbookKey(key);
  const def = WORKBOOKS[name];
  if (!def) throw new Error(`Unknown workbook: ${key}`);
  if (def.sheets[sheetName]) return def.sheets[sheetName];
  if (def.monthlySheet && /^\d{4}-\d{2}$/.test(sheetName)) return def.monthlySheet;
  throw new Error(`Unknown sheet ${sheetName} in workbook ${key}`);
}

function hasSheetDef(key, sheetName) {
  try {
    sheetDef(key, sheetName);
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  WORKBOOKS,
  STATIC_WORKBOOKS,
  YEAR_WORKBOOKS,
  workbookKey,
  parseWorkbookKey,
  fileNameFor,
  sheetDef,
  hasSheetDef,
};
