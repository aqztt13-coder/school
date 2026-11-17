import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalDbError,
  localAuthenticateStudent,
  localDeleteSession,
  localGetStudentByToken,
  localListAllPublicStudents,
  localRegisterStudent,
  localUpdateStudentProfile,
  type StorageLike,
} from './localDatabase';

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

test('localDatabase handles student registration, transfer, duplicate detection, login, and updates', () => {
  const storage = createMemoryStorage();

  // Demo student login works out of the box
  const demoLogin = localAuthenticateStudent(
    { identifier: 'student@rowad.edu.sa', password: 'Rowad2026' },
    storage,
  );
  assert.equal(demoLogin.student.studentCode, 'RA-2026-101');

  // Register a brand new student
  const reg = localRegisterStudent(
    {
      fullName: 'نورة فهد الحربي',
      email: 'noura.harbi@rowad.edu.sa',
      grade: 'الثاني الثانوي',
      section: 'أ',
      track: 'علوم الحاسب والتقنية',
      guardianPhone: '0507766554',
      city: 'الرياض',
      notes: 'عضو نادي الذكاء الاصطناعي',
      password: 'Password123',
      confirmPassword: 'Password123',
    },
    storage,
  );
  assert.equal(reg.student.studentCode, 'RA-2026-104');
  assert.equal(reg.student.email, 'noura.harbi@rowad.edu.sa');

  // Duplicate email throws 409 LocalDbError
  assert.throws(
    () =>
      localRegisterStudent(
        {
          fullName: 'طالبة مكررة',
          email: 'noura.harbi@rowad.edu.sa',
          grade: 'الأول الثانوي',
          section: 'ب',
          track: 'المسار العام',
          guardianPhone: '0501112223',
          city: 'جدة',
          password: 'Password123',
          confirmPassword: 'Password123',
        },
        storage,
      ),
    (err: unknown) => err instanceof LocalDbError && err.status === 409,
  );

  // Token lookup works
  const loaded = localGetStudentByToken(reg.token, storage);
  assert.equal(loaded?.fullName, 'نورة فهد الحربي');

  // Update profile
  const updated = localUpdateStudentProfile(
    reg.token,
    {
      fullName: 'نورة فهد الحربي',
      grade: 'الثالث الثانوي',
      section: 'ب',
      track: 'العلوم الطبيعية والهندسة',
      guardianPhone: '0507766554',
      city: 'الدمام',
      notes: 'محدث',
    },
    storage,
  );
  assert.equal(updated.grade, 'الثالث الثانوي');
  assert.equal(updated.city, 'الدمام');

  // Directory list includes seeded + new student
  const list = localListAllPublicStudents(reg.token, storage);
  assert.equal(list.length, 4);

  // Logout clears token
  localDeleteSession(reg.token, storage);
  assert.equal(localGetStudentByToken(reg.token, storage), null);
});
