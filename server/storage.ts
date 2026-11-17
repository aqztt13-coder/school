import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  generateStudentCode,
  normalizeEmail,
  normalizeStudentCode,
  toPublicStudent,
  type PublicStudent,
  type RegisterInput,
  type StoredStudent,
  type UpdateProfileInput,
} from '../src/utils/studentLogic.ts';

interface StudentRow {
  id: string;
  student_code: string;
  full_name: string;
  email: string;
  grade: string;
  section: string;
  track: string;
  guardian_phone: string;
  city: string;
  notes: string;
  enrollment_status: string;
  created_at: string;
  updated_at: string;
  password_hash: string;
}

interface SessionJsonRecord {
  token: string;
  studentId: string;
  createdAt: string;
}

let dbInstance: DatabaseSync | null = null;
let activeDbPath = '';
let activeDataDir = '';

function isDirWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.rowad-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok', 'utf-8');
    fs.unlinkSync(probe);
    for (const fileName of ['rowad.db', 'rowad.db-wal', 'rowad.db-shm']) {
      const target = path.join(dir, fileName);
      if (fs.existsSync(target)) {
        fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function getCandidateDataDirs(): string[] {
  const candidates = [
    process.env.ROWAD_DATA_DIR ? path.resolve(process.env.ROWAD_DATA_DIR) : '',
    process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : '',
    path.resolve(process.cwd(), 'data'),
    path.join(os.tmpdir(), 'rowad-school-data'),
  ].filter(Boolean);

  const unique = Array.from(new Set(candidates));
  const writable = unique.filter((dir) => isDirWritable(dir));
  return writable.length > 0 ? writable : [os.tmpdir()];
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

function rowToStoredStudent(row: StudentRow): StoredStudent {
  return {
    id: row.id,
    studentCode: row.student_code,
    fullName: row.full_name,
    email: row.email,
    grade: row.grade,
    section: row.section,
    track: row.track,
    guardianPhone: row.guardian_phone,
    city: row.city,
    notes: row.notes,
    enrollmentStatus: row.enrollment_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    passwordHash: row.password_hash,
  };
}

function getDefaultSeedStudents(): StoredStudent[] {
  const now = new Date('2026-09-01T08:00:00.000Z').toISOString();
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
      createdAt: now,
      updatedAt: now,
      passwordHash: hashPassword('Rowad2026'),
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
      passwordHash: hashPassword('Rowad2026'),
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
      passwordHash: hashPassword('Rowad2026'),
    },
  ];
}

function seedOrMigrateDatabase(db: DatabaseSync, dataDir: string): void {
  const countRow = db.prepare('SELECT COUNT(*) AS count FROM students').get() as { count: number };
  if (countRow.count > 0) return;

  const insertStudent = db.prepare(`
    INSERT OR IGNORE INTO students (
      id, student_code, full_name, email, grade, section, track,
      guardian_phone, city, notes, enrollment_status, created_at, updated_at, password_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const legacyStudentsFiles = [
    path.join(dataDir, 'students.json'),
    path.resolve(process.cwd(), 'data', 'students.json'),
  ];

  let importedFromJson = false;
  if (!process.env.ROWAD_DISABLE_LEGACY_MIGRATION) {
    for (const filePath of legacyStudentsFiles) {
      if (!fs.existsSync(filePath)) continue;
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          for (const item of parsed as StoredStudent[]) {
            if (!item?.id || !item?.email || !item?.studentCode || !item?.passwordHash) continue;
            insertStudent.run(
              item.id,
              normalizeStudentCode(item.studentCode),
              String(item.fullName ?? ''),
              normalizeEmail(item.email),
              String(item.grade ?? ''),
              String(item.section ?? ''),
              String(item.track ?? ''),
              String(item.guardianPhone ?? ''),
              String(item.city ?? ''),
              String(item.notes ?? ''),
              String(item.enrollmentStatus ?? 'مقيد ومُرحّل'),
              String(item.createdAt ?? new Date().toISOString()),
              String(item.updatedAt ?? new Date().toISOString()),
              String(item.passwordHash),
            );
            importedFromJson = true;
          }
          break;
        }
      } catch {
        // Ignore corrupt legacy json and fall through to default seeds
      }
    }
  }

  for (const seed of getDefaultSeedStudents()) {
    insertStudent.run(
      seed.id,
      seed.studentCode,
      seed.fullName,
      seed.email,
      seed.grade,
      seed.section,
      seed.track,
      seed.guardianPhone,
      seed.city,
      seed.notes,
      seed.enrollmentStatus,
      seed.createdAt,
      seed.updatedAt,
      seed.passwordHash,
    );
  }

  if (importedFromJson && !process.env.ROWAD_DISABLE_LEGACY_MIGRATION) {
    const legacySessionsFiles = [
      path.join(dataDir, 'sessions.json'),
      path.resolve(process.cwd(), 'data', 'sessions.json'),
    ];
    const insertSession = db.prepare(`
      INSERT OR IGNORE INTO sessions (token, student_id, created_at)
      VALUES (?, ?, ?)
    `);
    for (const filePath of legacySessionsFiles) {
      if (!fs.existsSync(filePath)) continue;
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const session of parsed as SessionJsonRecord[]) {
            if (!session?.token || !session?.studentId) continue;
            insertSession.run(
              session.token,
              session.studentId,
              String(session.createdAt ?? new Date().toISOString()),
            );
          }
          break;
        }
      } catch {
        // Ignore corrupt legacy sessions
      }
    }
  }
}

const REQUIRED_STUDENT_COLUMNS: Record<string, string> = {
  student_code: "TEXT NOT NULL DEFAULT ''",
  full_name: "TEXT NOT NULL DEFAULT ''",
  email: "TEXT NOT NULL DEFAULT ''",
  grade: "TEXT NOT NULL DEFAULT ''",
  section: "TEXT NOT NULL DEFAULT ''",
  track: "TEXT NOT NULL DEFAULT ''",
  guardian_phone: "TEXT NOT NULL DEFAULT ''",
  city: "TEXT NOT NULL DEFAULT ''",
  notes: "TEXT NOT NULL DEFAULT ''",
  enrollment_status: "TEXT NOT NULL DEFAULT 'مقيد ومُرحّل'",
  created_at: "TEXT NOT NULL DEFAULT ''",
  updated_at: "TEXT NOT NULL DEFAULT ''",
  password_hash: "TEXT NOT NULL DEFAULT ''",
};

const REQUIRED_SESSION_COLUMNS: Record<string, string> = {
  student_id: "TEXT NOT NULL DEFAULT ''",
  created_at: "TEXT NOT NULL DEFAULT ''",
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isCorruptionError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes('malformed') ||
    msg.includes('not a database') ||
    msg.includes('file is encrypted') ||
    msg.includes('disk image')
  );
}

/**
 * A leftover "-wal" / "-shm" file without its main database (or left over from a different
 * database file) makes SQLite fail or behave unpredictably. Move such files aside (never delete,
 * so no data is lost) before opening the database.
 */
function quarantineOrphanedJournalFiles(dbPath: string): void {
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) return;
  const stamp = Date.now();
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const side = `${dbPath}${suffix}`;
    if (!fs.existsSync(side)) continue;
    try {
      fs.renameSync(side, `${side}.orphan-${stamp}`);
      console.warn(`[storage] Moved orphaned SQLite file aside: ${side}`);
    } catch {
      try {
        fs.unlinkSync(side);
      } catch {
        // Ignore: opening will surface a real error if this still blocks us
      }
    }
  }
}

function quarantineDatabaseFiles(dbPath: string): void {
  const stamp = Date.now();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const file = `${dbPath}${suffix}`;
    if (!fs.existsSync(file)) continue;
    try {
      fs.renameSync(file, `${file}.corrupt-${stamp}`);
    } catch {
      try {
        fs.unlinkSync(file);
      } catch {
        // Ignore
      }
    }
  }
  console.warn(`[storage] Unreadable database was moved aside: ${dbPath}.corrupt-${stamp}`);
}

function ensureColumns(db: DatabaseSync, table: string, required: Record<string, string>): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [column, definition] of Object.entries(required)) {
    if (!existing.has(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.warn(`[storage] Added missing column ${table}.${column} (old database schema)`);
    }
  }
}

function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      student_code TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      grade TEXT NOT NULL,
      section TEXT NOT NULL,
      track TEXT NOT NULL,
      guardian_phone TEXT NOT NULL,
      city TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      enrollment_status TEXT NOT NULL DEFAULT 'مقيد ومُرحّل',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    );
  `);

  // Databases created by an older version may lack columns, which only breaks INSERTs
  // (i.e. registration) while login/read keeps working.
  ensureColumns(db, 'students', REQUIRED_STUDENT_COLUMNS);
  ensureColumns(db, 'sessions', REQUIRED_SESSION_COLUMNS);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_students_email ON students(email);
    CREATE INDEX IF NOT EXISTS idx_students_code ON students(student_code);
    CREATE INDEX IF NOT EXISTS idx_sessions_student_id ON sessions(student_id);
  `);
}

function openDatabaseAt(dataDir: string): { db: DatabaseSync; dbPath: string } {
  const dbPath = path.join(dataDir, 'rowad.db');

  for (let attempt = 0; attempt < 2; attempt++) {
    quarantineOrphanedJournalFiles(dbPath);
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA busy_timeout = 5000;');
      try {
        db.exec('PRAGMA journal_mode = WAL;');
      } catch {
        // WAL mode may be unsupported on some virtual filesystems; default journal mode works
      }
      db.exec('PRAGMA foreign_keys = ON;');

      initializeSchema(db);

      // Prove the database is really writable now, so we fail here (and can fall back to
      // another location) instead of at the moment a student presses "register".
      db.exec('BEGIN IMMEDIATE;');
      db.exec('ROLLBACK;');

      seedOrMigrateDatabase(db, dataDir);
      return { db, dbPath };
    } catch (err) {
      try {
        db?.close();
      } catch {
        // Ignore close errors
      }
      if (attempt === 0 && fs.existsSync(dbPath) && isCorruptionError(err)) {
        console.error('[storage] Database file is corrupt, recreating it:', errorMessage(err));
        quarantineDatabaseFiles(dbPath);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unable to open database');
}

function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;

  let lastError: unknown = null;
  for (const dataDir of getCandidateDataDirs()) {
    try {
      const { db, dbPath } = openDatabaseAt(dataDir);
      dbInstance = db;
      activeDataDir = dataDir;
      activeDbPath = dbPath;
      return db;
    } catch (err) {
      lastError = err;
      console.error(`[storage] Cannot use database in ${dataDir}:`, errorMessage(err));
    }
  }

  throw lastError ?? new Error('No writable location found for the database');
}

export function getStorageInfo(): { engine: 'sqlite'; dataDir: string; dbPath: string; studentCount: number } {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS count FROM students').get() as { count: number };
  return {
    engine: 'sqlite',
    dataDir: activeDataDir,
    dbPath: activeDbPath,
    studentCount: row.count,
  };
}

export function closeStorage(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    activeDataDir = '';
    activeDbPath = '';
  }
}

export function createSession(studentId: string): string {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, student_id, created_at) VALUES (?, ?, ?)').run(
    token,
    studentId,
    new Date().toISOString(),
  );
  return token;
}

export function deleteSession(token: string): void {
  if (!token) return;
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function getStudentByToken(token: string): PublicStudent | null {
  if (!token) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT st.*
       FROM sessions se
       INNER JOIN students st ON st.id = se.student_id
       WHERE se.token = ?`,
    )
    .get(token) as StudentRow | undefined;

  return row ? toPublicStudent(rowToStoredStudent(row)) : null;
}

