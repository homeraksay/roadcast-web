const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const textToSpeech = require("@google-cloud/text-to-speech");
const { randomUUID } = require("crypto");

admin.initializeApp();

const ADMIN_EMAIL = "info@nextron.com.tr";
const REGION = "europe-west1";
const VOICES = {
  tr: { languageCode: "tr-TR", name: "tr-TR-Chirp3-HD-Despina", label: "Türkçe" },
  en: { languageCode: "en-US", name: "en-US-Chirp3-HD-Despina", label: "İngilizce" }
};
const MIN_TEXT_LENGTH = 20;
const TTS_CHUNK_MAX_BYTES = 4200;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PREVIEW_PREFIX = "admin-audio-previews";
const IMAGE_MIME_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif"
};
const tts = new textToSpeech.TextToSpeechClient();

function assertAdmin(request) {
  const email = String(request.auth?.token?.email || "").trim().toLowerCase();
  if (!request.auth || email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "Bu işlem yalnızca RoadCast yöneticisine açıktır.");
  }
}

function validatePoiId(rawPoiId) {
  const poiId = String(rawPoiId || "").trim();
  if (!poiId || poiId === "." || poiId === ".." || poiId.includes("/") || poiId.length > 180) {
    throw new HttpsError("invalid-argument", "POI kimliği geçersiz.");
  }
  return poiId;
}

function validateLanguage(rawLang) {
  const lang = String(rawLang || "tr").trim().toLowerCase();
  if (!VOICES[lang]) {
    throw new HttpsError("invalid-argument", "Desteklenmeyen ses dili.");
  }
  return lang;
}

function validateInput(data) {
  const poiId = validatePoiId(data?.poiId);
  const lang = validateLanguage(data?.lang);
  const text = String(data?.text || "").trim();
  if (text.length < MIN_TEXT_LENGTH) {
    throw new HttpsError("invalid-argument", `${VOICES[lang].label} metin en az ${MIN_TEXT_LENGTH} karakter olmalıdır.`);
  }
  return { poiId, lang, text };
}

