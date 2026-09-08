import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  indexedDBLocalPersistence
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

// Configure robust persistence for Safari and cross-platform browsers
try {
  setPersistence(auth, browserLocalPersistence).catch(() => {
    setPersistence(auth, indexedDBLocalPersistence).catch(() => {
      setPersistence(auth, browserSessionPersistence).catch(console.warn);
    });
  });
} catch (e) {
  console.warn("Persistence setup error:", e);
}

export const googleProvider = new GoogleAuthProvider();
export const GOOGLE_REDIRECT_PENDING_KEY = 'masrofi_google_redirect_pending';

function markGoogleRedirectPending() {
  try {
    localStorage.setItem(GOOGLE_REDIRECT_PENDING_KEY, JSON.stringify({ startedAt: Date.now() }));
  } catch (e) {
    console.warn('Could not mark Google redirect pending:', e);
  }
}

export function clearGoogleRedirectPending() {
  try {
    localStorage.removeItem(GOOGLE_REDIRECT_PENDING_KEY);
  } catch (e) {
    console.warn('Could not clear Google redirect pending:', e);
  }
}

export function isGoogleRedirectPending(maxAgeMs = 120_000): boolean {
  try {
    const raw = localStorage.getItem(GOOGLE_REDIRECT_PENDING_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    const startedAt = Number(parsed?.startedAt || 0);
    if (!startedAt || Date.now() - startedAt > maxAgeMs) {
      clearGoogleRedirectPending();
      return false;
    }
    return true;
  } catch (e) {
    console.warn('Could not read Google redirect pending state:', e);
    return false;
  }
}

/**
 * Safari/Mobile login uses Firebase's provider-controlled redirect flow.
 * The client never asks our server to mint an identity from an email address.
 * Google/Firebase performs the identity proof, and onAuthStateChanged restores
 * the authenticated user after the browser returns from the redirect.
 */
export const loginWithSafariDirect = async (_email?: string): Promise<{ success: boolean; user?: any; error?: string }> => {
  try {
    clearGoogleRedirectPending();
    // Do not use redirect on Safari here. Keeping signInWithPopup as the first
    // awaited auth action preserves the user's click gesture and avoids the
    // redirect/session loop seen on iOS Safari.
    const result = await signInWithPopup(auth, googleProvider);
    return { success: true, user: result.user };
  } catch (err: any) {
    console.error("Safari popup login error:", err);
    let errorMessage = err?.message || "فشل بدء تسجيل الدخول الآمن بواسطة Google";
    if (err?.code === 'auth/popup-blocked') {
      errorMessage = "حظر Safari نافذة Google. اضغط زر Google مرة واحدة مباشرة بعد تحميل الصفحة، أو افتح الموقع من Safari وليس من داخل تطبيق آخر.";
    }
    return { success: false, error: errorMessage };
  }
};

function shouldUseRedirectLogin(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const vendor = navigator.vendor || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1);
  const isSafari = /Safari/i.test(ua) && /Apple/i.test(vendor) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  return isIOS || isSafari;
}

export const loginWithGoogle = async (): Promise<{ success: boolean; user?: any; redirecting?: boolean; error?: string }> => {
  try {
    clearGoogleRedirectPending();
    if (shouldUseRedirectLogin()) {
      // On Safari/iOS, do not await anything before opening the popup; otherwise
      // Safari loses the user gesture and blocks the window or redirect loops.
      const result = await signInWithPopup(auth, googleProvider);
      return { success: true, user: result.user };
    }
    await setPersistence(auth, browserLocalPersistence);
    const result = await signInWithPopup(auth, googleProvider);
    return { success: true, user: result.user };
  } catch (error: any) {
    console.warn("Google login error:", error);
    let errorMessage = "تعذر تسجيل الدخول بواسطة Google";
    if (error.code === 'auth/popup-blocked') {
      try {
        markGoogleRedirectPending();
        await signInWithRedirect(auth, googleProvider);
        return { success: true, redirecting: true };
      } catch (redirectErr: any) {
        errorMessage = redirectErr?.message || "حظر المتصفح النافذة المنبثقة وتعذر بدء تحويل تسجيل الدخول.";
      }
    } else if (error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') {
      errorMessage = "تم إغلاق نافذة تسجيل الدخول قبل إتمام العملية.";
    } else if (error.code === 'auth/network-request-failed') {
      errorMessage = "تعذر الاتصال بالشبكة، يرجى التحقق من اتصال الإنترنت.";
    } else if (error.message) {
      errorMessage = error.message;
    }
    return { success: false, error: errorMessage };
  }
};

export const completeGoogleRedirectLogin = async (): Promise<{ success: boolean; user?: any; error?: string }> => {
  try {
    await setPersistence(auth, browserLocalPersistence);
    const result = await getRedirectResult(auth);
    if (result?.user) clearGoogleRedirectPending();
    return result?.user ? { success: true, user: result.user } : { success: true };
  } catch (error: any) {
    console.warn("Google redirect result error:", error);
    return { success: false, error: error?.message || "تعذر إكمال تسجيل الدخول بعد الرجوع من Google" };
  }
};

export const logout = async () => {
  try {
    localStorage.removeItem('masrofi_direct_session');
    await signOut(auth);
  } catch (error) {
    localStorage.removeItem('masrofi_direct_session');
    console.error("Logout failed", error);
  }
};