function registerStudentOnce(input: RegisterInput): {
  ok: true;
  student: PublicStudent;
  token: string;
} | {
  ok: false;
  error: string;
  field?: string;
} {
  const db = getDb();
  const email = normalizeEmail(input.email);

  db.exec('BEGIN IMMEDIATE;');
  try {
    const existingEmail = db
      .prepare('SELECT id FROM students WHERE lower(email) = ?')
      .get(email) as { id: string } | undefined;

    if (existingEmail) {
      db.exec('ROLLBACK;');
      return {
        ok: false,
        error: 'هذا البريد الإلكتروني مسجل مسبقاً في منصة المدرسة.',
        field: 'email',
      };
    }

    let studentCode = input.studentCode ? normalizeStudentCode(input.studentCode) : '';
    if (studentCode) {
      const existingCode = db
        .prepare('SELECT id FROM students WHERE upper(student_code) = ?')
        .get(studentCode) as { id: string } | undefined;
      if (existingCode) {
        db.exec('ROLLBACK;');
        return {
          ok: false,
          error: 'الرقم المدرسي المدخل مسجل لطالب آخر.',
          field: 'studentCode',
        };
      }
    } else {
      const codeRows = db.prepare('SELECT student_code FROM students').all() as Array<{
        student_code: string;
      }>;
      studentCode = generateStudentCode(codeRows.map((r) => String(r.student_code).toUpperCase()));
    }

    const now = new Date().toISOString();
    const newRecord: StoredStudent = {
      id: `stu-${crypto.randomUUID()}`,
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
      passwordHash: hashPassword(input.password),
    };

    db.prepare(
      `INSERT INTO students (
        id, student_code, full_name, email, grade, section, track,
        guardian_phone, city, notes, enrollment_status, created_at, updated_at, password_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newRecord.id,
      newRecord.studentCode,
      newRecord.fullName,
      newRecord.email,
      newRecord.grade,
      newRecord.section,
      newRecord.track,
      newRecord.guardianPhone,
      newRecord.city,
      newRecord.notes,
      newRecord.enrollmentStatus,
      newRecord.createdAt,
      newRecord.updatedAt,
      newRecord.passwordHash,
    );

    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, student_id, created_at) VALUES (?, ?, ?)').run(
      token,
      newRecord.id,
      now,
    );

    db.exec('COMMIT;');
    return {
      ok: true,
      student: toPublicStudent(newRecord),
      token,
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Ignore rollback errors
    }
    throw err;
  }
}

type RegisterResult =
  | { ok: true; student: PublicStudent; token: string }
  | { ok: false; error: string; field?: string };

function uniqueViolation(err: unknown): 'email' | 'studentCode' | 'other' | null {
  const msg = errorMessage(err);
  if (!msg.includes('UNIQUE constraint failed')) return null;
  if (msg.includes('students.email')) return 'email';
  if (msg.includes('students.student_code')) return 'studentCode';
  return 'other';
}

function isBusyError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return msg.includes('database is locked') || msg.includes('busy');
}

export function registerStudent(input: RegisterInput): RegisterResult {
  const autoCode = !input.studentCode;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return registerStudentOnce(input);
    } catch (err) {
      lastError = err;
      const violation = uniqueViolation(err);
      if (violation === 'email') {
        return {
          ok: false,
          error: 'هذا البريد الإلكتروني مسجل مسبقاً في منصة المدرسة.',
          field: 'email',
        };
      }
      if (violation === 'studentCode') {
        if (autoCode) continue; // someone took the generated number first: generate a new one
        return {
          ok: false,
          error: 'الرقم المدرسي المدخل مسجل لطالب آخر.',
          field: 'studentCode',
        };
      }
      if (isBusyError(err)) continue;
      throw err;
    }
  }
  throw lastError;
}

export function authenticateStudent(identifier: string, password: string): {
  ok: true;
  student: PublicStudent;
  token: string;
} | {
  ok: false;
  error: string;
} {
  const db = getDb();
  const normalizedId = identifier.trim().toLowerCase();
  const row = db
    .prepare(
      `SELECT * FROM students
       WHERE lower(email) = ? OR lower(student_code) = ?
       LIMIT 1`,
    )
    .get(normalizedId, normalizedId) as StudentRow | undefined;

  if (!row || !verifyPassword(password, row.password_hash)) {
    return {
      ok: false,
      error: 'بيانات الدخول غير صحيحة. تأكد من البريد الإلكتروني أو الرقم المدرسي وكلمة المرور.',
    };
  }

  const student = rowToStoredStudent(row);
  const token = createSession(student.id);
  return {
    ok: true,
    student: toPublicStudent(student),
    token,
  };
}

export function updateStudentProfile(
  studentId: string,
  updates: UpdateProfileInput,
): PublicStudent | null {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `UPDATE students
       SET full_name = ?,
           grade = ?,
           section = ?,
           track = ?,
           guardian_phone = ?,
           city = ?,
           notes = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      updates.fullName.trim(),
      updates.grade.trim(),
      updates.section.trim(),
      updates.track.trim(),
      updates.guardianPhone.trim(),
      updates.city.trim(),
      updates.notes.trim(),
      now,
      studentId,
    );

  if (result.changes === 0) return null;

  const row = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId) as
    | StudentRow
    | undefined;
  return row ? toPublicStudent(rowToStoredStudent(row)) : null;
}

export function listAllPublicStudents(): PublicStudent[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM students ORDER BY created_at DESC, rowid DESC')
    .all() as unknown as StudentRow[];
  return rows.map((row) => toPublicStudent(rowToStoredStudent(row)));
}