function prepareText(text, lang = "tr") {
  const normalized = text.normalize("NFC");
  if (lang === "en") {
    return normalized
      .replace(/[“”„«»"]/g, "")
      .replace(/[\[\]{}\\_#@$%^&*]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return normalized
    .replace(/\byirmi bin (?=(?:[a-zçğıöşü]+\s+){1,3}yıl(?:ında|ında|ı|a)?\b)/giu, "iki bin ")
    .replace(/\bM\.Ö\.|\bMÖ\b/giu, "Milattan önce")
    .replace(/\bM\.S\.|\bMS\b/giu, "Milattan sonra")
    .replace(/\bUNESCO\b/giu, "Yunesko")
    .replace(/[’‘`´'′“”„«»"]/g, "")
    .replace(/[\[\]{}\\_#@$%^&*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTokenByBytes(token, maxBytes) {
  const parts = [];
  let current = "";
  for (const ch of token) {
    const next = current + ch;
    if (Buffer.byteLength(next, "utf8") > maxBytes && current) {
      parts.push(current);
      current = ch;
    } else {
      current = next;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function splitTextForTts(text, maxBytes = TTS_CHUNK_MAX_BYTES) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
  const segments = text.split(/(?<=[.!?…])\s+/);
  const chunks = [];
  let current = "";

  const pushSegment = (segment) => {
    const candidate = current ? `${current} ${segment}` : segment;
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      current = candidate;
      return;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    if (Buffer.byteLength(segment, "utf8") <= maxBytes) {
      current = segment;
      return;
    }
    for (const word of segment.split(/\s+/)) {
      if (!word) continue;
      if (Buffer.byteLength(word, "utf8") > maxBytes) {
        if (current) {
          chunks.push(current);
          current = "";
        }
        const slices = splitTokenByBytes(word, maxBytes);
        chunks.push(...slices.slice(0, -1));
        current = slices[slices.length - 1] || "";
        continue;
      }
      const next = current ? `${current} ${word}` : word;
      if (Buffer.byteLength(next, "utf8") <= maxBytes) {
        current = next;
      } else {
        if (current) chunks.push(current);
        current = word;
      }
    }
  };

  for (const segment of segments) {
    if (segment) pushSegment(segment);
  }
  if (current) chunks.push(current);
  return chunks;
}

function stripLeadingId3(buffer) {
  if (buffer.length > 10 && buffer.subarray(0, 3).toString("ascii") === "ID3") {
    const size = ((buffer[6] & 0x7f) << 21)
      | ((buffer[7] & 0x7f) << 14)
      | ((buffer[8] & 0x7f) << 7)
      | (buffer[9] & 0x7f);
    return buffer.subarray(10 + size);
  }
  return buffer;
}

async function synthesizeChirpAudio(text, lang) {
  const voice = VOICES[lang];
  const chunks = splitTextForTts(prepareText(text, lang));
  const audioBuffers = [];
  for (let i = 0; i < chunks.length; i++) {
    const [response] = await tts.synthesizeSpeech({
      input: { text: chunks[i] },
      voice: { languageCode: voice.languageCode, name: voice.name },
      audioConfig: { audioEncoding: "MP3" }
    });
    if (!response?.audioContent) {
      throw new Error("TTS boş ses döndürdü.");
    }
    const buf = Buffer.from(response.audioContent);
    audioBuffers.push(i === 0 ? buf : stripLeadingId3(buf));
  }
  return Buffer.concat(audioBuffers);
}

function downloadUrl(bucketName, objectPath, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

function pathFromUrl(url, bucketName) {
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

function pathFromAudio(point, bucketName, lang = "tr") {
  const direct = point?.audio?.[lang]?.storagePath;
  if (direct) return String(direct);
  const url = lang === "en"
    ? (point?.audio_urls?.en || point?.audio_en)
    : (point?.audio_urls?.tr || point?.audio_url || point?.dbAudioURL);
  return pathFromUrl(url, bucketName);
}

function buildCanonicalPointDoc(pointData, poiId, { audioUpdate, coverUpdate, existingPoint } = {}) {
  const source = {
    ...(existingPoint || {}),
    ...(pointData && typeof pointData === "object" ? pointData : {})
  };
  const namesSource = source.names || {};
  const names = {
    tr: String(namesSource.tr || source.name || poiId),
    ...(namesSource.en ? { en: String(namesSource.en) } : {})
  };
  const descriptions = { tr: String(source.description || source.descriptions?.tr || source.content_tr || "") };
  const audioUrls = { tr: String(source.audio_url || source.audio_urls?.tr || "") };
  let description = descriptions.tr;
  let audioUrl = audioUrls.tr;
  const descriptionEn = source.descriptions?.en || source.content_en;
  const audioUrlEn = source.audio_urls?.en || source.audio_en;
  if (descriptionEn) descriptions.en = String(descriptionEn);
  if (audioUrlEn) audioUrls.en = String(audioUrlEn);
  if (audioUpdate?.lang === "tr") {
    description = audioUpdate.text;
    descriptions.tr = audioUpdate.text;
    audioUrl = audioUpdate.audioUrl;
    audioUrls.tr = audioUpdate.audioUrl;
  } else if (audioUpdate?.lang === "en") {
    descriptions.en = audioUpdate.text;
    audioUrls.en = audioUpdate.audioUrl;
  }

  const imageUrl = coverUpdate?.imageUrl ?? source.image_url ?? source.imageUrl ?? source.coverImage ?? source.image?.url ?? "";
  const imageStoragePath = coverUpdate?.storagePath ?? source.image_storage_path ?? source.imageStoragePath ?? source.image?.storagePath ?? "";
  const imageMimeType = coverUpdate?.imageMimeType ?? source.image_mime_type ?? "";
  const latitude = Number(source.latitude);
  const longitude = Number(source.longitude);
  const seed = {
    id: poiId,
    source: "admin",
    tts_status: audioUrl ? "completed" : "pending",
    content_status: description ? "completed" : "pending",
    names,
    description,
    descriptions,
    audio_url: audioUrl,
    audio_urls: audioUrls,
    image_url: String(imageUrl),
    image_storage_path: String(imageStoragePath),
    image_mime_type: String(imageMimeType),
    latitude: Number.isFinite(latitude) ? latitude : 0,
    longitude: Number.isFinite(longitude) ? longitude : 0,
    city: String(source.city || source.cityName || source.cityId || ""),
    country: String(source.country || "Türkiye"),
    countryCode: String(source.countryCode || "TR"),
    category: String(source.category || ""),
    updatedAt: new Date().toISOString()
  };
  const imageUpdatedAt = coverUpdate?.imageUpdatedAt || source.image_updated_at;
  if (imageUpdatedAt) seed.image_updated_at = String(imageUpdatedAt);
  return seed;
}

function buildAudioPointPatch(point, lang, text, audioUrl, destinationPath) {
  const trAudioUrl = lang === "tr" ? audioUrl : String(point.audio_url || point.audio_urls?.tr || "");
  const contentTr = lang === "tr" ? text : String(point.description || point.descriptions?.tr || "");
  const patch = {
    audio_urls: { ...(point.audio_urls || {}), [lang]: audioUrl },
    descriptions: { ...(point.descriptions || {}), [lang]: text },
    tts_status: trAudioUrl ? "completed" : "pending",
    content_status: contentTr ? "completed" : "pending",
    updatedAt: new Date().toISOString()
  };
  if (Object.prototype.hasOwnProperty.call(point, "content_tr") && lang === "tr") {
    patch.content_tr = text;
  }
  if (Object.prototype.hasOwnProperty.call(point, "content_en") && lang === "en") {
    patch.content_en = text;
  }
  if (Object.prototype.hasOwnProperty.call(point, "audio_en") && lang === "en") {
    patch.audio_en = audioUrl;
  }
  if (point.audio && typeof point.audio === "object") {
    patch.audio = {
      ...point.audio,
      [lang]: {
        ...(point.audio[lang] || {}),
        storagePath: destinationPath,
        version: Number(point.audio[lang]?.version || 0) + 1
      }
    };
  }
  return lang === "tr" ? { ...patch, description: text, audio_url: audioUrl } : patch;
}

function parseImagePayload(data) {
  const poiId = validatePoiId(data?.poiId);
  const normalizeMime = (mime) => {
    const m = String(mime || "").trim().toLowerCase();
    if (m === "image/pjpeg") return "image/jpeg";
    if (m === "image/x-png") return "image/png";
    return m;
  };
  let contentType = normalizeMime(data?.contentType);
  let rawBase64 = String(data?.dataUrl || data?.imageBase64 || "").trim();
  const dataUrlMatch = rawBase64.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (dataUrlMatch) {
    const dataUrlMime = normalizeMime(dataUrlMatch[1]);
    if (!IMAGE_MIME_EXTENSIONS[contentType]) {
      contentType = dataUrlMime;
    }
    rawBase64 = dataUrlMatch[2];
  }
  const ext = IMAGE_MIME_EXTENSIONS[contentType];
  if (!ext) {
    throw new HttpsError("invalid-argument", "Desteklenen görsel formatları: JPG, PNG, WEBP, GIF veya AVIF.");
  }
  const buffer = Buffer.from(rawBase64, "base64");
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
    throw new HttpsError("invalid-argument", "Kapak görseli boş olamaz ve en fazla 8 MB olmalıdır.");
  }
  return { poiId, contentType, ext, buffer };
}

async function saveCoverImageToBucket({ poiId, contentType, ext, buffer, uid }) {
  const bucket = admin.storage().bucket();
  const storagePath = `poi-images/${poiId}.${ext}`;
  const token = randomUUID();
  await bucket.file(storagePath).save(buffer, {
    contentType,
    metadata: {
      metadata: {
        firebaseStorageDownloadTokens: token,
        poiId,
        createdBy: uid
      }
    }
  });
  return {
    storagePath,
    imageUrl: downloadUrl(bucket.name, storagePath, token),
    imageMimeType: contentType,
    imageUpdatedAt: new Date().toISOString()
  };
}

exports.uploadPoiCoverImage = onCall({
  region: REGION,
  timeoutSeconds: 60,
  memory: "512MiB",
  cors: true,
  invoker: "public"
}, async (request) => {
  assertAdmin(request);
  const payload = parseImagePayload(request.data);
  return saveCoverImageToBucket({ ...payload, uid: request.auth.uid });
});

exports.previewPoiAudio = onCall({
  region: REGION,
  timeoutSeconds: 300,
  memory: "512MiB",
  cors: true,
  invoker: "public"
}, async (request) => {
  assertAdmin(request);
  const { poiId, lang, text } = validateInput(request.data);
  const voice = VOICES[lang];

  let audioBuffer;
  try {
    audioBuffer = await synthesizeChirpAudio(text, lang);
  } catch (error) {
    console.error("Chirp 3 generation failed", error);
    throw new HttpsError("internal", "Chirp 3 sesi üretilemedi. TTS API ve faturalamayı kontrol edin.");
  }

  const bucket = admin.storage().bucket();
  const previewId = randomUUID();
  const previewPath = `${PREVIEW_PREFIX}/${request.auth.uid}/${previewId}.mp3`;
  const token = randomUUID();
  await bucket.file(previewPath).save(audioBuffer, {
    contentType: "audio/mpeg",
    metadata: {
      metadata: {
        firebaseStorageDownloadTokens: token,
        poiId,
        lang,
        createdBy: request.auth.uid
      }
    }
  });
  return {
    previewPath,
    previewUrl: downloadUrl(bucket.name, previewPath, token),
    voice: voice.name,
    lang
  };
});

exports.publishPoiAudio = onCall({
  region: REGION,
  timeoutSeconds: 120,
  memory: "512MiB",
  cors: true,
  invoker: "public"
}, async (request) => {
  assertAdmin(request);
  const { poiId, lang, text } = validateInput(request.data);
  const previewPath = String(request.data?.previewPath || "").trim();
  const expectedPrefix = `${PREVIEW_PREFIX}/${request.auth.uid}/`;
  if (!previewPath.startsWith(expectedPrefix) || !previewPath.endsWith(".mp3")) {
    throw new HttpsError("invalid-argument", "Ses önizlemesi geçersiz.");
  }

  const pointRef = admin.firestore().collection("points").doc(poiId);
  const snapshot = await pointRef.get();
  if (!snapshot.exists && !request.data?.allowCreate && !request.data?.pointData) {
    throw new HttpsError("not-found", "POI kaydı bulunamadı.");
  }
  if (!snapshot.exists && !request.data?.pointData) {
    throw new HttpsError("invalid-argument", "Yeni POI için tam nokta bilgileri gerekli.");
  }

  const bucket = admin.storage().bucket();
  const previewFile = bucket.file(previewPath);
  const [previewExists] = await previewFile.exists();
  if (!previewExists) throw new HttpsError("not-found", "Önizleme süresi dolmuş veya dosya bulunamadı.");

  const point = snapshot.data() || {};
  const destinationPath = pathFromAudio(point, bucket.name, lang) || `audio/${lang}/${poiId}_admin.mp3`;
  const token = randomUUID();
  await previewFile.copy(bucket.file(destinationPath));
  await bucket.file(destinationPath).setMetadata({
    contentType: "audio/mpeg",
    metadata: { firebaseStorageDownloadTokens: token }
  });
  const audioUrl = downloadUrl(bucket.name, destinationPath, token);
  const patch = request.data?.pointData
    ? buildCanonicalPointDoc(request.data.pointData, poiId, { audioUpdate: { lang, text, audioUrl } })
    : buildAudioPointPatch(point, lang, text, audioUrl, destinationPath);
  await pointRef.set(patch, { merge: true });
  await previewFile.delete({ ignoreNotFound: true });
  return { audioUrl, storagePath: destinationPath, lang };
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

function assertJobAdmin(job) {
  if (String(job.createdByEmail || "").toLowerCase() !== ADMIN_EMAIL || !job.createdByUid) {
    throw new Error("Yönetici kimliği doğrulanamadı.");
  }
}

async function generateJobPreview(jobRef, job) {
  assertJobAdmin(job);
  if (job.type === "cover_image") {
    const payload = parseImagePayload(job);
    const { imageUrl, storagePath, imageMimeType, imageUpdatedAt } = await saveCoverImageToBucket({ ...payload, uid: job.createdByUid });
    const pointRef = admin.firestore().collection("points").doc(payload.poiId);
    const pointSnapshot = await pointRef.get();
    const pointDoc = buildCanonicalPointDoc(job.pointData, payload.poiId, {
      existingPoint: pointSnapshot.data(),
      coverUpdate: { imageUrl, storagePath, imageMimeType, imageUpdatedAt }
    });
    await pointRef.set(pointDoc, { merge: true });
    await jobRef.update({
      status: "uploaded",
      imageUrl,
      storagePath,
      imageMimeType,
      imageUpdatedAt,
      imageBase64: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return;
  }

  const { poiId, lang, text } = validateInput(job);
  const voice = VOICES[lang];
  const audioBuffer = await synthesizeChirpAudio(text, lang);
  const bucket = admin.storage().bucket();
  const previewPath = `${PREVIEW_PREFIX}/${job.createdByUid}/${jobRef.id}.mp3`;
  const token = randomUUID();
  await bucket.file(previewPath).save(audioBuffer, {
    contentType: "audio/mpeg",
    metadata: { metadata: { firebaseStorageDownloadTokens: token, poiId, lang, createdBy: job.createdByUid } }
  });
  await jobRef.update({
    status: "preview_ready",
    previewPath,
    previewUrl: downloadUrl(bucket.name, previewPath, token),
    voice: voice.name,
    lang,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function publishJobPreview(jobRef, job) {
  assertJobAdmin(job);
  const { poiId, lang, text } = validateInput(job);
  const expectedPrefix = `${PREVIEW_PREFIX}/${job.createdByUid}/`;
  const previewPath = String(job.previewPath || "");
  if (!previewPath.startsWith(expectedPrefix) || !previewPath.endsWith(".mp3")) {
    throw new Error("Ses önizlemesi geçersiz.");
  }
  const pointRef = admin.firestore().collection("points").doc(poiId);
  const snapshot = await pointRef.get();
  const bucket = admin.storage().bucket();
  const previewFile = bucket.file(previewPath);
  const [previewExists] = await previewFile.exists();
  if (!previewExists) throw new Error("Önizleme dosyası bulunamadı.");
  const point = snapshot.data() || {};
  const destinationPath = pathFromAudio(point, bucket.name, lang) || `audio/${lang}/${poiId}_admin.mp3`;
  const token = randomUUID();
  await previewFile.copy(bucket.file(destinationPath));
  await bucket.file(destinationPath).setMetadata({
    contentType: "audio/mpeg",
    metadata: { firebaseStorageDownloadTokens: token }
  });
  const audioUrl = downloadUrl(bucket.name, destinationPath, token);
  const pointDoc = buildCanonicalPointDoc(job.pointData, poiId, {
    existingPoint: point,
    audioUpdate: { lang, text, audioUrl }
  });
  await pointRef.set(pointDoc, { merge: true });
  await previewFile.delete({ ignoreNotFound: true });
  await jobRef.update({
    status: "published",
    audioUrl,
    storagePath: destinationPath,
    lang,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

exports.processAdminAudioJob = onDocumentWritten({
  document: "admin_audio_jobs/{jobId}",
  region: REGION,
  timeoutSeconds: 300,
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
      imageBase64: admin.firestore.FieldValue.delete(),
      errorMessage: String(error?.message || error).slice(0, 500),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
});
