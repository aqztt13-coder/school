import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  authenticateStudent,
  closeStorage,
  deleteSession,
  getStorageInfo,
  getStudentByToken,
  listAllPublicStudents,
  registerStudent,
  updateStudentProfile,
} from './storage.ts';

test('SQLite storage handles registration, authentication, profile update, and duplicate checks', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowad-db-test-'));
  process.env.ROWAD_DATA_DIR = tempDir;
  process.env.ROWAD_DISABLE_LEGACY_MIGRATION = '1';
  closeStorage();

  try {
    const info = getStorageInfo();
    assert.equal(info.engine, 'sqlite');
    assert.equal(info.dataDir, tempDir);
    assert.equal(info.studentCount, 3);

    // Register a new student
    const reg = registerStudent({
      fullName: 'يوسف ناصر القحطاني',
      email: 'Yousef.N@rowad.edu.sa',
      grade: 'الثاني الثانوي',
      section: 'أ',
      track: 'علوم الحاسب والتقنية',
      guardianPhone: '0551122334',
      city: 'جدة',
      notes: 'عضو نادي البرمجة',
      password: 'Password123',
      confirmPassword: 'Password123',
    });

    assert.equal(reg.ok, true);
    if (!reg.ok) return;
    assert.equal(reg.student.email, 'yousef.n@rowad.edu.sa');
    assert.equal(reg.student.studentCode, 'RA-2026-104');
    assert.ok(reg.token.length > 20);

    // Duplicate email rejected cleanly
    const dup = registerStudent({
      fullName: 'طالب آخر',
      email: 'yousef.n@rowad.edu.sa',
      grade: 'الأول الثانوي',
      section: 'ب',
      track: 'المسار العام',
      guardianPhone: '0551122335',
      city: 'الرياض',
      password: 'Password123',
      confirmPassword: 'Password123',
    });
    assert.equal(dup.ok, false);
    if (!dup.ok) {
      assert.equal(dup.field, 'email');
    }

    // Session token lookup works
    const fromToken = getStudentByToken(reg.token);
    assert.ok(fromToken);
    assert.equal(fromToken?.fullName, 'يوسف ناصر القحطاني');

    // Profile update persists
    const updated = updateStudentProfile(reg.student.id, {
      fullName: 'يوسف ناصر القحطاني',
      grade: 'الثالث الثانوي',
      section: 'ب',
      track: 'العلوم الطبيعية والهندسة',
      guardianPhone: '0559988776',
      city: 'الدمام',
      notes: 'تم تحديث البيانات',
    });
    assert.ok(updated);
    assert.equal(updated?.grade, 'الثالث الثانوي');
    assert.equal(updated?.city, 'الدمام');

    // Re-open DB from disk to verify persistence
    closeStorage();
    const afterReopen = getStudentByToken(reg.token);
    assert.equal(afterReopen?.city, 'الدمام');
    assert.equal(listAllPublicStudents().length, 4);

    // Authenticate by student code
    const auth = authenticateStudent('RA-2026-104', 'Password123');
    assert.equal(auth.ok, true);

    // Logout removes session
    deleteSession(reg.token);
    assert.equal(getStudentByToken(reg.token), null);
  } finally {
    closeStorage();
    delete process.env.ROWAD_DATA_DIR;
    delete process.env.ROWAD_DISABLE_LEGACY_MIGRATION;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
