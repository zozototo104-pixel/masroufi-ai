import fs from 'fs';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import firebaseConfig from '../../firebase-applet-config.json';

function parseServiceAccount(raw: string) {
  const trimmed = raw.trim();
  const jsonText = trimmed.startsWith('{')
    ? trimmed
    : Buffer.from(trimmed, 'base64').toString('utf8');

  const parsed = JSON.parse(jsonText);
  if (parsed.private_key && typeof parsed.private_key === 'string') {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  return parsed;
}

function loadServiceAccount() {
  const inline =
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (inline) {
    return parseServiceAccount(inline);
  }

  const filePath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.FIREBASE_SERVICE_ACCOUNT_FILE;

  if (filePath && fs.existsSync(filePath)) {
    return parseServiceAccount(fs.readFileSync(filePath, 'utf8'));
  }

  // Render secret files are commonly mounted at /etc/secrets/<filename>.
  const renderSecretPath = '/etc/secrets/firebase-service-account.json';
  if (fs.existsSync(renderSecretPath)) {
    return parseServiceAccount(fs.readFileSync(renderSecretPath, 'utf8'));
  }

  return null;
}

if (!getApps().length) {
  const serviceAccount = loadServiceAccount();
  initializeApp(serviceAccount
    ? {
        credential: cert(serviceAccount),
        projectId: serviceAccount.project_id || firebaseConfig.projectId,
      }
    : {
        projectId: firebaseConfig.projectId,
      }
  );

  if (!serviceAccount) {
    console.warn('[firebase-admin] No service account was provided. Local ADC may work, but Render requires FIREBASE_SERVICE_ACCOUNT_KEY or a secret file.');
  }
}

export const adminDb = firebaseConfig.firestoreDatabaseId
  ? getFirestore(firebaseConfig.firestoreDatabaseId)
  : getFirestore();
export const adminAuth = getAuth();
