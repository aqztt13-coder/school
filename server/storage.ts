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
    return true;
  } catch {
    return false;
  }
}

function resolveWritableDataDir(): string {
  const candidates = [
    process.env.ROWAD_DATA_DIR ? path.resolve(process.env.ROWAD_DATA_DIR) : '',
    process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : '',
    path.resolve(process.cwd(), 'data'),
    path.join(os.tmpdir(), 'rowad-school-data'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (isDirWritable(candidate)) {
      return candidate;
    }
  }

  return os.tmpdir();
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

function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;

  const dataDir = resolveWritableDataDir();
  const dbPath = path.join(dataDir, 'rowad.db');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch {
    // WAL mode may be unsupported on some virtual filesystems; default journal mode works
  }

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

    CREATE INDEX IF NOT EXISTS idx_students_email ON students(email);
    CREATE INDEX IF NOT EXISTS idx_students_code ON students(student_code);
    CREATE INDEX IF NOT EXISTS idx_sessions_student_id ON sessions(student_id);
  `);

  seedOrMigrateDatabase(db, dataDir);

  dbInstance = db;
  activeDataDir = dataDir;
  activeDbPath = dbPath;
  return db;
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

export function registerStudent(input: RegisterInput): {
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
      studentCode = generateStudentCode(codeRows.map((r) => r.student_code));
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
