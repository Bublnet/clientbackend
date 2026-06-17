import fs from 'fs';
import path from 'path';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const localServiceAccountPath = path.join(__dirname, '..', 'backend', 'inventory-management-ce97e-firebase-adminsdk-r6egv-3376080a19.json');
const hasLocalServiceAccount = fs.existsSync(localServiceAccountPath);

export function initFirebaseAdmin() {
  if (getApps().length) return getApps()[0];

  let credential;
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const base64Json = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  if (rawJson || base64Json) {
    const parsed = JSON.parse(
      rawJson || Buffer.from(base64Json, 'base64').toString('utf8'),
    );
    credential = cert(parsed);
  } else if (hasLocalServiceAccount) {
    const parsed = JSON.parse(fs.readFileSync(localServiceAccountPath, 'utf8'));
    credential = cert(parsed);
  } else {
    credential = applicationDefault();
  }

  const appConfig = {
    credential,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  };
  if (!rawJson && !base64Json && !hasLocalServiceAccount && process.env.FIREBASE_PROJECT_ID) {
    appConfig.projectId = process.env.FIREBASE_PROJECT_ID;
  }

  const app = initializeApp(appConfig);
  return app;
}

initFirebaseAdmin();

export const db = getFirestore();
export const auth = getAuth();

export const hasFirebaseServerCredentials = Boolean(
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    || process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
    || process.env.GOOGLE_APPLICATION_CREDENTIALS
    || process.env.K_SERVICE
    || hasLocalServiceAccount,
);