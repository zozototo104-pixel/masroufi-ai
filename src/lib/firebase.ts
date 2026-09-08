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
 * Safari/Mobile direct email login.
 * This path must not open Google. It creates the app's local direct session that
 * App.tsx already knows how to restore from masrofi_direct_session.
 */
export const loginWithSafariDirect = async (email?: string): Promise<{ success: boolean; user?: any; token?: string; error?: string }> => {
  try {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !/^\S+@\S+\.\S+$/.test(cleanEmail)) {
      return { success: false, error: "يرجى إدخال بريد إلكتروني صالح للدخول السريع." };
    }
    clearGoogleRedirectPending();
    const directUser = {
      uid: `direct:${cleanEmail}`,
      email: cleanEmail,
      displayName: cleanEmail.split('@')[0],
      isAnonymous: false,
      providerId: 'masrofi-direct-email',
    };
    const token = `direct:${cleanEmail}`;
    localStorage.setItem('masrofi_direct_session', JSON.stringify({
      user: directUser,
      token,
      createdAt: Date.now(),
    }));
    return { success: true, user: directUser, token };
  } catch (err: any) {
    console.error("Direct email login error:", err);
    return { success: false, error: err?.message || "تعذر إتمام الدخول السريع بالبريد الإلكتروني." };
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
        return { success: false, error: "حظر Safari نافذة Google. اضغط زر Google مباشرة مرة واحدة بعد تحميل الصفحة، أو استخدم الدخول الفوري بالبريد الإلكتروني." };
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

