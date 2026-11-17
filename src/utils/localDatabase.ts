import {
  generateStudentCode,
  normalizeEmail,
  normalizeStudentCode,
  toPublicStudent,
  validateLoginInput,
  validateProfileUpdate,
  validateRegisterInput,
  type LoginInput,
  type PublicStudent,
  type RegisterInput,
  type StoredStudent,
  type UpdateProfileInput,
} from './studentLogic';

const LOCAL_STUDENTS_KEY = 'rowad_local_db_students_v1';
const LOCAL_SESSIONS_KEY = 'rowad_local_db_sessions_v1';
const IDB_NAME = 'rowad_al_alam_local_db';
const IDB_STORE = 'kv';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface LocalSession {
  token: string;
  studentId: string;
  createdAt: string;
}

export class LocalDbError extends Error {
  status: number;
  fieldErrors: Record<string, string>;

  constructor(message: string, status: number, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

function getBrowserStorage(): StorageLike {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  throw new Error('Local storage is unavailable outside browser context without an explicit adapter.');
}

// Fast FNV-1a + salted digest fallback that works synchronously in any browser/HTTP context (including non-HTTPS where crypto.subtle may be unavailable)
function hashLocalPassword(password: string, existingSalt?: string): string {
  const salt =
    existingSalt ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const input = `${salt}::${password}::rowad-al-alam`;
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + i;
    h2 = Math.imul(h2, 0x01000193);
  }
  const digest = `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
  return `local:${salt}:${digest}`;
}

function verifyLocalPassword(password: string, storedHash: string): boolean {
  if (storedHash.startsWith('local:')) {
    const [, salt] = storedHash.split(':');
    if (!salt) return false;
    return hashLocalPassword(password, salt) === storedHash;
  }
  return false;
}

function getDefaultLocalStudents(): StoredStudent[] {
  const demoHash = hashLocalPassword('Rowad2026', 'seed-rowad-2026');
  return [
    {
      id: 'stu-seed-101',
      studentCode: 'RA-2026-101',
      fullName: 'أحمد خالد المنصور',
      email: 'student@rowad.edu.sa',
      grade: 'الثالث الثانوي',
      section: 'أ',
      track: 'العلوم الطبيعية والهندسة',
      guardianPhone: '0501234567',
      city: 'الرياض',
      notes: 'مشارك في نادي الروبوت والابتكار العلمي.',
      enrollmentStatus: 'مقيد ومُرحّل',
      createdAt: '2026-09-01T08:00:00.000Z',
      updatedAt: '2026-09-01T08:00:00.000Z',
      passwordHash: demoHash,
    },
    {
      id: 'stu-seed-102',
      studentCode: 'RA-2026-102',
      fullName: 'سارة فهد الدوسري',
      email: 'sara.fahad@rowad.edu.sa',
      grade: 'الثاني الثانوي',
      section: 'ب',
      track: 'علوم الحاسب والتقنية',
      guardianPhone: '0554321987',
      city: 'الرياض',
      notes: 'عضو فريق الأولمبياد الوطني للبرمجة.',
      enrollmentStatus: 'مقيد ومُرحّل',
      createdAt: '2026-09-03T09:15:00.000Z',
      updatedAt: '2026-09-03T09:15:00.000Z',
      passwordHash: demoHash,
    },
    {
      id: 'stu-seed-103',
      studentCode: 'RA-2026-103',
      fullName: 'عمر عبد الله السبيعي',
      email: 'omar.abdullah@rowad.edu.sa',
      grade: 'الأول الثانوي',
      section: 'ج',
      track: 'المسار العام',
      guardianPhone: '0548765432',
      city: 'الدمام',
      notes: 'منسق الأنشطة الثقافية للصف الأول الثانوي.',
      enrollmentStatus: 'مقيد ومُرحّل',
      createdAt: '2026-09-05T10:30:00.000Z',
      updatedAt: '2026-09-05T10:30:00.000Z',
      passwordHash: demoHash,
    },
  ];
}

function syncToIndexedDb(key: string, json: string): void {
  if (typeof indexedDB === 'undefined') return;
  try {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => {
      try {
        const db = req.result;
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(json, key);
        tx.oncomplete = () => db.close();
      } catch {
        // Ignore IndexedDB quota/privacy errors
      }
    };
  } catch {
    // Ignore IndexedDB errors
  }
}

export function hydrateLocalDbFromIndexedDb(): Promise<void> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onerror = () => resolve();
      req.onsuccess = () => {
        try {
          const db = req.result;
          const tx = db.transaction(IDB_STORE, 'readonly');
          const store = tx.objectStore(IDB_STORE);
          const getStudents = store.get(LOCAL_STUDENTS_KEY);
          const getSessions = store.get(LOCAL_SESSIONS_KEY);
          tx.oncomplete = () => {
            try {
              if (!window.localStorage.getItem(LOCAL_STUDENTS_KEY) && typeof getStudents.result === 'string') {
                window.localStorage.setItem(LOCAL_STUDENTS_KEY, getStudents.result);
              }
              if (!window.localStorage.getItem(LOCAL_SESSIONS_KEY) && typeof getSessions.result === 'string') {
                window.localStorage.setItem(LOCAL_SESSIONS_KEY, getSessions.result);
              }
            } catch {
              // Ignore localStorage access errors
            }
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            resolve();
          };
        } catch {
          resolve();
        }
      };
    } catch {
      resolve();
    }
  });
}

function readStudents(storage: StorageLike): StoredStudent[] {
  const raw = storage.getItem(LOCAL_STUDENTS_KEY);
  if (!raw) {
    const seeded = getDefaultLocalStudents();
    writeStudents(storage, seeded);
    return seeded;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed as StoredStudent[];
    }
  } catch {
    // Re-seed if corrupted
  }
  const seeded = getDefaultLocalStudents();
  writeStudents(storage, seeded);
  return seeded;
}

function writeStudents(storage: StorageLike, students: StoredStudent[]): void {
  const serialized = JSON.stringify(students);
  storage.setItem(LOCAL_STUDENTS_KEY, serialized);
  syncToIndexedDb(LOCAL_STUDENTS_KEY, serialized);
}

function readSessions(storage: StorageLike): LocalSession[] {
  const raw = storage.getItem(LOCAL_SESSIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LocalSession[]) : [];
  } catch {
    return [];
  }
}

function writeSessions(storage: StorageLike, sessions: LocalSession[]): void {
  const serialized = JSON.stringify(sessions);
  storage.setItem(LOCAL_SESSIONS_KEY, serialized);
  syncToIndexedDb(LOCAL_SESSIONS_KEY, serialized);
}

function createLocalToken(storage: StorageLike, studentId: string): string {
  const token = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  const sessions = readSessions(storage);
  sessions.push({
    token,
    studentId,
    createdAt: new Date().toISOString(),
  });
  writeSessions(storage, sessions);
  return token;
}

export function localRegisterStudent(
  input: RegisterInput,
  storage: StorageLike = getBrowserStorage(),
): { student: PublicStudent; token: string } {
  const validation = validateRegisterInput(input);
  if (!validation.valid) {
    throw new LocalDbError('يرجى التحقق من الحقول المطلوبة.', 400, validation.errors);
  }

  const students = readStudents(storage);
  const email = normalizeEmail(input.email);

  if (students.some((s) => normalizeEmail(s.email) === email)) {
    throw new LocalDbError('هذا البريد الإلكتروني مسجل مسبقاً في منصة المدرسة.', 409, {
      email: 'هذا البريد الإلكتروني مسجل مسبقاً في منصة المدرسة.',
    });
  }

  let studentCode = input.studentCode ? normalizeStudentCode(input.studentCode) : '';
  if (studentCode) {
    if (students.some((s) => normalizeStudentCode(s.studentCode) === studentCode)) {
      throw new LocalDbError('الرقم المدرسي المدخل مسجل لطالب آخر.', 409, {
        studentCode: 'الرقم المدرسي المدخل مسجل لطالب آخر.',
      });
    }
  } else {
    studentCode = generateStudentCode(students.map((s) => s.studentCode));
  }

  const now = new Date().toISOString();
  const newRecord: StoredStudent = {
    id: `stu-local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    studentCode,
    fullName: input.fullName.trim(),
    email,
    grade: input.grade.trim(),
    section: input.section.trim(),
    track: input.track.trim(),
    guardianPhone: input.guardianPhone.trim(),
    city: input.city.trim(),
    notes: (input.notes ?? '').trim(),
    enrollmentStatus: 'مقيد ومُرحّل',
    createdAt: now,
    updatedAt: now,
    passwordHash: hashLocalPassword(input.password),
  };

