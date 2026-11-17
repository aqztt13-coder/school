import type {
  LoginInput,
  PublicStudent,
  RegisterInput,
  UpdateProfileInput,
} from './studentLogic';
import {
  LocalDbError,
  hydrateLocalDbFromIndexedDb,
  localAuthenticateStudent,
  localDeleteSession,
  localGetStudentByToken,
  localListAllPublicStudents,
  localRegisterStudent,
  localUpdateStudentProfile,
  mirrorServerStudentIntoLocalDb,
} from './localDatabase';

const TOKEN_STORAGE_KEY = 'rowad_auth_token';
const CACHED_STUDENT_KEY = 'rowad_cached_student';
const CACHED_STUDENTS_KEY = 'rowad_cached_students';

export function getStoredToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setStoredToken(token: string): void {
  try {
    if (token) {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota/access errors
  }
}

function readCachedJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeCachedJson(key: string, value: unknown): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // Ignore storage errors
  }
}

export class ApiError extends Error {
  status: number;
  fieldErrors: Record<string, string>;

  constructor(message: string, status: number, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function mapLocalError(err: unknown): never {
  if (err instanceof LocalDbError) {
    throw new ApiError(err.message, err.status, err.fieldErrors);
  }
  throw err;
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      credentials: 'include',
    });
  } catch {
    throw new BackendUnavailableError('Network or offline failure');
  }

  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.json().catch(() => null);

  if (!response.ok) {
    // When running on static hosting (e.g. shared preview without Express server),
    // API endpoints return non-JSON 404/405/501/502/503/504 responses.
    if (
      !data &&
      (response.status === 404 ||
        response.status === 405 ||
        response.status === 501 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504)
    ) {
      throw new BackendUnavailableError(`Backend endpoint returned ${response.status}`);
    }

    const fallbackMsg =
      response.status >= 500
        ? 'حدث خطأ في قاعدة البيانات أو الخادم. يرجى المحاولة مرة أخرى.'
        : 'حدث خطأ أثناء الاتصال بالخادم.';
    throw new ApiError(
      data && typeof data.error === 'string' ? data.error : fallbackMsg,
      response.status,
      data && typeof data.fieldErrors === 'object' && data.fieldErrors ? data.fieldErrors : {},
    );
  }

  if (!data || typeof data !== 'object') {
    throw new BackendUnavailableError('Non-JSON 200 response from static fallback');
  }
  return data as T;
}

export async function loginStudentApi(
  payload: LoginInput,
): Promise<{ student: PublicStudent; token: string }> {
  await hydrateLocalDbFromIndexedDb();
  try {
    const result = await apiRequest<{ student: PublicStudent; token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setStoredToken(result.token);
    writeCachedJson(CACHED_STUDENT_KEY, result.student);
    mirrorServerStudentIntoLocalDb(result.student, result.token);
    return result;
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      try {
        const localResult = localAuthenticateStudent(payload);
        setStoredToken(localResult.token);
        writeCachedJson(CACHED_STUDENT_KEY, localResult.student);
        return localResult;
      } catch (localErr) {
        mapLocalError(localErr);
      }
    }
    throw err;
  }
}

export async function registerStudentApi(
  payload: RegisterInput,
): Promise<{ student: PublicStudent; token: string }> {
  await hydrateLocalDbFromIndexedDb();
  try {
    const result = await apiRequest<{ student: PublicStudent; token: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setStoredToken(result.token);
    writeCachedJson(CACHED_STUDENT_KEY, result.student);
    mirrorServerStudentIntoLocalDb(result.student, result.token);
    return result;
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      try {
        const localResult = localRegisterStudent(payload);
        setStoredToken(localResult.token);
        writeCachedJson(CACHED_STUDENT_KEY, localResult.student);
        return localResult;
      } catch (localErr) {
        mapLocalError(localErr);
      }
    }
    throw err;
  }
}

export async function fetchCurrentStudentApi(): Promise<PublicStudent | null> {
  await hydrateLocalDbFromIndexedDb();
  const token = getStoredToken();
  if (token.startsWith('local-')) {
    const localStudent = localGetStudentByToken(token);
    if (localStudent) {
      writeCachedJson(CACHED_STUDENT_KEY, localStudent);
      return localStudent;
    }
    setStoredToken('');
    writeCachedJson(CACHED_STUDENT_KEY, null);
    return null;
  }

  try {
    const result = await apiRequest<{ student: PublicStudent | null }>('/api/auth/me');
    if (!result.student) {
      setStoredToken('');
      writeCachedJson(CACHED_STUDENT_KEY, null);
      return null;
    }
    writeCachedJson(CACHED_STUDENT_KEY, result.student);
    mirrorServerStudentIntoLocalDb(result.student, token);
    return result.student;
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    if (token) {
      const localStudent = localGetStudentByToken(token);
      if (localStudent) return localStudent;
      return readCachedJson<PublicStudent>(CACHED_STUDENT_KEY);
    }
    return null;
  }
}

export async function updateCurrentStudentApi(
  payload: UpdateProfileInput,
): Promise<PublicStudent> {
  await hydrateLocalDbFromIndexedDb();
  const token = getStoredToken();
  if (token.startsWith('local-')) {
    try {
      const updated = localUpdateStudentProfile(token, payload);
      writeCachedJson(CACHED_STUDENT_KEY, updated);
      return updated;
    } catch (localErr) {
      mapLocalError(localErr);
    }
  }

  try {
    const result = await apiRequest<{ student: PublicStudent }>('/api/students/me', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    writeCachedJson(CACHED_STUDENT_KEY, result.student);
    mirrorServerStudentIntoLocalDb(result.student, token);
    return result.student;
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      try {
        const updated = localUpdateStudentProfile(token, payload);
        writeCachedJson(CACHED_STUDENT_KEY, updated);
        return updated;
      } catch (localErr) {
        mapLocalError(localErr);
      }
    }
    throw err;
  }
}

export async function fetchAllStudentsApi(): Promise<PublicStudent[]> {
  await hydrateLocalDbFromIndexedDb();
  const token = getStoredToken();
  if (token.startsWith('local-')) {
    try {
      const list = localListAllPublicStudents(token);
      writeCachedJson(CACHED_STUDENTS_KEY, list);
      return list;
    } catch (localErr) {
      mapLocalError(localErr);
    }
  }

  try {
    const result = await apiRequest<{ students: PublicStudent[] }>('/api/students');
    writeCachedJson(CACHED_STUDENTS_KEY, result.students);
    return result.students;
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      try {
        const list = localListAllPublicStudents(token);
        writeCachedJson(CACHED_STUDENTS_KEY, list);
        return list;
      } catch {
        const cached = readCachedJson<PublicStudent[]>(CACHED_STUDENTS_KEY);
        if (cached) return cached;
      }
    }
    if (err instanceof ApiError) {
      throw err;
    }
    const cached = readCachedJson<PublicStudent[]>(CACHED_STUDENTS_KEY);
    if (cached) return cached;
    throw err;
  }
}

export async function logoutStudentApi(): Promise<void> {
  const token = getStoredToken();
  try {
    if (!token.startsWith('local-')) {
      await apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
    }
  } catch {
    // Always complete logout locally even if server/network is unavailable
  } finally {
    localDeleteSession(token);
    setStoredToken('');
    writeCachedJson(CACHED_STUDENT_KEY, null);
    writeCachedJson(CACHED_STUDENTS_KEY, null);
  }
}
