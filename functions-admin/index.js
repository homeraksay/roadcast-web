const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const textToSpeech = require("@google-cloud/text-to-speech");
const { randomUUID } = require("crypto");

admin.initializeApp();

const ADMIN_EMAIL = "info@nextron.com.tr";
const REGION = "europe-west1";
const VOICE_NAME = "tr-TR-Chirp3-HD-Despina";
const LANGUAGE_CODE = "tr-TR";
const MAX_TEXT_LENGTH = 5000;
const PREVIEW_PREFIX = "admin-audio-previews";
const tts = new textToSpeech.TextToSpeechClient();

function assertAdmin(request) {
  const email = String(request.auth?.token?.email || "").trim().toLowerCase();
  if (!request.auth || email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "Bu işlem yalnızca RoadCast yöneticisine açıktır.");
  }
}

function validateInput(data) {
  const poiId = String(data?.poiId || "").trim();
  const text = String(data?.text || "").trim();
  if (!poiId || poiId.includes("/") || poiId.length > 180) {
    throw new HttpsError("invalid-argument", "POI kimliği geçersiz.");
  }
  if (text.length < 20 || text.length > MAX_TEXT_LENGTH) {
    throw new HttpsError("invalid-argument", `Türkçe metin 20-${MAX_TEXT_LENGTH} karakter arasında olmalıdır.`);
  }
  return { poiId, text };
}