  students.unshift(newRecord);
  writeStudents(storage, students);
  const token = createLocalToken(storage, newRecord.id);

  return {
    student: toPublicStudent(newRecord),
    token,
  };
}

export function localAuthenticateStudent(
  input: LoginInput,
  storage: StorageLike = getBrowserStorage(),
): { student: PublicStudent; token: string } {
  const validation = validateLoginInput(input);
  if (!validation.valid) {
    throw new LocalDbError('يرجى إدخال بيانات تسجيل الدخول كاملة.', 400, validation.errors);
  }

  const students = readStudents(storage);
  const normalizedId = input.identifier.trim().toLowerCase();
  const match = students.find(
    (s) =>
      normalizeEmail(s.email) === normalizedId ||
      s.studentCode.toLowerCase() === normalizedId,
  );

  if (!match || !verifyLocalPassword(input.password, match.passwordHash)) {
    throw new LocalDbError(
      'بيانات الدخول غير صحيحة. تأكد من البريد الإلكتروني أو الرقم المدرسي وكلمة المرور.',
      401,
    );
  }

  const token = createLocalToken(storage, match.id);
  return {
    student: toPublicStudent(match),
    token,
  };
}

export function localGetStudentByToken(
  token: string,
  storage: StorageLike = getBrowserStorage(),
): PublicStudent | null {
  if (!token) return null;
  const session = readSessions(storage).find((s) => s.token === token);
  if (!session) return null;
  const student = readStudents(storage).find((s) => s.id === session.studentId);
  return student ? toPublicStudent(student) : null;
}

