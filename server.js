import express from 'express';
import multer from 'multer';
import fetch from 'node-fetch';
import FormData from 'form-data';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Allow requests from any origin (your HTML app)
app.use(cors());
app.use(express.json());

// Store uploaded files in memory (Railway has ephemeral disk anyway)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB max

// ── Health check ──
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Mise en place video backend' }));

// ── POST /extract-video ──
// Accepts a video file upload, sends to Google File API, then asks Gemini to extract the recipe
app.post('/extract-video', upload.single('video'), async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set on server.' });
  if (!req.file) return res.status(400).json({ error: 'No video file uploaded.' });

  const { buffer, mimetype, originalname, size } = req.file;
  console.log(`Received video: ${originalname}, ${(size / 1024 / 1024).toFixed(1)} MB, type: ${mimetype}`);

  try {
    // ── Step 1: Initiate resumable upload with Google File API ──
    const initRes = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': size,
          'X-Goog-Upload-Header-Content-Type': mimetype,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { display_name: originalname } }),
      }
    );

    if (!initRes.ok) {
      const errText = await initRes.text();
      console.error('File API init failed:', errText);
      return res.status(502).json({ error: 'Failed to initiate upload with Google File API.', detail: errText });
    }

    const uploadUrl = initRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) return res.status(502).json({ error: 'No upload URL returned by Google.' });

    // ── Step 2: Upload the video bytes ──
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': size,
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
        'Content-Type': mimetype,
      },
      body: buffer,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error('File upload failed:', errText);
      return res.status(502).json({ error: 'Failed to upload video to Google.', detail: errText });
    }

    const fileData = await uploadRes.json();
    const fileUri = fileData?.file?.uri;
    const fileState = fileData?.file?.state;

    if (!fileUri) return res.status(502).json({ error: 'No file URI returned after upload.' });
    console.log(`File uploaded: ${fileUri}, state: ${fileState}`);

    // ── Step 3: Poll until file is ACTIVE (Google processes the video) ──
    const fileName = fileData.file.name;
    let state = fileState;
    let attempts = 0;
    while (state === 'PROCESSING' && attempts < 30) {
      await new Promise(r => setTimeout(r, 4000));
      const statusRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${GEMINI_API_KEY}`
      );
      const statusData = await statusRes.json();
      state = statusData?.state;
      console.log(`Polling file state: ${state} (attempt ${++attempts})`);
    }

    if (state !== 'ACTIVE') {
      return res.status(502).json({ error: `File did not become ready in time. Final state: ${state}` });
    }

    // ── Step 4: Ask Gemini to extract the recipe ──
    const prompt = `Watch this cooking video and extract the recipe being demonstrated. Return ONLY a JSON object (no markdown, no backticks) with these exact keys:
- name (string): the recipe name
- emoji (string): a single relevant food emoji
- category (string): one of breakfast, lunch, dinner, dessert, snack
- time (number): estimated total time in minutes
- servings (number): estimated servings
- ingredients (array of strings): all ingredients with quantities as shown
- steps (array of strings): clear step-by-step instructions based on what's shown in the video

If this video does not appear to contain a cooking recipe, return {"error": "not a recipe"}.`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { file_data: { mime_type: mimetype, file_uri: fileUri } },
              { text: prompt }
            ]
          }]
        })
      }
    );

    const geminiData = await geminiRes.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    const cleaned = rawText.replace(/```json|```/g, '').trim();

    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch { return res.status(422).json({ error: 'Gemini returned unparseable output.', raw: rawText }); }

    // ── Step 5: Delete the uploaded file from Google to keep things clean ──
    fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${GEMINI_API_KEY}`, { method: 'DELETE' })
      .catch(() => {}); // fire and forget

    return res.json(parsed);

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Unexpected server error.', detail: err.message });
  }
});

app.listen(PORT, () => console.log(`Mise en place backend running on port ${PORT}`));
