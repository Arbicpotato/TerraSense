import { initializeApp } from "firebase/app";
import {
  initializeAuth,
  indexedDBLocalPersistence,
  browserPopupRedirectResolver,
} from "firebase/auth";
import { getDatabase } from "firebase/database";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDv9YjfsZL2MhfzikMnKydMvv_-sd_vSj4",
  authDomain: "terrasense-dde20.firebaseapp.com",
  databaseURL: "https://terrasense-dde20-default-rtdb.firebaseio.com",
  projectId: "terrasense-dde20",
  storageBucket: "terrasense-dde20.firebasestorage.app",
  messagingSenderId: "214542249444",
  appId: "1:214542249444:web:a8f33d4bff2f38dc8e2bf1",
};

const app = initializeApp(firebaseConfig);

export const auth = initializeAuth(app, {
  persistence: indexedDBLocalPersistence,
  popupRedirectResolver: browserPopupRedirectResolver,
});

// Realtime Database
export const db = getDatabase(app);

// Firestore
export const firestore = getFirestore(app);