export function localUpdateStudentProfile(
  token: string,
  updates: UpdateProfileInput,
  storage: StorageLike = getBrowserStorage(),
): PublicStudent {
  const current = localGetStudentByToken(token, storage);
  if (!current) {
    throw new LocalDbError('غير مصرح. يرجى تسجيل الدخول.', 401);
  }

  const validation = validateProfileUpdate(updates);
  if (!validation.valid) {
    throw new LocalDbError('يرجى تصحيح البيانات المدخلة.', 400, validation.errors);
  }

  const students = readStudents(storage);
  const idx = students.findIndex((s) => s.id === current.id);
  if (idx === -1) {
    throw new LocalDbError('لم يتم العثور على سجل الطالب.', 404);
  }

  const updated: StoredStudent = {
    ...students[idx],
    fullName: updates.fullName.trim(),
    grade: updates.grade.trim(),
    section: updates.section.trim(),
    track: updates.track.trim(),
    guardianPhone: updates.guardianPhone.trim(),
    city: updates.city.trim(),
    notes: updates.notes.trim(),
    updatedAt: new Date().toISOString(),
  };

  students[idx] = updated;
  writeStudents(storage, students);
  return toPublicStudent(updated);
}

export function localListAllPublicStudents(
  token: string,
  storage: StorageLike = getBrowserStorage(),
): PublicStudent[] {
  const current = localGetStudentByToken(token, storage);
  if (!current) {
    throw new LocalDbError('غير مصرح. يرجى تسجيل الدخول.', 401);
  }
  return readStudents(storage).map(toPublicStudent);
}

export function localDeleteSession(
  token: string,
  storage: StorageLike = getBrowserStorage(),
): void {
  if (!token) return;
  const next = readSessions(storage).filter((s) => s.token !== token);
  writeSessions(storage, next);
}

export function mirrorServerStudentIntoLocalDb(
  student: PublicStudent,
  token: string,
  storage: StorageLike = getBrowserStorage(),
): void {
  try {
    const students = readStudents(storage);
    const existingIdx = students.findIndex((s) => s.id === student.id || normalizeEmail(s.email) === normalizeEmail(student.email));
    const merged: StoredStudent = {
      ...student,
      passwordHash: existingIdx >= 0 ? students[existingIdx].passwordHash : hashLocalPassword('Rowad2026', 'mirror'),
    };
    if (existingIdx >= 0) {
      students[existingIdx] = merged;
    } else {
      students.unshift(merged);
    }
    writeStudents(storage, students);
    if (token) {
      const sessions = readSessions(storage);
      if (!sessions.some((s) => s.token === token)) {
        sessions.push({ token, studentId: merged.id, createdAt: new Date().toISOString() });
        writeSessions(storage, sessions);
      }
    }
  } catch {
    // Ignore mirror errors
  }
}