function prepareText(text) {
  return text
    .normalize("NFC")
    .replace(/\byirmi bin (?=(?:[a-zçğıöşü]+\s+){1,3}yıl(?:ında|ında|ı|a)?\b)/giu, "iki bin ")
    .replace(/\bM\.Ö\.|\bMÖ\b/giu, "Milattan önce")
    .replace(/\bM\.S\.|\bMS\b/giu, "Milattan sonra")
    .replace(/\bUNESCO\b/giu, "Yunesko")
    .replace(/[’‘`´'′“”„«»"]/g, "")
    .replace(/[\[\]{}\\_#@$%^&*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function downloadUrl(bucketName, objectPath, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

function pathFromAudio(point, bucketName) {
  const direct = point?.audio?.tr?.storagePath;
  if (direct) return String(direct);
  const url = point?.audio_urls?.tr || point?.audio_url || point?.dbAudioURL;
  if (!url) return null;
  try {
    const parsed = new URL(String(url));
    const marker = `/v0/b/${bucketName}/o/`;
    const index = parsed.pathname.indexOf(marker);
    return index >= 0 ? decodeURIComponent(parsed.pathname.slice(index + marker.length)) : null;
  } catch (_) {
    return null;
  }
}

exports.previewPoiAudio = onCall({
  region: REGION,
  timeoutSeconds: 120,
  memory: "512MiB",
  invoker: "public"
}, async (request) => {
  assertAdmin(request);
  const { poiId, text } = validateInput(request.data);
  const pointRef = admin.firestore().collection("points").doc(poiId);
  if (!(await pointRef.get()).exists) {
    throw new HttpsError("not-found", "POI kaydı bulunamadı.");
  }

  let response;
  try {
    [response] = await tts.synthesizeSpeech({
      input: { text: prepareText(text) },
      voice: { languageCode: LANGUAGE_CODE, name: VOICE_NAME },
      audioConfig: { audioEncoding: "MP3" }
    });
  } catch (error) {
    console.error("Chirp 3 generation failed", error);
    throw new HttpsError("internal", "Chirp 3 sesi üretilemedi. TTS API ve faturalamayı kontrol edin.");
  }
  if (!response.audioContent) throw new HttpsError("internal", "TTS boş ses döndürdü.");

  const bucket = admin.storage().bucket();
  const previewId = randomUUID();
  const previewPath = `${PREVIEW_PREFIX}/${request.auth.uid}/${previewId}.mp3`;
  const token = randomUUID();
  await bucket.file(previewPath).save(Buffer.from(response.audioContent), {
    contentType: "audio/mpeg",
    metadata: {
      metadata: {
        firebaseStorageDownloadTokens: token,
        poiId,
        createdBy: request.auth.uid
      }
    }
  });
  return {
    previewPath,
    previewUrl: downloadUrl(bucket.name, previewPath, token),
    voice: VOICE_NAME
  };
});

exports.publishPoiAudio = onCall({
  region: REGION,
  timeoutSeconds: 120,
  memory: "512MiB",
  invoker: "public"
}, async (request) => {
  assertAdmin(request);
  const { poiId, text } = validateInput(request.data);
  const previewPath = String(request.data?.previewPath || "").trim();
  const expectedPrefix = `${PREVIEW_PREFIX}/${request.auth.uid}/`;
  if (!previewPath.startsWith(expectedPrefix) || !previewPath.endsWith(".mp3")) {
    throw new HttpsError("invalid-argument", "Ses önizlemesi geçersiz.");
  }

  const pointRef = admin.firestore().collection("points").doc(poiId);
  const snapshot = await pointRef.get();
  if (!snapshot.exists) throw new HttpsError("not-found", "POI kaydı bulunamadı.");

  const bucket = admin.storage().bucket();
  const previewFile = bucket.file(previewPath);
  const [previewExists] = await previewFile.exists();
  if (!previewExists) throw new HttpsError("not-found", "Önizleme süresi dolmuş veya dosya bulunamadı.");

  const point = snapshot.data() || {};
  const destinationPath = pathFromAudio(point, bucket.name) || `audio/tr/${poiId}_admin.mp3`;
  const token = randomUUID();
  await previewFile.copy(bucket.file(destinationPath));
  await bucket.file(destinationPath).setMetadata({
    contentType: "audio/mpeg",
    metadata: { firebaseStorageDownloadTokens: token }
  });
  const audioUrl = downloadUrl(bucket.name, destinationPath, token);
  await pointRef.set({
    description: text,
    content_tr: text,
    descriptions: { ...(point.descriptions || {}), tr: text },
    audio_url: audioUrl,
    audio_urls: { ...(point.audio_urls || {}), tr: audioUrl },
    audio: {
      ...(point.audio || {}),
      tr: { ...(point.audio?.tr || {}), storagePath: destinationPath, version: Number(point.audio?.tr?.version || 0) + 1 }
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  await previewFile.delete({ ignoreNotFound: true });
  return { audioUrl, storagePath: destinationPath };
});

async function claimJob(jobRef, expectedStatus) {
  return admin.firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(jobRef);
    if (!snapshot.exists || snapshot.data().status !== expectedStatus) return null;
    const job = snapshot.data();
    transaction.update(jobRef, {
      status: expectedStatus === "requested" ? "generating" : "publishing",
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return job;
  });
}

async function generateJobPreview(jobRef, job) {
  const { poiId, text } = validateInput(job);
  if (String(job.createdByEmail || "").toLowerCase() !== ADMIN_EMAIL || !job.createdByUid) {
    throw new Error("Yönetici kimliği doğrulanamadı.");
  }
  const pointRef = admin.firestore().collection("points").doc(poiId);
  if (!(await pointRef.get()).exists) throw new Error("POI kaydı bulunamadı.");
  const [response] = await tts.synthesizeSpeech({
    input: { text: prepareText(text) },
    voice: { languageCode: LANGUAGE_CODE, name: VOICE_NAME },
    audioConfig: { audioEncoding: "MP3" }
  });
  if (!response.audioContent) throw new Error("TTS boş ses döndürdü.");
  const bucket = admin.storage().bucket();
  const previewPath = `${PREVIEW_PREFIX}/${job.createdByUid}/${jobRef.id}.mp3`;
  const token = randomUUID();
  await bucket.file(previewPath).save(Buffer.from(response.audioContent), {
    contentType: "audio/mpeg",
    metadata: { metadata: { firebaseStorageDownloadTokens: token, poiId, createdBy: job.createdByUid } }
  });
  await jobRef.update({
    status: "preview_ready",
    previewPath,
    previewUrl: downloadUrl(bucket.name, previewPath, token),
    voice: VOICE_NAME,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function publishJobPreview(jobRef, job) {
  const { poiId, text } = validateInput(job);
  const expectedPrefix = `${PREVIEW_PREFIX}/${job.createdByUid}/`;
  const previewPath = String(job.previewPath || "");
  if (!previewPath.startsWith(expectedPrefix) || !previewPath.endsWith(".mp3")) {
    throw new Error("Ses önizlemesi geçersiz.");
  }
  const pointRef = admin.firestore().collection("points").doc(poiId);
  const snapshot = await pointRef.get();
  if (!snapshot.exists) throw new Error("POI kaydı bulunamadı.");
  const bucket = admin.storage().bucket();
  const previewFile = bucket.file(previewPath);
  const [previewExists] = await previewFile.exists();
  if (!previewExists) throw new Error("Önizleme dosyası bulunamadı.");
  const point = snapshot.data() || {};
  const destinationPath = pathFromAudio(point, bucket.name) || `audio/tr/${poiId}_admin.mp3`;
  const token = randomUUID();
  await previewFile.copy(bucket.file(destinationPath));
  await bucket.file(destinationPath).setMetadata({
    contentType: "audio/mpeg",
    metadata: { firebaseStorageDownloadTokens: token }
  });
  const audioUrl = downloadUrl(bucket.name, destinationPath, token);
  await pointRef.set({
    description: text,
    content_tr: text,
    descriptions: { ...(point.descriptions || {}), tr: text },
    audio_url: audioUrl,
    audio_urls: { ...(point.audio_urls || {}), tr: audioUrl },
    audio: {
      ...(point.audio || {}),
      tr: { ...(point.audio?.tr || {}), storagePath: destinationPath, version: Number(point.audio?.tr?.version || 0) + 1 }
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  await previewFile.delete({ ignoreNotFound: true });
  await jobRef.update({
    status: "published",
    audioUrl,
    storagePath: destinationPath,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

exports.processAdminAudioJob = onDocumentWritten({
  document: "admin_audio_jobs/{jobId}",
  region: REGION,
  timeoutSeconds: 180,
  memory: "512MiB"
}, async (event) => {
  if (!event.data?.after.exists) return;
  const jobRef = event.data.after.ref;
  const status = event.data.after.data().status;
  if (!["requested", "publish_requested"].includes(status)) return;
  const job = await claimJob(jobRef, status);
  if (!job) return;
  try {
    if (status === "requested") await generateJobPreview(jobRef, job);
    else await publishJobPreview(jobRef, job);
  } catch (error) {
    console.error("Admin audio job failed", error);
    await jobRef.update({
      status: "error",
      errorMessage: String(error?.message || error).slice(0, 500),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
});
