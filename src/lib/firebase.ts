import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup,
  signInWithRedirect,
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

/**
 * V6: Safari/Mobile direct login now uses Firebase Custom Tokens.
 * Server mints a custom token via Admin SDK; client calls signInWithCustomToken,
 * then getIdToken() to obtain a real Bearer token for API calls.
 * This replaces the unsigned masrofi_token_ bypass (CF-1).
 */
export const loginWithSafariDirect = async (email: string): Promise<{ success: boolean; user?: any; token?: string; error?: string }> => {
  try {
    const res = await fetch('/api/auth/safari-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim() })
    });
    const data = await res.json();
    if (!res.ok || !data.customToken || !data.user) {
      return { success: false, error: data.error || "تعذر إكمال التحقق السريع" };
    }
    // Sign in with the Firebase Custom Token. This produces a real verified ID token.
    const cred = await signInWithCustomToken(auth, data.customToken);
    const idToken = await cred.user.getIdToken();
    // Persist a minimal session for re-hydration on next page load.
    localStorage.setItem('masrofi_direct_session', JSON.stringify({
      user: data.user,
      // Note: we don't store the idToken here — it's short-lived (1h). On reload,
      // onAuthStateChanged fires and re-fetches a fresh token via Firebase Auth.
    }));
    return { success: true, user: data.user, token: idToken };
  } catch (err: any) {
    console.error("Safari direct login error:", err);
    return { success: false, error: err?.message || "فشل تسجيل الدخول المباشر" };
  }
};

export const loginWithGoogle = async (): Promise<{ success: boolean; user?: any; error?: string }> => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return { success: true, user: result.user };
  } catch (error: any) {
    console.warn("Google popup login error:", error);
    let errorMessage = "تعذر تسجيل الدخول بواسطة Google";
    if (error.code === 'auth/popup-blocked') {
      errorMessage = "قام متصفح Safari بحظر النافذة المنبثقة. يمكنك استخدام زر «الدخول المباشر السريع» بالأسفل للدخول الفوري دون نوافذ منبثقة.";
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

export const logout = async () => {
  try {
    localStorage.removeItem('masrofi_direct_session');
    await signOut(auth);
  } catch (error) {
    localStorage.removeItem('masrofi_direct_session');
    console.error("Logout failed", error);
  }
};

