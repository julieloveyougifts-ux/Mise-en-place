import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { readFile, unlink, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Mise en place video backend' }));

async function uploadAndExtract(buffer, mimetype, displayName) {
  const size = buffer.length;
  const initRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': size,
      'X-Goog-Upload-Header-Content-Type': mimetype,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!initRes.ok) throw new Error(`File API init failed: ${await initRes.text()}`);
  const uploadUrl = initRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('No upload URL returned by Google.');
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Length': size, 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize', 'Content-Type': mimetype },
    body: buffer,
  });
  if (!uploadRes.ok) throw new Error(`File upload failed: ${await uploadRes.text()}`);
  const fileData = await uploadRes.json();
  const fileUri = fileData?.file?.uri;
  const fileName = fileData?.file?.name;
  if (!fileUri) throw new Error('No file URI returned after upload.');
  console.log(`Uploaded to Google: ${fileUri}`);
  let state = fileData?.file?.state;
  let attempts = 0;
  while (state === 'PROCESSING' && attempts < 30) {
    await new Promise(r => setTimeout(r, 4000));
    const statusRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${GEMINI_API_KEY}`);
    const statusData = await statusRes.json();
    state = statusData?.state;
    console.log(`Polling: ${state} (attempt ${++attempts})`);
  }
  if (state !== 'ACTIVE') throw new Error(`File not ready. Final state: ${state}`);
  const prompt = `Watch this cooking video and extract the recipe. Return ONLY a JSON object (no markdown, no backticks) with: name (string), emoji (string), category (breakfast/lunch/dinner/dessert/snack), time (number, minutes), servings (number), ingredients (string[]), steps (string[]). If not a recipe, return {"error":"not a recipe"}.`;
  const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ file_data: { mime_type: mimetype, file_uri: fileUri } }, { text: prompt }] }] })
  });
  const geminiData = await geminiRes.json();
  const rawText = geminiData.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${GEMINI_API_KEY}`, { method: 'DELETE' }).catch(() => {});
  return JSON.parse(rawText.replace(/```json|```/g, '').trim());
}

app.post('/extract-video-url', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided.' });
  console.log(`Downloading video from: ${url}`);
  let tmpDir, tmpFile;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'mise-'));
    tmpFile = join(tmpDir, 'video.mp4');
    let cleanUrl = url;
    try {
      const u = new URL(url);
      if (u.hostname.includes('facebook.com') && u.pathname.includes('watch')) {
        const v = u.searchParams.get('v');
        if (v) cleanUrl = `https://www.facebook.com/watch/?v=${v}`;
      }
    } catch {}
    console.log(`Clean URL: ${cleanUrl}`);
    await execFileAsync('yt-dlp', ['--no-playlist', '--format', 'best[ext=mp4][filesize<150M]/best', '--merge-output-format', 'mp4', '--output', tmpFile, '--no-warnings', '--no-check-certificates', cleanUrl], { timeout: 180_000 });
    const buffer = await readFile(tmpFile);
    console.log(`Downloaded: ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
    const parsed = await uploadAndExtract(buffer, 'video/mp4', 'recipe-video.mp4');
    return res.json(parsed);
  } catch (err) {
    console.error('URL extract error:', err.message);
    return res.status(500).json({ error: 'Could not download that video. Make sure it is a public Facebook video.' });
  } finally {
    if (tmpFile) unlink(tmpFile).catch(() => {});
  }
});

app.post('/ai/scan-photo', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  const { image, mimeType } = req.body;
  if (!image) return res.status(400).json({ error: 'No image provided.' });
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mimeType || 'image/jpeg', data: image } }, { text: 'Extract the recipe from this image. Return ONLY JSON (no markdown) with: name, emoji, category (breakfast/lunch/dinner/dessert/snack), time (number, minutes), servings (number), ingredients (string[]), steps (string[]). If no recipe, return {"error":"not a recipe"}.' }] }] })
    });
    const d = await r.json();
    const txt = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    return res.json(JSON.parse(txt.replace(/```json|```/g, '').trim()));
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post('/ai/extract-url', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  const { pageText } = req.body;
  if (!pageText) return res.status(400).json({ error: 'No page text provided.' });
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: `Extract the recipe from this webpage text. Return ONLY JSON (no markdown) with: name, emoji, category (breakfast/lunch/dinner/dessert/snack), time (number, minutes), servings (number), ingredients (string[]), steps (string[]). If no recipe, return {"error":"not a recipe"}.\n\n${pageText.slice(0, 12000)}` }] }] })
    });
    const d = await r.json();
    const txt = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    return res.json(JSON.parse(txt.replace(/```json|```/g, '').trim()));
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post('/ai/scan-fridge', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  const { image, mimeType, savedRecipes } = req.body;
  if (!image) return res.status(400).json({ error: 'No image provided.' });
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mimeType || 'image/jpeg', data: image } }, { text: `Look at this fridge/pantry photo. Suggest 4 recipes. Saved recipes: ${savedRecipes || 'none'}. Return ONLY a JSON array of objects with: name, emoji, description (one sentence), ingredients_needed (string[]). No markdown.` }] }] })
    });
    const d = await r.json();
    const txt = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '[]';
    return res.json(JSON.parse(txt.replace(/```json|```/g, '').trim()));
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post('/ai/grocery-list', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'No prompt provided.' });
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const d = await r.json();
    const txt = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '[]';
    return res.json(JSON.parse(txt.replace(/```json|```/g, '').trim()));
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post('/ai/ask', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  const { question, recipeNames } = req.body;
  if (!question) return res.status(400).json({ error: 'No question provided.' });
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_instruction: { parts: [{ text: `You are a helpful cooking assistant. User's saved recipes: ${recipeNames || 'none'}. Reply in under 80 words, no markdown.` }] }, contents: [{ parts: [{ text: question }] }] })
    });
    const d = await r.json();
    const answer = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || 'Sorry, could not respond.';
    return res.json({ answer });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// Install yt-dlp if not present, then start server
async function ensureYtDlp() {
  try {
    await execAsync('yt-dlp --version');
    console.log('yt-dlp already installed');
  } catch {
    console.log('Installing yt-dlp...');
    try {
      await execAsync('pip3 install yt-dlp || pip install yt-dlp || python3 -m pip install yt-dlp');
      console.log('yt-dlp installed successfully');
    } catch (e) {
      console.error('yt-dlp install failed:', e.message);
    }
  }
}

ensureYtDlp().then(() => {
  app.listen(PORT, () => console.log(`Mise en place backend running on port ${PORT}`));
});
